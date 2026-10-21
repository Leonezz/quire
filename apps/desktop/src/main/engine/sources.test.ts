import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { openDatabase } from "./db";
import type { FetchedPage, Fetcher } from "./fetch";
import { ItemStore } from "./items";
import { SourceStore, alternateFeedOf, detectSource, subscriptionOf } from "./sources";

const fixture = (name: string) => readFile(join(__dirname, "__fixtures__", name));

function answering(pages: Record<string, { bytes: string | Uint8Array; mediaType: string; finalUrl?: string }>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const fetcher = async (url: URL, accept?: string): Promise<FetchedPage> => {
    calls.push(`${url.toString()} ${accept ?? ""}`.trim());
    const page = pages[url.toString()];
    if (!page) throw new Error(`unexpected fetch ${url}`);
    const bytes = typeof page.bytes === "string" ? new TextEncoder().encode(page.bytes) : page.bytes;
    return { bytes, mediaType: page.mediaType, finalUrl: page.finalUrl ?? url.toString() };
  };
  return Object.assign(fetcher, { calls });
}

describe("SourceStore", () => {
  it("adds, lists, updates health, pauses and removes with its undecided items", () => {
    const db = openDatabase(":memory:");
    const items = new ItemStore(db, () => new Date("2026-09-18T00:00:00Z"));
    const sources = new SourceStore(db, items, () => new Date("2026-09-18T00:00:00Z"));
    const added = sources.add({ kind: "feed", locator: "https://systems.example.test/feed.xml", title: "Systems Notes", siteUrl: "https://systems.example.test/" });
    expect(added).toMatchObject({ kind: "feed", title: "Systems Notes", intervalMinutes: 30, failureCount: 0, itemCount: 0, keptCount: 0, weeklyRate: 0, addedAt: "2026-09-18T00:00:00.000Z" });
    expect(added.lastSyncAt).toBeUndefined();
    expect(() => sources.add({ kind: "feed", locator: "https://systems.example.test/feed.xml", title: "Again" })).toThrow(/Already subscribed/);
    const arxiv = sources.add({ kind: "arxiv", locator: "cs.CL", title: "arXiv cs.CL" });
    expect(sources.list().map((s) => s.id)).toEqual([added.id, arxiv.id]);

    items.upsert(added, [{ externalId: "a", title: "A", link: "https://x/a", publishedAt: "2026-09-17T00:00:00.000Z", gist: "", readingMinutes: 1, signals: {}, summaryOnly: true }]);
    expect(sources.get(added.id)?.itemCount).toBe(1);

    const failed = sources.updateHealth(added.id, { lastSyncAt: "2026-09-18T01:00:00.000Z", failureCount: 1, lastError: "The page answered 500." });
    expect(failed).toMatchObject({ failureCount: 1, lastError: "The page answered 500.", lastSyncAt: "2026-09-18T01:00:00.000Z" });
    const ok = sources.updateHealth(added.id, { lastSyncAt: "2026-09-18T02:00:00.000Z", lastSuccessAt: "2026-09-18T02:00:00.000Z", failureCount: 0, title: "Systems Notes, renamed" });
    expect(ok).toMatchObject({ failureCount: 0, lastSuccessAt: "2026-09-18T02:00:00.000Z", title: "Systems Notes, renamed" });
    expect(ok.lastError).toBeUndefined();

    expect(sources.pause(added.id, true).pausedAt).toBe("2026-09-18T00:00:00.000Z");
    expect(sources.pause(added.id, false).pausedAt).toBeUndefined();

    sources.remove(added.id);
    expect(sources.get(added.id)).toBeUndefined();
    expect(items.inbox()).toEqual([]);
    expect(() => sources.remove(added.id)).toThrow("SOURCE_NOT_FOUND");
    db.close();
  });
});

