import { randomBytes } from "node:crypto";
import type { SourceConfig, SourceDetection, SourceKind, SourceRecord } from "../../shared/contracts";
import { arxivCategoryFromInput, arxivSourceTitle } from "./arxiv";
import type { Database } from "./db";
import { FEED_ACCEPT, FetchError, PAGE_ACCEPT, assertPublicHttpUrl, type Fetcher } from "./fetch";
import type { ItemStore } from "./items";

export const DEFAULT_INTERVAL_MINUTES = 30;

type Row = Record<string, string | number | null>;

export interface SourceInput {
  kind: SourceKind;
  locator: string;
  title: string;
  siteUrl?: string;
  config?: SourceConfig;
}

export interface SourceHealthUpdate {
  lastSyncAt: string;
  lastSuccessAt?: string;
  lastError?: string;
  failureCount: number;
  title?: string;
  siteUrl?: string;
}

const COLUMNS = "id, kind, locator, title, site_url, added_at, interval_minutes, last_sync_at, last_success_at, last_error, failure_count, paused_at, config";

function parseSourceConfig(kind: SourceKind, raw: unknown): SourceConfig | undefined {
  let cfg: SourceConfig = {};
  if (typeof raw === "string" && raw.trim()) {
    try { cfg = JSON.parse(raw) as SourceConfig; } catch { cfg = {}; }
  }
  if (kind === "youtube" && cfg.ignoreShorts === undefined) {
    cfg = { ...cfg, ignoreShorts: true };
  }
  return cfg.ignoreShorts !== undefined ? cfg : undefined;
}

/** Subscriptions. Item counts are read live from the item store so a record is never stale. */
export class SourceStore {
  constructor(private readonly db: Database, private readonly items: ItemStore, private readonly now: () => Date = () => new Date()) {}

  private toRecord(row: Row): SourceRecord {
    const optional = (column: string, key: keyof SourceRecord) => (typeof row[column] === "string" ? { [key]: row[column] } : {});
    const kind = row.kind as SourceKind;
    const config = parseSourceConfig(kind, row.config);
    return {
      id: row.id as string, kind, locator: row.locator as string, title: row.title as string,
      addedAt: row.added_at as string, intervalMinutes: row.interval_minutes as number, failureCount: row.failure_count as number,
      ...(config ? { config } : {}),
      ...optional("site_url", "siteUrl"), ...optional("last_sync_at", "lastSyncAt"), ...optional("last_success_at", "lastSuccessAt"),
      ...optional("last_error", "lastError"), ...optional("paused_at", "pausedAt"),
      ...this.items.healthOf(row.id as string),
    };
  }

  /** Adds a subscription; the same locator twice is an error the caller can show ("already subscribed"). */
  add(input: SourceInput): SourceRecord {
    if (this.byLocator(input.locator)) throw new Error(`Already subscribed to ${input.title || input.locator}.`);
    const id = randomBytes(8).toString("hex");
    const defaultCfg = input.config ?? (input.kind === "youtube" ? { ignoreShorts: true } : {});
    this.db.prepare(`INSERT INTO sources (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, ?)`)
      .run(id, input.kind, input.locator, input.title, input.siteUrl ?? null, this.now().toISOString(), DEFAULT_INTERVAL_MINUTES, JSON.stringify(defaultCfg));
    return this.get(id) as SourceRecord;
  }

