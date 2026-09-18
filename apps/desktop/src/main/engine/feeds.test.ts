import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gistOf, parseFeed } from "./feeds";

const fixture = (name: string) => readFile(join(__dirname, "__fixtures__", name));
const NOW = () => new Date("2026-09-18T12:00:00Z");

describe("parseFeed", () => {
  it("maps an RSS 2.0 feed: full entries carry content and signals, short ones are summary-only", async () => {
    const feed = parseFeed(new Uint8Array(await fixture("blog.rss")), "application/rss+xml", "https://systems.example.test/feed.xml", NOW);
    expect(feed.title).toBe("Systems Notes");
    expect(feed.siteUrl).toBe("https://systems.example.test/");
    expect(feed.items.map((item) => item.title)).toEqual(["Cache keys that include the prompt", "A short note on fair schedulers", "Why the retry budget is a proof"]);

    const [full, short, math] = feed.items;
    expect(full!.link).toBe("https://systems.example.test/posts/cache-keys");
    expect(full!.publishedAt).toBe("2026-09-14T09:30:00.000Z");
    expect(full!.summaryOnly).toBe(false);
    expect(full!.signals).toEqual({ code: true, figures: true, lang: "en-us" });
    expect(full!.readingMinutes).toBe(1);
    expect(full!.gist.startsWith("Two harnesses cache the tokenised prompt")).toBe(true);
    expect(full!.gist.length).toBeLessThanOrEqual(300);
    expect(full!.content?.reader?.schema).toBe("reader.document.v2");
    expect(full!.content?.markdown).toContain("```");
    expect(full!.content?.plain).toContain("cache_key");

    expect(short!.summaryOnly).toBe(true);
    expect(short!.content).toBeUndefined();
    expect(short!.gist).toBe("A fair scheduler that never overlaps runs is easier to reason about than one that tries to catch up. Skip the tick, log it, move on.");
    expect(short!.signals).toEqual({ lang: "en-us" });

    expect(math!.summaryOnly).toBe(false);
    expect(math!.signals.math).toBe(true);
    expect(math!.signals.code).toBeUndefined();
    expect(math!.signals.figures).toBeUndefined();
  });

  it("maps an Atom feed with the root language and summary-only entries", async () => {
    const feed = parseFeed(new Uint8Array(await fixture("blog.atom")), "application/atom+xml", "https://beweise.example.test/feed.atom", NOW);
    expect(feed.title).toBe("Beweise und Bilder");
    expect(feed.siteUrl).toBe("https://beweise.example.test/");
    expect(feed.lang).toBe("de");
    const [full, lemma, slow] = feed.items;
    expect(full!.summaryOnly).toBe(false);
    expect(full!.signals).toEqual({ code: true, figures: true, lang: "de" });
    expect(full!.externalId).toHaveLength(64);
    expect(lemma!.summaryOnly).toBe(true);
    expect(lemma!.gist).toBe("Every bounded monotone sequence converges; the proof is the supremum.");
    expect(slow!.summaryOnly).toBe(true);
    expect(slow!.signals.math).toBe(true);
  });

  it("falls back to now for entries without a date", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>https://t.example.test/</link><description>d</description><item><title>Undated</title><link>https://t.example.test/a</link></item></channel></rss>`;
    const feed = parseFeed(new TextEncoder().encode(xml), "text/xml", "https://t.example.test/feed", NOW);
    expect(feed.items[0]!.publishedAt).toBe("2026-09-18T12:00:00.000Z");
    expect(feed.items[0]!.readingMinutes).toBe(1);
  });

  it("refuses HTML and malformed documents with a message that says what to do", () => {
    const html = new TextEncoder().encode("<!doctype html><html><head><title>Home</title></head><body>hi</body></html>");
    expect(() => parseFeed(html, "text/html", "https://x.example.test/")).toThrow(/Not a feed: .* HTML page/);
    expect(() => parseFeed(new TextEncoder().encode("<root><x/></root>"), "application/xml", "https://x.example.test/f")).toThrow(/neither RSS 2.0 nor Atom/);
    expect(() => parseFeed(new TextEncoder().encode("{\"json\": true}"), "application/json", "https://x.example.test/f")).toThrow(/Not a feed/);
  });
});

describe("gistOf", () => {
  it("collapses whitespace and cuts at a sentence boundary inside 300 characters", () => {
    const sentence = "This is a sentence that carries some words and then ends. ";
    const gist = gistOf(`  ${sentence.repeat(10)}`);
    expect(gist.length).toBeLessThanOrEqual(300);
    expect(gist.endsWith(".")).toBe(true);
    expect(gist).not.toContain("  ");
  });

  it("cuts at a word when no sentence ends in time", () => {
    const gist = gistOf("word ".repeat(200));
    expect(gist.length).toBeLessThanOrEqual(300);
    expect(gist.endsWith("…")).toBe(true);
  });
});
