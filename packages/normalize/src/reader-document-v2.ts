import type {
  Element,
  ElementContent,
  Nodes,
  Root,
  RootContent,
  Text,
} from "hast";
import rehypeParse from "rehype-parse";
import rehypeSanitize, {
  defaultSchema,
  type Options as SanitizeOptions,
} from "rehype-sanitize";
import { unified } from "unified";

import {
  readerDocumentV2Schema,
  type ReaderDocumentV2,
  type ReaderV2FlowNode,
  type ReaderV2FootnoteDefinition,
  type ReaderV2Figure,
  type ReaderV2Image,
  type ReaderV2Loss,
  type ReaderV2Math,
  type ReaderV2PhrasingNode,
  type ReaderV2TableCell,
  type ReaderV2TableRow,
  type ReaderV2TableSection,
} from "./reader-document-v2-contract";
import { trackingPixelRule } from "./image-policy";
import { htmlStructureWithinBudget, Utf8Budget } from "./output-budget";

const ACTIVE_TAGS = new Set([
  "button",
  "embed",
  "form",
  "iframe",
  "input",
  "object",
  "script",
  "style",
  "svg",
]);
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "footer",
  "header",
  "main",
  "nav",
  "section",
  "summary",
]);
const PHRASING_PARENT_TYPES = {
  b: "strong",
  cite: "cite",
  del: "delete",
  em: "emphasis",
  i: "emphasis",
  ins: "insert",
  kbd: "keyboard",
  mark: "mark",
  q: "quote",
  s: "delete",
  strong: "strong",
  sub: "subscript",
  sup: "superscript",
} as const;
const SANITIZER_SCHEMA_ID = "reader-html.v2";
const SANITIZER_TAG_NAMES = new Set([
  ...(defaultSchema.tagNames ?? []),
  "abbr",
  "annotation",
  "article",
  "aside",
  "caption",
  "cite",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "header",
  "ins",
  "kbd",
  "main",
  "mark",
  "math",
  "merror",
  "mfrac",
  "mi",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mphantom",
  "mroot",
  "mrow",
  "mmultiscripts",
  "ms",
  "mspace",
  "msqrt",
  "mstyle",
  "msub",
  "msubsup",
  "msup",
  "mprescripts",
  "none",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
  "nav",
  "q",
  "section",
  "semantics",
  "summary",
  "tbody",
  "tfoot",
  "thead",
  "var",
]);

function appendAttributes(tagName: string, names: string[]) {
  return [...(defaultSchema.attributes?.[tagName] ?? []), ...names];
}

const sanitizerSchema: SanitizeOptions = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": appendAttributes("*", ["className", "dir", "id", "lang", "role"]),
    a: appendAttributes("a", [
      "dataFootnoteBackref",
      "dataFootnoteRef",
      "id",
      "role",
    ]),
    abbr: appendAttributes("abbr", ["title"]),
    annotation: ["encoding"],
    code: appendAttributes("code", ["className"]),
    div: appendAttributes("div", ["className", "role"]),
    img: appendAttributes("img", ["alt", "height", "src", "title", "width"]),
    math: ["display", "id", "mathVariant", "title"],
    section: appendAttributes("section", ["className", "role"]),
    span: appendAttributes("span", ["className", "role"]),
    td: appendAttributes("td", ["align", "colSpan", "rowSpan"]),
    th: appendAttributes("th", ["align", "colSpan", "rowSpan", "scope"]),
  },
  clobberPrefix: "reader-",
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
  },
  strip: [...ACTIVE_TAGS],
  tagNames: Array.from(SANITIZER_TAG_NAMES),
};

type Context = {
  baseUri?: string;
  losses: ReaderV2Loss[];
  outputBudget: Utf8Budget;
  producerEntryId?: string;
  producerKey: string;
  rulesApplied: Set<string>;
};

type MappedFlow = ReaderV2FlowNode | ReaderV2FlowNode[] | undefined;

function isElement(node: Nodes): node is Element {
  return node.type === "element";
}

function isText(node: Nodes): node is Text {
  return node.type === "text";
}

function propertyString(element: Element, name: string) {
  const value = element.properties[name];
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  return undefined;
}

function hasProperty(element: Element, name: string) {
  return Object.prototype.hasOwnProperty.call(element.properties, name);
}

function classNames(element: Element) {
  const value: unknown = element.properties.className;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/\s+/u).filter(Boolean);
  return [];
}

function hasClass(element: Element, value: string) {
  return classNames(element).includes(value);
}

function textContent(node: Nodes): string {
  if (isText(node)) return node.value;
  if ("children" in node)
    return node.children.map((child) => textContent(child)).join("");
  return "";
}

function elementPath(parentPath: string, element: Element, childIndex: number) {
  return `${parentPath}/${element.tagName}[${childIndex}]`;
}

function loss(context: Context, value: ReaderV2Loss) {
  context.outputBudget.consumeString(value.code);
  context.outputBudget.consumeString(value.fallback);
  context.outputBudget.consumeString(value.sourcePath);
  context.outputBudget.consumeString(value.sourceTag);
  context.losses.push(value);
}

function bounded(context: Context, value: string) {
  return context.outputBudget.consumeString(value);
}

