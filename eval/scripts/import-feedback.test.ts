// Unit tests for import-feedback: the slug rules, the corpus.json / sources.json appends, the zip
// reader, and the whole import against reports in temp directories (never the real eval/corpus).
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendCorpusEntry, appendPdfSource, deriveSlug, derivePdfSlug, describeFeedback, importFeedback, readZip } from "./import-feedback.mjs";

/** A minimal zip writer (deflated entries, or stored with `store`), so the fixtures need no zip tool. */
function zip(files: Record<string, string | Uint8Array>, options: { store?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const name = Buffer.from(path, "utf8");
    const data = Buffer.from(content);
    const packed = options.store ? data : deflateRawSync(data);
    const method = options.store ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  const count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

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

  it("asks for --slug when the URL has no host", () => {
    expect(() => deriveSlug("about:blank")).toThrow(/pass --slug/);
  });
});

describe("derivePdfSlug", () => {
  it("uses the web rule for http(s) and the file name for a local PDF", () => {
    expect(derivePdfSlug("https://arxiv.org/pdf/2106.09685")).toBe("arxiv-2106-09685");
    expect(derivePdfSlug("file:///Users/me/Papers/Some%20Paper%20v2.pdf")).toBe("some-paper-v2");
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

describe("appendPdfSource", () => {
  const original = `${JSON.stringify([{ slug: "p", url: "https://p.test/a.pdf", kind: "arxiv", layout: "two-column" }], null, 2)}\n`;

  it("appends in the sources.json shape and keeps the trailing newline", () => {
    const next = appendPdfSource(original, { slug: "q", url: "https://q.test/b.pdf", kind: "feedback", layout: "unknown" });
    expect(JSON.parse(next)[1]).toEqual({ slug: "q", url: "https://q.test/b.pdf", kind: "feedback", layout: "unknown" });
    expect(next.endsWith("]\n")).toBe(true);
  });

  it("refuses a duplicate slug always, and a duplicate URL unless allowed", () => {
    expect(() => appendPdfSource(original, { slug: "p", url: "u", kind: "k", layout: "l" }, { allowSameUrl: true })).toThrow(/slug p already exists/);
    expect(() => appendPdfSource(original, { slug: "r", url: "https://p.test/a.pdf", kind: "k", layout: "l" })).toThrow(/already in eval\/pdf\/sources\.json as p/);
    expect(JSON.parse(appendPdfSource(original, { slug: "r", url: "https://p.test/a.pdf", kind: "k", layout: "l" }, { allowSameUrl: true }))).toHaveLength(2);
  });
});

describe("readZip", () => {
  it("reads stored and deflated entries and skips directories and Finder litter", () => {
    const files = { "a.txt": "hello", "dir/b.bin": new Uint8Array([0, 1, 2, 255]), "__MACOSX/._a.txt": "x", "dir/.DS_Store": "y" };
    for (const store of [false, true]) {
      const read = readZip(zip(files, { store }));
      expect([...read.keys()]).toEqual(["a.txt", "dir/b.bin"]);
      expect(read.get("a.txt")?.toString()).toBe("hello");
      expect([...(read.get("dir/b.bin") ?? [])]).toEqual([0, 1, 2, 255]);
    }
  });

  it("refuses entries outside the bundle, corrupt data and non-zips", () => {
    expect(() => readZip(zip({ "../evil": "x" }))).toThrow(/outside the bundle/);
    const corrupt = zip({ "a.txt": "hello" }, { store: true });
    corrupt[30 + "a.txt".length] ^= 0xff;
    expect(() => readZip(corrupt)).toThrow(/corrupt/);
    expect(() => readZip(Buffer.from("not a zip at all, just some text"))).toThrow(/not a zip/);
  });
});

describe("importFeedback", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  const tempDir = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
  const WEB_URL = "https://blog.example.test/2026/09/broken-page/";
  const PDF_URL = "https://arxiv.org/pdf/2609.12345";
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const PDF = Buffer.from("%PDF-1.7\n%fake\n");
  const selection = { quote: "the broken table", prefix: "Here comes ", suffix: " and more text" };

  function evalRoot(): string {
    const root = tempDir("quire-eval-");
    mkdirSync(join(root, "corpus"));
    mkdirSync(join(root, "pdf", "corpus"), { recursive: true });
    writeFileSync(join(root, "corpus.json"), JSON.stringify([{ slug: "taken", url: "https://taken.test/", framework: "x", tags: [] }], null, 2));
    writeFileSync(join(root, "pdf", "sources.json"), `${JSON.stringify([{ slug: "arxiv-old", url: "https://arxiv.org/pdf/1810.04805", kind: "arxiv", layout: "two-column ACL/NAACL" }], null, 2)}\n`);
    return root;
  }

  /** The files of a one-step report, as the app packs them. */
  function reportFiles(options: { view?: string; capture?: boolean; url?: string } = {}): Record<string, string | Uint8Array> {
    const view = options.view ?? "web";
    const url = options.url ?? (view === "web" ? WEB_URL : PDF_URL);
    const included = options.capture ?? true;
    const pdf = view === "pdf" || view === "text";
    const files: Record<string, string | Uint8Array> = {
      "report.json": JSON.stringify({ id: "0123456789abcdef", createdAt: "2026-10-13T00:00:00Z", url, title: "Broken", view, kinds: ["missing_content", "tables"], note: "table lost its rows", app: { version: "0.1", platform: "darwin", normalize: "0.0.1" }, capture: { included }, selection, readerState: { scrollFraction: 0.4, prefs: { fontSize: 18 } } }),
      "meta.json": JSON.stringify({ slug: "app-side-slug", url, finalUrl: url, status: 200, contentType: pdf ? "application/pdf" : "text/html", bytes: 12, generator: "", fetchedAt: "2026-09-23T00:00:00Z", framework: "", tags: [] }),
      "extracted.md": "# Broken\n",
      "reader-document.json": "{}",
      "screenshots/reader-viewport.png": PNG,
      "screenshots/original-top.jpg": PNG,
      "composite.png": PNG,
    };
    if (included && pdf) files["original.pdf"] = PDF;
    if (included && !pdf) files["page.html.gz"] = gzipSync(Buffer.from("<html><body><p>hi</p></body></html>"));
    return files;
  }

  function bundleDir(files: Record<string, string | Uint8Array>): string {
    const dir = tempDir("quire-bundle-");
    for (const [name, content] of Object.entries(files)) { mkdirSync(join(dir, name, ".."), { recursive: true }); writeFileSync(join(dir, name), content); }
    return dir;
  }

  function bundleZip(files: Record<string, string | Uint8Array>, folder?: string): string {
    const path = join(tempDir("quire-zip-"), "quire-report-broken-0123456789abcdef.zip");
    writeFileSync(path, zip(Object.fromEntries(Object.entries(files).map(([name, content]) => [folder ? `${folder}/${name}` : name, content]))));
    return path;
  }

  const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

  it("imports a web report zip: capture + meta + feedback.json into eval/corpus/<slug>, corpus.json entry, screenshots aside", () => {
    const root = evalRoot();
    const result = importFeedback({ bundlePath: bundleZip(reportFiles()), evalRoot: root });
    expect(result).toMatchObject({ type: "web", slug: "example-broken-page", framework: "unknown", tags: ["missing_content", "tables", "feedback"] });
    const caseDir = join(root, "corpus", "example-broken-page");
    expect(existsSync(join(caseDir, "page.html.gz"))).toBe(true);
    expect(existsSync(join(caseDir, "composite.png"))).toBe(false);
    expect(readJson(join(caseDir, "meta.json"))).toMatchObject({ slug: "example-broken-page", framework: "unknown", tags: ["missing_content", "tables", "feedback"], finalUrl: WEB_URL });
    expect(readJson(join(caseDir, "feedback.json"))).toMatchObject({ slug: "example-broken-page", view: "web", note: "table lost its rows", selection, readerState: { scrollFraction: 0.4 } });
    const corpus = readJson(join(root, "corpus.json")) as { slug: string; tags: string[] }[];
    expect(corpus.map((entry) => entry.slug)).toEqual(["taken", "example-broken-page"]);
    expect(corpus[1]?.tags).toEqual(["missing_content", "tables", "feedback"]);
    const shots = join(root, "feedback-screenshots", "example-broken-page");
    expect(existsSync(join(shots, "composite.png"))).toBe(true);
    expect([...readFileSync(join(shots, "screenshots", "reader-viewport.png"))]).toEqual([...PNG]);
    expect(result.screenshots).toHaveLength(3);
    expect(describeFeedback(result.feedback)).toEqual(["Reported: missing_content, tables", "Selection: Here comes [[the broken table]] and more text", "Note: table lost its rows"]);
  });

  it("imports the bundle directory too, loose files or holding just the zip", () => {
    const loose = evalRoot();
    expect(importFeedback({ bundlePath: bundleDir(reportFiles()), evalRoot: loose }).slug).toBe("example-broken-page");
    const zipOnly = evalRoot();
    const dir = tempDir("quire-bundle-");
    writeFileSync(join(dir, "quire-report-broken-0123456789abcdef.zip"), readFileSync(bundleZip(reportFiles())));
    expect(importFeedback({ bundlePath: dir, evalRoot: zipOnly }).slug).toBe("example-broken-page");
  });

  it("finds the files under one top-level folder in the zip", () => {
    const root = evalRoot();
    const result = importFeedback({ bundlePath: bundleZip(reportFiles(), "quire-report-broken-0123456789abcdef"), evalRoot: root });
    expect(result.slug).toBe("example-broken-page");
    expect(existsSync(join(root, "corpus", "example-broken-page", "feedback.json"))).toBe(true);
    expect(existsSync(join(root, "feedback-screenshots", "example-broken-page", "composite.png"))).toBe(true);
  });

  it.each(["pdf", "text"])("imports a %s-view report into eval/pdf: the PDF, a sources.json entry and the reported spot", (view) => {
    const root = evalRoot();
    const result = importFeedback({ bundlePath: bundleZip(reportFiles({ view })), evalRoot: root });
    expect(result).toMatchObject({ type: "pdf", slug: "arxiv-2609-12345", kind: "feedback", layout: "unknown" });
    expect(readFileSync(join(root, "pdf", "corpus", "arxiv-2609-12345.pdf"))).toEqual(PDF);
    expect(readJson(join(root, "pdf", "corpus", "arxiv-2609-12345.feedback.json"))).toMatchObject({ view, selection });
    const sourcesText = readFileSync(join(root, "pdf", "sources.json"), "utf8");
    expect(JSON.parse(sourcesText)).toEqual([
      { slug: "arxiv-old", url: "https://arxiv.org/pdf/1810.04805", kind: "arxiv", layout: "two-column ACL/NAACL" },
      { slug: "arxiv-2609-12345", url: PDF_URL, kind: "feedback", layout: "unknown" },
    ]);
    expect(sourcesText.endsWith("]\n")).toBe(true);
    expect(readJson(join(root, "corpus.json"))).toHaveLength(1);
    expect(existsSync(join(root, "feedback-screenshots", "arxiv-2609-12345", "screenshots", "original-top.jpg"))).toBe(true);
  });

  it("honours --slug", () => {
    const root = evalRoot();
    expect(importFeedback({ bundlePath: bundleZip(reportFiles()), evalRoot: root, slugOverride: "custom" }).slug).toBe("custom");
    expect(existsSync(join(root, "corpus", "custom", "meta.json"))).toBe(true);
  });

  it("refuses a report without the original, naming the checkbox, and writes nothing", () => {
    const root = evalRoot();
    expect(() => importFeedback({ bundlePath: bundleZip(reportFiles({ capture: false })), evalRoot: root })).toThrow(/no page\.html\.gz.*"Include the original page" ticked/);
    expect(() => importFeedback({ bundlePath: bundleZip(reportFiles({ view: "pdf", capture: false })), evalRoot: root })).toThrow(/no original\.pdf.*"Include the original page" ticked/);
    expect(readJson(join(root, "corpus.json"))).toHaveLength(1);
    expect(readJson(join(root, "pdf", "sources.json"))).toHaveLength(1);
    expect(existsSync(join(root, "feedback-screenshots"))).toBe(false);
  });

  it("refuses a zip without report.json and a report about an unknown view", () => {
    const root = evalRoot();
    const { "report.json": _report, ...rest } = reportFiles();
    expect(() => importFeedback({ bundlePath: bundleZip(rest), evalRoot: root })).toThrow(/has no report\.json/);
    expect(() => importFeedback({ bundlePath: bundleZip(reportFiles({ view: "markdown" })), evalRoot: root })).toThrow(/"markdown" view; only web .* and pdf\/text/);
    expect(() => importFeedback({ bundlePath: bundleZip(reportFiles({ view: "slides" })), evalRoot: root })).toThrow(/"slides" view/);
  });

  it("refuses a web slug that is already in corpus.json or on disk", () => {
    const root = evalRoot();
    expect(() => importFeedback({ bundlePath: bundleZip(reportFiles({ url: "https://taken.test/" })), evalRoot: root, slugOverride: "taken" })).toThrow(/already exists/);
    mkdirSync(join(root, "corpus", "example-broken-page"));
    expect(() => importFeedback({ bundlePath: bundleZip(reportFiles()), evalRoot: root })).toThrow(/eval\/corpus\/example-broken-page already exists/);
  });

  it("refuses a duplicate PDF (same slug, or same URL without --slug) and leaves sources.json untouched", () => {
    const root = evalRoot();
    importFeedback({ bundlePath: bundleZip(reportFiles({ view: "pdf" })), evalRoot: root });
    expect(() => importFeedback({ bundlePath: bundleZip(reportFiles({ view: "pdf" })), evalRoot: root })).toThrow(/eval\/pdf\/corpus\/arxiv-2609-12345\.pdf already exists/);
    expect(() => importFeedback({ bundlePath: bundleZip(reportFiles({ view: "pdf", url: "https://arxiv.org/pdf/1810.04805" })), evalRoot: root })).toThrow(/already in eval\/pdf\/sources\.json as arxiv-old/);
    expect(readJson(join(root, "pdf", "sources.json"))).toHaveLength(2);
    expect(importFeedback({ bundlePath: bundleZip(reportFiles({ view: "pdf", url: "https://arxiv.org/pdf/1810.04805" })), evalRoot: root, slugOverride: "bert-reported" }).slug).toBe("bert-reported");
    expect(readJson(join(root, "pdf", "sources.json"))).toHaveLength(3);
  });
});
