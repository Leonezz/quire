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
    expect(subscriptionOf({ kind: "podcast", url: "https://a.test/podcast.xml", title: "Show", siteUrl: "https://a.test" })).toEqual({ kind: "podcast", locator: "https://a.test/podcast.xml", title: "Show", siteUrl: "https://a.test" });
    expect(subscriptionOf({ kind: "episode", url: "https://podcasts.apple.com/us/podcast/x/id1?i=2", mediaKind: "audio", feed: "https://feeds.example.test/show.xml" })).toEqual({ kind: "podcast", locator: "https://feeds.example.test/show.xml", title: "feeds.example.test" });
  });

  it("recognises Podcast RSS feeds and Apple Podcasts show & episode URLs with region preservation", async () => {
    const podcastXml = `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Dwarkesh Podcast</title><link>https://www.dwarkeshpatel.com</link><item><title>Ep 1</title><enclosure url="https://cdn.example.test/ep1.mp3" type="audio/mpeg" length="1000" /></item></channel></rss>`;
    const lookupJson = JSON.stringify({
      resultCount: 2,
      results: [
        { wrapperType: "track", kind: "podcast", collectionId: 1516093381, collectionName: "Dwarkesh Podcast", feedUrl: "https://api.substack.com/feed/podcast/69345.rss", collectionViewUrl: "https://podcasts.apple.com/jp/podcast/id1516093381" },
        { wrapperType: "track", kind: "podcast-episode", collectionId: 1516093381, trackId: 1000678901234, trackName: "Ilya Sutskever — Scaling", trackTimeMillis: 6120000 },
      ],
    });
    const fetch = answering({
      "https://feeds.example.test/podcast.xml": { bytes: podcastXml, mediaType: "application/rss+xml" },
      "https://itunes.apple.com/lookup?id=1516093381&country=jp&entity=podcastEpisode&limit=200": { bytes: lookupJson, mediaType: "application/json" },
    });

    expect(await detectSource("https://feeds.example.test/podcast.xml", fetch)).toEqual({
      kind: "podcast",
      url: "https://feeds.example.test/podcast.xml",
      title: "Dwarkesh Podcast",
      siteUrl: "https://www.dwarkeshpatel.com/",
    });

    expect(await detectSource("https://podcasts.apple.com/jp/podcast/dwarkesh-podcast/id1516093381", fetch)).toEqual({
      kind: "podcast",
      url: "https://api.substack.com/feed/podcast/69345.rss",
      title: "Dwarkesh Podcast",
      siteUrl: "https://podcasts.apple.com/jp/podcast/id1516093381",
    });

    expect(await detectSource("https://podcasts.apple.com/jp/podcast/dwarkesh-podcast/id1516093381?i=1000678901234", fetch)).toEqual({
      kind: "episode",
      url: "https://podcasts.apple.com/jp/podcast/dwarkesh-podcast/id1516093381?i=1000678901234",
      mediaKind: "audio",
      title: "Ilya Sutskever — Scaling",
      durationSec: 6120,
      feed: "https://api.substack.com/feed/podcast/69345.rss",
    });
  });

  it("recognises YouTube channels, playlists, and single video links with channel subscription offer", async () => {
    const channelHtml = `<!doctype html><html><head><title>Andrej Karpathy - YouTube</title>
      <link rel="alternate" type="application/rss+xml" title="RSS" href="https://www.youtube.com/feeds/videos.xml?channel_id=UCXUPKJO5MZQN11PqgIvyuvQ">
      </head><body></body></html>`;
    const watchHtml = `<!doctype html><html><head><title>Intro to LLMs - YouTube</title></head><body>
      <script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"zjkBMFhNj_g","title":"Intro to Large Language Models","lengthSeconds":"3600","channelId":"UCXUPKJO5MZQN11PqgIvyuvQ","author":"Andrej Karpathy"}};</script>
      </body></html>`;
    const atomXml = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Deep Learning Lectures</title></feed>`;

    const fetch = answering({
      "https://www.youtube.com/@AndrejKarpathy": { bytes: channelHtml, mediaType: "text/html" },
      "https://www.youtube.com/watch?v=zjkBMFhNj_g": { bytes: watchHtml, mediaType: "text/html" },
      "https://www.youtube.com/feeds/videos.xml?playlist_id=PLAqhIrjkxbuWI23v9cThsA9GvCAUhRvKZ": { bytes: atomXml, mediaType: "application/atom+xml" },
    });

    expect(await detectSource("https://www.youtube.com/@AndrejKarpathy", fetch)).toEqual({
      kind: "youtube",
      url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCXUPKJO5MZQN11PqgIvyuvQ",
      channelId: "UCXUPKJO5MZQN11PqgIvyuvQ",
      title: "Andrej Karpathy",
    });

    expect(await detectSource("https://www.youtube.com/playlist?list=PLAqhIrjkxbuWI23v9cThsA9GvCAUhRvKZ", fetch)).toEqual({
      kind: "youtube",
      url: "https://www.youtube.com/feeds/videos.xml?playlist_id=PLAqhIrjkxbuWI23v9cThsA9GvCAUhRvKZ",
      title: "Deep Learning Lectures",
    });

    const videoDet = await detectSource("https://youtu.be/zjkBMFhNj_g?si=xyz", fetch);
    expect(videoDet).toEqual({
      kind: "episode",
      url: "https://www.youtube.com/watch?v=zjkBMFhNj_g",
      mediaKind: "video",
      title: "Intro to Large Language Models",
      durationSec: 3600,
      feed: "https://www.youtube.com/feeds/videos.xml?channel_id=UCXUPKJO5MZQN11PqgIvyuvQ",
      feedTitle: "Andrej Karpathy",
    });
    expect(subscriptionOf(videoDet)).toEqual({
      kind: "youtube",
      locator: "https://www.youtube.com/feeds/videos.xml?channel_id=UCXUPKJO5MZQN11PqgIvyuvQ",
      title: "Andrej Karpathy",
    });
  });

  it("reports a plain page and refuses private hosts", async () => {
    const fetch = answering({ "https://example.test/post": { bytes: "<!doctype html><html><head><title>A post</title></head><body>hi</body></html>", mediaType: "text/html" } });
    expect(await detectSource("https://example.test/post", fetch)).toEqual({ kind: "page", url: "https://example.test/post" });
    await expect(detectSource("http://localhost:3000/feed", fetch)).rejects.toThrow(/private/i);
    await expect(detectSource("not a url at all", fetch)).rejects.toThrow();
  });
});