function boundedNullable(context: Context, value: string | null | undefined) {
  return value === null || value === undefined ? null : bounded(context, value);
}

function safeUrl(
  rawValue: string,
  baseUri: string | undefined,
  purpose: "image" | "link",
) {
  const value = rawValue.trim();
  if (!value) return undefined;
  try {
    const parsed = new URL(value, baseUri);
    if (parsed.username || parsed.password) return undefined;
    if (purpose === "link" && parsed.protocol === "mailto:")
      return parsed.toString();
    if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizedIdentifier(value: string | undefined) {
  if (!value) return undefined;
  let identifier = value.startsWith("#") ? value.slice(1) : value;
  try {
    identifier = decodeURIComponent(identifier);
  } catch {}
  identifier = identifier
    .replace(/^reader-/u, "")
    .replace(/^user-content-/u, "");
  const match = /^(?:fn(?:ref)?|footnote)(?:[-_:]?)(.+)$/iu.exec(identifier);
  const normalized = (match?.[1] ?? identifier).trim();
  return normalized || undefined;
}

function sourceAnchor(element: Element, context: Context) {
  const anchor = normalizedIdentifier(propertyString(element, "id"));
  return anchor ? bounded(context, anchor) : undefined;
}

function sameDocumentTargetAnchor(
  rawHref: string,
  baseUri: string | undefined,
) {
  const value = rawHref.trim();
  if (!value) return undefined;
  if (value.startsWith("#")) return normalizedIdentifier(value);
  if (!baseUri) return undefined;
  try {
    const target = new URL(value, baseUri);
    const base = new URL(baseUri);
    if (
      !target.hash ||
      target.origin !== base.origin ||
      target.pathname !== base.pathname ||
      target.search !== base.search
    )
      return undefined;
    return normalizedIdentifier(target.hash);
  } catch {
    return undefined;
  }
}

function normalizeText(value: string) {
  return value.replace(/\s+/gu, " ");
}

function isEscaped(value: string, index: number) {
  let slashCount = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && value[cursor] === "\\";
    cursor -= 1
  )
    slashCount += 1;
  return slashCount % 2 === 1;
}

function findNextUnescaped(value: string, token: string, fromIndex: number) {
  let index = value.indexOf(token, fromIndex);
  while (index >= 0 && isEscaped(value, index))
    index = value.indexOf(token, index + 1);
  return index;
}

function inlineMathRanges(value: string) {
  const ranges: Array<{ end: number; source: string; start: number }> = [];
  let cursor = 0;
  while (cursor < value.length) {
    if (value.startsWith("\\(", cursor) && !isEscaped(value, cursor)) {
      const end = findNextUnescaped(value, "\\)", cursor + 2);
      if (end >= 0) {
        ranges.push({
          end: end + 2,
          source: value.slice(cursor + 2, end),
          start: cursor,
        });
        cursor = end + 2;
        continue;
      }
    }

    if (
      value[cursor] === "$" &&
      !isEscaped(value, cursor) &&
      value[cursor + 1] !== "$" &&
      !/\s/u.test(value[cursor + 1] ?? "")
    ) {
      const closing = findNextUnescaped(value, "$", cursor + 1);
      if (closing >= 0) {
        const source = value.slice(cursor + 1, closing);
        const previous = value[closing - 1] ?? "";
        const next = value[closing + 1] ?? "";
        const isConservativeMath =
          source.length > 0 &&
          !source.includes("\n") &&
          !/\s/u.test(previous) &&
          next !== "$" &&
          !/[A-Za-z0-9_]/u.test(next) &&
          !/^[0-9.,]+$/u.test(source);
        if (isConservativeMath) {
          ranges.push({ end: closing + 1, source, start: cursor });
          cursor = closing + 1;
          continue;
        }
      }
    }
    cursor += 1;
  }
  return ranges;
}

function displayMathFromDelimitedText(
  value: string,
  context: Context,
): ReaderV2Math | undefined {
  const match = /^(?:\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$)$/u.exec(
    value.trim(),
  );
  const source = match
    ?.slice(1)
    .find((candidate) => candidate !== undefined)
    ?.trim();
  return source
    ? {
        display: true,
        format: "tex",
        label: null,
        type: "math",
        value: bounded(context, source),
      }
    : undefined;
}

function phrasingFromText(
  value: string,
  context: Context,
): ReaderV2PhrasingNode[] {
  const result: ReaderV2PhrasingNode[] = [];
  let cursor = 0;
  for (const range of inlineMathRanges(value)) {
    const prefix = normalizeText(value.slice(cursor, range.start));
    if (prefix) result.push({ type: "text", value: bounded(context, prefix) });
    const source = range.source.trim();
    if (source)
      result.push({
        display: false,
        format: "tex",
        label: null,
        type: "math",
        value: bounded(context, source),
      });
    else {
      const fallback = normalizeText(value.slice(range.start, range.end));
      if (fallback)
        result.push({ type: "text", value: bounded(context, fallback) });
    }
    cursor = range.end;
  }
  const suffix = normalizeText(value.slice(cursor));
  if (suffix) result.push({ type: "text", value: bounded(context, suffix) });
  return result;
}

const DISPLAY_TEX_ENVIRONMENT =
  /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}/gu;