describe("detectSource", () => {
  it("recognises arXiv categories without fetching", async () => {
    const fetch = answering({});
    expect(await detectSource("cs.CL", fetch)).toEqual({ kind: "arxiv", category: "cs.CL", title: "arXiv cs.CL" });
    expect(await detectSource("https://arxiv.org/list/hep-th/recent", fetch)).toEqual({ kind: "arxiv", category: "hep-th", title: "arXiv hep-th" });
    expect(fetch.calls).toEqual([]);
  });

  it("recognises a direct feed by media type or by its root element", async () => {
    const rss = new Uint8Array(await fixture("blog.rss"));
    const fetch = answering({
      "https://systems.example.test/feed.xml": { bytes: rss, mediaType: "application/rss+xml" },
      "https://systems.example.test/feed": { bytes: rss, mediaType: "text/plain" },
      "https://beweise.example.test/feed.atom": { bytes: new Uint8Array(await fixture("blog.atom")), mediaType: "application/octet-stream", finalUrl: "https://beweise.example.test/feed.atom?x=1" },
    });
    expect(await detectSource("https://systems.example.test/feed.xml", fetch)).toEqual({ kind: "feed", url: "https://systems.example.test/feed.xml", title: "Systems Notes" });
    expect(await detectSource("systems.example.test/feed", fetch)).toEqual({ kind: "feed", url: "https://systems.example.test/feed", title: "Systems Notes" });
    expect(await detectSource("https://beweise.example.test/feed.atom", fetch)).toEqual({ kind: "feed", url: "https://beweise.example.test/feed.atom?x=1", title: "Beweise und Bilder" });
    expect(fetch.calls[0]).toContain("application/rss+xml,application/atom+xml");
  });

  it("finds the declared feed of a site's front page or the section it lives under, preferring Atom, and resolves relative hrefs", async () => {
    const html = `<!doctype html><html><head><title>Systems Notes — home</title>
      <link rel="stylesheet" href="/x.css">
      <link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
      <link rel="alternate" type="application/atom+xml" title="Atom" href="feed.atom"></head><body></body></html>`;
    const fetch = answering({
      "https://systems.example.test/": { bytes: html, mediaType: "text/html" },
      "https://systems.example.test/blog/": { bytes: html, mediaType: "text/html" },
    });
    expect(await detectSource("systems.example.test", fetch)).toEqual({ kind: "feed", url: "https://systems.example.test/feed.atom", title: "Systems Notes — home" });
    expect(await detectSource("https://systems.example.test/blog/", fetch)).toEqual({ kind: "feed", url: "https://systems.example.test/blog/feed.atom", title: "Systems Notes — home" });
    expect(alternateFeedOf('<link rel="alternate" type="application/rss+xml" href="/feed.xml">', "https://a.test/b/")).toBe("https://a.test/feed.xml");
    expect(alternateFeedOf('<link rel="alternate" type="text/html" href="/other">', "https://a.test/")).toBeUndefined();
  });

  it("reports any other page that declares a feed as a page to read, with the feed to offer", async () => {
    const html = (title: string) => `<!doctype html><html><head><title>${title}</title>
      <link rel="alternate" type="application/rss+xml" title="${title}" href="https://developers.example.test/rss.xml"></head><body></body></html>`;
    const fetch = answering({
      "https://developers.example.test/api/docs/guides/migrate": { bytes: html("Migrate | API"), mediaType: "text/html" },
      "https://developers.example.test/blog/": { bytes: html("Blog"), mediaType: "text/html" },
      "https://developers.example.test/?p=12": { bytes: html("A post"), mediaType: "text/html" },
    });
    for (const url of ["https://developers.example.test/api/docs/guides/migrate", "https://developers.example.test/blog/", "https://developers.example.test/?p=12"]) {
      expect(await detectSource(url, fetch)).toEqual({ kind: "page", url, feed: "https://developers.example.test/rss.xml" });
    }
  });

  it("still reads a page whose declared feed cannot be fetched, without offering that feed", async () => {
    const html = `<!doctype html><html><head><link rel="alternate" type="application/atom+xml" href="http://localhost:4000/feed.xml"></head><body></body></html>`;
    const fetch = answering({ "https://someone.example.test/2023/05/post.html": { bytes: html, mediaType: "text/html" } });
    expect(await detectSource("https://someone.example.test/2023/05/post.html", fetch)).toEqual({ kind: "page", url: "https://someone.example.test/2023/05/post.html" });
  });

  it("subscribes to a detected feed, a page's declared feed or an arXiv category, and to nothing for a page without one", () => {
    expect(subscriptionOf({ kind: "feed", url: "https://a.test/feed.xml", title: "A" })).toEqual({ kind: "feed", locator: "https://a.test/feed.xml", title: "A" });
    expect(subscriptionOf({ kind: "feed", url: "https://a.test/feed.xml" })).toEqual({ kind: "feed", locator: "https://a.test/feed.xml", title: "a.test" });
    expect(subscriptionOf({ kind: "page", url: "https://a.test/post", feed: "https://a.test/rss.xml" })).toEqual({ kind: "feed", locator: "https://a.test/rss.xml", title: "a.test" });
    expect(subscriptionOf({ kind: "arxiv", category: "cs.CL", title: "arXiv cs.CL" })).toEqual({ kind: "arxiv", locator: "cs.CL", title: "arXiv cs.CL" });
    expect(subscriptionOf({ kind: "page", url: "https://a.test/post" })).toBeUndefined();
  });

  it("reports a plain page and refuses private hosts", async () => {
    const fetch = answering({ "https://example.test/post": { bytes: "<!doctype html><html><head><title>A post</title></head><body>hi</body></html>", mediaType: "text/html" } });
    expect(await detectSource("https://example.test/post", fetch)).toEqual({ kind: "page", url: "https://example.test/post" });
    await expect(detectSource("http://localhost:3000/feed", fetch)).rejects.toThrow(/private/i);
    await expect(detectSource("not a url at all", fetch)).rejects.toThrow();
  });
});
