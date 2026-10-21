import { createHash } from "node:crypto";

// Which material a link names. A material's id is the hash of its URL with the tracking
// parameters and the fragment dropped, so `?utm_source=rss` and a shared `#comments` open the
// copy already in the library (#28).

/**
 * Parameters that only say how the reader arrived, dropped everywhere. Never one that picks the
 * content: `?id=` (Hacker News), `?p=` (WordPress), `?v=` (YouTube) and anything unlisted stay.
 */
const TRACKING = new Set(["ref", "ref_src", "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid", "_hsenc", "_hsmi", "mkt_tok", "yclid", "spm", "share"]);
/** Google Analytics campaign tags: utm_source, utm_medium, utm_campaign, utm_term, utm_content and the rest. */
const TRACKING_PREFIX = "utm_";
/** Share parameters that are tracking only on the sites that add them: elsewhere `?s=` is a WordPress search. */
const SITE_TRACKING: Readonly<Record<string, readonly string[]>> = {
  s: ["x.com", "twitter.com"],
  si: ["youtube.com", "youtu.be", "spotify.com"],
};
/** Where `?ref=` names a git revision (the contents APIs), so it picks the content. */
const REF_IS_CONTENT = ["github.com", "gitlab.com"];

function onSite(hostname: string, sites: readonly string[]): boolean {
  return sites.some((site) => hostname === site || hostname.endsWith(`.${site}`));
}

function isTracking(name: string, hostname: string): boolean {
  if (name === "ref") return !onSite(hostname, REF_IS_CONTENT);
  if (TRACKING.has(name) || name.startsWith(TRACKING_PREFIX)) return true;
  const sites = SITE_TRACKING[name];
  return sites !== undefined && onSite(hostname, sites);
}

/** The URL without its fragment and tracking parameters; the parameters kept stay exactly as written, so a URL with none to drop is unchanged. */
export function canonicalUrlOf(url: URL): string {
  const page = new URL(url);
  page.hash = "";
  const pairs = page.search.slice(1).split("&");
  const kept = pairs.filter((pair) => !isTracking(pair.split("=", 1)[0]!, page.hostname));
  if (kept.length < pairs.length) page.search = kept.join("&");
  return page.toString();
}

export function idFor(locator: string): string {
  return createHash("sha256").update(locator).digest("hex").slice(0, 16);
}

/** The id a new material read from this URL gets. */
export function materialIdOf(url: URL): string {
  return idFor(canonicalUrlOf(url));
}

/** The ids a URL's material may be stored under: the canonical one, then the one versions before #28 derived from the URL as given. */
export function storedIdsOf(url: URL): string[] {
  const page = new URL(url);
  page.hash = "";
  return [...new Set([materialIdOf(url), idFor(page.toString())])];
}