type TextRunPiece = {
  end: number;
  node: Extract<ReaderV2PhrasingNode, { type: "break" | "text" }>;
  start: number;
};

function displayEnvironmentRanges(value: string) {
  const ranges: Array<{ end: number; source: string; start: number }> = [];
  for (const match of value.matchAll(DISPLAY_TEX_ENVIRONMENT)) {
    const start = match.index;
    if (isEscaped(value, start)) continue;
    if (ranges.at(-1)?.end && start < (ranges.at(-1)?.end ?? 0)) continue;
    const terminator = `\\end{${match[1]}}`;
    const endStart = findNextUnescaped(
      value,
      terminator,
      start + match[0].length,
    );
    if (endStart < 0) continue;
    const end = endStart + terminator.length;
    ranges.push({ end, source: value.slice(start, end), start });
  }
  return ranges;
}

function textRunSlice(pieces: TextRunPiece[], start: number, end: number) {
  const result: ReaderV2PhrasingNode[] = [];
  for (const piece of pieces) {
    if (piece.end <= start || piece.start >= end) continue;
    if (piece.node.type === "break") {
      result.push(piece.node);
      continue;
    }
    const value = piece.node.value.slice(
      Math.max(start, piece.start) - piece.start,
      Math.min(end, piece.end) - piece.start,
    );
    if (value) result.push({ type: "text", value });
  }
  return result;
}

function flowFromParagraphPhrasing(
  children: ReaderV2PhrasingNode[],
  context: Context,
): ReaderV2FlowNode[] {
  const result: ReaderV2FlowNode[] = [];
  let pending: ReaderV2PhrasingNode[] = [];
  let foundDisplayMath = false;
  const flush = () => {
    const compact = compactPhrasing(pending, true);
    while (compact[0]?.type === "break") compact.shift();
    while (compact.at(-1)?.type === "break") compact.pop();
    if (compact.length) result.push({ children: compact, type: "paragraph" });
    pending = [];
  };

  for (let index = 0; index < children.length; ) {
    const node = children[index];
    if (node.type !== "text" && node.type !== "break") {
      pending.push(node);
      index += 1;
      continue;
    }

    const pieces: TextRunPiece[] = [];
    let value = "";
    while (index < children.length) {
      const candidate = children[index];
      if (candidate.type !== "text" && candidate.type !== "break") break;
      const pieceValue = candidate.type === "break" ? "\n" : candidate.value;
      pieces.push({
        end: value.length + pieceValue.length,
        node: candidate,
        start: value.length,
      });
      value += pieceValue;
      index += 1;
    }

    const ranges = displayEnvironmentRanges(value);
    if (!ranges.length) {
      pending.push(...pieces.map((piece) => piece.node));
      continue;
    }
    foundDisplayMath = true;
    let cursor = 0;
    for (const range of ranges) {
      pending.push(...textRunSlice(pieces, cursor, range.start));
      flush();
      context.rulesApplied.add("reader.tex-display-environment");
      result.push({
        display: true,
        format: "tex",
        label: null,
        type: "math",
        value: range.source.trim(),
      });
      cursor = range.end;
    }
    pending.push(...textRunSlice(pieces, cursor, value.length));
  }

  if (!foundDisplayMath)
    return [{ children: compactPhrasing(children, true), type: "paragraph" }];
  flush();
  return result;
}

function normalizedHeadingIdentity(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

function phrasingText(nodes: ReaderV2PhrasingNode[]): string {
  return nodes
    .map((node) => {
      if (
        node.type === "text" ||
        node.type === "inlineCode" ||
        node.type === "math"
      )
        return node.value;
      if (node.type === "image") return node.alt;
      if (node.type === "footnoteReference") return node.label;
      if (node.type === "break") return " ";
      return phrasingText(node.children);
    })
    .join("");
}

function removeLeadingDuplicateTitle(
  children: ReaderV2FlowNode[],
  title: string | undefined,
  path = "root",
): ReaderV2Loss | undefined {
  if (title === undefined) return undefined;
  const leading = children[0];
  if (
    leading?.type === "heading" &&
    normalizedHeadingIdentity(phrasingText(leading.children)) ===
      normalizedHeadingIdentity(title)
  ) {
    children.shift();
    return {
      code: "DUPLICATE_PAGE_TITLE_REMOVED",
      fallback: "omitted",
      sourcePath: `${path}/heading[0]`,
      sourceTag: `h${leading.depth}`,
    };
  }
  if (leading?.type === "section")
    return removeLeadingDuplicateTitle(
      leading.children,
      title,
      `${path}/section[0]`,
    );
  return undefined;
}

function compactPhrasing(nodes: ReaderV2PhrasingNode[], trimEdges: boolean) {
  const compact: ReaderV2PhrasingNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      if (!node.value) continue;
      const previous = compact.at(-1);
      if (previous?.type === "text") previous.value += node.value;
      else compact.push({ ...node });
    } else {
      compact.push(node);
    }
  }
  if (trimEdges && compact[0]?.type === "text")
    compact[0].value = compact[0].value.trimStart();
  const last = compact.at(-1);
  if (trimEdges && last?.type === "text") last.value = last.value.trimEnd();
  return compact.filter(
    (node) => node.type !== "text" || node.value.length > 0,
  );
}

