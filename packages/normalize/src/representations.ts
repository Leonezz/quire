import { createHash } from "node:crypto";

import { toString } from "mdast-util-to-string";
import { normalizeIdentifier } from "micromark-util-normalize-identifier";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import TurndownService from "turndown";
import { gfm as turndownGfm } from "turndown-plugin-gfm";
import { unified } from "unified";

import type { ContentRepresentation, Sha256Identity } from "./model";
import { trackingPixelRule } from "./image-policy";
import {
  htmlStructureWithinBudget,
  jsonByteLengthWithin,
  transformInputByteLimit,
  Utf8Budget,
  utf8ByteLength,
} from "./output-budget";
import { readerDocumentSchema } from "./reader-document-contract";
import { readerDocumentV2FromHtml, readerDocumentV2FromText } from "./reader-document-v2";
import { normalizeSyntaxHighlightingHtml } from "./syntax-highlight-html";

type MdNode = {
  align?: Array<"center" | "left" | "right" | null>;
  alt?: string;
  children?: MdNode[];
  depth?: number;
  identifier?: string;
  lang?: string | null;
  meta?: string | null;
  ordered?: boolean | null;
  spread?: boolean;
  start?: number | null;
  title?: string | null;
  type: string;
  url?: string;
  value?: string;
};

type MarkdownDefinition = {
  title: string | null;
  url: string;
};

type ProtectedTexDelimiters = {
  content: string;
  tokens: ReadonlyMap<string, string>;
};

type ProtectedTexExpressions = {
  restoreOutput: (value: string) => string;
  restoreTree: () => void;
};

export type MarkdownRepresentationInput = {
  baseUri?: string;
  content: string;
  maxDepth: number;
  maxNodes: number;
  maxOutputBytes: number;
  outputBudgetErrorCode: string;
};

const DROP_TAGS = new Set(["BUTTON", "EMBED", "FORM", "IFRAME", "INPUT", "OBJECT", "SCRIPT", "STYLE", "SVG"]);
const CONTAINER_TYPES = new Set(["blockquote", "delete", "emphasis", "link", "list", "listItem", "paragraph", "root", "strong", "table", "tableCell", "tableRow"]);
const LEAF_TYPES = new Set(["break", "code", "image", "inlineCode", "text", "thematicBreak"]);
const FLOW_TYPES = new Set(["blockquote", "code", "heading", "list", "paragraph", "table", "thematicBreak"]);
const PHRASING_TYPES = new Set(["break", "delete", "emphasis", "image", "inlineCode", "link", "strong", "text"]);

