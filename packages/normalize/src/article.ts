import { Readability } from "@mozilla/readability";
import { DefuddleClass } from "defuddle/node";
import { parseHTML } from "linkedom";

import type {
  ArticleCaptureInput,
  ArticleNormalizationOutcome,
  ContentMaterialization,
  NormalizationProblem,
} from "./model";
import {
  inspectHtmlStructureBeforeParse,
  transformInputByteLimit,
} from "./output-budget";
import {
  applyArticleSiteAdapter,
  articleSiteAdapterRule,
} from "./article-site-adapters";
import { createRepresentations, sha256Identity } from "./representations";

const DEFUDDLE_MIN_TEXT_CHARACTERS = 600;
const DEFUDDLE_MIN_RELATIVE_TEXT_RATIO = 0.5;
const MIN_RICH_CATEGORY_RETENTION_RATIO = 0.6;
const MIN_SELECTED_ARTICLE_TEXT_CHARACTERS = 80;
const MAX_FALLBACK_TEXT_BYTES = 64 * 1024;
const MAX_MATH_SPAN_CHARACTERS = 16 * 1024;
const FALLBACK_DROP_SELECTOR =
  "script,style,noscript,template,iframe,object,embed,svg,canvas";

type DocumentLike = Document & {
  cloneNode(deep?: boolean): DocumentLike;
};

type ExtractionCandidate = {
  byline?: string;
  content: string;
  dir?: "ltr" | "rtl";
  lang?: string;
  publishedAt?: string;
  sourcePath:
    | "article.extractor.defuddle"
    | "article.extractor.readability"
    | "article.extractor.semantic-root"
    | "article.extractor.site-adapter";
  title: string;
};

type CharsetEvidence = {
  label: string;
  source: "bom" | "http" | "meta";
};

type HtmlDecodeResult = {
  html: string;
  problems: NormalizationProblem[];
  rulesApplied: string[];
};

function problem(
  code: string,
  severity: NormalizationProblem["severity"],
  recoverBy: NormalizationProblem["recoverBy"],
  scope: NormalizationProblem["scope"],
): NormalizationProblem {
  return { code, recoverBy, scope, severity };
}

function charsetParameter(value: string) {
  const marker = /(?:^|;)\s*charset\s*=/iu.exec(value);
  if (!marker) return undefined;
  const remainder = value.slice(marker.index + marker[0].length);
  const match = /^\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/u.exec(remainder);
  return (
    match?.slice(1).find((candidate) => candidate !== undefined) ?? ""
  ).trim();
}

function bomCharset(bytes: Uint8Array): CharsetEvidence | undefined {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  )
    return { label: "utf-8", source: "bom" };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return { label: "utf-16le", source: "bom" };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return { label: "utf-16be", source: "bom" };
  return undefined;
}

function htmlAttribute(tag: string, name: string) {
  const pattern = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
    "iu",
  );
  const match = pattern.exec(tag);
  return match
    ? (match.slice(1).find((candidate) => candidate !== undefined) ?? "").trim()
    : undefined;
}

function metaCharset(bytes: Uint8Array): CharsetEvidence | undefined {
  const prescan = Buffer.from(bytes.subarray(0, 1_024)).toString("latin1");
  for (const match of prescan.matchAll(/<meta\b[^>]*>/giu)) {
    const tag = match[0];
    const direct = htmlAttribute(tag, "charset");
    if (direct !== undefined) return { label: direct, source: "meta" };
    const httpEquiv = htmlAttribute(tag, "http-equiv")?.toLowerCase();
    const content = htmlAttribute(tag, "content");
    if (httpEquiv === "content-type" && content !== undefined) {
      const label = charsetParameter(content);
      if (label !== undefined) return { label, source: "meta" };
    }
  }
  return undefined;
}

function fatalDecode(bytes: Uint8Array, label: string) {
  const decoder = new TextDecoder(label, { fatal: true });
  return { encoding: decoder.encoding, html: decoder.decode(bytes) };
}

