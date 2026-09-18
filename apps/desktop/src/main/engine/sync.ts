import type { SourceRecord, SyncSourceResult } from "../../shared/contracts";
import { arxivItemsOf, arxivQueryUrl } from "./arxiv";
import { parseFeed } from "./feeds";
import { FEED_ACCEPT, FetchError, assertPublicHttpUrl, type Fetcher } from "./fetch";
import type { ItemInput, ItemStore } from "./items";
import type { SourceStore } from "./sources";

export interface SyncDeps {
  fetch: Fetcher;
  sources: SourceStore;
  items: ItemStore;
  now?: () => Date;
}

const CONCURRENCY = 2;

interface Fetched { title: string; siteUrl?: string; items: ItemInput[] }

async function fetchEntries(source: SourceRecord, deps: SyncDeps): Promise<Fetched> {
  const now = deps.now ?? (() => new Date());
  if (source.kind === "arxiv") {
    const url = arxivQueryUrl(source.locator);
    const page = await deps.fetch(assertPublicHttpUrl(url), FEED_ACCEPT);
    const feed = parseFeed(page.bytes, page.mediaType, url, now);
    return { title: source.title, items: arxivItemsOf(feed) };
  }
  const page = await deps.fetch(assertPublicHttpUrl(source.locator), FEED_ACCEPT);
  const feed = parseFeed(page.bytes, page.mediaType, source.locator, now);
  return { title: feed.title, ...(feed.siteUrl ? { siteUrl: feed.siteUrl } : {}), items: feed.items };
}

/** Fetches, parses and upserts one source, then writes its health. A failure is stored on the source and returned, never dropped. */
export async function syncSource(source: SourceRecord, deps: SyncDeps): Promise<SyncSourceResult> {
  const now = deps.now ?? (() => new Date());
  try {
    const fetched = await fetchEntries(source, deps);
    const added = deps.items.upsert(source, fetched.items);
    const at = now().toISOString();
    const updated = deps.sources.updateHealth(source.id, { lastSyncAt: at, lastSuccessAt: at, failureCount: 0, title: fetched.title, ...(fetched.siteUrl ? { siteUrl: fetched.siteUrl } : {}) });
    return { ok: true, source: updated, added };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof FetchError ? error.code : "SYNC_FAILED";
    const updated = deps.sources.updateHealth(source.id, { lastSyncAt: now().toISOString(), failureCount: source.failureCount + 1, lastError: message });
    return { ok: false, code, message, source: updated };
  }
}

export function isDue(source: SourceRecord, now: Date): boolean {
  if (source.pausedAt) return false;
  if (!source.lastSyncAt) return true;
  return now.getTime() - new Date(source.lastSyncAt).getTime() >= source.intervalMinutes * 60_000;
}

export interface SyncDueOutcome {
  synced: number;
  added: number;
  failures: { source: SourceRecord; message: string }[];
}

/** Syncs every due source, two at a time; `onChanged` fires once when any source or item changed. */
export async function syncDue(deps: SyncDeps & { onChanged: () => void }): Promise<SyncDueOutcome> {
  const now = deps.now ?? (() => new Date());
  const queue = deps.sources.list().filter((source) => isDue(source, now()));
  const outcome: SyncDueOutcome = { synced: 0, added: 0, failures: [] };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let source = queue.shift(); source !== undefined; source = queue.shift()) {
      const result = await syncSource(source, deps);
      outcome.synced += 1;
      if (result.ok) outcome.added += result.added;
      else outcome.failures.push({ source: result.source, message: result.message });
    }
  }));
  if (outcome.synced > 0) deps.onChanged();
  return outcome;
}
