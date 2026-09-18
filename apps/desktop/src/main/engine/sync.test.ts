import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./db";
import { FetchError, type FetchedPage, type Fetcher } from "./fetch";
import { ItemStore } from "./items";
import { SourceStore } from "./sources";
import { isDue, syncDue, syncSource } from "./sync";

const fixture = (name: string) => readFile(join(__dirname, "__fixtures__", name));

function setup(clock: () => Date) {
  const db = openDatabase(":memory:");
  const items = new ItemStore(db, clock);
  const sources = new SourceStore(db, items, clock);
  return { db, items, sources, now: clock };
}

function fetcherOf(answer: (url: URL) => Promise<FetchedPage>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  return Object.assign(async (url: URL) => { calls.push(url.toString()); return answer(url); }, { calls });
}

describe("syncSource", () => {
  it("fetches a feed, upserts its entries and records a healthy sync", async () => {
    let clock = new Date("2026-09-18T10:00:00Z");
    const { items, sources, db, now } = setup(() => clock);
    const rss = new Uint8Array(await fixture("blog.rss"));
    const fetch = fetcherOf(async () => ({ bytes: rss, mediaType: "application/rss+xml", finalUrl: "https://systems.example.test/feed.xml" }));
    const source = sources.add({ kind: "feed", locator: "https://systems.example.test/feed.xml", title: "pending" });
    const first = await syncSource(source, { fetch, sources, items, now });
    expect(first).toMatchObject({ ok: true, added: 3 });
    if (!first.ok) return;
    expect(first.source).toMatchObject({ title: "Systems Notes", siteUrl: "https://systems.example.test/", lastSyncAt: "2026-09-18T10:00:00.000Z", lastSuccessAt: "2026-09-18T10:00:00.000Z", failureCount: 0, itemCount: 3 });
    expect(items.inbox().map((item) => item.sourceTitle)).toEqual(["pending", "pending", "pending"]);
    clock = new Date("2026-09-18T11:00:00Z");
    const second = await syncSource(first.source, { fetch, sources, items, now });
    expect(second).toMatchObject({ ok: true, added: 0 });
    expect(items.inbox().map((item) => item.sourceTitle)).toEqual(["Systems Notes", "Systems Notes", "Systems Notes"]);
    expect(fetch.calls).toEqual(["https://systems.example.test/feed.xml", "https://systems.example.test/feed.xml"]);
    db.close();
  });

  it("syncs an arXiv category through the export API", async () => {
    const { items, sources, db, now } = setup(() => new Date("2026-09-18T10:00:00Z"));
    const atom = new Uint8Array(await fixture("arxiv-cs-cl.atom"));
    const fetch = fetcherOf(async (url) => ({ bytes: atom, mediaType: "application/atom+xml", finalUrl: url.toString() }));
    const source = sources.add({ kind: "arxiv", locator: "cs.CL", title: "arXiv cs.CL" });
    const result = await syncSource(source, { fetch, sources, items, now });
    expect(result).toMatchObject({ ok: true, added: 3 });
    expect(fetch.calls).toEqual(["https://export.arxiv.org/api/query?search_query=cat:cs.CL&sortBy=submittedDate&sortOrder=descending&max_results=50"]);
    const inbox = items.inbox();
    expect(inbox[0]).toMatchObject({ sourceKind: "arxiv", sourceTitle: "arXiv cs.CL", link: "https://arxiv.org/abs/2409.12345", readingMinutes: 20, signals: { math: true } });
    expect(result.source.title).toBe("arXiv cs.CL");
    db.close();
  });

  it("stores and returns the failure, counting consecutive failures until the next success", async () => {
    let clock = new Date("2026-09-18T10:00:00Z");
    const { items, sources, db, now } = setup(() => clock);
    let answer: () => Promise<FetchedPage> = async () => { throw new FetchError("HTTP_503", "The page answered 503."); };
    const fetch = fetcherOf(() => answer());
    const source = sources.add({ kind: "feed", locator: "https://down.example.test/feed", title: "Down" });
    const first = await syncSource(source, { fetch, sources, items, now });
    expect(first).toMatchObject({ ok: false, code: "HTTP_503", message: "The page answered 503." });
    expect(first.source).toMatchObject({ failureCount: 1, lastError: "The page answered 503.", lastSyncAt: "2026-09-18T10:00:00.000Z" });
    expect(first.source.lastSuccessAt).toBeUndefined();

    answer = async () => ({ bytes: new TextEncoder().encode("<!doctype html><html><body>not a feed</body></html>"), mediaType: "text/html", finalUrl: "https://down.example.test/feed" });
    clock = new Date("2026-09-18T11:00:00Z");
    const second = await syncSource(first.source, { fetch, sources, items, now });
    expect(second).toMatchObject({ ok: false, code: "SYNC_FAILED" });
    expect(second.source.failureCount).toBe(2);
    expect(second.source.lastError).toMatch(/Not a feed/);

    const rss = new Uint8Array(await fixture("blog.rss"));
    answer = async () => ({ bytes: rss, mediaType: "application/rss+xml", finalUrl: "https://down.example.test/feed" });
    clock = new Date("2026-09-18T12:00:00Z");
    const third = await syncSource(second.source, { fetch, sources, items, now });
    expect(third.ok).toBe(true);
    expect(third.source).toMatchObject({ failureCount: 0, lastSuccessAt: "2026-09-18T12:00:00.000Z" });
    expect(third.source.lastError).toBeUndefined();
    db.close();
  });
});