function fallbackDecode(
  bytes: Uint8Array,
  problems: NormalizationProblem[],
  prefixRules: string[] = [],
): HtmlDecodeResult {
  try {
    const decoded = fatalDecode(bytes, "utf-8");
    return {
      html: decoded.html,
      problems,
      rulesApplied: [...prefixRules, "article.decode.fallback.utf-8"],
    };
  } catch {
    problems.push(
      problem(
        "SOURCE_ARTICLE_CHARSET_GUESSED",
        "warning",
        "generic-fallback",
        "capture",
      ),
    );
    return {
      html: new TextDecoder("windows-1252").decode(bytes),
      problems,
      rulesApplied: [...prefixRules, "article.decode.fallback.windows-1252"],
    };
  }
}

function decodeHtml(bytes: Uint8Array, mediaType: string): HtmlDecodeResult {
  const httpCharset = charsetParameter(mediaType);
  const evidence =
    bomCharset(bytes) ??
    (httpCharset !== undefined
      ? { label: httpCharset, source: "http" as const }
      : undefined) ??
    metaCharset(bytes);
  if (!evidence) {
    try {
      const decoded = fatalDecode(bytes, "utf-8");
      return {
        html: decoded.html,
        problems: [],
        rulesApplied: ["article.decode.default.utf-8"],
      };
    } catch {
      return fallbackDecode(
        bytes,
        [],
        ["article.decode.default.invalid-utf-8"],
      );
    }
  }

  let canonicalEncoding: string;
  try {
    canonicalEncoding = new TextDecoder(evidence.label, { fatal: true })
      .encoding;
  } catch {
    return fallbackDecode(
      bytes,
      [
        problem(
          "SOURCE_ARTICLE_CHARSET_UNSUPPORTED",
          "warning",
          "generic-fallback",
          "capture",
        ),
      ],
      [`article.decode.${evidence.source}.unsupported`],
    );
  }
  try {
    const decoded = fatalDecode(bytes, canonicalEncoding);
    return {
      html: decoded.html,
      problems: [],
      rulesApplied: [`article.decode.${evidence.source}.${canonicalEncoding}`],
    };
  } catch {
    return {
      html: new TextDecoder(canonicalEncoding).decode(bytes),
      problems: [
        problem(
          "SOURCE_ARTICLE_DECODING_REPLACED",
          "warning",
          "generic-fallback",
          "capture",
        ),
      ],
      rulesApplied: [
        `article.decode.${evidence.source}.${canonicalEncoding}.replacement`,
      ],
    };
  }
}

function serializedBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncateUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    characters.push(character);
    bytes += characterBytes;
  }
  return characters.join("").trimEnd();
}