function descendants(element: Element, predicate: (value: Element) => boolean) {
  const values: Element[] = [];
  const visit = (node: Nodes) => {
    if (!isElement(node)) return;
    if (predicate(node)) values.push(node);
    for (const child of node.children) visit(child);
  };
  for (const child of element.children) visit(child);
  return values;
}

function mathFromElement(
  element: Element,
  displayHint: boolean,
  context: Context,
): ReaderV2Math | undefined {
  const annotation = descendants(
    element,
    (candidate) =>
      candidate.tagName === "annotation" &&
      /(?:x-tex|tex)/iu.test(propertyString(candidate, "encoding") ?? ""),
  )[0];
  const rawValue = (
    annotation ? textContent(annotation) : textContent(element)
  ).trim();
  if (!rawValue) return undefined;
  if (element.tagName === "math" && !annotation) {
    return {
      display: displayHint || propertyString(element, "display") === "block",
      format: "mathml",
      label: boundedNullable(
        context,
        normalizedIdentifier(propertyString(element, "id")),
      ),
      type: "math",
      value: serializeMathMl(element, context),
    };
  }
  const delimiter =
    /^(?:\\\(([\s\S]*)\\\)|\\\[([\s\S]*)\\\]|\$\$([\s\S]*)\$\$|\$([\s\S]*)\$)$/u.exec(
      rawValue,
    );
  const value =
    (delimiter
      ? delimiter.slice(1).find((part) => part !== undefined)
      : rawValue
    )?.trim() ?? "";
  if (!value) return undefined;
  return {
    display:
      displayHint ||
      hasClass(element, "display") ||
      hasClass(element, "katex-display"),
    format: "tex",
    label: boundedNullable(
      context,
      normalizedIdentifier(propertyString(element, "id")),
    ),
    type: "math",
    value: bounded(context, value),
  };
}

function escapedXml(value: string, context: Context, attribute: boolean) {
  const pattern = attribute ? /[&<>"]/gu : /[&<>]/gu;
  let bytes = 0;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    bytes += Buffer.byteLength(value.slice(cursor, match.index), "utf8");
    bytes += match[0] === "&" ? 5 : match[0] === '"' ? 6 : 4;
    cursor = match.index + 1;
  }
  bytes += Buffer.byteLength(value.slice(cursor), "utf8");
  context.outputBudget.consumeBytes(bytes);
  const text = value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return attribute ? text.replaceAll('"', "&quot;") : text;
}

function serializeMathMl(root: Nodes, context: Context): string {
  const chunks: string[] = [];
  const append = (value: string) => chunks.push(bounded(context, value));
  const visit = (node: Nodes): void => {
    if (isText(node)) {
      chunks.push(escapedXml(node.value, context, false));
      return;
    }
    if (!isElement(node)) return;
    append(`<${node.tagName}`);
    for (const [name, value] of Object.entries(node.properties)) {
      if (typeof value !== "string" && typeof value !== "number") continue;
      append(` ${name}="`);
      chunks.push(escapedXml(String(value), context, true));
      append('"');
    }
    append(">");
    for (const child of node.children) visit(child);
    append(`</${node.tagName}>`);
  };
  visit(root);
  return chunks.join("");
}

function footnoteReference(
  element: Element,
  context: Context,
): ReaderV2PhrasingNode | undefined {
  const directAnchor =
    element.tagName === "a" &&
    (propertyString(element, "role") === "doc-noteref" ||
      hasProperty(element, "dataFootnoteRef"));
  if (element.tagName !== "sup" && !directAnchor) return undefined;
  const anchor = directAnchor
    ? element
    : descendants(
        element,
        (candidate) =>
          candidate.tagName === "a" &&
          (propertyString(candidate, "role") === "doc-noteref" ||
            hasProperty(candidate, "dataFootnoteRef") ||
            /#(?:reader-)?(?:user-content-)?fn(?:[-_:]|$)/iu.test(
              propertyString(candidate, "href") ?? "",
            )),
      )[0];
  const identifier = normalizedIdentifier(
    propertyString(anchor ?? element, anchor ? "href" : "id"),
  );
  if (!identifier) return undefined;
  const label = textContent(anchor ?? element).trim() || identifier;
  return {
    identifier: bounded(context, identifier),
    label: bounded(context, label),
    type: "footnoteReference",
  };
}

