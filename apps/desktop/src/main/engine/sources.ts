import { randomBytes } from "node:crypto";
import type { SourceDetection, SourceKind, SourceRecord } from "../../shared/contracts";
import { arxivCategoryFromInput, arxivSourceTitle } from "./arxiv";
import type { Database } from "./db";
import { FEED_ACCEPT, assertPublicHttpUrl, type Fetcher } from "./fetch";
import type { ItemStore } from "./items";

export const DEFAULT_INTERVAL_MINUTES = 30;

type Row = Record<string, string | number | null>;

export interface SourceInput {
  kind: SourceKind;
  locator: string;
  title: string;
  siteUrl?: string;
}

export interface SourceHealthUpdate {
  lastSyncAt: string;
  lastSuccessAt?: string;
  lastError?: string;
  failureCount: number;
  title?: string;
  siteUrl?: string;
}

const COLUMNS = "id, kind, locator, title, site_url, added_at, interval_minutes, last_sync_at, last_success_at, last_error, failure_count, paused_at";

/** Subscriptions. Item counts are read live from the item store so a record is never stale. */
export class SourceStore {
  constructor(private readonly db: Database, private readonly items: ItemStore, private readonly now: () => Date = () => new Date()) {}

  private toRecord(row: Row): SourceRecord {
    const optional = (column: string, key: keyof SourceRecord) => (typeof row[column] === "string" ? { [key]: row[column] } : {});
    return {
      id: row.id as string, kind: row.kind as SourceKind, locator: row.locator as string, title: row.title as string,
      addedAt: row.added_at as string, intervalMinutes: row.interval_minutes as number, failureCount: row.failure_count as number,
      ...optional("site_url", "siteUrl"), ...optional("last_sync_at", "lastSyncAt"), ...optional("last_success_at", "lastSuccessAt"),
      ...optional("last_error", "lastError"), ...optional("paused_at", "pausedAt"),
      ...this.items.healthOf(row.id as string),
    };
  }

  /** Adds a subscription; the same locator twice is an error the caller can show ("already subscribed"). */
  add(input: SourceInput): SourceRecord {
    if (this.byLocator(input.locator)) throw new Error(`Already subscribed to ${input.title || input.locator}.`);
    const id = randomBytes(8).toString("hex");
    this.db.prepare(`INSERT INTO sources (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL)`)
      .run(id, input.kind, input.locator, input.title, input.siteUrl ?? null, this.now().toISOString(), DEFAULT_INTERVAL_MINUTES);
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

/**
 * What a pasted string is. arXiv categories never touch the network; URLs are fetched once
 * with a feed-first accept header, and an HTML page is searched for its declared feed.
 */
export async function detectSource(input: string, fetch: Fetcher): Promise<SourceDetection> {
  const value = input.trim();
  const category = arxivCategoryFromInput(value);
  if (category) return { kind: "arxiv", category, title: arxivSourceTitle(category) };
  const url = assertPublicHttpUrl(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  const page = await fetch(url, FEED_ACCEPT);
  const head = decodeHead(page.bytes);
  if (XML_TYPES.test(page.mediaType) || FEED_ROOT.test(head)) {
    const title = feedTitleOf(page.bytes);
    return { kind: "feed", url: page.finalUrl, ...(title ? { title } : {}) };
  }
  const alternate = alternateFeedOf(head, page.finalUrl);
  if (alternate) {
    assertPublicHttpUrl(alternate);
    const title = htmlTitleOf(head);
    return { kind: "feed", url: alternate, ...(title ? { title } : {}) };
  }
  return { kind: "page", url: page.finalUrl };
}
