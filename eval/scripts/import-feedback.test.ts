// Unit tests for import-feedback: the slug rule, the corpus.json append, and the whole import
// against a bundle in a temp directory (never the real eval/corpus).
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendCorpusEntry, deriveSlug, importFeedback } from "./import-feedback.mjs";

describe("deriveSlug", () => {
  it.each([
    ["https://simonwillison.net/2024/Dec/31/llms-in-2024/", "simonwillison-llms-in-2024"],
    ["https://karpathy.github.io/2015/05/21/rnn-effectiveness/", "karpathy-rnn-effectiveness"],
    ["https://www.paulgraham.com/greatwork.html", "paulgraham-greatwork"],
    ["https://blog.cloudflare.com/how-we-built-pingora/", "cloudflare-how-we-built-pingora"],
    ["https://huyenchip.com/2023/04/11/llm-engineering.html", "huyenchip-llm-engineering"],
    ["https://danluu.com/", "danluu-home"],
    ["https://example.org/posts/2024/07/", "example-posts"],
    ["https://www.ruanyifeng.com/blog/2019/09/curl-reference.html?utm=1#top", "ruanyifeng-curl-reference"],
    ["https://x.test/%E4%B8%AD%E6%96%87/Hello World!", "x-hello-world"],
  ])("%s → %s", (url, slug) => {
    expect(deriveSlug(url)).toBe(slug);
  });

  it("caps the length", () => {
    expect(deriveSlug(`https://host.test/${"a".repeat(100)}`).length).toBeLessThanOrEqual(60);
  });
});

describe("appendCorpusEntry", () => {
  const original = JSON.stringify([{ slug: "a", url: "https://a.test/", framework: "hugo", tags: [] }], null, 2);

  it("appends an entry, keeps the format, and leaves the input alone", () => {
    const next = appendCorpusEntry(original, { slug: "b", url: "https://b.test/x", framework: "unknown", tags: ["images", "feedback"] });
    expect(JSON.parse(next)).toEqual([{ slug: "a", url: "https://a.test/", framework: "hugo", tags: [] }, { slug: "b", url: "https://b.test/x", framework: "unknown", tags: ["images", "feedback"] }]);
    expect(next.endsWith("\n")).toBe(false);
    expect(appendCorpusEntry(`${original}\n`, { slug: "b", url: "u", framework: "f", tags: [] }).endsWith("\n")).toBe(true);
    expect(JSON.parse(original)).toHaveLength(1);
  });

  it("refuses a duplicate slug", () => {
    expect(() => appendCorpusEntry(original, { slug: "a", url: "u", framework: "f", tags: [] })).toThrow(/slug a already exists/);
  });
});

describe("importFeedback", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function evalRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "quire-eval-"));
    dirs.push(root);
    mkdirSync(join(root, "corpus"));
    writeFileSync(join(root, "corpus.json"), JSON.stringify([{ slug: "taken", url: "https://taken.test/", framework: "x", tags: [] }], null, 2));
    return root;
  }

  function bundle(options: { capture?: boolean; url?: string } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "quire-bundle-"));
    dirs.push(dir);
    const url = options.url ?? "https://blog.example.test/2026/09/broken-page/";
    const included = options.capture ?? true;
    writeFileSync(join(dir, "report.json"), JSON.stringify({ id: "f1", url, title: "Broken", kinds: ["missing_content", "tables"], note: "", app: { version: "0.1", platform: "darwin", normalize: "0.0.1" }, capture: { included } }));
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ slug: "app-side-slug", url, finalUrl: url, status: 200, contentType: "text/html", bytes: 12, generator: "", fetchedAt: "2026-09-23T00:00:00Z", framework: "", tags: [] }));
    if (included) writeFileSync(join(dir, "page.html.gz"), gzipSync(Buffer.from("<html><body><p>hi</p></body></html>")));
    return dir;
  }

  it("copies the capture and meta into eval/corpus/<slug> and appends to corpus.json with the report kinds + feedback as tags", () => {
    const root = evalRoot();
    const result = importFeedback({ bundlePath: bundle(), evalRoot: root });
    expect(result.slug).toBe("example-broken-page");
    expect(existsSync(join(root, "corpus", "example-broken-page", "page.html.gz"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(root, "corpus", "example-broken-page", "meta.json"), "utf8")) as Record<string, unknown>;
    expect(meta).toMatchObject({ slug: "example-broken-page", framework: "unknown", tags: ["missing_content", "tables", "feedback"], finalUrl: "https://blog.example.test/2026/09/broken-page/" });
    const corpus = JSON.parse(readFileSync(join(root, "corpus.json"), "utf8")) as { slug: string; tags: string[] }[];
    expect(corpus.map((entry) => entry.slug)).toEqual(["taken", "example-broken-page"]);
    expect(corpus[1]?.tags).toEqual(["missing_content", "tables", "feedback"]);
  });

  it("honours --slug", () => {
    const root = evalRoot();
    expect(importFeedback({ bundlePath: bundle(), evalRoot: root, slugOverride: "custom" }).slug).toBe("custom");
    expect(existsSync(join(root, "corpus", "custom", "meta.json"))).toBe(true);
  });

  it("refuses a bundle without the capture, and leaves corpus.json untouched", () => {
    const root = evalRoot();
    expect(() => importFeedback({ bundlePath: bundle({ capture: false }), evalRoot: root })).toThrow(/no page\.html\.gz/);
    expect(JSON.parse(readFileSync(join(root, "corpus.json"), "utf8"))).toHaveLength(1);
  });

  it("refuses a slug that is already in corpus.json or on disk", () => {
    const root = evalRoot();
    expect(() => importFeedback({ bundlePath: bundle({ url: "https://taken.test/" }), evalRoot: root, slugOverride: "taken" })).toThrow(/already exists/);
    mkdirSync(join(root, "corpus", "example-broken-page"));
    expect(() => importFeedback({ bundlePath: bundle(), evalRoot: root })).toThrow(/eval\/corpus\/example-broken-page already exists/);
  });
});