function phrasingFromElement(
  element: Element,
  path: string,
  context: Context,
  insideLink: boolean,
): ReaderV2PhrasingNode[] {
  const reference = footnoteReference(element, context);
  if (reference) return [reference];
  if (element.tagName === "br") return [{ type: "break" }];
  if (element.tagName === "code")
    return [
      { type: "inlineCode", value: bounded(context, textContent(element)) },
    ];
  if (element.tagName === "img") {
    const image = imageFromElement(element, path, context);
    if (image) return [image];
    const alt = propertyString(element, "alt")?.trim();
    const source = safeUrl(
      propertyString(element, "src") ?? "",
      context.baseUri,
      "image",
    );
    return !source && alt
      ? [{ type: "text", value: bounded(context, alt) }]
      : [];
  }
  if (
    element.tagName === "math" ||
    ((hasClass(element, "math") || hasClass(element, "katex")) &&
      !hasClass(element, "display") &&
      !hasClass(element, "katex-display"))
  ) {
    const math = mathFromElement(element, false, context);
    return math ? [math] : [];
  }
  if (element.tagName === "a") {
    if (
      propertyString(element, "role") === "doc-backlink" ||
      hasProperty(element, "dataFootnoteBackref")
    )
      return [];
    const children = phrasingFromChildren(
      element.children,
      path,
      context,
      insideLink,
    );
    if (insideLink) {
      loss(context, {
        code: "NESTED_LINK_FLATTENED",
        fallback: "children",
        sourcePath: path,
        sourceTag: element.tagName,
      });
      return children;
    }
    const rawHref = propertyString(element, "href") ?? "";
    const url = safeUrl(rawHref, context.baseUri, "link");
    if (!url) {
      loss(context, {
        code: "UNSAFE_LINK_DROPPED",
        fallback: "children",
        sourcePath: path,
        sourceTag: element.tagName,
      });
      return children;
    }
    const targetAnchor = sameDocumentTargetAnchor(rawHref, context.baseUri);
    return [
      {
        children,
        ...(targetAnchor
          ? {
              targetAnchor: boundedNullable(
                context,
                targetAnchor,
              ),
            }
          : {}),
        title: boundedNullable(context, propertyString(element, "title")),
        type: "link",
        url: bounded(context, url),
      },
    ];
  }
  if (element.tagName === "abbr") {
    return [
      {
        children: phrasingFromChildren(
          element.children,
          path,
          context,
          insideLink,
        ),
        title: boundedNullable(context, propertyString(element, "title")),
        type: "abbreviation",
      },
    ];
  }
  const parentType =
    PHRASING_PARENT_TYPES[
      element.tagName as keyof typeof PHRASING_PARENT_TYPES
    ];
  if (parentType) {
    return [
      {
        children: phrasingFromChildren(
          element.children,
          path,
          context,
          insideLink,
        ),
        type: parentType,
      },
    ];
  }
  loss(context, {
    code: "UNSUPPORTED_ELEMENT",
    fallback: "children",
    sourcePath: path,
    sourceTag: element.tagName,
  });
  return phrasingFromChildren(element.children, path, context, insideLink);
}

function phrasingFromChildren(
  children: RootContent[],
  parentPath: string,
  context: Context,
  insideLink = false,
) {
  const result: ReaderV2PhrasingNode[] = [];
  children.forEach((child, index) => {
    if (isText(child)) {
      result.push(...phrasingFromText(child.value, context));
      return;
    }
    if (!isElement(child)) return;
    result.push(
      ...phrasingFromElement(
        child,
        elementPath(parentPath, child, index),
        context,
        insideLink,
      ),
    );
  });
  return compactPhrasing(result, false);
}

function imageFromElement(
  element: Element,
  path: string,
  context: Context,
): ReaderV2Image | undefined {
  const url = safeUrl(
    propertyString(element, "src") ?? "",
    context.baseUri,
    "image",
  );
  if (!url) {
    loss(context, {
      code: "UNSAFE_IMAGE_DROPPED",
      fallback: propertyString(element, "alt") ? "text" : "omitted",
      sourcePath: path,
      sourceTag: element.tagName,
    });
    return undefined;
  }
  const trackingRule = trackingPixelRule({
    alt: propertyString(element, "alt"),
    height: propertyString(element, "height"),
    producerEntryId: context.producerEntryId,
    producerKey: context.producerKey,
    title: propertyString(element, "title"),
    url,
    width: propertyString(element, "width"),
  });
  if (trackingRule) {
    context.rulesApplied.add(trackingRule);
    loss(context, {
      code: "TRACKING_PIXEL_DROPPED",
      fallback: "omitted",
      sourcePath: path,
      sourceTag: element.tagName,
    });
    return undefined;
  }
  return {
    alt: bounded(context, propertyString(element, "alt") ?? ""),
    title: boundedNullable(context, propertyString(element, "title")),
    type: "image",
    url: bounded(context, url),
  };
}

function languageFromCode(element: Element) {
  const token = classNames(element).find((value: string) =>
    /^(?:lang|language)-/u.test(value),
  );
  return token?.replace(/^(?:lang|language)-/u, "") || null;
}

function integerProperty(element: Element, name: string) {
  const parsed = Number(propertyString(element, name));
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, 1_000) : 1;
}

function tableCellFromElement(
  element: Element,
  path: string,
  context: Context,
): ReaderV2TableCell {
  const rawAlign = propertyString(element, "align")?.toLowerCase();
  const align =
    rawAlign === "left" || rawAlign === "center" || rawAlign === "right"
      ? rawAlign
      : null;
  const rawScope = propertyString(element, "scope")?.toLowerCase();
  const scope =
    element.tagName === "th" &&
    (rawScope === "col" ||
      rawScope === "colgroup" ||
      rawScope === "row" ||
      rawScope === "rowgroup")
      ? rawScope
      : null;
  return {
    align,
    children: flowFromChildren(element.children, path, context),
    colSpan: integerProperty(element, "colSpan"),
    header: element.tagName === "th",
    rowSpan: integerProperty(element, "rowSpan"),
    scope,
    type: "tableCell",
  };
}

