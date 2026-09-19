import { readingMinutes, wordCount } from "./reading-time";
import { createHash } from "node:crypto";
import { normalizeFeedCapture, type NormalizedFeedEntry } from "@read/normalize";
import type { ItemSignals, MaterialMeta } from "../../shared/contracts";
import type { ItemContent, ItemInput } from "./items";

const BUDGET = { maxBytes: 8 * 1024 * 1024, maxDepth: 100, maxEntries: 200, maxEntryOutputBytes: 2 * 1024 * 1024, maxNodes: 200_000, maxTotalOutputBytes: 64 * 1024 * 1024 };
const GIST_CHARS = 300;
const SUMMARY_WORDS = 150;

export interface ParsedFeed {
  title: string;
  siteUrl?: string;
  lang?: string;
  items: ItemInput[];
}

const FAILURE_MESSAGES: Record<string, string> = {
  SOURCE_UNSUPPORTED_FEED: "Not a feed: the document is neither RSS 2.0 nor Atom.",
  SOURCE_FEED_INVALID: "Not a feed: the document is not well-formed XML.",
  SOURCE_XML_DTD_FORBIDDEN: "The feed declares a DTD, which is not accepted.",
  SOURCE_FEED_TOO_LARGE: "The feed is larger than 8 MB.",
  SOURCE_TOO_MANY_ENTRIES: "The feed has more than 200 entries.",
  SOURCE_NO_USABLE_ENTRIES: "The feed has entries, but none could be read.",
};

function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 2048)).replace(/^﻿/, "").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/** Feed language: RSS <language> in the channel or xml:lang on the Atom root; the normalizer does not surface it. */
function languageOf(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 64 * 1024));
  const atom = /<feed\b[^>]*\sxml:lang="([A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*)"/.exec(head);
  const rss = /<language>\s*([A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*)\s*<\/language>/.exec(head);
  return atom?.[1] ?? rss?.[1] ?? undefined;
}

function siteUrlOf(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 64 * 1024));
  const atom = /<link\b[^>]*\brel="alternate"[^>]*\bhref="(https?:\/\/[^"]+)"/.exec(head) ?? /<link\b[^>]*\bhref="(https?:\/\/[^"]+)"[^>]*\brel="alternate"/.exec(head);
  const rss = /<channel>[\s\S]*?<link>\s*(https?:\/\/[^<\s]+)\s*<\/link>/.exec(head);
  const candidate = /<feed\b/.test(head) ? atom?.[1] : rss?.[1];
  return candidate;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The first ~300 characters, cut at the last sentence end inside the window when there is one. */
export function gistOf(plain: string): string {
  const text = collapse(plain);
  if (text.length <= GIST_CHARS) return text;
  const window = text.slice(0, GIST_CHARS);
  const sentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "), window.lastIndexOf("。"));
  if (sentenceEnd >= GIST_CHARS / 3) return window.slice(0, sentenceEnd + 1).trim();
  const wordEnd = window.lastIndexOf(" ");
  return `${window.slice(0, wordEnd > 0 ? wordEnd : GIST_CHARS).trim()}…`;
}

interface ReaderScan { code: boolean; math: boolean; figures: boolean }

function scanReader(payload: string | undefined): ReaderScan {
  const found: ReaderScan = { code: false, math: false, figures: false };
  if (!payload) return found;
  let root: unknown;
  try { root = JSON.parse(payload); } catch { return found; }
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const value = node as Record<string, unknown>;
    if (value.type === "code") found.code = true;
    if (value.type === "math") found.math = true;
    if (value.type === "image" || value.type === "figure") found.figures = true;
    for (const key of ["children", "caption", "credit", "media", "bodies", "head", "foot"]) visit(value[key]);
  };
  visit(root);
  return found;
}

export function signalsOf(content: ItemContent, lang: string | undefined): ItemSignals {
  const scan = scanReader(content.reader?.payload);
  const text = content.plain ?? "";
  const code = scan.code || /```/.test(content.markdown ?? "");
  const math = scan.math || /\$[^$\n]{1,200}\$/.test(text) || /\\\(/.test(text);
  return { ...(code ? { code } : {}), ...(math ? { math } : {}), ...(scan.figures ? { figures: true } : {}), ...(lang ? { lang } : {}) };
}

function contentOf(entry: NormalizedFeedEntry): ItemContent {
  const by = (schema: string) => entry.materialization.representations.find((r) => r.schema === schema)?.content;
  const v2 = by("reader.document.v2"); const v1 = by("reader.document.v1");
  const reader = v2 ? { schema: "reader.document.v2" as const, payload: v2 } : v1 ? { schema: "reader.document.v1" as const, payload: v1 } : undefined;
  const markdown = by("agent.gfm.v1"); const plain = by("selection.text.v1");
  return { ...(reader ? { reader } : {}), ...(markdown ? { markdown } : {}), ...(plain ? { plain } : {}) };
}

export function itemOf(entry: NormalizedFeedEntry, lang: string | undefined, now: () => Date): ItemInput {
  const content = contentOf(entry);
  const plain = content.plain ?? content.markdown ?? "";
  const completeness = entry.materialization.quality.completeness;
  const carriesFullText = completeness === "declared_full" || completeness === "ambiguous";
  const summaryOnly = !carriesFullText || wordCount(plain) < SUMMARY_WORDS;
  return {
    externalId: entry.externalId,
    title: collapse(entry.title) || "Untitled",
    link: entry.link,
    publishedAt: entry.publishedAt ?? now().toISOString(),
    gist: gistOf(plain),
    readingMinutes: readingMinutes(plain),
    signals: signalsOf(content, lang),
    summaryOnly,
    ...(summaryOnly ? {} : { content }),
  };
}

const NEWSLETTER_WORDS = /newsletter|weekly|周刊|digest/i;

/** What the feed itself says about every entry: where it appeared and, from the feed's name, whether it is a newsletter or a blog. The normalizer exposes no per-entry author. */
export function feedItemMeta(sourceTitle: string, publishedAt: string): MaterialMeta {
  return { kind: NEWSLETTER_WORDS.test(sourceTitle) ? "newsletter" : "blogPost", publication: sourceTitle, date: publishedAt };
}

/** RSS 2.0 or Atom bytes to items. Throws with an actionable message when the bytes are not a feed. */
export function parseFeed(bytes: Uint8Array, mediaType: string, url: string, now: () => Date = () => new Date()): ParsedFeed {
  if (mediaType === "text/html" || (mediaType === "application/octet-stream" && looksLikeHtml(bytes))) throw new Error(`Not a feed: ${url} answered with an HTML page. Paste the site's feed URL, or the page itself to discover one.`);
  const outcome = normalizeFeedCapture({
    budget: BUDGET,
    capture: { baseLocator: url, bytes, contentIdentity: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, mediaType: mediaType || "application/xml" },
  });
  if (!outcome.ok) {
    const fatal = outcome.problems.find((p) => p.severity === "fatal") ?? outcome.problems[0];
    const code = fatal?.code ?? "SOURCE_FEED_INVALID";
    throw new Error(`${FAILURE_MESSAGES[code] ?? `The feed could not be read (${code}).`} (${url})`);
  }
  const lang = languageOf(bytes);
  const siteUrl = siteUrlOf(bytes);
  const title = collapse(outcome.feed.title) || new URL(url).hostname;
  return {
    title,
    ...(siteUrl ? { siteUrl } : {}),
    ...(lang ? { lang } : {}),
    items: outcome.feed.entries.map((entry) => { const item = itemOf(entry, lang, now); return { ...item, meta: feedItemMeta(title, item.publishedAt) }; }),
  };
}