export function sha256Identity(value: string | Uint8Array): Sha256Identity {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function safeUrl(rawValue: string, baseUri: string | undefined, purpose: "image" | "link") {
  const value = rawValue.trim();
  if (!value) return undefined;
  if (purpose === "link" && /^(?:mailto):/i.test(value)) return value;
  try {
    const parsed = new URL(value, baseUri);
    if (parsed.username || parsed.password || !["http:", "https:"].includes(parsed.protocol)) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function markdownFromHtml(
  html: string,
  baseUri: string | undefined,
  producerKey: string,
  producerEntryId: string | undefined,
  rulesApplied: string[],
  maxOutputBytes: number,
  outputBudgetErrorCode: string,
) {
  const service = new TurndownService({ bulletListMarker: "-", codeBlockStyle: "fenced", headingStyle: "atx" });
  service.use(turndownGfm);
  service.addRule("unsafe-elements", {
    filter: (node) => DROP_TAGS.has(node.nodeName),
    replacement: () => "",
  });
  // Multi-line <code> outside <pre> is a code block (see the reader conversion's same rule).
  service.addRule("standalone-code-block", {
    filter: (node) => node.nodeName === "CODE" && node.parentNode?.nodeName !== "PRE" && (node.textContent ?? "").includes("\n"),
    replacement: (_content, node) => {
      const element = node as unknown as { getAttribute(name: string): string | null; textContent: string | null };
      const lang = (element.getAttribute("class") ?? "").split(/\s+/).find((token) => /^(?:lang|language)-/.test(token))?.replace(/^(?:lang|language)-/, "") ?? "";
      const text = (element.textContent ?? "").replace(/\n$/, "");
      return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
    },
  });
  service.addRule("safe-links", {
    filter: "a",
    replacement: (content, node) => {
      const href = safeUrl(node.getAttribute("href") ?? "", baseUri, "link");
      return href ? `[${content}](${href.replaceAll("(", "%28").replaceAll(")", "%29")})` : content;
    },
  });
  service.addRule("safe-images", {
    filter: "img",
    replacement: (_content, node) => {
      const src = safeUrl(node.getAttribute("src") ?? "", baseUri, "image");
      if (!src) return "";
      const trackingRule = trackingPixelRule({
        alt: node.getAttribute("alt"),
        height: node.getAttribute("height"),
        producerEntryId,
        producerKey,
        title: node.getAttribute("title"),
        url: src,
        width: node.getAttribute("width"),
      });
      if (trackingRule) {
        if (!rulesApplied.includes(trackingRule)) rulesApplied.push(trackingRule);
        return "";
      }
      const alt = (node.getAttribute("alt") ?? "").replace(/[\[\]]/g, "");
      return `![${alt}](${src.replaceAll("(", "%28").replaceAll(")", "%29")})`;
    },
  });
  const markdown = service.turndown(html);
  if (utf8ByteLength(markdown) > maxOutputBytes) throw new Error(outputBudgetErrorCode);
  return markdown;
}

function asFlowChildren(nodes: MdNode[]) {
  const result: MdNode[] = [];
  let phrasing: MdNode[] = [];
  const flush = () => {
    if (phrasing.length) result.push({ children: phrasing, type: "paragraph" });
    phrasing = [];
  };
  for (const node of nodes) {
    if (FLOW_TYPES.has(node.type)) {
      flush();
      result.push(node);
    } else if (PHRASING_TYPES.has(node.type)) {
      phrasing.push(node);
    }
  }
  flush();
  return result;
}

function markdownDefinitions(root: MdNode, maxDepth: number, maxNodes: number) {
  const definitions = new Map<string, MarkdownDefinition>();
  let count = 0;
  const visit = (node: MdNode, depth: number) => {
    count += 1;
    if (count > maxNodes || depth > maxDepth) throw new Error("SOURCE_REPRESENTATION_BUDGET_EXCEEDED");
    if (node.type === "definition" && node.identifier && node.url) {
      const identifier = normalizeIdentifier(node.identifier);
      if (!definitions.has(identifier)) {
        definitions.set(identifier, { title: node.title ?? null, url: node.url });
      }
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(root, 0);
  return definitions;
}

function isEscapedAt(value: string, index: number) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function usedPrivateCodePoints(value: string) {
  const used = new Set<number>();
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint >= 0xe000 && codePoint <= 0xf8ff) used.add(codePoint);
  }
  return used;
}

function protectTexDelimiters(content: string): ProtectedTexDelimiters {
  const delimiters = ["\\(", "\\)", "\\[", "\\]"] as const;
  const usedCodePoints = usedPrivateCodePoints(content);
  let tokens: string[] | undefined;
  for (let base = 0xe000; base <= 0xf8f9; base += delimiters.length + 2) {
    const candidate = Array.from(
      { length: delimiters.length + 2 },
      (_value, index) => String.fromCodePoint(base + index),
    );
    if (candidate.every((_token, index) => !usedCodePoints.has(base + index))) {
      tokens = candidate;
      break;
    }
  }
  if (!tokens) throw new Error("SOURCE_SAFE_REPRESENTATION_MISSING");
  const originalsByToken = new Map<string, string>();
  let expressionIndex = 0;
  const contentWithProtectedExpressions = replaceTexExpressions(content, (expression) => {
    const token = `${tokens![0]}${expressionIndex.toString(36)}${tokens![1]}`;
    expressionIndex += 1;
    originalsByToken.set(token, expression);
    return token;
  });
  const protectedByDelimiter = new Map(delimiters.map((delimiter, index) => [delimiter, tokens![index + 2]]));
  for (const [delimiter, token] of protectedByDelimiter) originalsByToken.set(token, delimiter);
  let protectedContent = "";
  for (let index = 0; index < contentWithProtectedExpressions.length; index += 1) {
    const delimiter = contentWithProtectedExpressions.slice(index, index + 2) as (typeof delimiters)[number];
    const token = protectedByDelimiter.get(delimiter);
    if (token && !isEscapedAt(contentWithProtectedExpressions, index)) {
      protectedContent += token;
      index += 1;
    } else {
      protectedContent += contentWithProtectedExpressions[index];
    }
  }
  return { content: protectedContent, tokens: originalsByToken };
}

function restoreTexDelimiters(root: MdNode, tokens: ReadonlyMap<string, string>) {
  const restore = (value: string) => {
    let restored = value;
    for (const [token, delimiter] of tokens) restored = restored.replaceAll(token, delimiter);
    return restored;
  };
  const visit = (node: MdNode) => {
    for (const key of ["alt", "identifier", "title", "url", "value"] as const) {
      if (typeof node[key] === "string") node[key] = restore(node[key]);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
}

function replaceTexExpressions(value: string, replacement: (expression: string) => string) {
  let cursor = 0;
  let result = "";
  for (let index = 0; index < value.length - 1;) {
    const opening = value.slice(index, index + 2);
    if ((opening !== "\\(" && opening !== "\\[") || isEscapedAt(value, index)) {
      index += 1;
      continue;
    }
    const closing = opening === "\\(" ? "\\)" : "\\]";
    let closingIndex = value.indexOf(closing, index + opening.length);
    while (closingIndex >= 0 && isEscapedAt(value, closingIndex)) {
      closingIndex = value.indexOf(closing, closingIndex + closing.length);
    }
    if (closingIndex < 0) {
      index += opening.length;
      continue;
    }
    const end = closingIndex + closing.length;
    result += value.slice(cursor, index);
    result += replacement(value.slice(index, end));
    cursor = end;
    index = end;
  }
  return result + value.slice(cursor);
}

function protectTexExpressionsForStringify(root: MdNode): ProtectedTexExpressions {
  const serialized = JSON.stringify(root);
  const usedCodePoints = usedPrivateCodePoints(serialized);
  let boundary: [string, string] | undefined;
  for (let base = 0xe000; base < 0xf8ff; base += 2) {
    const candidate: [string, string] = [String.fromCodePoint(base), String.fromCodePoint(base + 1)];
    if (candidate.every((_token, index) => !usedCodePoints.has(base + index))) {
      boundary = candidate;
      break;
    }
  }
  if (!boundary) throw new Error("SOURCE_SAFE_REPRESENTATION_MISSING");

  const expressions = new Map<string, string>();
  const textNodes: MdNode[] = [];
  const visit = (node: MdNode) => {
    if (node.type === "text" && typeof node.value === "string") {
      textNodes.push(node);
      node.value = replaceTexExpressions(node.value, (expression) => {
        const token = `${boundary![0]}${expressions.size.toString(36)}${boundary![1]}`;
        expressions.set(token, expression);
        return token;
      });
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);

  const restore = (value: string) => {
    let restored = value;
    for (const [token, expression] of expressions) restored = restored.replaceAll(token, expression);
    return restored;
  };
  return {
    restoreOutput: restore,
    restoreTree: () => {
      for (const node of textNodes) node.value = restore(node.value ?? "");
    },
  };
}

function rawHtmlVisibleText(
  html: string,
  baseUri: string | undefined,
  maxOutputBytes: number,
  outputBudgetErrorCode: string,
) {
  const markdown = markdownFromHtml(
    html,
    baseUri,
    "scholarly-markdown",
    undefined,
    [],
    maxOutputBytes,
    outputBudgetErrorCode,
  );
  const parsed = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  return toString(parsed).trim();
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inlineMathHtml(value: string) {
  let cursor = 0;
  let result = "";
  const pattern = /(?<!\\)\$([^$\n]+?)(?<!\\)\$/gu;
  for (const match of value.matchAll(pattern)) {
    const source = match[1]?.trim();
    if (!source || /^[0-9.,]+$/u.test(source)) continue;
    result += escapeHtml(value.slice(cursor, match.index));
    result += `<span class="math">${escapeHtml(`$${source}$`)}</span>`;
    cursor = (match.index ?? 0) + match[0].length;
  }
  return result + escapeHtml(value.slice(cursor));
}

function markdownNodeHtml(node: MdNode): string {
  const children = () => (node.children ?? []).map(markdownNodeHtml).join("");
  switch (node.type) {
    case "root": return children();
    case "text": return inlineMathHtml(node.value ?? "");
    case "heading": return `<h${node.depth ?? 1}>${children()}</h${node.depth ?? 1}>`;
    case "paragraph": {
      const raw = node.children?.length === 1 && node.children[0]?.type === "text" ? node.children[0].value?.trim() ?? "" : "";
      const display = /^(?:\\\[[\s\S]+\\\]|\$\$[\s\S]+\$\$|\\begin\{(?:equation\*?|align\*?|gather\*?|multline\*?)\}[\s\S]+\\end\{(?:equation\*?|align\*?|gather\*?|multline\*?)\})$/u.test(raw);
      return display ? `<div class="math display">${escapeHtml(raw)}</div>` : `<p>${children()}</p>`;
    }
    case "emphasis": return `<em>${children()}</em>`;
    case "strong": return `<strong>${children()}</strong>`;
    case "delete": return `<del>${children()}</del>`;
    case "link": return `<a href="${escapeHtml(node.url ?? "")}"${node.title ? ` title="${escapeHtml(node.title)}"` : ""}>${children()}</a>`;
    case "image": return `<img src="${escapeHtml(node.url ?? "")}" alt="${escapeHtml(node.alt ?? "")}"${node.title ? ` title="${escapeHtml(node.title)}"` : ""}>`;
    case "inlineCode": return `<code>${escapeHtml(node.value ?? "")}</code>`;
    case "code": return `<pre><code${node.lang ? ` class="language-${escapeHtml(node.lang)}"` : ""}>${escapeHtml(node.value ?? "")}</code></pre>`;
    case "blockquote": return `<blockquote>${children()}</blockquote>`;
    case "list": return node.ordered ? `<ol${node.start ? ` start="${node.start}"` : ""}>${children()}</ol>` : `<ul>${children()}</ul>`;
    case "listItem": return `<li>${children()}</li>`;
    case "table": {
      const rows = node.children ?? [];
      const rowHtml = (row: MdNode, cellTag: "td" | "th") => {
        const cells = (row.children ?? []).map((cell, index) => {
          const align = node.align?.[index];
          const alignAttribute = align === "center" || align === "left" || align === "right"
            ? ` align="${align}"`
            : "";
          return `<${cellTag}${alignAttribute}>${(cell.children ?? []).map(markdownNodeHtml).join("")}</${cellTag}>`;
        }).join("");
        return `<tr>${cells}</tr>`;
      };
      const head = rows[0] ? `<thead>${rowHtml(rows[0], "th")}</thead>` : "";
      const body = rows.length > 1 ? `<tbody>${rows.slice(1).map((row) => rowHtml(row, "td")).join("")}</tbody>` : "";
      return `<table>${head}${body}</table>`;
    }
    case "tableRow": return `<tr>${children()}</tr>`;
    case "tableCell": return `<td>${children()}</td>`;
    case "thematicBreak": return "<hr>";
    case "break": return "<br>";
    default: return "";
  }
}

function readerV1CompatibleTree(node: MdNode): MdNode {
  const compatible = { ...node };
  delete compatible.align;
  if (node.children) compatible.children = node.children.map(readerV1CompatibleTree);
  return compatible;
}

export function createMarkdownRepresentations(input: MarkdownRepresentationInput) {
  if (utf8ByteLength(input.content) > transformInputByteLimit(input.maxOutputBytes)) throw new Error(input.outputBudgetErrorCode);
  const parser = unified().use(remarkParse).use(remarkGfm);
  const protectedTex = protectTexDelimiters(input.content);
  const parsed = parser.parse(protectedTex.content) as unknown as MdNode;
  restoreTexDelimiters(parsed, protectedTex.tokens);
  const definitions = markdownDefinitions(parsed, input.maxDepth, input.maxNodes);
  const projectionBudget = new Utf8Budget(input.maxOutputBytes, input.outputBudgetErrorCode);
  const tree = sanitizeNode(parsed, {
    baseUri: input.baseUri,
    definitions,
    depth: 0,
    htmlNodePolicy: "sanitize",
    maxOutputBytes: input.maxOutputBytes,
    maxDepth: input.maxDepth,
    maxNodes: input.maxNodes,
    nodes: { value: 0 },
    outputBudgetErrorCode: input.outputBudgetErrorCode,
    outputBudget: projectionBudget,
  });
  if (!tree || tree.type !== "root") throw new Error("SOURCE_SAFE_REPRESENTATION_MISSING");
  const parsedReaderDocument = readerDocumentSchema.safeParse(readerV1CompatibleTree(tree));
  if (!parsedReaderDocument.success) throw new Error("SOURCE_SAFE_REPRESENTATION_MISSING");
  const rulesApplied = ["generic.safe-url-policy", "scholarly.markdown-to-reader-v2@1"];
  const readerV2Result = readerDocumentV2FromHtml({
    baseUri: input.baseUri,
    html: `<article>${markdownNodeHtml(tree)}</article>`,
    maxDepth: input.maxDepth,
    maxNodes: input.maxNodes,
    maxOutputBytes: input.maxOutputBytes,
    outputBudgetErrorCode: input.outputBudgetErrorCode,
    producerKey: "scholarly-metadata",
    title: "Scholarly record",
  });
  for (const rule of readerV2Result.rulesApplied) if (!rulesApplied.includes(rule)) rulesApplied.push(rule);
  const writer = unified().use(remarkParse).use(remarkGfm).use(remarkStringify, {
    bullet: "-",
    fences: true,
    listItemIndent: "one",
  });
  const readerContent = JSON.stringify(parsedReaderDocument.data);
  const readerV2Content = JSON.stringify(readerV2Result.document);
  const protectedAgentMath = protectTexExpressionsForStringify(tree);
  const agentContent = protectedAgentMath.restoreOutput(writer.stringify(tree as never)).trim();
  protectedAgentMath.restoreTree();
  const selectionContent = toString(tree as never).trim();
  const representations: ContentRepresentation[] = [
    { content: readerContent, contentIdentity: sha256Identity(readerContent), purpose: "reader", schema: "reader.document.v1" },
    { content: readerV2Content, contentIdentity: sha256Identity(readerV2Content), purpose: "reader", schema: "reader.document.v2" },
    { content: agentContent, contentIdentity: sha256Identity(agentContent), purpose: "agent", schema: "agent.gfm.v1" },
    { content: selectionContent, contentIdentity: sha256Identity(selectionContent), purpose: "selection", schema: "selection.text.v1" },
  ];
  jsonByteLengthWithin(representations, input.maxOutputBytes, input.outputBudgetErrorCode);
  return { representations, rulesApplied };
}

function sanitizeNode(node: MdNode, input: {
  baseUri?: string;
  definitions: ReadonlyMap<string, MarkdownDefinition>;
  depth: number;
  htmlNodePolicy: "literal-text" | "sanitize";
  maxDepth: number;
  maxNodes: number;
  maxOutputBytes: number;
  nodes: { value: number };
  outputBudgetErrorCode: string;
  outputBudget: Utf8Budget;
}): MdNode | undefined {
  input.nodes.value += 1;
  if (input.nodes.value > input.maxNodes || input.depth > input.maxDepth) throw new Error("SOURCE_REPRESENTATION_BUDGET_EXCEEDED");
  if (node.type === "html") {
    if (input.htmlNodePolicy === "literal-text") {
      const value = node.value ?? "";
      return value ? { type: "text", value: input.outputBudget.consumeString(value) } : undefined;
    }
    const value = rawHtmlVisibleText(
      node.value ?? "",
      input.baseUri,
      input.maxOutputBytes,
      input.outputBudgetErrorCode,
    );
    return value ? { type: "text", value: input.outputBudget.consumeString(value) } : undefined;
  }
  if (node.type === "definition") return undefined;
  if (node.type === "footnoteReference") {
    const identifier = node.identifier ?? node.value ?? "note";
    return { type: "text", value: input.outputBudget.consumeString(`[^${identifier}]`) };
  }
  if (node.type === "imageReference") {
    const definition = node.identifier ? input.definitions.get(normalizeIdentifier(node.identifier)) : undefined;
    const url = definition ? safeUrl(definition.url, input.baseUri, "image") : undefined;
    if (!url) return { type: "text", value: input.outputBudget.consumeString(node.alt ?? "") };
    return {
      alt: input.outputBudget.consumeString(node.alt ?? ""),
      title: definition?.title === null || definition?.title === undefined ? null : input.outputBudget.consumeString(definition.title),
      type: "image",
      url: input.outputBudget.consumeString(url),
    };
  }
  if (node.type === "linkReference") {
    const children = node.children?.map((child) => sanitizeNode(child, { ...input, depth: input.depth + 1 })).filter(Boolean) as MdNode[] ?? [];
    const definition = node.identifier ? input.definitions.get(normalizeIdentifier(node.identifier)) : undefined;
    const url = definition ? safeUrl(definition.url, input.baseUri, "link") : undefined;
    if (!url) {
      const value = toString({ children, type: "root" } as never);
      return value ? { type: "text", value } : undefined;
    }
    return {
      children,
      title: definition?.title === null || definition?.title === undefined ? null : input.outputBudget.consumeString(definition.title),
      type: "link",
      url: input.outputBudget.consumeString(url),
    };
  }
  if (node.type === "footnoteDefinition") {
    const children = asFlowChildren(node.children
      ?.map((child) => sanitizeNode(child, { ...input, depth: input.depth + 1 }))
      .filter((child): child is MdNode => child !== undefined) ?? []);
    return children.length ? { children, type: "blockquote" } : undefined;
  }
  if (!CONTAINER_TYPES.has(node.type) && !LEAF_TYPES.has(node.type) && node.type !== "heading") return undefined;

  if (node.type === "link") {
    const children = node.children
      ?.map((child) => sanitizeNode(child, { ...input, depth: input.depth + 1 }))
      .filter((child): child is MdNode => child !== undefined) ?? [];
    const url = safeUrl(node.url ?? "", input.baseUri, "link");
    if (!url) {
      const value = toString({ children, type: "root" } as never);
      return value ? { type: "text", value } : undefined;
    }
    return {
      children,
      title: node.title === null || node.title === undefined ? null : input.outputBudget.consumeString(node.title),
      type: node.type,
      url: input.outputBudget.consumeString(url),
    };
  }
  if (node.type === "image") {
    const url = safeUrl(node.url ?? "", input.baseUri, "image");
    if (!url) return undefined;
    return {
      alt: input.outputBudget.consumeString(node.alt ?? ""),
      title: node.title === null || node.title === undefined ? null : input.outputBudget.consumeString(node.title),
      type: "image",
      url: input.outputBudget.consumeString(url),
    };
  }
  if (CONTAINER_TYPES.has(node.type) || node.type === "heading") {
    const children = node.children?.map((child) => sanitizeNode(child, { ...input, depth: input.depth + 1 })).filter(Boolean) as MdNode[] ?? [];
    const sanitized: MdNode = {
      children: ["blockquote", "listItem", "root"].includes(node.type) ? asFlowChildren(children) : children,
      type: node.type,
    };
    if (node.type === "heading") sanitized.depth = Math.min(6, Math.max(1, Number(node.depth) || 1));
    if (node.type === "list") {
      sanitized.ordered = Boolean(node.ordered);
      sanitized.start = node.start ?? null;
      sanitized.spread = Boolean(node.spread);
    }
    if (node.type === "listItem") sanitized.spread = Boolean(node.spread);
    if (node.type === "table") {
      sanitized.align = node.align?.map((align) =>
        align === "center" || align === "left" || align === "right" ? align : null,
      ) ?? [];
    }
    return sanitized;
  }
  if (node.type === "code") return {
    lang: node.lang === null || node.lang === undefined ? null : input.outputBudget.consumeString(node.lang),
    meta: node.meta === null || node.meta === undefined ? null : input.outputBudget.consumeString(node.meta),
    type: "code",
    value: input.outputBudget.consumeString(node.value ?? ""),
  };
  return node.value === undefined ? { type: node.type } : { type: node.type, value: input.outputBudget.consumeString(node.value) };
}

export function createRepresentations(input: {
  baseUri?: string;
  content: string;
  mediaType: string;
  producerKey: string;
  producerEntryId?: string;
  title: string;
  maxDepth: number;
  maxNodes: number;
  maxOutputBytes: number;
  outputBudgetErrorCode: string;
}) {
  if (utf8ByteLength(input.content) > transformInputByteLimit(input.maxOutputBytes)) throw new Error(input.outputBudgetErrorCode);
  if (
    input.mediaType !== "text/plain" &&
    !htmlStructureWithinBudget(input.content, input.maxDepth, input.maxNodes)
  )
    throw new Error(input.outputBudgetErrorCode);
  const rulesApplied = ["generic.drop-active-content", "generic.safe-url-policy"];
  const normalizedHtml = input.mediaType === "text/plain"
    ? undefined
    : normalizeSyntaxHighlightingHtml(input.content);
  if (normalizedHtml?.replacements) rulesApplied.push("generic.syntax-highlight-table-to-code@1");
  const normalizedContent = normalizedHtml?.html ?? input.content;
  if (
    utf8ByteLength(normalizedContent) > transformInputByteLimit(input.maxOutputBytes) ||
    (input.mediaType !== "text/plain" &&
      !htmlStructureWithinBudget(normalizedContent, input.maxDepth, input.maxNodes))
  )
    throw new Error(input.outputBudgetErrorCode);
  const parser = unified().use(remarkParse).use(remarkGfm);
  const parsed: MdNode = input.mediaType === "text/plain"
    ? {
        children: [{ children: [{ type: "text", value: input.content }], type: "paragraph" }],
        type: "root",
      }
    : parser.parse(markdownFromHtml(
        normalizedContent,
        input.baseUri,
        input.producerKey,
        input.producerEntryId,
        rulesApplied,
        input.maxOutputBytes,
        input.outputBudgetErrorCode,
      )) as unknown as MdNode;
  const definitions = markdownDefinitions(parsed, input.maxDepth, input.maxNodes);
  const projectionBudget = new Utf8Budget(input.maxOutputBytes, input.outputBudgetErrorCode);
  const tree = sanitizeNode(parsed, {
    baseUri: input.baseUri,
    definitions,
    depth: 0,
    htmlNodePolicy: "literal-text",
    maxOutputBytes: input.maxOutputBytes,
    maxDepth: input.maxDepth,
    maxNodes: input.maxNodes,
    nodes: { value: 0 },
    outputBudgetErrorCode: input.outputBudgetErrorCode,
    outputBudget: projectionBudget,
  });
  if (!tree || tree.type !== "root") throw new Error("SOURCE_SAFE_REPRESENTATION_MISSING");
  const writer = unified().use(remarkParse).use(remarkGfm).use(remarkStringify, {
    bullet: "-",
    fences: true,
    listItemIndent: "one",
  });
  const representationBudget = new Utf8Budget(input.maxOutputBytes, input.outputBudgetErrorCode);
  representationBudget.consumeBytes(5);
  const representations: ContentRepresentation[] = [];
  const appendRepresentation = (content: string, purpose: ContentRepresentation["purpose"], schema: ContentRepresentation["schema"]) => {
    const representation: ContentRepresentation = { content, contentIdentity: sha256Identity(content), purpose, schema };
    representationBudget.consumeJson(representation);
    representations.push(representation);
  };

  const parsedReaderDocument = readerDocumentSchema.safeParse(readerV1CompatibleTree(tree));
  if (!parsedReaderDocument.success) throw new Error("SOURCE_SAFE_REPRESENTATION_MISSING");
  jsonByteLengthWithin(parsedReaderDocument.data, representationBudget.remainingBytes, input.outputBudgetErrorCode);
  const readerContent = JSON.stringify(parsedReaderDocument.data);
  appendRepresentation(readerContent, "reader", "reader.document.v1");
  const readerV2Result = input.mediaType === "text/plain"
    ? {
        document: readerDocumentV2FromText(input.content, {
          maxOutputBytes: representationBudget.remainingBytes,
          outputBudgetErrorCode: input.outputBudgetErrorCode,
        }),
        rulesApplied: ["generic.plain-text-to-reader-v2"],
      }
    : readerDocumentV2FromHtml({
        baseUri: input.baseUri,
        html: normalizedContent,
        maxDepth: input.maxDepth,
        maxNodes: input.maxNodes,
        maxOutputBytes: representationBudget.remainingBytes,
        outputBudgetErrorCode: input.outputBudgetErrorCode,
        producerEntryId: input.producerEntryId,
        producerKey: input.producerKey,
        title: input.title,
      });
  for (const rule of readerV2Result.rulesApplied) {
    if (!rulesApplied.includes(rule)) rulesApplied.push(rule);
  }
  jsonByteLengthWithin(readerV2Result.document, representationBudget.remainingBytes, input.outputBudgetErrorCode);
  const readerV2Content = JSON.stringify(readerV2Result.document);
  appendRepresentation(readerV2Content, "reader", "reader.document.v2");

  if (projectionBudget.usedBytes + utf8ByteLength(input.title) > representationBudget.remainingBytes) throw new Error(input.outputBudgetErrorCode);
  const titleTree: MdNode = {
    children: [{ children: [{ type: "text", value: input.title }], depth: 1, type: "heading" }, ...(tree.children ?? [])],
    type: "root",
  };
  const agentContent = writer.stringify(titleTree as never).trim();
  appendRepresentation(agentContent, "agent", "agent.gfm.v1");
  const selectionContent = toString(tree as never).trim();
  appendRepresentation(selectionContent, "selection", "selection.text.v1");
  return { representations, rulesApplied };
}