  get(id: string): SourceRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM sources WHERE id = ?`).get(id) as Row | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  byLocator(locator: string): SourceRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM sources WHERE locator = ?`).get(locator) as Row | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  list(): SourceRecord[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM sources ORDER BY added_at, rowid`).all() as Row[]).map((row) => this.toRecord(row));
  }

  /** After a sync: success clears the error and resets the count; failure keeps the last success and increments. */
  updateHealth(id: string, update: SourceHealthUpdate): SourceRecord {
    if (!this.get(id)) throw new Error("SOURCE_NOT_FOUND");
    this.db.prepare(`UPDATE sources SET last_sync_at = ?, last_success_at = COALESCE(?, last_success_at), last_error = ?, failure_count = ?,
      title = COALESCE(?, title), site_url = COALESCE(?, site_url) WHERE id = ?`)
      .run(update.lastSyncAt, update.lastSuccessAt ?? null, update.lastError ?? null, update.failureCount, update.title ?? null, update.siteUrl ?? null, id);
    return this.get(id) as SourceRecord;
  }

  pause(id: string, paused: boolean): SourceRecord {
    if (!this.get(id)) throw new Error("SOURCE_NOT_FOUND");
    this.db.prepare("UPDATE sources SET paused_at = ? WHERE id = ?").run(paused ? this.now().toISOString() : null, id);
    return this.get(id) as SourceRecord;
  }

  /** Drops the subscription and its undecided items; decided items keep their denormalised source title. */
  remove(id: string): void {
    if (!this.get(id)) throw new Error("SOURCE_NOT_FOUND");
    this.items.removeUndecidedOf(id);
    this.db.prepare("DELETE FROM sources WHERE id = ?").run(id);
  }
}

const FEED_ROOT = /^(?:\uFEFF)?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:rss|feed|rdf:RDF)\b/;
const XML_TYPES = /^(?:application\/(?:rss|atom|rdf)\+xml|application\/xml|text\/xml)$/;
const PODCAST_ENCLOSURE = /<enclosure\b[^>]*?(?:\btype\s*=\s*["']audio\/|\burl\s*=\s*["'][^"']+\.(?:mp3|m4a|aac|ogg|opus|wav)(?:[?#][^"']*)?["'])/i;
const APPLE_PODCAST_URL = /^https?:\/\/podcasts\.apple\.com\/(?:([a-z]{2})\/)?podcast\/(?:[^/?#]+\/)?id(\d+)(?:\?[^#]*?\bi=(\d+))?/i;

export interface ApplePodcastRef {
  country: string;
  collectionId: string;
  trackId?: string;
}

export function parseApplePodcastUrl(raw: string): ApplePodcastRef | undefined {
  const match = APPLE_PODCAST_URL.exec(raw.trim());
  if (!match) return undefined;
  return {
    country: (match[1] ?? "us").toLowerCase(),
    collectionId: match[2]!,
    ...(match[3] ? { trackId: match[3] } : {}),
  };
}

interface ItunesLookupEntry {
  wrapperType?: string;
  kind?: string;
  collectionId?: number;
  trackId?: number;
  collectionName?: string;
  trackName?: string;
  feedUrl?: string;
  collectionViewUrl?: string;
  trackTimeMillis?: number;
}

async function detectApplePodcast(ref: ApplePodcastRef, pageUrl: string, fetch: Fetcher): Promise<SourceDetection> {
  const lookupUrl = new URL(`https://itunes.apple.com/lookup?id=${ref.collectionId}&country=${ref.country}&entity=podcastEpisode&limit=200`);
  const resp = await fetch(lookupUrl, "application/json");
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(resp.bytes)) as { results?: ItunesLookupEntry[] };
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const show = results.find((r) => r.kind === "podcast" || r.wrapperType === "collection" || Boolean(r.feedUrl));
  const feedUrl = show?.feedUrl?.trim();

  if (ref.trackId) {
    let episode = results.find((r) => String(r.trackId) === ref.trackId && r.kind === "podcast-episode");
    if (!episode) {
      const singleUrl = new URL(`https://itunes.apple.com/lookup?id=${ref.trackId}&country=${ref.country}&entity=podcastEpisode`);
      try {
        const singleResp = await fetch(singleUrl, "application/json");
        const singleParsed = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(singleResp.bytes)) as { results?: ItunesLookupEntry[] };
        episode = singleParsed.results?.find((r) => String(r.trackId) === ref.trackId);
      } catch {
        // Keep show-level fallback when single track lookup fails.
      }
    }
    const title = episode?.trackName?.trim() || show?.collectionName?.trim() || undefined;
    const durationSec = typeof episode?.trackTimeMillis === "number" && episode.trackTimeMillis > 0
      ? Math.round(episode.trackTimeMillis / 1000)
      : undefined;
    const feed = feedUrl ? offeredFeed(feedUrl) : undefined;
    return {
      kind: "episode",
      url: pageUrl,
      mediaKind: "audio",
      ...(title ? { title } : {}),
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(feed ? { feed } : {}),
    };
  }

  if (!feedUrl) throw new FetchError("PODCAST_NOT_FOUND", "Apple Podcasts did not return an RSS feed for this show.");
  assertPublicHttpUrl(feedUrl);
  const title = show?.collectionName?.trim() || undefined;
  const siteUrl = show?.collectionViewUrl ? offeredFeed(show.collectionViewUrl) : undefined;
  return {
    kind: "podcast",
    url: feedUrl,
    ...(title ? { title } : {}),
    ...(siteUrl ? { siteUrl } : {}),
  };
}