function normalizedFallbackText(value: string | null | undefined) {
  return (
    value
      ?.replace(/[\u0000-\u001f\u007f]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim() ?? ""
  );
}

function fallbackIdentity(value: string) {
  return value.normalize("NFKC").toLowerCase();
}

function plainTextFallbackFromDocument(
  sourceDocument: DocumentLike,
  maxOutputBytes: number,
) {
  try {
    const document = sourceDocument.cloneNode(true) as unknown as DocumentLike;
    for (const element of document.querySelectorAll(FALLBACK_DROP_SELECTOR))
      element.remove();
    const title = normalizedFallbackText(document.title);
    const body = normalizedFallbackText(
      document.body?.innerText ||
        document.body?.textContent ||
        document.documentElement?.textContent,
    );
    const text =
      title &&
      body &&
      !fallbackIdentity(body).startsWith(fallbackIdentity(title))
        ? `${title} ${body}`
        : body || title;
    const byteLimit = Math.min(
      MAX_FALLBACK_TEXT_BYTES,
      Math.max(1, Math.floor(maxOutputBytes / 4)),
    );
    return truncateUtf8(text, byteLimit) || undefined;
  } catch {
    return undefined;
  }
}

function articleFailure(
  problems: NormalizationProblem[],
  maxOutputBytes: number,
  fallbackText?: string,
): ArticleNormalizationOutcome {
  const withoutFallback = { ok: false, problems } as const;
  if (!fallbackText) return withoutFallback;
  let candidate = fallbackText;
  while (candidate) {
    const outcome = { fallbackText: candidate, ok: false, problems } as const;
    if (serializedBytes(outcome) <= maxOutputBytes) return outcome;
    candidate = truncateUtf8(
      candidate,
      Math.floor(Buffer.byteLength(candidate, "utf8") / 2),
    );
  }
  return withoutFallback;
}

function isByteArray(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

function safeSourceUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizedOptionalString(
  value: string | null | undefined,
  maxLength: number,
) {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function normalizedPublishedAt(value: string | null | undefined) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}

function normalizedDirection(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "ltr" || normalized === "rtl" ? normalized : undefined;
}

function documentFromHtml(html: string, source: string) {
  const parsed = parseHTML(html).document as unknown as DocumentLike;
  for (const existing of parsed.querySelectorAll("base")) existing.remove();
  const base = parsed.createElement("base");
  base.setAttribute("href", source);
  parsed.head.prepend(base);
  return parsed;
}

function offlineExtractorDocument(
  sourceDocument: DocumentLike,
  source: string,
) {
  const document = sourceDocument.cloneNode(true) as unknown as DocumentLike;
  Object.defineProperties(document, {
    defaultView: { configurable: true, value: { location: new URL(source) } },
    ownerWindow: { configurable: true, value: null },
    window: { configurable: true, value: null },
  });
  return document;
}

function preferredArticleTitle(document: DocumentLike) {
  for (const selector of ["article h1", "main h1", "[role='main'] h1", "h1"]) {
    const title = normalizedOptionalString(
      document.querySelector(selector)?.textContent,
      500,
    );
    if (title) return title;
  }
  return undefined;
}

function preferredExtractedTitle(html: string) {
  const document = parseHTML(`<html><body>${html}</body></html>`)
    .document as unknown as DocumentLike;
  return preferredArticleTitle(document);
}

function metaContent(document: DocumentLike, selectors: readonly string[]) {
  for (const selector of selectors) {
    const value = normalizedOptionalString(
      document.querySelector(selector)?.getAttribute("content"),
      500,
    );
    if (value) return value;
  }
  return undefined;
}

function assertDocumentBudget(
  document: DocumentLike,
  maxDepth: number,
  maxNodes: number,
) {
  const root = document.documentElement;
  if (!root) throw new Error("SOURCE_ARTICLE_INVALID");
  let nodes = 0;
  const stack: { depth: number; element: Element }[] = [
    { depth: 1, element: root },
  ];
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > maxNodes || current.depth > maxDepth)
      throw new Error("SOURCE_REPRESENTATION_BUDGET_EXCEEDED");
    for (const child of Array.from(current.element.children))
      stack.push({ depth: current.depth + 1, element: child });
  }
}

function contentStats(html: string) {
  const document = parseHTML(`<html><body>${html}</body></html>`).document;
  return contentStatsFromDocument(document as unknown as DocumentLike);
}

function countBoundedDelimitedMath(
  value: string,
  opening: string,
  closing: string,
) {
  // `$$` uses the same token to open and close a unit. Keeping a single
  // cursor for the other delimiters is important: searching a 16 KiB window
  // again for every opener makes a page with many unmatched tokens quadratic.
  let count = 0;
  let openerIndex = -1;
  let cursor = 0;
  while (cursor < value.length) {
    const hasOpening = value.startsWith(opening, cursor);
    const hasClosing = value.startsWith(closing, cursor);
    const isOpening =
      hasOpening && (cursor === 0 || value[cursor - 1] !== "\\");
    const isClosing =
      hasClosing && (cursor === 0 || value[cursor - 1] !== "\\");

    if ((hasOpening && !isOpening) || (hasClosing && !isClosing)) {
      cursor += Math.max(
        hasOpening ? opening.length : 0,
        hasClosing ? closing.length : 0,
        1,
      );
      continue;
    }

    if (opening === closing && isOpening) {
      if (openerIndex < 0) {
        openerIndex = cursor;
      } else {
        const maxClosingIndex =
          openerIndex + opening.length + MAX_MATH_SPAN_CHARACTERS;
        if (cursor <= maxClosingIndex) count += 1;
        openerIndex = -1;
      }
      cursor += opening.length;
      continue;
    }

    if (openerIndex >= 0) {
      const maxClosingIndex =
        openerIndex + opening.length + MAX_MATH_SPAN_CHARACTERS;
      if (cursor > maxClosingIndex) openerIndex = -1;
    }
    if (isOpening) {
      if (openerIndex < 0) openerIndex = cursor;
      cursor += opening.length;
      continue;
    }
    if (isClosing) {
      if (openerIndex >= 0) count += 1;
      openerIndex = -1;
      cursor += closing.length;
      continue;
    }
    cursor += 1;
  }
  return count;
}

