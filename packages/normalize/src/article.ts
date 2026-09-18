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
import { pruneArticleChrome } from "./article-prune";
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

type StructuredDataMetadata = { author?: string; datePublished?: string };

/** JSON-LD is the one place most CMSs (WordPress, Ghost, Substack, Medium) state the date and author reliably. */
function structuredDataMetadata(document: DocumentLike): StructuredDataMetadata {
  const ARTICLE_TYPES = /Article|BlogPosting|NewsArticle|TechArticle|ScholarlyArticle|Report|WebPage/;
  const found: StructuredDataMetadata = {};
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 4) return;
    if (Array.isArray(value)) { value.forEach((item) => visit(item, depth + 1)); return; }
    const record = value as Record<string, unknown>;
    if (Array.isArray(record["@graph"])) visit(record["@graph"], depth + 1);
    const type = Array.isArray(record["@type"]) ? record["@type"].join(" ") : String(record["@type"] ?? "");
    if (!ARTICLE_TYPES.test(type)) return;
    if (!found.datePublished && typeof record.datePublished === "string") found.datePublished = record.datePublished;
    if (!found.author) found.author = authorName(record.author);
  };
  for (const script of document.querySelectorAll("script[type='application/ld+json']")) {
    const text = script.textContent?.trim();
    if (!text || text.length > 200_000) continue;
    try { visit(JSON.parse(text), 0); } catch { /* malformed JSON-LD is common and carries no article data */ }
    if (found.datePublished && found.author) break;
  }
  return found;
}

function authorName(value: unknown): string | undefined {
  if (typeof value === "string") return normalizedOptionalString(value, 200);
  if (Array.isArray(value)) {
    const names = value.map(authorName).filter((name): name is string => !!name);
    return names.length ? names.slice(0, 5).join(", ") : undefined;
  }
  if (value && typeof value === "object") return normalizedOptionalString((value as { name?: unknown }).name as string | undefined, 200);
  return undefined;
}

/** A permalink date with a day is trusted over prose (sidebars carry other dates); a month-only permalink takes the day from prose in that month. */
function publishedAtFromUrlOrText(source: string, text: string) {
  const fromUrl = publishedAtFromUrl(source);
  const fromText = publishedAtFromText(text);
  if (!fromUrl) return fromText;
  if (!fromText) return fromUrl;
  const urlHasDay = /\/(?:19|20)\d{2}[/-](?:0[1-9]|1[0-2])[/-](?:0[1-9]|[12]\d|3[01])(?:\/|$|-)/u.test(new URL(source).pathname) || /\/(?:19|20)\d{2}\/[A-Z][a-z]{2}\/\d{1,2}\//u.test(new URL(source).pathname);
  if (urlHasDay) return fromUrl;
  return fromText.slice(0, 7) === fromUrl.slice(0, 7) ? fromText : fromUrl;
}