function tableRowFromElement(
  element: Element,
  path: string,
  context: Context,
): ReaderV2TableRow {
  return {
    children: element.children.flatMap((child, index) =>
      isElement(child) && (child.tagName === "th" || child.tagName === "td")
        ? [
            tableCellFromElement(
              child,
              elementPath(path, child, index),
              context,
            ),
          ]
        : [],
    ),
    type: "tableRow",
  };
}

function tableSectionFromElement(
  element: Element,
  path: string,
  context: Context,
): ReaderV2TableSection {
  return {
    children: element.children.flatMap((child, index) =>
      isElement(child) && child.tagName === "tr"
        ? [tableRowFromElement(child, elementPath(path, child, index), context)]
        : [],
    ),
    type: "tableSection",
  };
}

function tableFromElement(
  element: Element,
  path: string,
  context: Context,
): ReaderV2FlowNode[] {
  const captionElement = element.children.find(
    (child): child is Element =>
      isElement(child) && child.tagName === "caption",
  );
  const headElement = element.children.find(
    (child): child is Element => isElement(child) && child.tagName === "thead",
  );
  const footElement = element.children.find(
    (child): child is Element => isElement(child) && child.tagName === "tfoot",
  );
  const bodyElements = element.children.filter(
    (child): child is Element => isElement(child) && child.tagName === "tbody",
  );
  const directRows = element.children.filter(
    (child): child is Element => isElement(child) && child.tagName === "tr",
  );
  const head = headElement
    ? tableSectionFromElement(headElement, `${path}/thead`, context)
    : null;
  const foot = footElement
    ? tableSectionFromElement(footElement, `${path}/tfoot`, context)
    : null;
  const bodies = bodyElements.map((body, index) =>
    tableSectionFromElement(body, `${path}/tbody[${index}]`, context),
  );
  if (directRows.length) {
    bodies.push({
      children: directRows.map((row, index) =>
        tableRowFromElement(row, `${path}/tr[${index}]`, context),
      ),
      type: "tableSection",
    });
  }
  if (head === null && foot === null && bodies.length === 0) {
    loss(context, {
      code: "EMPTY_TABLE_FLATTENED",
      fallback: "children",
      sourcePath: path,
      sourceTag: element.tagName,
    });
    return flowFromChildren(element.children, path, context);
  }
  return [
    {
      bodies,
      caption: captionElement
        ? compactPhrasing(
            phrasingFromChildren(
              captionElement.children,
              `${path}/caption`,
              context,
            ),
            true,
          )
        : [],
      foot,
      head,
      type: "table",
    },
  ];
}

function figureFromElement(
  element: Element,
  path: string,
  context: Context,
): ReaderV2FlowNode[] {
  const captionElement = element.children.find(
    (child): child is Element =>
      isElement(child) && child.tagName === "figcaption",
  );
  const creditElement = descendants(
    element,
    (child) => hasClass(child, "credit") || hasClass(child, "source"),
  )[0];
  const imageElements = descendants(
    element,
    (child) => child.tagName === "img",
  );
  const imageMappings = imageElements.map((image, index) => ({
    element: image,
    mapped: imageFromElement(image, `${path}/img[${index}]`, context),
  }));
  const media = imageMappings.flatMap(({ mapped }) =>
    mapped ? [mapped] : [],
  );
  if (!media.length) {
    loss(context, {
      code: "FIGURE_WITHOUT_SUPPORTED_MEDIA",
      fallback: "children",
      sourcePath: path,
      sourceTag: element.tagName,
    });
    return flowFromChildren(element.children, path, context);
  }
  const fallbackImageElements = new Set(
    imageMappings.flatMap(({ element: image, mapped }) => {
      if (mapped || !propertyString(image, "alt")?.trim()) return [];
      const source = safeUrl(
        propertyString(image, "src") ?? "",
        context.baseUri,
        "image",
      );
      return source ? [] : [image];
    }),
  );
  const representedElements = new Set<Element>([
    ...imageElements.filter((image) => !fallbackImageElements.has(image)),
    ...(captionElement ? [captionElement] : []),
    ...(creditElement ? [creditElement] : []),
  ]);
  const figureNode: ReaderV2Figure = {
    caption: captionElement
      ? compactPhrasing(
          phrasingFromChildren(
            creditElement
              ? childrenWithoutElement(captionElement.children, creditElement)
              : captionElement.children,
            `${path}/figcaption`,
            context,
          ),
          true,
        )
      : [],
    credit: creditElement
      ? compactPhrasing(
          phrasingFromChildren(
            creditElement.children,
            `${path}/credit`,
            context,
          ),
          true,
        )
      : [],
    media,
    type: "figure",
  };
  const isRepresented = (candidate: Element) =>
    representedElements.has(candidate) ||
    candidate.tagName === "figcaption" ||
    hasClass(candidate, "credit") ||
    hasClass(candidate, "source");
  const stripRepresentedContent = (
    candidate: ElementContent,
  ): ElementContent | undefined => {
    if (!isElement(candidate)) return candidate;
    if (isRepresented(candidate)) return undefined;
    const children = candidate.children.flatMap((child) => {
      const remaining = stripRepresentedContent(child);
      return remaining ? [remaining] : [];
    });
    if (candidate.children.length > 0 && children.length === 0)
      return undefined;
    return { ...candidate, children };
  };
  const children: ReaderV2FlowNode[] = [];
  let figureInserted = false;
  let flattenedContent = false;
  element.children.forEach((child, index) => {
    const represented =
      isElement(child) &&
      (isRepresented(child) ||
        descendants(child, (candidate) => isRepresented(candidate)).length > 0);
    if (represented && !figureInserted) {
      children.push(figureNode);
      figureInserted = true;
    }
    const remaining = stripRepresentedContent(child);
    if (!remaining) return;
    const flow = flowFromChildren(
      [remaining],
      `${path}/content[${index}]`,
      context,
    );
    if (flow.length) {
      flattenedContent = true;
      children.push(...flow);
    }
  });
  if (!figureInserted) children.push(figureNode);
  if (flattenedContent) {
    loss(context, {
      code: "FIGURE_CONTENT_FLATTENED",
      fallback: "children",
      sourcePath: path,
      sourceTag: element.tagName,
    });
  }
  return children;
}

