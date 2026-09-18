import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Database } from "./db";
import { EventStore } from "./events";
import { FetchError, type FetchedPage, type Fetcher } from "./fetch";
import { readItem } from "./inbox";
import { ItemStore } from "./items";
import { MaterialStore } from "./materials";

let root = "";
let db: Database;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-inbox-")); db = openDatabase(":memory:"); });
afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); });

function fetcherOf(answer: (url: URL) => Promise<FetchedPage>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  return Object.assign(async (url: URL) => { calls.push(url.toString()); return answer(url); }, { calls });
}

const html = (title: string) => new TextEncoder().encode(`<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>${"<p>A paragraph long enough for the extractor to keep, repeated so the article has a body worth reading and a few sentences to count.</p>".repeat(8)}</article></body></html>`);

describe("readItem", () => {
  it("tries the arXiv HTML rendering first and falls back to the PDF on 404", async () => {
    const pdf = new Uint8Array(await readFile(join(__dirname, "__fixtures__", "two-pages.pdf")));
    const fetch = fetcherOf(async (url) => {
      if (url.pathname.startsWith("/html/")) throw new FetchError("HTTP_404", "The page answered 404.");
      return { bytes: pdf, mediaType: "application/pdf", finalUrl: url.toString() };
    });
    const store = new MaterialStore(root, fetch);
    const items = new ItemStore(db);
    const events = new EventStore(db);
    const warnings: string[] = [];
    items.upsert({ id: "arxiv", title: "arXiv cs.CL", kind: "arxiv" }, [{ externalId: "2409.12345", title: "Paper", link: "https://arxiv.org/abs/2409.12345", publishedAt: "2026-09-17T00:00:00.000Z", gist: "", readingMinutes: 20, signals: { math: true }, summaryOnly: false }]);
    const item = items.inbox()[0]!;
    let materialized = 0;
    const result = await readItem(item.id, { items, events, store, warn: (m) => warnings.push(m), onMaterialized: () => { materialized += 1; } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fetch.calls).toEqual(["https://arxiv.org/html/2409.12345", "https://arxiv.org/pdf/2409.12345"]);
    expect(result.material).toMatchObject({ mediaType: "application/pdf", origin: "feed" });
    expect(items.get(item.id)).toMatchObject({ materialId: result.material.id });
    expect(items.get(item.id)?.openedAt).toBeDefined();
    expect(events.list("opened").map((e) => e.ref)).toEqual([item.id]);
    expect(materialized).toBe(1);
    expect(warnings).toEqual([]);

    const again = await readItem(item.id, { items, events, store, warn: () => {} , onMaterialized: () => { materialized += 1; } });
    expect(again.ok && again.material.id).toBe(result.material.id);
    expect(fetch.calls).toHaveLength(2);
    expect(materialized).toBe(1);
    expect(events.list("opened")).toHaveLength(2);
  });

  it("reports both failures when neither arXiv rendering can be read", async () => {
    const fetch = fetcherOf(async () => { throw new FetchError("HTTP_503", "The page answered 503."); });
    const store = new MaterialStore(root, fetch);
    const items = new ItemStore(db);
    items.upsert({ id: "arxiv", title: "arXiv cs.CL", kind: "arxiv" }, [{ externalId: "2409.1", title: "Paper", link: "https://arxiv.org/abs/2409.10021", publishedAt: "2026-09-17T00:00:00.000Z", gist: "", readingMinutes: 20, signals: {}, summaryOnly: false }]);
    const result = await readItem(items.inbox()[0]!.id, { items, events: new EventStore(db), store, warn: () => {} });
    expect(result).toMatchObject({ ok: false, code: "HTTP_503" });
    expect(!result.ok && result.message).toMatch(/Neither the HTML rendering .* nor the PDF/);
    expect(items.inbox()).toHaveLength(1);
  });

  it("reads a feed item from its page when the fetch works", async () => {
    const fetch = fetcherOf(async (url) => ({ bytes: html("Cache keys"), mediaType: "text/html", finalUrl: url.toString() }));
    const store = new MaterialStore(root, fetch);
    const items = new ItemStore(db);
    items.upsert({ id: "feed", title: "Systems Notes", kind: "feed" }, [{ externalId: "a", title: "Cache keys", link: "https://systems.example.test/posts/cache-keys", publishedAt: "2026-09-14T00:00:00.000Z", gist: "", readingMinutes: 2, signals: {}, summaryOnly: true }]);
    const result = await readItem(items.inbox()[0]!.id, { items, events: new EventStore(db), store, warn: () => { throw new Error("no warning expected"); } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material).toMatchObject({ title: "Cache keys", origin: "feed", problems: [] });
  });

  it("falls back to the feed's copy when the page cannot be fetched, and says so", async () => {
    const fetch = fetcherOf(async () => { throw new FetchError("NETWORK", "getaddrinfo ENOTFOUND"); });
    const store = new MaterialStore(root, fetch);
    const items = new ItemStore(db);
    const events = new EventStore(db);
    const content = { reader: { schema: "reader.document.v2" as const, payload: JSON.stringify({ type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: "Hello from the feed" }] }], losses: [] }) }, markdown: "Hello from the feed", plain: "Hello from the feed" };
    items.upsert({ id: "feed", title: "Systems Notes", kind: "feed" }, [
      { externalId: "full", title: "Cache keys", link: "https://systems.example.test/posts/cache-keys", publishedAt: "2026-09-14T00:00:00.000Z", gist: "", readingMinutes: 2, signals: { lang: "en" }, summaryOnly: false, content },
      { externalId: "short", title: "Short", link: "https://systems.example.test/posts/short", publishedAt: "2026-09-13T00:00:00.000Z", gist: "", readingMinutes: 1, signals: {}, summaryOnly: true },
    ]);
    const [full, short] = items.inbox();
    const warnings: string[] = [];
    const result = await readItem(full!.id, { items, events, store, warn: (m) => warnings.push(m) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material).toMatchObject({ title: "Cache keys", origin: "feed", url: "https://systems.example.test/posts/cache-keys", lang: "en", publishedAt: "2026-09-14T00:00:00.000Z", markdown: "Hello from the feed", reader: content.reader });
    expect(result.material.problems.map((p) => p.code)).toEqual(["FEED_CONTENT_FALLBACK"]);
    expect(warnings).toEqual(["Could not fetch https://systems.example.test/posts/cache-keys (NETWORK: getaddrinfo ENOTFOUND); showing the feed's copy."]);
    expect(await store.get(result.material.id)).toMatchObject({ title: "Cache keys" });
    expect(items.get(full!.id)?.materialId).toBe(result.material.id);

    const noCopy = await readItem(short!.id, { items, events, store, warn: (m) => warnings.push(m) });
    expect(noCopy).toMatchObject({ ok: false, code: "NETWORK", message: "getaddrinfo ENOTFOUND" });
    expect(warnings).toHaveLength(1);
    expect(items.get(short!.id)?.openedAt).toBeUndefined();
  });

  it("answers ITEM_NOT_FOUND for unknown ids", async () => {
    const store = new MaterialStore(root, async () => { throw new Error("no fetch"); });
    const result = await readItem("missing", { items: new ItemStore(db), events: new EventStore(db), store, warn: () => {} });
    expect(result).toMatchObject({ ok: false, code: "ITEM_NOT_FOUND" });
  });
});