describe("syncDue", () => {
  it("skips paused and recently synced sources and fires onChanged once", async () => {
    const clock = () => new Date("2026-09-18T10:00:00Z");
    const { items, sources, db, now } = setup(clock);
    const rss = new Uint8Array(await fixture("blog.rss"));
    const fetch = fetcherOf(async (url) => ({ bytes: rss, mediaType: "application/rss+xml", finalUrl: url.toString() }));
    const due = sources.add({ kind: "feed", locator: "https://a.example.test/feed", title: "A" });
    const fresh = sources.add({ kind: "feed", locator: "https://b.example.test/feed", title: "B" });
    const stale = sources.add({ kind: "feed", locator: "https://c.example.test/feed", title: "C" });
    const paused = sources.add({ kind: "feed", locator: "https://d.example.test/feed", title: "D" });
    sources.updateHealth(fresh.id, { lastSyncAt: "2026-09-18T09:45:00.000Z", failureCount: 0 });
    sources.updateHealth(stale.id, { lastSyncAt: "2026-09-18T09:00:00.000Z", failureCount: 0 });
    sources.pause(paused.id, true);
    expect(isDue(sources.get(due.id)!, clock())).toBe(true);
    expect(isDue(sources.get(fresh.id)!, clock())).toBe(false);
    expect(isDue(sources.get(stale.id)!, clock())).toBe(true);
    expect(isDue(sources.get(paused.id)!, clock())).toBe(false);

    let changed = 0;
    const outcome = await syncDue({ fetch, sources, items, now, onChanged: () => { changed += 1; } });
    expect(outcome).toEqual({ synced: 2, added: 6, failures: [] });
    expect(changed).toBe(1);
    expect(fetch.calls.sort()).toEqual(["https://a.example.test/feed", "https://c.example.test/feed"]);

    const again = await syncDue({ fetch, sources, items, now, onChanged: () => { changed += 1; } });
    expect(again).toEqual({ synced: 0, added: 0, failures: [] });
    expect(changed).toBe(1);
    db.close();
  });

  it("collects failures instead of stopping at the first one", async () => {
    const { items, sources, db, now } = setup(() => new Date("2026-09-18T10:00:00Z"));
    const fetch = fetcherOf(async () => { throw new FetchError("NETWORK", "fetch failed"); });
    sources.add({ kind: "feed", locator: "https://a.example.test/feed", title: "A" });
    sources.add({ kind: "feed", locator: "https://b.example.test/feed", title: "B" });
    const outcome = await syncDue({ fetch, sources, items, now, onChanged: () => {} });
    expect(outcome.synced).toBe(2);
    expect(outcome.failures.map((f) => f.message)).toEqual(["fetch failed", "fetch failed"]);
    expect(sources.list().map((s) => s.failureCount)).toEqual([1, 1]);
    db.close();
  });
});