function childrenWithoutElement(
  children: Element["children"],
  excluded: Element,
): Element["children"] {
  return children.flatMap((child): Element["children"] => {
    if (!isElement(child)) return [child];
    if (child === excluded) return [];
    return [
      { ...child, children: childrenWithoutElement(child.children, excluded) },
    ];
  });
}

function footnoteDefinitionsFromSection(
  element: Element,
  path: string,
  context: Context,
): ReaderV2FootnoteDefinition[] {
  const items = descendants(
    element,
    (candidate) =>
      candidate.tagName === "li" &&
      normalizedIdentifier(propertyString(candidate, "id")) !== undefined,
  );
  return items.flatMap((item, index) => {
    const identifier = normalizedIdentifier(propertyString(item, "id"));
    if (!identifier) return [];
    const children = flowFromChildren(
      item.children,
      `${path}/li[${index}]`,
      context,
    );
    return [
      {
        children,
        identifier: bounded(context, identifier),
        label: bounded(context, identifier),
        type: "footnoteDefinition",
      },
    ];
  });
}

function isFootnoteSection(element: Element) {
  const id = propertyString(element, "id")
    ?.replace(/^reader-/u, "")
    .toLowerCase();
  return (
    propertyString(element, "role") === "doc-endnotes" ||
    hasClass(element, "footnotes") ||
    hasClass(element, "footnote-list") ||
    id === "footnotes"
  );
}