function countBoundedDisplayMathEnvironments(value: string) {
  type PendingEnvironment = { limit: number };
  type PendingEnvironmentQueue = {
    entries: PendingEnvironment[];
    head: number;
  };

  let count = 0;
  const pending = new Map<string, PendingEnvironmentQueue>();
  const tokens =
    /\\(begin|end)\{(equation|align|gather|multline|flalign|alignat)(\*)?\}/gu;
  for (const match of value.matchAll(tokens)) {
    const index = match.index ?? -1;
    if (index < 0 || (index > 0 && value[index - 1] === "\\")) continue;
    const environment = `${match[2]}${match[3] ?? ""}`;
    const queue =
      pending.get(environment) ??
      ({ entries: [], head: 0 } satisfies PendingEnvironmentQueue);
    const { entries } = queue;
    while (queue.head < entries.length && entries[queue.head]!.limit < index) {
      queue.head += 1;
    }

    if (match[1] === "begin") {
      if (queue.head === entries.length) {
        queue.entries = [];
        queue.head = 0;
      }
      queue.entries.push({
        limit: index + match[0].length + MAX_MATH_SPAN_CHARACTERS,
      });
      pending.set(environment, queue);
      continue;
    }

    count += entries.length - queue.head;
    pending.delete(environment);
  }
  return count;
}

function countBoundedMath(value: string) {
  return (
    countBoundedDelimitedMath(value, "\\(", "\\)") +
    countBoundedDelimitedMath(value, "\\[", "\\]") +
    countBoundedDelimitedMath(value, "$$", "$$") +
    countBoundedDisplayMathEnvironments(value)
  );
}

function contentStatsFromDocument(sourceDocument: DocumentLike) {
  const document = sourceDocument.cloneNode(true) as unknown as DocumentLike;
  document
    .querySelectorAll(FALLBACK_DROP_SELECTOR)
    .forEach((element) => element.remove());
  const text =
    document.body?.textContent ?? document.documentElement?.textContent ?? "";
  const mathUnits = countBoundedMath(text);
  const standaloneImages = Array.from(document.querySelectorAll("img")).filter(
    (image) => image.closest("picture") === null,
  ).length;
  const richUnits = [
    document.querySelectorAll("pre").length,
    document.querySelectorAll("figure").length,
    document.querySelectorAll("picture").length,
    standaloneImages,
    document.querySelectorAll("table").length,
    Math.max(
      document.querySelectorAll("math, .math, .katex").length,
      mathUnits,
    ),
    document.querySelectorAll(
      "[role='doc-noteref'], a.footnote-ref, sup[id^='fnref'] > a[href^='#fn']",
    ).length,
    document.querySelectorAll("[role='doc-endnotes'], .footnotes, #footnotes")
      .length,
    document.querySelectorAll("a[href]").length,
    document.querySelectorAll(
      "cite, [role='doc-bibliography'], [role='doc-biblioentry'], .bibliography, .references, #bibliography, #references",
    ).length,
    document.querySelectorAll("h1, h2, h3, h4, h5, h6").length,
    document.querySelectorAll("ul, ol, dl").length,
    document.querySelectorAll("details").length,
  ];
  return {
    richUnits,
    textCharacters: text.replace(/\s+/gu, " ").trim().length,
  };
}

function candidateRetainsSourceRichStructure(
  candidate: ExtractionCandidate,
  sourceRichUnits: readonly number[],
) {
  const candidateRichUnits = contentStats(candidate.content).richUnits;
  return sourceRichUnits.every(
    (sourceCount, index) =>
      sourceCount === 0 ||
      (candidateRichUnits[index] ?? 0) >=
        Math.max(1, Math.ceil(sourceCount * MIN_RICH_CATEGORY_RETENTION_RATIO)),
  );
}

function defuddlePassesQualityGate(input: {
  candidate: ExtractionCandidate;
  readability?: ExtractionCandidate;
  sourceRichUnits: readonly number[];
}) {
  const stats = contentStats(input.candidate.content);
  const readabilityStats = input.readability
    ? contentStats(input.readability.content)
    : undefined;
  const retainsText =
    readabilityStats === undefined ||
    stats.textCharacters >=
      readabilityStats.textCharacters * DEFUDDLE_MIN_RELATIVE_TEXT_RATIO;
  return (
    stats.textCharacters >= DEFUDDLE_MIN_TEXT_CHARACTERS &&
    candidateRetainsSourceRichStructure(
      input.candidate,
      input.sourceRichUnits,
    ) &&
    retainsText
  );
}