function feedSiteUrlOf(xmlHead: string): string | undefined {
  const rss = /<channel\b[^>]*>[\s\S]*?<link>\s*(https?:\/\/[^<\s]+)\s*<\/link>/i.exec(xmlHead);
  return rss?.[1] ? offeredFeed(rss[1]) : undefined;
}

function decodeHead(bytes: Uint8Array, length = 64 * 1024): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, length));
}

function feedTitleOf(bytes: Uint8Array): string | undefined {
  const head = decodeHead(bytes);
  const match = /<(?:channel|feed)\b[^>]*>[\s\S]*?<title(?:\s[^>]*)?>(?:<!\[CDATA\[)?([^<\]]{1,300})/.exec(head);
  return match?.[1]?.replace(/\s+/g, " ").trim() || undefined;
}

function htmlTitleOf(head: string): string | undefined {
  const match = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(head);
  return match?.[1]?.replace(/\s+/g, " ").trim() || undefined;
}

/** The first <link rel="alternate" type="application/(atom|rss)+xml" href> of the page head, Atom preferred. */
export function alternateFeedOf(html: string, baseUrl: string): string | undefined {
  const head = html.slice(0, 256 * 1024);
  const candidates: { type: string; href: string }[] = [];
  for (const tag of head.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = tag[0];
    const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]?.toLowerCase() ?? "";
    if (!rel.split(/\s+/).includes("alternate")) continue;
    const type = /\btype\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]?.toLowerCase() ?? "";
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if ((type === "application/atom+xml" || type === "application/rss+xml") && href) candidates.push({ type, href: href.trim() });
  }
  const chosen = candidates.find((c) => c.type === "application/atom+xml") ?? candidates[0];
  if (!chosen) return undefined;
  try { return new URL(chosen.href, baseUrl).toString(); } catch { return undefined; }
}

/** A site's front page, or the section its feed lives under (/blog/ for /blog/feed.xml), stands for the feed; any other page is read. */
function isFeedHome(pageUrl: string, feedUrl: string): boolean {
  const page = new URL(pageUrl);
  const feed = new URL(feedUrl);
  const home = page.pathname.replace(/index\.html?$/i, "");
  if (page.search !== "" || !home.endsWith("/")) return false;
  return home === "/" || (feed.origin === page.origin && feed.pathname.startsWith(home));
}

/** The feed a page offers beside reading, or none when the app would refuse to fetch it (localhost, a private host). */
function offeredFeed(url: string): string | undefined {
  try { return assertPublicHttpUrl(url).toString(); } catch (error) {
    if (error instanceof FetchError) return undefined;
    throw error;
  }
}

const YT_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function isYoutubeHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "youtu.be" || h === "youtube.com" || h.endsWith(".youtube.com");
}