/** Blog permalinks often carry the only machine-readable date: /2015/05/21/slug or /2023/04/. */
function publishedAtFromUrl(source: string): string | undefined {
  const path = new URL(source).pathname;
  const numeric = /\/((?:19|20)\d{2})[/-](0[1-9]|1[0-2])(?:[/-](0[1-9]|[12]\d|3[01]))?(?:\/|$|-)/u.exec(path);
  if (numeric) {
    const [, year, month, day] = numeric;
    return normalizedPublishedAt(`${year}-${month}-${day ?? "01"}T00:00:00Z`);
  }
  // simonwillison.net style: /2024/Dec/31/slug
  const named = /\/((?:19|20)\d{2})\/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\/(\d{1,2})\//u.exec(path);
  if (!named) return undefined;
  const [, year, monthName, day] = named;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(monthName!) + 1;
  return normalizedPublishedAt(`${year}-${String(month).padStart(2, "0")}-${day!.padStart(2, "0")}T00:00:00Z`);
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** The first stretch of visible text after the chrome is dropped: where a page states its date and author. */
function leadingText(document: DocumentLike) {
  const clone = document.cloneNode(true) as unknown as DocumentLike;
  clone.querySelectorAll("script, style, noscript, nav, footer, header nav, [role='navigation'], [class*='comment']").forEach((element) => element.remove());
  const text = (clone.body?.textContent ?? "").replace(/[ \t]+/gu, " ").replace(/\n\s*\n+/gu, "\n").trim();
  return text.slice(0, 4000);
}

function monthNumber(name: string) {
  const index = MONTHS.findIndex((month) => month.startsWith(name.toLowerCase().slice(0, 3)));
  return index >= 0 ? index + 1 : undefined;
}

/** Dates written for readers near the top of the page: 2019年9月5日, January 18, 2022, 18 January 2022, 2022-01-18. */
function publishedAtFromText(text: string): string | undefined {
  const cjk = /((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/u.exec(text);
  if (cjk) return normalizedPublishedAt(`${cjk[1]}-${cjk[2]!.padStart(2, "0")}-${cjk[3]!.padStart(2, "0")}T00:00:00Z`);
  const iso = /\b((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/u.exec(text);
  if (iso) return normalizedPublishedAt(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
  const mdy = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})\b/u.exec(text);
  if (mdy) { const month = monthNumber(mdy[1]!); if (month) return normalizedPublishedAt(`${mdy[3]}-${String(month).padStart(2, "0")}-${mdy[2]!.padStart(2, "0")}T00:00:00Z`); }
  const dmy = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?,?\s+((?:19|20)\d{2})\b/u.exec(text);
  if (dmy) { const month = monthNumber(dmy[2]!); if (month) return normalizedPublishedAt(`${dmy[3]}-${String(month).padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}T00:00:00Z`); }
  return undefined;
}

/** "By Ben Thompson", "作者： 阮一峰", "Written by Joel Spolsky" on their own line near the top. */
function bylineFromText(text: string): string | undefined {
  const head = text.slice(0, 2500);
  const labelled = /(?:^|\n|\d{4}\s*|[·•|]\s*)(?:by|written by|posted by|author|作者)[\s:：]+([^\n|·•—–]{2,60}?)\s*(?:\n|$|\s{2,}|[·•|])/iu.exec(head);
  if (labelled) return cleanByline(labelled[1]);
  // "May 15, 2015 · The Rust Core Team": a name right after the date on the same line.
  const afterDate = /(?:\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2})\s*[·•|—–-]\s*([A-Z][^\n·•|]{2,50}?)\s*(?:\n|$|[·•|])/u.exec(head);
  if (afterDate && !/min read|comments?|share|tweet|\d/iu.test(afterDate[1]!)) return cleanByline(afterDate[1]);
  return undefined;
}

/** Visible author markup that pages use when they have no author meta tag. */
function bylineFromMarkup(document: DocumentLike): string | undefined {
  for (const selector of ["a[rel~='author']", "[itemprop~='author'] [itemprop~='name']", "[itemprop~='author']", ".author-name", ".byline .author", "[class~='byline'] a", "[class~='byline']", "[class~='author']", "[class*='post-author']", "[class*='author-name']"]) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      // Comment threads carry rel=author links for every commenter.
      if (element.closest("[class*='comment'], [id*='comment'], footer, nav")) continue;
      const text = cleanByline(normalizedOptionalString(element.textContent, 160));
      if (text) return text;
    }
  }
  return undefined;
}

/** "Bret Devereaux, View all posts by Bret" → "Bret Devereaux"; "Sameer Ajmani 13 March 2014" → "Sameer Ajmani". */
function cleanByline(value: string | undefined) {
  if (!value) return undefined;
  const cleaned = value
    .replace(/^(by|author|posted by|written by|作者)[:：\s]+/iu, "")
    .replace(/[,\s]*(view all posts.*|all posts by.*|posted (on|in).*|\d{1,2}\s+\w+\s+\d{4}.*|\w+\s+\d{1,2},\s+\d{4}.*)$/iu, "")
    .trim();
  return cleaned.length >= 2 && cleaned.length <= 120 && !/^(by|author)$/iu.test(cleaned) ? cleaned : undefined;
}

function normalizedDirection(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "ltr" || normalized === "rtl" ? normalized : undefined;
}

function documentFromHtml(html: string, source: string) {
  const parsed = parseHTML(html).document as unknown as DocumentLike;
  // Presentational <font>/<center> confuse the extractors' phrasing checks
  // (Readability ends a paragraph at an anchor that holds a <font>), so they go first.
  for (const wrapper of Array.from(parsed.querySelectorAll("font, center"))) {
    const parent = wrapper.parentNode;
    if (!parent) continue;
    while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
    wrapper.remove();
  }
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

/** Heading text without the controls some sites nest inside their h1 (save buttons, tooltips, icons). */
function headingOwnText(element: Element) {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll("button, [role='button'], svg, [aria-hidden='true'], [class*='tooltip'], [class*='devsite-'], input, select").forEach((node) => node.remove());
  return normalizedOptionalString(clone.textContent, 500);
}

function preferredArticleTitle(document: DocumentLike) {
  for (const selector of ["article h1", "main h1", "[role='main'] h1", "h1"]) {
    for (const heading of Array.from(document.querySelectorAll(selector))) {
      const title = headingOwnText(heading);
      if (title) return title;
    }
  }
  return undefined;
}

const TITLE_SEPARATOR = /\s+(?:\||–|—|-|·|»|::)\s+/u;

const SITE_WORDS = /\b(blog|log|weblog|magazine|journal|news|newsletter|home)\b|\.(com|net|io|org|dev|me|co|ai)\b/iu;

function lettersOnly(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Names the page uses for itself: og:site_name, the home link, an h1 that links to the site root, the hostname. */
function siteNames(document: DocumentLike, source: string) {
  const names = new Set<string>();
  const add = (value: string | null | undefined) => { const v = value?.replace(/\s+/gu, " ").trim().toLowerCase(); if (v && v.length >= 2) names.add(v); };
  add(metaContent(document, ["meta[property='og:site_name']", "meta[name='application-name']"]));
  for (const selector of ["[class*='site-title']", "[class*='site-name']", "[class*='logo'] a", "#logo", ".brand", "a[rel~='home']"]) {
    add(normalizedOptionalString(document.querySelector(selector)?.textContent, 120));
  }
  const origin = new URL(source).origin;
  for (const link of Array.from(document.querySelectorAll("a[href]")).slice(0, 200)) {
    const href = link.getAttribute("href") ?? "";
    let target: URL | undefined;
    try { target = new URL(href, source); } catch { continue; }
    if (target.origin !== origin) continue;
    const segments = target.pathname.split("/").filter(Boolean);
    // The home link, or an h1 that links one level deep ("/blog/"): a section or site title, not an article's.
    if (segments.length === 0 || (segments.length === 1 && link.closest("h1"))) add(normalizedOptionalString(link.textContent, 120));
  }
  const host = new URL(source).hostname.replace(/^www\./u, "");
  add(host);
  add(host.split(".")[0]);
  return names;
}

function hostLabel(document: DocumentLike, source: string) {
  void document;
  return lettersOnly(new URL(source).hostname.replace(/^www\./u, "").split(".")[0] ?? "");
}

function stripTitleAnchors(value: string) {
  return value.replace(/[\s¶#🔗]+$/u, "").replace(/^[\s¶#🔗]+/u, "").trim();
}

function isSiteLike(value: string, names: Set<string>, label: string) {
  const lower = value.toLowerCase();
  if (names.has(lower) || /^\d+$/u.test(value) || value.length < 3) return true;
  // "Brendan Gregg's Blog" on brendangregg.com, "null program" on nullprogram.com.
  const letters = lettersOnly(value);
  return label.length >= 6 && letters.length <= label.length + 8 && letters.includes(label);
}

/** A short side of a split title that is the site: a known name, "Lil'Log" / "Gwern.net"-like words, or the host label. */
function isSiteSide(part: string, names: Set<string>, label: string) {
  if (names.has(part.toLowerCase())) return true;
  const words = part.split(/\s+/u).length;
  return words <= 4 && (SITE_WORDS.test(part) || (label.length >= 4 && lettersOnly(part).includes(label)));
}

/** Drops a "| Site" / "– Site" side of a title when that side is the page's own name. */
function withoutSiteSuffix(value: string, names: Set<string>, label: string) {
  const parts = value.split(TITLE_SEPARATOR).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return value;
  const kept = parts.filter((part) => !isSiteSide(part, names, label));
  if (kept.length === parts.length || kept.length === 0) return value;
  return kept.join(" – ");
}

/** First candidate that, once cleaned, is a title of its own rather than the site's name or a number. */
function chooseArticleTitle(document: DocumentLike, source: string, candidates: readonly (string | undefined)[], byline?: string) {
  const names = siteNames(document, source);
  // "GPS – Bartosz Ciechanowski": the author's name is not part of the title either.
  if (byline) for (const name of byline.split(/,|&| and /u)) { const v = name.trim().toLowerCase(); if (v.length >= 4) names.add(v); }
  const label = hostLabel(document, source);
  const cleanedCandidates = candidates
    .map((candidate) => (candidate ? stripTitleAnchors(withoutSiteSuffix(stripTitleAnchors(candidate), names, label)) : ""))
    .filter(Boolean);
  const chosen = cleanedCandidates.find((cleaned) => !isSiteLike(cleaned, names, label));
  if (chosen) {
    // An h1 padded with UI text ("Web Vitals Stay organized with collections…") still starts
    // with the real title, which the page metadata states on its own.
    const shorter = cleanedCandidates.find((other) => other !== chosen && other.length >= 8 && chosen.startsWith(other));
    return (shorter ?? chosen).slice(0, 500);
  }
  return candidates.find((candidate) => !!candidate)?.slice(0, 500) ?? new URL(source).hostname;
}

function firstHeadingText(html: string, tag: "h2" | "h3") {
  const document = parseHTML(`<html><body>${html}</body></html>`).document as unknown as DocumentLike;
  return normalizedOptionalString(document.querySelector(tag)?.textContent, 500);
}

function preferredExtractedTitle(html: string) {
  const document = parseHTML(`<html><body>${html}</body></html>`)
    .document as unknown as DocumentLike;
  return preferredArticleTitle(document);
}

function sameTitle(a: string | undefined, b: string | undefined) {
  if (!a || !b) return false;
  const norm = (value: string) => value.replace(/\s+/gu, " ").trim().toLowerCase();
  return norm(a) === norm(b);
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

// richUnits order: pre, figure, picture, image, table, math, noteref, endnotes, link, citation, heading, list, details.
// Links, headings and lists are exactly what site footers and related-post widgets are made of, so a
// semantic <article> that wraps them inflates those three; only the content categories are enforced.
const NAVIGATION_HEAVY_RICH_UNITS = new Set([8, 10, 11]);

function candidateRetainsSourceRichStructure(
  candidate: ExtractionCandidate,
  sourceRichUnits: readonly number[],
) {
  const candidateRichUnits = contentStats(candidate.content).richUnits;
  return sourceRichUnits.every(
    (sourceCount, index) =>
      sourceCount === 0 ||
      NAVIGATION_HEAVY_RICH_UNITS.has(index) ||
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

function extractorDocumentFor(
  document: DocumentLike,
  root: Element,
  source: string,
) {
  return root === document.body
    ? offlineExtractorDocument(document, source)
    : boundedExtractorDocument(document, root, source);
}

/** Element-wise maximum of the candidates' rich-structure counts. */
function unionRichUnits(candidates: readonly (ExtractionCandidate | undefined)[]) {
  return candidates
    .filter((candidate): candidate is ExtractionCandidate => candidate !== undefined)
    .map((candidate) => contentStats(candidate.content).richUnits)
    .reduce<number[]>(
      (union, units) => units.map((count, index) => Math.max(count, union[index] ?? 0)),
      [],
    );
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
    const rawByline =
      metaContent(document, [
        "meta[name='author']",
        "meta[property='article:author']",
        "meta[name='byl']",
      ]) ?? cleanByline(structuredDataMetadata(document).author) ?? bylineFromMarkup(document) ?? bylineFromText(leadingText(document));
    const structured = structuredDataMetadata(document);
    const leadText = leadingText(document);
    const rawPublishedAt =
      normalizedPublishedAt(
        metaContent(document, [
          "meta[property='article:published_time']",
          "meta[name='date']",
          "meta[itemprop='datePublished']",
        ]) ??
          structured.datePublished ??
          document.querySelector("time[datetime]")?.getAttribute("datetime"),
      ) ?? publishedAtFromUrlOrText(source, leadText);
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
    // Without a unique semantic root the extractors see the whole page: most
    // personal blogs have no <article> and would otherwise never be extracted.
    const extractorRoot = semanticRoot ?? document.body ?? undefined;
    if (extractorRoot) {
      try {
        defuddle = defuddleCandidate(
          extractorDocumentFor(document, extractorRoot, source),
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
          extractorDocumentFor(document, extractorRoot, source),
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
          byline: cleanByline(defuddle?.byline ?? readability?.byline) ?? rawByline,
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

    // Retention is measured against the article region, never the whole page:
    // navigation and sidebars hold headings, lists and images that a correct
    // extraction must drop. Without a semantic region, "what the best
    // extractor kept" is the reference, which still rejects an extractor that
    // lost code blocks or tables the other one preserved.
    // <main> is a page region, not an article boundary: it routinely holds the
    // site's related-post widgets, whose images would be "lost" by any correct extraction.
    const rootIsArticleBoundary = semanticRoot !== undefined && semanticRoot.tagName.toLowerCase() !== "main" && semanticRoot.getAttribute("role") !== "main";
    const sourceRichUnits = siteAdapterExtraction
      ? contentStats(siteAdapterExtraction.content).richUnits
      : semanticRootExtraction && rootIsArticleBoundary
        ? contentStats(semanticRootExtraction.content).richUnits
        : unionRichUnits([defuddle, readability]);
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
    // When the two extractors disagree about which structure matters, neither
    // passes the union gate; the longer extraction is still a readable article
    // and is reported with both quality warnings attached rather than refused.
    const longerCandidate = [defuddle, readability]
      .filter((candidate): candidate is ExtractionCandidate => candidate !== undefined)
      .sort((a, b) => contentStats(b.content).textCharacters - contentStats(a.content).textCharacters)[0];
    // A semantic root far larger than what the extractors found is a page-wide
    // wrapper (article + footer widgets), not the article: the extraction wins then.
    const rootIsPageWide =
      semanticRootExtraction !== undefined &&
      longerCandidate !== undefined &&
      contentStats(semanticRootExtraction.content).textCharacters > contentStats(longerCandidate.content).textCharacters * 1.5;
    const selected = siteAdapterExtraction
      ? siteAdapterExtraction
      : defuddleIsHealthy
        ? defuddle!
        : readabilityIsHealthy
          ? readability!
          : rootIsPageWide
            ? longerCandidate
            : semanticRootExtraction ?? longerCandidate;
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
    const title = chooseArticleTitle(
      document,
      source,
      // The article's own h1 first; the page metadata only when the h1 turns
      // out to be the site header or something else that is not a title. When
      // the page's h1 and og:title agree, that pair outranks whatever h1 the
      // extractor kept (Substack uses h1 for section headings too).
      (() => {
        const ogTitle = metaContent(document, ["meta[property='og:title']", "meta[name='twitter:title']"]);
        const agreed = sameTitle(preferredTitle, ogTitle) ? [preferredTitle] : [];
        return [
          ...agreed,
          preferredExtractedTitle(selected.content),
          preferredTitle,
          ogTitle,
          normalizedOptionalString(document.title, 500),
          selected.title,
          // Sites whose h1 is the site name put the post title in the first h2.
          firstHeadingText(selected.content, "h2"),
        ];
      })(),
      cleanByline(defuddle?.byline ?? readability?.byline) ?? rawByline,
    );
    const pruned = pruneArticleChrome(selected.content, { title, siteNames: siteNames(document, source), byline: cleanByline(selected.byline) ?? rawByline });
    const representationResult = createRepresentations({
      baseUri: source,
      content: pruned.content,
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
      ...pruned.rulesApplied,
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
      ...((cleanByline(selected.byline) ?? rawByline)
        ? { byline: cleanByline(selected.byline) ?? rawByline }
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