function readabilityPassesQualityGate(
  candidate: ExtractionCandidate,
  sourceRichUnits: readonly number[],
) {
  return (
    contentStats(candidate.content).textCharacters >=
      MIN_SELECTED_ARTICLE_TEXT_CHARACTERS &&
    candidateRetainsSourceRichStructure(candidate, sourceRichUnits)
  );
}

function defuddleCandidate(
  document: DocumentLike,
  source: string,
): ExtractionCandidate | undefined {
  const offlineFetch: typeof globalThis.fetch = async () => {
    throw new Error("SOURCE_ARTICLE_EXTRACTOR_NETWORK_FORBIDDEN");
  };
  const result = new DefuddleClass(document, {
    debug: false,
    fetch: offlineFetch,
    includeReplies: false,
    markdown: false,
    standardize: false,
    url: source,
    useAsync: false,
  }).parse();
  if (!result.content?.trim()) return undefined;
  return {
    byline: normalizedOptionalString(result.author, 500),
    content: result.content,
    lang: normalizedOptionalString(result.language, 64),
    publishedAt: normalizedPublishedAt(result.published),
    sourcePath: "article.extractor.defuddle",
    title: normalizedOptionalString(result.title, 500) ?? "",
  };
}

function readabilityCandidate(
  document: DocumentLike,
  maxNodes: number,
): ExtractionCandidate | undefined {
  const result = new Readability(document, {
    charThreshold: 120,
    keepClasses: true,
    maxElemsToParse: maxNodes,
  }).parse();
  if (!result?.content?.trim()) return undefined;
  return {
    byline: normalizedOptionalString(result.byline, 500),
    content: result.content,
    dir: normalizedDirection(result.dir),
    lang: normalizedOptionalString(result.lang, 64),
    publishedAt: normalizedPublishedAt(result.publishedTime),
    sourcePath: "article.extractor.readability",
    title: normalizedOptionalString(result.title, 500) ?? "",
  };
}

function uniqueSemanticArticleRoot(document: DocumentLike) {
  const articleBodies = Array.from(
    document.querySelectorAll("[itemprop~='articleBody']"),
  );
  if (articleBodies.length === 1) return articleBodies[0];
  if (articleBodies.length > 1) return undefined;

  const articles = Array.from(document.querySelectorAll("article"));
  if (articles.length === 1) return articles[0];

  const mainLandmarks = Array.from(
    document.querySelectorAll("main, [role='main']"),
  );
  if (mainLandmarks.length !== 1) return undefined;
  const main = mainLandmarks[0];
  if (articles.length === 0) return main;

  const containedArticles = articles.filter((candidate) =>
    main.contains(candidate),
  );
  return containedArticles.length === 1 ? containedArticles[0] : undefined;
}

function boundedExtractorDocument(
  sourceDocument: DocumentLike,
  root: Element,
  source: string,
) {
  const document = sourceDocument.cloneNode(true) as unknown as DocumentLike;
  if (!document.body) throw new Error("SOURCE_ARTICLE_BOUNDARY_INVALID");
  document.body.replaceChildren(root.cloneNode(true));
  return offlineExtractorDocument(document, source);
}

function semanticRootCandidate(root: Element): ExtractionCandidate | undefined {
  const content = root.outerHTML.trim();
  if (!content) return undefined;
  return {
    content,
    sourcePath: "article.extractor.semantic-root",
    title: preferredExtractedTitle(content) ?? "",
  };
}

function siteAdapterCandidate(
  content: string,
  metadata: {
    byline?: string;
    dir?: "ltr" | "rtl";
    lang?: string;
    publishedAt?: string;
    title?: string;
  },
): ExtractionCandidate | undefined {
  const normalizedContent = content.trim();
  if (!normalizedContent) return undefined;
  return {
    ...metadata,
    content: normalizedContent,
    sourcePath: "article.extractor.site-adapter",
    title: preferredExtractedTitle(normalizedContent) ?? metadata.title ?? "",
  };
}