function flowFromElement(
  element: Element,
  path: string,
  context: Context,
): MappedFlow {
  if (/^h[1-6]$/u.test(element.tagName)) {
    const anchor = sourceAnchor(element, context);
    return {
      ...(anchor ? { anchor } : {}),
      children: compactPhrasing(
        phrasingFromChildren(element.children, path, context),
        true,
      ),
      depth: Number(element.tagName.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6,
      type: "heading",
    };
  }
  if (isFootnoteSection(element))
    return footnoteDefinitionsFromSection(element, path, context);
  const delimitedDisplayMath =
    element.tagName === "p" || BLOCK_TAGS.has(element.tagName)
      ? displayMathFromDelimitedText(textContent(element), context)
      : undefined;
  if (delimitedDisplayMath) return delimitedDisplayMath;
  if (element.tagName === "p")
    return flowFromParagraphPhrasing(
      phrasingFromChildren(element.children, path, context),
      context,
    );
  if (element.tagName === "blockquote")
    return {
      children: flowFromChildren(element.children, path, context),
      type: "blockquote",
    };
  if (element.tagName === "section") {
    const anchor = sourceAnchor(element, context);
    return {
      ...(anchor ? { anchor } : {}),
      children: flowFromChildren(element.children, path, context),
      type: "section",
    };
  }
  if (element.tagName === "ul" || element.tagName === "ol") {
    const items = element.children.flatMap((child, index) =>
      isElement(child) && child.tagName === "li"
        ? [
            {
              children: flowFromChildren(
                child.children,
                elementPath(path, child, index),
                context,
              ),
              spread: false,
              type: "listItem" as const,
            },
          ]
        : [],
    );
    return {
      children: items,
      ordered: element.tagName === "ol",
      spread: false,
      start:
        element.tagName === "ol"
          ? Number(propertyString(element, "start")) || null
          : null,
      type: "list",
    };
  }
  if (element.tagName === "pre") {
    const code = element.children.find(
      (child): child is Element => isElement(child) && child.tagName === "code",
    );
    return {
      lang: boundedNullable(context, languageFromCode(code ?? element)),
      meta: null,
      type: "code",
      value: bounded(context, textContent(code ?? element).replace(/\n$/u, "")),
    };
  }
  if (element.tagName === "figure")
    return figureFromElement(element, path, context);
  if (element.tagName === "table")
    return tableFromElement(element, path, context);
  if (element.tagName === "hr") return { type: "thematicBreak" };
  if (
    element.tagName === "math" ||
    ((hasClass(element, "math") || hasClass(element, "katex-display")) &&
      (hasClass(element, "display") || hasClass(element, "katex-display")))
  ) {
    return mathFromElement(element, true, context);
  }
  if (BLOCK_TAGS.has(element.tagName)) {
    loss(context, {
      code: "UNSUPPORTED_ELEMENT",
      fallback: "children",
      sourcePath: path,
      sourceTag: element.tagName,
    });
    return flowFromChildren(element.children, path, context);
  }
  return undefined;
}

function flowFromChildren(
  children: RootContent[],
  parentPath: string,
  context: Context,
) {
  const result: ReaderV2FlowNode[] = [];
  let pending: ReaderV2PhrasingNode[] = [];
  const flush = () => {
    const children = compactPhrasing(pending, true);
    if (children.length)
      result.push(...flowFromParagraphPhrasing(children, context));
    pending = [];
  };
  children.forEach((child, index) => {
    if (isText(child)) {
      const delimitedDisplayMath = displayMathFromDelimitedText(
        child.value,
        context,
      );
      if (delimitedDisplayMath) {
        flush();
        result.push(delimitedDisplayMath);
        return;
      }
      pending.push(...phrasingFromText(child.value, context));
      return;
    }
    if (!isElement(child)) return;
    const path = elementPath(parentPath, child, index);
    const flow = flowFromElement(child, path, context);
    if (flow !== undefined) {
      flush();
      result.push(...(Array.isArray(flow) ? flow : [flow]));
      return;
    }
    pending.push(...phrasingFromElement(child, path, context, false));
  });
  flush();
  return result;
}

function auditTree(
  root: Root,
  maxDepth: number,
  maxNodes: number,
  context: Context,
) {
  let count = 0;
  const stack: { depth: number; node: Nodes; path: string }[] = root.children
    .map((node, index) => ({
      depth: 1,
      node,
      path: isElement(node)
        ? elementPath("root", node, index)
        : `root/text()[${index}]`,
    }))
    .reverse();
  while (stack.length) {
    const current = stack.pop()!;
    count += 1;
    if (count > maxNodes || current.depth > maxDepth)
      throw new Error("SOURCE_REPRESENTATION_BUDGET_EXCEEDED");
    if (!isElement(current.node)) continue;
    if (ACTIVE_TAGS.has(current.node.tagName)) {
      loss(context, {
        code: "ACTIVE_CONTENT_DROPPED",
        fallback: "omitted",
        sourcePath: current.path,
        sourceTag: current.node.tagName,
      });
      continue;
    }
    if (!SANITIZER_TAG_NAMES.has(current.node.tagName)) {
      loss(context, {
        code: "UNSUPPORTED_ELEMENT",
        fallback: "children",
        sourcePath: current.path,
        sourceTag: current.node.tagName,
      });
    }
    current.node.children.forEach((node, index) => {
      stack.push({
        depth: current.depth + 1,
        node,
        path: isElement(node)
          ? elementPath(current.path, node, index)
          : `${current.path}/text()[${index}]`,
      });
    });
  }
}

export function readerDocumentV2FromHtml(input: {
  baseUri?: string;
  html: string;
  maxDepth: number;
  maxNodes: number;
  maxOutputBytes: number;
  outputBudgetErrorCode: string;
  producerEntryId?: string;
  producerKey?: string;
  title?: string;
}) {
  if (!htmlStructureWithinBudget(input.html, input.maxDepth, input.maxNodes))
    throw new Error(input.outputBudgetErrorCode);
  const processor = unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeSanitize, sanitizerSchema);
  const parsed = processor.parse(input.html) as Root;
  const context: Context = {
    baseUri: input.baseUri,
    losses: [],
    outputBudget: new Utf8Budget(
      input.maxOutputBytes,
      input.outputBudgetErrorCode,
    ),
    producerEntryId: input.producerEntryId,
    producerKey: input.producerKey ?? "generic",
    rulesApplied: new Set(),
  };
  auditTree(parsed, input.maxDepth, input.maxNodes, context);
  const sanitized = processor.runSync(parsed) as Root;
  const children = flowFromChildren(sanitized.children, "root", context);
  const duplicateTitleLoss = removeLeadingDuplicateTitle(children, input.title);
  if (duplicateTitleLoss) loss(context, duplicateTitleLoss);
  const document: ReaderDocumentV2 = {
    children,
    losses: context.losses,
    type: "root",
  };
  const result = readerDocumentV2Schema.safeParse(document);
  if (!result.success) throw new Error("SOURCE_SAFE_REPRESENTATION_MISSING");
  return {
    document: result.data,
    rulesApplied: [
      `generic.${SANITIZER_SCHEMA_ID}`,
      "generic.hast-to-reader-v2",
      ...(duplicateTitleLoss ? ["generic.remove-duplicate-page-title"] : []),
      ...context.rulesApplied,
    ],
  };
}

export function readerDocumentV2FromText(
  value: string,
  input: { maxOutputBytes: number; outputBudgetErrorCode: string },
): ReaderDocumentV2 {
  const outputBudget = new Utf8Budget(
    input.maxOutputBytes,
    input.outputBudgetErrorCode,
  );
  return {
    children: value
      ? [
          {
            children: [
              { type: "text", value: outputBudget.consumeString(value) },
            ],
            type: "paragraph",
          },
        ]
      : [],
    losses: [],
    type: "root",
  };
}