export function parseYoutubeVideoId(raw: string): string | undefined {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return undefined; }
  if (!isYoutubeHost(u.hostname)) return undefined;
  if (u.hostname.toLowerCase() === "youtu.be") {
    const seg = u.pathname.split("/").filter(Boolean)[0];
    return seg && YT_VIDEO_ID.test(seg) ? seg : undefined;
  }
  if (u.pathname === "/watch") {
    const v = u.searchParams.get("v");
    return v && YT_VIDEO_ID.test(v) ? v : undefined;
  }
  for (const prefix of ["/live/", "/shorts/", "/embed/", "/v/"]) {
    if (u.pathname.startsWith(prefix)) {
      const seg = u.pathname.slice(prefix.length).split("/")[0];
      if (seg && YT_VIDEO_ID.test(seg)) return seg;
    }
  }
  return undefined;
}

async function detectYoutubeUrl(url: URL, fetch: Fetcher): Promise<SourceDetection | undefined> {
  if (!isYoutubeHost(url.hostname)) return undefined;
  const videoId = parseYoutubeVideoId(url.toString());
  if (videoId) {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    try {
      const page = await fetch(new URL(watchUrl), PAGE_ACCEPT);
      const html = decodeHead(page.bytes, 512 * 1024);
      const rawTitle = /"videoDetails"\s*:\s*\{[\s\S]*?"title"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/.exec(html)?.[1]
        ?.replace(/\\"/g, '"')
        ?? htmlTitleOf(html)?.replace(/\s*-\s*YouTube$/i, "");
      const author = /"videoDetails"\s*:\s*\{[\s\S]*?"author"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/.exec(html)?.[1]?.replace(/\\"/g, '"');
      const channelId = /"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{16,})"/.exec(html)?.[1];
      const lenRaw = /"lengthSeconds"\s*:\s*"(\d+)"/.exec(html)?.[1];
      const durationSec = lenRaw && Number(lenRaw) > 0 ? Number(lenRaw) : undefined;
      const feed = channelId ? `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}` : undefined;
      return {
        kind: "episode",
        url: watchUrl,
        mediaKind: "video",
        ...(rawTitle ? { title: rawTitle.trim() } : {}),
        ...(durationSec !== undefined ? { durationSec } : {}),
        ...(feed ? { feed } : {}),
        ...(author ? { feedTitle: author.trim() } : {}),
      };
    } catch {
      return { kind: "episode", url: watchUrl, mediaKind: "video" };
    }
  }
  if (url.hostname.toLowerCase() === "youtu.be") return undefined;

  if (url.pathname === "/feeds/videos.xml") {
    const cid = url.searchParams.get("channel_id") ?? undefined;
    const pid = url.searchParams.get("playlist_id") ?? undefined;
    if (cid || pid) {
      let title: string | undefined;
      try {
        const resp = await fetch(url, FEED_ACCEPT);
        title = feedTitleOf(resp.bytes);
      } catch { /* keep bare feed URL */ }
      return { kind: "youtube", url: url.toString(), ...(cid ? { channelId: cid } : {}), ...(title ? { title } : {}) };
    }
  }

  if (url.pathname === "/playlist") {
    const listId = url.searchParams.get("list");
    if (listId && /^[A-Za-z0-9_-]{10,}$/.test(listId)) {
      const feedUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${listId}`;
      let title: string | undefined;
      try {
        const resp = await fetch(new URL(feedUrl), FEED_ACCEPT);
        title = feedTitleOf(resp.bytes);
      } catch { /* keep bare feed URL */ }
      return { kind: "youtube", url: feedUrl, ...(title ? { title } : {}) };
    }
  }

  const chanMatch = /^\/channel\/(UC[A-Za-z0-9_-]{16,})/.exec(url.pathname);
  if (chanMatch) {
    const cid = chanMatch[1]!;
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${cid}`;
    let title: string | undefined;
    try {
      const resp = await fetch(new URL(feedUrl), FEED_ACCEPT);
      title = feedTitleOf(resp.bytes);
    } catch { /* keep bare feed URL */ }
    return { kind: "youtube", url: feedUrl, channelId: cid, ...(title ? { title } : {}) };
  }

  if (/^\/(?:@[^/]+|c\/[^/]+|user\/[^/]+)/.test(url.pathname)) {
    const page = await fetch(url, PAGE_ACCEPT);
    const html = decodeHead(page.bytes, 512 * 1024);
    const cid = /https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=(UC[A-Za-z0-9_-]{16,})/.exec(html)?.[1]
      ?? /"(?:externalId|channelId|browseId)"\s*:\s*"(UC[A-Za-z0-9_-]{16,})"/.exec(html)?.[1];
    if (!cid) throw new FetchError("YOUTUBE_CHANNEL_NOT_FOUND", "Could not resolve a YouTube channel feed from that URL.");
    const ogTitle = /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i.exec(html)?.[1];
    const title = (ogTitle ?? htmlTitleOf(html))?.replace(/\s*-\s*YouTube$/i, "").trim() || undefined;
    return {
      kind: "youtube",
      url: `https://www.youtube.com/feeds/videos.xml?channel_id=${cid}`,
      channelId: cid,
      ...(title ? { title } : {}),
    };
  }
  return undefined;
}

/**
 * What a pasted string is. arXiv categories never touch the network; URLs are fetched once
 * with a feed-first accept header, and an HTML page is searched for its declared feed.
 */
export async function detectSource(input: string, fetch: Fetcher): Promise<SourceDetection> {
  const value = input.trim();
  const category = arxivCategoryFromInput(value);
  if (category) return { kind: "arxiv", category, title: arxivSourceTitle(category) };
  const normalized = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const url = assertPublicHttpUrl(normalized);
  const apple = parseApplePodcastUrl(url.toString());
  if (apple) return detectApplePodcast(apple, url.toString(), fetch);
  const yt = await detectYoutubeUrl(url, fetch);
  if (yt) return yt;
  const page = await fetch(url, FEED_ACCEPT);
  const head = decodeHead(page.bytes);
  if (XML_TYPES.test(page.mediaType) || FEED_ROOT.test(head)) {
    const title = feedTitleOf(page.bytes);
    const head256 = decodeHead(page.bytes, 256 * 1024);
    if (PODCAST_ENCLOSURE.test(head256)) {
      const siteUrl = feedSiteUrlOf(head256);
      return { kind: "podcast", url: page.finalUrl, ...(title ? { title } : {}), ...(siteUrl ? { siteUrl } : {}) };
    }
    return { kind: "feed", url: page.finalUrl, ...(title ? { title } : {}) };
  }
  const alternate = alternateFeedOf(head, page.finalUrl);
  if (alternate) {
    if (!isFeedHome(page.finalUrl, alternate)) {
      const feed = offeredFeed(alternate);
      return { kind: "page", url: page.finalUrl, ...(feed ? { feed } : {}) };
    }
    assertPublicHttpUrl(alternate);
    const title = htmlTitleOf(head);
    return { kind: "feed", url: alternate, ...(title ? { title } : {}) };
  }
  return { kind: "page", url: page.finalUrl };
}

/** What subscribing to a detection adds: the feed, the feed a page declares, or the arXiv category; nothing for a bare page. */
export function subscriptionOf(detection: SourceDetection): SourceInput | undefined {
  switch (detection.kind) {
    case "arxiv": return { kind: "arxiv", locator: detection.category, title: detection.title };
    case "feed": return { kind: "feed", locator: detection.url, title: detection.title ?? new URL(detection.url).hostname };
    case "podcast": return { kind: "podcast", locator: detection.url, title: detection.title ?? new URL(detection.url).hostname, ...(detection.siteUrl ? { siteUrl: detection.siteUrl } : {}) };
    case "youtube": return { kind: "youtube", locator: detection.url, title: detection.title ?? "YouTube channel" };
    case "page":
      return detection.feed ? { kind: "feed", locator: detection.feed, title: new URL(detection.feed).hostname } : undefined;
    case "episode": {
      if (!detection.feed) return undefined;
      const kind: SourceKind = detection.mediaKind === "audio"
        ? "podcast"
        : detection.feed.includes("youtube.com/feeds/videos.xml")
          ? "youtube"
          : "feed";
      return { kind, locator: detection.feed, title: detection.feedTitle?.trim() || new URL(detection.feed).hostname };
    }
  }
}
