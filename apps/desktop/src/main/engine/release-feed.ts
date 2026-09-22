import type { GithubRelease } from "./updates";

// GitHub's releases feed (https://github.com/<owner>/<repo>/releases.atom), which has no rate limit,
// read into the same shape the releases API returns. The feed is small and regular, so a few
// patterns over its entries do; anything that does not look like a feed of releases throws, and
// the caller falls back to the API.

export class ReleaseFeedError extends Error {
  constructor(message: string) { super(message); this.name = "ReleaseFeedError"; }
}

const ENTRY = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
const FEED_ROOT = /^(?:﻿)?\s*(?:<\?xml[^>]*\?>\s*)?<feed\b/;
const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** The text of the first `<name>` element of `entry`, entities decoded; undefined when absent. */
function elementText(entry: string, name: string): string | undefined {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(entry);
  if (!match || match[1] === undefined) return undefined;
  const inner = match[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
  return cdata?.[1] !== undefined ? cdata[1] : decodeEntities(inner);
}

/** The href of the entry's alternate link (a link without rel counts as alternate). */
function alternateHref(entry: string): string | undefined {
  for (const match of entry.matchAll(/<link\b([^>]*?)\/?>/g)) {
    const attributes = match[1] ?? "";
    const rel = /\brel="([^"]*)"/.exec(attributes)?.[1];
    if (rel !== undefined && rel !== "alternate") continue;
    const href = /\bhref="([^"]*)"/.exec(attributes)?.[1];
    if (href) return decodeEntities(href);
  }
  return undefined;
}

/**
 * Release notes as plain text: the source's own line breaks are HTML whitespace (kept only inside <pre>),
 * block ends become line breaks, list items get a dash, tags go, entities are decoded.
 */
export function htmlToPlainText(html: string): string {
  const text = html
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, "")
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, (block) => block.replace(/\n/g, "<br>"))
    .replace(/\s+/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/(?:p|div|li|h[1-6]|ul|ol|blockquote|pre|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text).replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The tag a release entry's id names: everything after its last "/", e.g. "tag:github.com,2008:Repository/1/v1.2.3" → "v1.2.3"; undefined when the id has no "/". */
function tagOf(id: string): string | undefined {
  const slash = id.lastIndexOf("/");
  if (slash < 0) return undefined;
  const tag = id.slice(slash + 1).trim();
  return tag.length > 0 ? tag : undefined;
}

function releaseOf(entry: string): GithubRelease | undefined {
  const id = elementText(entry, "id");
  const tag = (id === undefined ? undefined : tagOf(id)) ?? elementText(entry, "title");
  const url = alternateHref(entry);
  if (!tag || !url) return undefined;
  const content = elementText(entry, "content");
  const updated = elementText(entry, "updated");
  return { tag_name: tag, html_url: url, body: content === undefined ? null : htmlToPlainText(content), ...(updated ? { published_at: updated } : {}) };
}

/**
 * Every release entry of the feed, newest first as GitHub lists them. Throws ReleaseFeedError when
 * the text is not an Atom feed or none of its entries names a release; an empty feed is a valid, empty list.
 */
export function parseReleaseFeed(xml: string): GithubRelease[] {
  if (!FEED_ROOT.test(xml)) throw new ReleaseFeedError("The releases feed is not an Atom document.");
  const entries = [...xml.matchAll(ENTRY)].map((match) => match[1] ?? "");
  const releases = entries.map(releaseOf).filter((release): release is GithubRelease => release !== undefined);
  if (entries.length > 0 && releases.length === 0) throw new ReleaseFeedError("The releases feed has entries, but none names a release tag and page.");
  return releases;
}