function candidateRules(sourcePath: ExtractionCandidate["sourcePath"]) {
  if (sourcePath === "article.extractor.defuddle") {
    return [
      "article.dom.linkedom@0.18.13",
      "article.extractor.semantic-boundary.v1",
      "article.extractor.structure-retention.v2",
      "article.extractor.defuddle@0.19.3",
      "article.extractor.defuddle.options.v1",
    ];
  }
  if (sourcePath === "article.extractor.readability") {
    return [
      "article.dom.linkedom@0.18.13",
      "article.extractor.semantic-boundary.v1",
      "article.extractor.structure-retention.v2",
      "article.extractor.readability@0.6.0",
      "article.extractor.readability.options.v1",
    ];
  }
  if (sourcePath === "article.extractor.site-adapter") {
    return [
      "article.dom.linkedom@0.18.13",
      "article.extractor.site-adapter.v1",
    ];
  }
  return [
    "article.dom.linkedom@0.18.13",
    "article.extractor.semantic-boundary.v1",
    "article.extractor.structure-retention.v2",
    "article.extractor.semantic-root.v1",
  ];
}

export function normalizeArticleCapture(
  input: ArticleCaptureInput,
): ArticleNormalizationOutcome {
  const budgetValues = [
    input.budget.maxBytes,
    input.budget.maxDepth,
    input.budget.maxNodes,
    input.budget.maxOutputBytes,
  ];
  if (
    !budgetValues.every((value) => Number.isSafeInteger(value) && value > 0)
  ) {
    return {
      ok: false,
      problems: [problem("SOURCE_BUDGET_INVALID", "fatal", "none", "capture")],
    };
  }
  if (input.budget.maxOutputBytes < 512) {
    return {
      ok: false,
      problems: [
        problem("SOURCE_OUTPUT_BUDGET_INVALID", "fatal", "none", "capture"),
      ],
    };
  }
  if (
    !isByteArray(input.capture.bytes) ||
    input.capture.bytes.byteLength > input.budget.maxBytes
  ) {
    return {
      ok: false,
      problems: [
        problem("SOURCE_ARTICLE_TOO_LARGE", "fatal", "none", "capture"),
      ],
    };
  }
  if (
    input.capture.bytes.byteLength >
    transformInputByteLimit(input.budget.maxOutputBytes)
  ) {
    return {
      ok: false,
      problems: [
        problem(
          "SOURCE_ARTICLE_OUTPUT_BUDGET_EXCEEDED",
          "fatal",
          "none",
          "capture",
        ),
      ],
    };
  }
  if (sha256Identity(input.capture.bytes) !== input.capture.contentIdentity) {
    return {
      ok: false,
      problems: [
        problem("SOURCE_CAPTURE_IDENTITY_MISMATCH", "fatal", "none", "capture"),
      ],
    };
  }
  const source = safeSourceUrl(input.capture.baseLocator);
  if (!source)
    return {
      ok: false,
      problems: [
        problem("SOURCE_ARTICLE_URL_INVALID", "fatal", "none", "capture"),
      ],
    };
  const mediaType = input.capture.mediaType
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
    return {
      ok: false,
      problems: [
        problem(
          "SOURCE_ARTICLE_MEDIA_TYPE_UNSUPPORTED",
          "fatal",
          "none",
          "capture",
        ),
      ],
    };
  }

  let failureFallbackText: string | undefined;
  let failureWarnings: NormalizationProblem[] = [];
  try {
    const decoding = decodeHtml(input.capture.bytes, input.capture.mediaType);
    const html = decoding.html;
    const problems: NormalizationProblem[] = [...decoding.problems];
    failureWarnings = problems;
    const preparse = inspectHtmlStructureBeforeParse(
      html,
      input.budget.maxDepth,
      input.budget.maxNodes,
      Math.min(
        MAX_FALLBACK_TEXT_BYTES,
        Math.max(1, Math.floor(input.budget.maxOutputBytes / 4)),
      ),
    );
    failureFallbackText = preparse.fallbackText || undefined;
    if (!preparse.withinBudget)
      throw new Error("SOURCE_REPRESENTATION_BUDGET_EXCEEDED");
    const document = documentFromHtml(html, source);
    assertDocumentBudget(
      document,
      input.budget.maxDepth,
      input.budget.maxNodes,
    );
    failureFallbackText =
      plainTextFallbackFromDocument(document, input.budget.maxOutputBytes) ??
      failureFallbackText;
    const preferredTitle = preferredArticleTitle(document);
    const rawByline = metaContent(document, [
      "meta[name='author']",
      "meta[property='article:author']",
      "meta[name='byl']",
    ]);
    const rawPublishedAt = normalizedPublishedAt(
      metaContent(document, [
        "meta[property='article:published_time']",
        "meta[name='date']",
        "meta[itemprop='datePublished']",
      ]) ?? document.querySelector("time[datetime]")?.getAttribute("datetime"),
    );
    let defuddle: ExtractionCandidate | undefined;
    let readability: ExtractionCandidate | undefined;
    const siteAdapterApplication = applyArticleSiteAdapter({
      document,
      source: new URL(source),
    });
    const semanticRoot = uniqueSemanticArticleRoot(document);
    const semanticRootExtraction = semanticRoot
      ? semanticRootCandidate(semanticRoot)
      : undefined;
    if (semanticRoot) {
      try {
        defuddle = defuddleCandidate(
          boundedExtractorDocument(document, semanticRoot, source),
          source,
        );
      } catch {
        problems.push(
          problem(
            "SOURCE_ARTICLE_DEFUDDLE_FAILED",
            "warning",
            "generic-fallback",
            "candidate",
          ),
        );
      }
      try {
        readability = readabilityCandidate(
          boundedExtractorDocument(document, semanticRoot, source),
          input.budget.maxNodes,
        );
      } catch {
        problems.push(
          problem(
            "SOURCE_ARTICLE_READABILITY_FAILED",
            "warning",
            "generic-fallback",
            "candidate",
          ),
        );
      }
    }

    const rawLang = normalizedOptionalString(
      document.documentElement.getAttribute("lang"),
      64,
    );
    const rawDir = normalizedDirection(
      document.documentElement.getAttribute("dir"),
    );
    const siteAdapterExtraction = siteAdapterApplication
      ? siteAdapterCandidate(siteAdapterApplication.content, {
          byline: defuddle?.byline ?? readability?.byline ?? rawByline,
          dir: readability?.dir ?? rawDir,
          lang: defuddle?.lang ?? readability?.lang ?? rawLang,
          publishedAt:
            defuddle?.publishedAt ?? readability?.publishedAt ?? rawPublishedAt,
          title:
            defuddle?.title ??
            readability?.title ??
            preferredTitle ??
            normalizedOptionalString(document.title, 500),
        })
      : undefined;

    const sourceRichUnits = siteAdapterExtraction
      ? contentStats(siteAdapterExtraction.content).richUnits
      : semanticRootExtraction
        ? contentStats(semanticRootExtraction.content).richUnits
        : contentStatsFromDocument(document).richUnits;
    const defuddleIsHealthy =
      defuddle !== undefined &&
      defuddlePassesQualityGate({
        candidate: defuddle,
        readability,
        sourceRichUnits,
      });
    if (defuddle && !defuddleIsHealthy) {
      problems.push(
        problem(
          "SOURCE_ARTICLE_DEFUDDLE_QUALITY_LOW",
          "warning",
          "generic-fallback",
          "candidate",
        ),
      );
    }
    const readabilityIsHealthy =
      readability !== undefined &&
      readabilityPassesQualityGate(readability, sourceRichUnits);
    if (readability && !readabilityIsHealthy) {
      problems.push(
        problem(
          "SOURCE_ARTICLE_READABILITY_QUALITY_LOW",
          "warning",
          "generic-fallback",
          "candidate",
        ),
      );
    }
    const selected = siteAdapterExtraction
      ? siteAdapterExtraction
      : defuddleIsHealthy
        ? defuddle!
        : readabilityIsHealthy
          ? readability!
          : semanticRootExtraction;
    if (!selected) {
      return articleFailure(
        [
          ...problems,
          problem(
            "SOURCE_ARTICLE_CONTENT_LOW_QUALITY",
            "fatal",
            failureFallbackText ? "plain-text-fallback" : "none",
            "candidate",
          ),
        ],
        input.budget.maxOutputBytes,
        failureFallbackText,
      );
    }
    if (
      contentStats(selected.content).textCharacters <
      MIN_SELECTED_ARTICLE_TEXT_CHARACTERS
    ) {
      return articleFailure(
        [
          ...problems,
          problem(
            "SOURCE_ARTICLE_CONTENT_LOW_QUALITY",
            "fatal",
            "plain-text-fallback",
            "candidate",
          ),
        ],
        input.budget.maxOutputBytes,
        failureFallbackText,
      );
    }
    const title =
      preferredExtractedTitle(selected.content) ||
      preferredTitle ||
      selected.title ||
      normalizedOptionalString(document.title, 500) ||
      new URL(source).hostname;
    const representationResult = createRepresentations({
      baseUri: source,
      content: selected.content,
      maxDepth: input.budget.maxDepth,
      maxNodes: input.budget.maxNodes,
      maxOutputBytes: input.budget.maxOutputBytes,
      mediaType: "text/html",
      outputBudgetErrorCode: "SOURCE_ARTICLE_OUTPUT_BUDGET_EXCEEDED",
      producerKey: "generic",
      title,
    });
    representationResult.rulesApplied.unshift(
      "article.normalization@3",
      ...decoding.rulesApplied,
      ...candidateRules(selected.sourcePath),
      ...(selected.sourcePath === "article.extractor.site-adapter" &&
      siteAdapterApplication
        ? [articleSiteAdapterRule(siteAdapterApplication)]
        : []),
    );

    const producer = { evidence: [], key: "generic", version: "1" };
    const sourceIdentity = sha256Identity(`article\0${source}`);
    const sourceFingerprint = input.capture.contentIdentity;
    const quality: ContentMaterialization["quality"] = {
      completeness: "declared_full",
      conformance: decoding.problems.length > 0 ? "recoverable" : "conformant",
      identityConfidence: "strong",
      safety: "safe",
      warnings: problems,
    };
    const provenance: ContentMaterialization["provenance"] = {
      captureIdentity: input.capture.contentIdentity,
      producer,
      rulesApplied: representationResult.rulesApplied,
      selectedCandidate: {
        mediaType: "text/html",
        role: "full",
        sourcePath: selected.sourcePath,
      },
    };
    const materializationBasis = JSON.stringify({
      normalizationVersion: "3",
      producer,
      quality,
      representations: representationResult.representations.map(
        ({ contentIdentity, purpose, schema }) => ({
          contentIdentity,
          purpose,
          schema,
        }),
      ),
      rulesApplied: representationResult.rulesApplied,
      selectedCandidate: provenance.selectedCandidate,
      sourceFingerprint,
      sourceIdentity,
    });
    const materialization: ContentMaterialization = {
      identity: sha256Identity(materializationBasis),
      provenance,
      quality,
      representations: representationResult.representations,
      sourceIdentity,
    };
    const article = {
      ...((selected.byline ?? rawByline)
        ? { byline: selected.byline ?? rawByline }
        : {}),
      ...((selected.dir ?? rawDir) ? { dir: selected.dir ?? rawDir } : {}),
      ...((selected.lang ?? rawLang) ? { lang: selected.lang ?? rawLang } : {}),
      materialization,
      ...((selected.publishedAt ?? rawPublishedAt)
        ? { publishedAt: selected.publishedAt ?? rawPublishedAt }
        : {}),
      source,
      sourceFingerprint,
      sourceIdentity,
      title,
    };
    const outcome = { article, ok: true, problems } as const;
    return serializedBytes(outcome) <= input.budget.maxOutputBytes
      ? outcome
      : articleFailure(
          [
            problem(
              "SOURCE_ARTICLE_OUTPUT_BUDGET_EXCEEDED",
              "fatal",
              failureFallbackText ? "plain-text-fallback" : "none",
              "representation",
            ),
          ],
          input.budget.maxOutputBytes,
          failureFallbackText,
        );
  } catch (error) {
    const code =
      error instanceof Error && /^SOURCE_[A-Z0-9_]+$/u.test(error.message)
        ? error.message
        : "SOURCE_ARTICLE_INVALID";
    return articleFailure(
      [
        ...failureWarnings,
        problem(
          code,
          "fatal",
          failureFallbackText ? "plain-text-fallback" : "none",
          "capture",
        ),
      ],
      input.budget.maxOutputBytes,
      failureFallbackText,
    );
  }
}
