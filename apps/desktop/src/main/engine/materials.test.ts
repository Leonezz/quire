import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db";
import { imageReferencesOf } from "./material-content";
import { MaterialStore, withoutTitleHeading, imageUrlsOf } from "./materials";
import { MetaStore } from "./meta";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-materials-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("MaterialStore", () => {
  it("reads a dropped Markdown file into a reader document and lists it", async () => {
    const store = new MaterialStore(root);
    const md = "# Momentum, revisited\n\nA paragraph with **emphasis** and `code`.\n\n## Why it is stable\n\nBecause.\n";
    const result = await store.openFile({ name: "momentum.md", mediaType: "", bytes: new TextEncoder().encode(md) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.title).toBe("Momentum, revisited");
    expect(result.material.origin).toBe("file");
    expect(result.material.reader?.schema).toBe("reader.document.v2");
    expect(JSON.parse(result.material.reader!.payload).type).toBe("root");
    expect(result.material.readingMinutes).toBe(1);
    const listed = await store.list();
    expect(listed.map((item) => item.title)).toEqual(["Momentum, revisited"]);
    expect(await store.get(result.material.id)).toMatchObject({ title: "Momentum, revisited" });
  });

  it("reads a dropped HTML file through the article extractor", async () => {
    const store = new MaterialStore(root);
    const html = `<!doctype html><html><head><title>Cache keys</title></head><body><article><h1>Cache keys</h1>${"<p>Two harnesses cache the tokenised prompt keyed on the question text alone, so a changed system prompt silently reuses the old one. The fix is a cache key that includes the full rendered prompt hash.</p>".repeat(12)}</article></body></html>`;
    const result = await store.openFile({ name: "cache.html", mediaType: "text/html", bytes: new TextEncoder().encode(html) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.title).toBe("Cache keys");
    expect(result.material.reader).toBeDefined();
    expect(result.material.quality.safety).toBe("safe");
  });

  it("refuses unsupported file types with a clear code", async () => {
    const store = new MaterialStore(root);
    const result = await store.openFile({ name: "photo.png", mediaType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) });
    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED_TYPE" });
  });

  it("refuses private and non-http URLs before fetching", async () => {
    const store = new MaterialStore(root);
    expect(await store.openUrl("http://localhost:3000/x")).toMatchObject({ ok: false, code: "URL_PRIVATE" });
    expect(await store.openUrl("http://10.0.0.8/x")).toMatchObject({ ok: false, code: "URL_PRIVATE" });
    expect(await store.openUrl("ftp://example.com/x")).toMatchObject({ ok: false, code: "URL_SCHEME" });
    expect(await store.openUrl("https://user:pw@example.com/x")).toMatchObject({ ok: false, code: "URL_CREDENTIALS" });
    expect(await store.openUrl("not a url")).toMatchObject({ ok: false, code: "URL_INVALID" });
    expect(await store.list()).toEqual([]);
  });
});

const article = (title: string) => `<!doctype html><html><head><title>${title}</title></head><body><nav>Home</nav><article><h1>${title}</h1>${"<p>Two harnesses cache the tokenised prompt keyed on the question text alone, so a changed system prompt silently reuses the old one. The fix is a cache key that includes the full rendered prompt hash.</p>".repeat(12)}</article></body></html>`;
const pageFetcher = (title: string) => async (url: URL) => ({ bytes: new TextEncoder().encode(article(title)), mediaType: "text/html", finalUrl: url.toString() });

describe("MaterialStore capture", () => {
  it("keeps the raw page next to the record when the setting is on and renders it as structured text", async () => {
    const store = new MaterialStore(root, pageFetcher("Cache keys"), { keepCapture: () => true });
    const result = await store.openUrl("https://example.test/cache");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { id } = result.material;
    const bytes = new TextEncoder().encode(article("Cache keys"));
    const { createHash } = await import("node:crypto");
    // Which bytes, read when (#27): the hash is the normalizer's contentIdentity.
    expect(result.material.capture).toEqual({ byteLength: bytes.byteLength, mediaType: "text/html", sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, fetchedAt: result.material.fetchedAt });
    expect(JSON.parse(await readFile(join(root, "materials", `${id}.json`), "utf8"))).toMatchObject({ capture: result.material.capture });
    expect((await stat(join(root, "materials", `${id}.html`))).size).toBe(result.material.capture!.byteLength);
    const text = await store.captureText(id);
    expect(text).toMatch(/^Home\n\n# Cache keys\n\nTwo harnesses cache/);
    expect(await store.captureText("0000000000000000")).toBeUndefined();
    expect(await store.captureText("../x")).toBeUndefined();
  });

  it("writes no capture when the setting is off, and drops a stale one when a fallback copy is fetched again", async () => {
    let keep = true;
    let challenge = true;
    const store = new MaterialStore(root, async (url) => ({ bytes: new TextEncoder().encode(challenge ? challengePage : article("Cache keys")), mediaType: "text/html", finalUrl: url.toString() }), { keepCapture: () => keep });
    const first = await store.openUrl("https://example.test/cache");
    if (!first.ok) throw new Error(first.message);
    expect(first.material.quality.safety).toBe("degraded_plaintext");
    expect(await store.captureText(first.material.id)).toBeDefined();
    keep = false;
    challenge = false;
    const second = await store.openUrl("https://example.test/cache");
    if (!second.ok) throw new Error(second.message);
    expect(second.material).toMatchObject({ id: first.material.id, title: "Cache keys" });
    expect(second.material.capture).toBeUndefined();
    expect(await store.captureText(second.material.id)).toBeUndefined();
    const other = await store.openUrl("https://example.test/other");
    expect(other.ok && other.material.capture).toBeUndefined();
    const markdown = await store.openFile({ name: "notes.md", mediaType: "", bytes: new TextEncoder().encode("# Notes\n\nText.") });
    expect(markdown.ok && markdown.material.capture).toBeUndefined();
  });
});

/** What a bot challenge serves: nothing the extractor can read, so the page is kept as plain text. */
const challengePage = `<!doctype html><html><head><title>Just a moment</title></head><body><nav>Checking your browser</nav></body></html>`;

/** Serves `html()` as it is at each call, optionally from a redirect target, and records every URL asked for. */
function countingFetcher(html: () => string, finalUrlOf: (url: URL) => string = (url) => url.toString()) {
  const calls: string[] = [];
  const fetcher = async (url: URL) => { calls.push(url.toString()); return { bytes: new TextEncoder().encode(html()), mediaType: "text/html", finalUrl: finalUrlOf(url) }; };
  return Object.assign(fetcher, { calls });
}

describe("MaterialStore re-adding", () => {
  it("returns a page already in the library as stored: no fetch, no write", async () => {
    let title = "Cache keys";
    const fetch = countingFetcher(() => article(title));
    const store = new MaterialStore(root, fetch);
    const first = await store.openUrl("https://example.test/cache");
    if (!first.ok) throw new Error(first.message);
    expect(first).not.toHaveProperty("existing");
    const path = join(root, "materials", `${first.material.id}.json`);
    const json = await readFile(path, "utf8");
    const capture = await store.captureBytes(first.material.id);
    title = "Cache keys, revised";
    const again = await store.openUrl("https://example.test/cache#why");
    expect(again).toMatchObject({ ok: true, existing: true, material: { id: first.material.id, title: "Cache keys", fetchedAt: first.material.fetchedAt } });
    expect(fetch.calls).toEqual(["https://example.test/cache"]);
    expect(await readFile(path, "utf8")).toBe(json);
    expect(await store.captureBytes(first.material.id)).toEqual(capture);
  });

  it("finds a redirected page once the fetch says where it ended, before anything is written", async () => {
    let title = "Cache keys";
    const fetch = countingFetcher(() => article(title), () => "https://example.test/posts/cache");
    const store = new MaterialStore(root, fetch);
    const first = await store.openUrl("https://example.test/cache");
    if (!first.ok) throw new Error(first.message);
    const capture = await store.captureBytes(first.material.id);
    title = "Cache keys, revised";
    const again = await store.openUrl("https://example.test/s/c4");
    expect(again).toMatchObject({ ok: true, existing: true, material: { id: first.material.id, title: "Cache keys", aliases: ["https://example.test/s/c4"] } });
    // The redirect is only known after one fetch; its answer is dropped, not materialized.
    expect(fetch.calls).toEqual(["https://example.test/cache", "https://example.test/s/c4"]);
    expect(await store.captureBytes(first.material.id)).toEqual(capture);
    // Both links are its names now: neither is fetched again.
    for (const link of ["https://example.test/cache", "https://example.test/s/c4"]) expect(await store.openUrl(link)).toMatchObject({ ok: true, existing: true, material: { id: first.material.id } });
    expect(fetch.calls).toHaveLength(2);
    expect((await store.list()).map((m) => m.title)).toEqual(["Cache keys"]);
  });

  it("adds what an item declared to a stored page, extracted again from its capture, and writes nothing when the item adds nothing", async () => {
    const fetch = countingFetcher(() => article("Retrieval Without Regret").replace("</head>", '<meta name="citation_doi" content="10.1234/rwr.1"></head>'));
    const store = new MaterialStore(root, fetch);
    const pasted = await store.openUrl("https://arxiv.org/html/2409.12345");
    if (!pasted.ok) throw new Error(pasted.message);
    expect(pasted.material.byline).toBeUndefined();
    const item = { kind: "preprint" as const, arxivId: "2409.12345", publication: "arXiv", creators: [{ role: "author" as const, name: "Mara Lindqvist" }], abstract: "From the Atom feed.", date: "2026-09-17T17:59:12.000Z" };
    const read = await store.openUrl("https://arxiv.org/html/2409.12345", "feed", item);
    expect(read).toMatchObject({ ok: true, existing: true, material: { id: pasted.material.id, origin: "web", kind: "preprint", title: "Retrieval Without Regret", byline: "Mara Lindqvist", fetchedAt: pasted.material.fetchedAt, meta: { arxivId: "2409.12345", abstract: "From the Atom feed.", doi: "10.1234/rwr.1" } } });
    expect(fetch.calls).toHaveLength(1);
    const path = join(root, "materials", `${pasted.material.id}.json`);
    const json = await readFile(path, "utf8");
    expect(JSON.parse(json)).toMatchObject({ itemMeta: item, extracted: { kind: "preprint", abstract: "From the Atom feed." }, primaryView: "web", views: [{ id: "web", status: "ready" }] });
    expect(await store.openUrl("https://arxiv.org/html/2409.12345", "feed", item)).toMatchObject({ ok: true, existing: true });
    expect(await readFile(path, "utf8")).toBe(json);
  });

  it("returns a dropped file already in the library as stored", async () => {
    const store = new MaterialStore(root);
    const bytes = new TextEncoder().encode("# Notes\n\nText.");
    const first = await store.openFile({ name: "notes.md", mediaType: "", bytes });
    if (!first.ok) throw new Error(first.message);
    expect(first).not.toHaveProperty("existing");
    const again = await store.openFile({ name: "renamed.md", mediaType: "", bytes });
    expect(again).toMatchObject({ ok: true, existing: true, material: { id: first.material.id, url: first.material.url, fetchedAt: first.material.fetchedAt } });
  });

  it("never replaces a stored page with a feed's copy", async () => {
    const store = new MaterialStore(root, pageFetcher("Cache keys"));
    const page = await store.openUrl("https://example.test/cache");
    if (!page.ok) throw new Error(page.message);
    const copy = await store.saveFromFeed({ url: "https://example.test/cache", title: "Feed title", content: { plain: "Only the feed's summary." } });
    expect(copy).toMatchObject({ id: page.material.id, title: "Cache keys", problems: [] });
    expect(await store.get(page.material.id)).toMatchObject({ title: "Cache keys", problems: [] });
  });

  it("never lets a page the extractor cannot read replace the feed's copy of it", async () => {
    let challenge = true;
    const store = new MaterialStore(root, async (url) => ({ bytes: new TextEncoder().encode(challenge ? challengePage : article("Cache keys")), mediaType: "text/html", finalUrl: url.toString() }));
    const copy = await store.saveFromFeed({ url: "https://example.test/cache", title: "Cache keys", content: { plain: "The full post as the feed carries it." }, meta: { kind: "newsletter" } });
    const again = await store.openUrl("https://example.test/cache");
    expect(again).toMatchObject({ ok: true, existing: true, material: { id: copy.id, plain: "The full post as the feed carries it.", kind: "newsletter", quality: { safety: "safe" } } });
    expect(await store.get(copy.id)).toMatchObject({ plain: "The full post as the feed carries it." });
    // The challenge page was captured while it was read; the feed's copy keeps none.
    expect(await store.captureBytes(copy.id)).toBeUndefined();
    challenge = false;
    const page = await store.openUrl("https://example.test/cache");
    expect(page).toMatchObject({ ok: true, material: { id: copy.id, title: "Cache keys", problems: [], kind: "newsletter" } });
    expect(page).not.toHaveProperty("existing");
  });
});

/** Moves a record to the id an older version gave it (the hash of its URL as given), as a library from before #28 has it. */
async function storeUnderLegacyId(id: string, url: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { rename, writeFile } = await import("node:fs/promises");
  const legacy = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const dir = join(root, "materials");
  const record = JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")) as Record<string, unknown>;
  await writeFile(join(dir, `${legacy}.json`), JSON.stringify({ ...record, id: legacy }));
  await rm(join(dir, `${id}.json`));
  await rename(join(dir, `${id}.html`), join(dir, `${legacy}.html`));
  return legacy;
}

describe("MaterialStore identity", () => {
  it("opens the material already in the library for a link with tracking parameters, without fetching it again", async () => {
    const fetch = countingFetcher(() => article("Cache keys"));
    const store = new MaterialStore(root, fetch);
    const first = await store.openUrl("https://example.test/cache?utm_source=rss&utm_medium=feed");
    if (!first.ok) throw new Error(first.message);
    for (const variant of ["https://example.test/cache?utm_source=newsletter#intro", "https://example.test/cache", "https://example.test/cache?fbclid=abc"]) {
      expect(await store.openUrl(variant)).toMatchObject({ ok: true, existing: true, material: { id: first.material.id } });
    }
    expect(fetch.calls).toEqual(["https://example.test/cache?utm_source=rss&utm_medium=feed"]);
    expect((await store.list()).map((m) => m.id)).toEqual([first.material.id]);
    // A parameter that picks the content is another page.
    const other = await store.openUrl("https://example.test/cache?page=2");
    expect(other.ok && other.material.id).not.toBe(first.material.id);
  });

  it("finds a material stored under the id its tracking link gave it before, instead of making another copy", async () => {
    const fetch = countingFetcher(() => article("Cache keys"));
    const store = new MaterialStore(root, fetch);
    const link = "https://example.test/cache?utm_source=rss";
    const opened = await store.openUrl(link);
    if (!opened.ok) throw new Error(opened.message);
    const legacy = await storeUnderLegacyId(opened.material.id, link);
    const reopened = new MaterialStore(root, fetch);
    expect(await reopened.openUrl(link)).toMatchObject({ ok: true, existing: true, material: { id: legacy, title: "Cache keys" } });
    expect(await reopened.saveFromFeed({ url: link, title: "Feed title", content: { plain: "The feed's copy." } })).toMatchObject({ id: legacy, title: "Cache keys" });
    // The link without tracking, or with other tracking, has neither id: the library's names find it.
    for (const variant of ["https://example.test/cache", "https://example.test/cache?utm_source=newsletter"]) {
      expect(await new MaterialStore(root, fetch).openUrl(variant)).toMatchObject({ ok: true, existing: true, material: { id: legacy } });
    }
    expect(fetch.calls).toHaveLength(1);
    expect((await reopened.list()).map((m) => m.id)).toEqual([legacy]);
    expect(await reopened.get(legacy)).not.toHaveProperty("aliases");
  });

  /** Serves each path its own page; a path not listed is a fixture mistake. */
  function sitePages(pages: Record<string, () => { bytes: Uint8Array; mediaType: string }>, finalUrlOf: (url: URL) => string = (url) => url.toString()) {
    const calls: string[] = [];
    const fetcher = async (url: URL) => {
      calls.push(url.toString());
      const page = pages[`${url.hostname}${url.pathname}`];
      if (!page) throw new Error(`no fixture for ${url.toString()}`);
      return { ...page(), finalUrl: finalUrlOf(url) };
    };
    return Object.assign(fetcher, { calls });
  }
  const html = (title: string, head = "") => () => ({ bytes: new TextEncoder().encode(article(title).replace("</head>", `${head}</head>`)), mediaType: "text/html" });

  it("resolves a paper's arXiv abs, html and pdf links, with or without a version, to one material", async () => {
    const pdf = new Uint8Array(await readFile(join(__dirname, "__fixtures__", "two-pages.pdf")));
    const fetch = sitePages({
      "arxiv.org/html/2409.12345": html("Retrieval Without Regret"),
      "arxiv.org/pdf/2409.12345": () => ({ bytes: pdf, mediaType: "application/pdf" }),
      "scholar.example.test/search": html("Search results"),
    });
    const store = new MaterialStore(root, fetch);
    const read = await store.openUrl("https://arxiv.org/html/2409.12345", "feed", { kind: "preprint", arxivId: "2409.12345" });
    if (!read.ok) throw new Error(read.message);
    const links = ["https://arxiv.org/abs/2409.12345", "https://arxiv.org/abs/2409.12345v2", "https://arxiv.org/html/2409.12345v1", "https://arxiv.org/pdf/2409.12345v1", "https://arxiv.org/pdf/2409.12345", "https://export.arxiv.org/abs/2409.12345?context=cs"];
    for (const link of links) expect(await store.openUrl(link)).toMatchObject({ ok: true, existing: true, material: { id: read.material.id, title: "Retrieval Without Regret" } });
    expect(fetch.calls).toEqual(["https://arxiv.org/html/2409.12345"]);
    expect((await store.get(read.material.id))?.aliases).toEqual(links);
    // A page elsewhere that only quotes the link is another material.
    const search = await store.openUrl("https://scholar.example.test/search?q=arxiv.org/abs/2409.12345");
    expect(search.ok && search.material.id).not.toBe(read.material.id);

    // A paper first read as its PDF is the one material its HTML rendering opens too.
    const other = sitePages({ "arxiv.org/pdf/2409.54321v3": () => ({ bytes: pdf, mediaType: "application/pdf" }) });
    const papers = new MaterialStore(join(root, "papers"), other);
    const first = await papers.openUrl("https://arxiv.org/pdf/2409.54321v3");
    if (!first.ok) throw new Error(first.message);
    expect(await papers.openUrl("https://arxiv.org/html/2409.54321")).toMatchObject({ ok: true, existing: true, material: { id: first.material.id, mediaType: "application/pdf" } });
    expect(other.calls).toHaveLength(1);
  });

  it("opens the page a same-site canonical link names as one material, but never by the site's home page", async () => {
    const fetch = sitePages({
      "example.test/post/amp": html("Cache keys", '<link rel="canonical" href="/post">'),
      "example.test/post": html("Cache keys"),
      "example.test/b": html("Batching"),
      "example.test/one": html("One", '<link rel="canonical" href="https://www.example.test/">'),
      "example.test/two": html("Two", '<link rel="canonical" href="https://example.test/">'),
      "example.test/three": html("Three", '<link rel="canonical" href="/blog/">'),
      "example.test/four": html("Four", '<link rel="canonical" href="/blog/">'),
      "example.test/syndicated": html("Elsewhere", '<link rel="canonical" href="https://other.test/original">'),
    });
    const store = new MaterialStore(root, fetch);
    const amp = await store.openUrl("https://example.test/post/amp");
    if (!amp.ok) throw new Error(amp.message);
    expect(amp.material.canonicalUrl).toBe("https://example.test/post");
    // The URL it declares is one of its names before anything is fetched.
    expect(await store.openUrl("https://example.test/post?utm_source=rss")).toMatchObject({ ok: true, existing: true, material: { id: amp.material.id } });
    expect(await store.get(amp.material.id)).not.toHaveProperty("aliases");
    // A page that declares a material's URL as its canonical one is that material.
    const page = await store.openUrl("https://example.test/b");
    if (!page.ok) throw new Error(page.message);
    expect(page.material).not.toHaveProperty("canonicalUrl");
    const variant = sitePages({ "example.test/b": html("Batching", '<link rel="canonical" href="https://example.test/b">') });
    expect(await new MaterialStore(root, variant).openUrl("https://example.test/b?view=print")).toMatchObject({ ok: true, existing: true, material: { id: page.material.id, aliases: ["https://example.test/b?view=print"] } });

    const ids: string[] = [];
    for (const path of ["one", "two", "three", "four", "syndicated"]) {
      const opened = await store.openUrl(`https://example.test/${path}`);
      if (!opened.ok) throw new Error(opened.message);
      ids.push(opened.material.id);
      if (path !== "three" && path !== "four") expect(opened.material).not.toHaveProperty("canonicalUrl");
    }
    // Two pages that declare one canonical page are two materials until that page itself is read.
    expect(new Set(ids).size).toBe(5);
    expect(fetch.calls).toHaveLength(7);
  });

  it("opens the material a page's DOI names, and keeps the names of a feed's copy it replaces", async () => {
    const fetch = sitePages({
      "journal.example.test/articles/42": () => ({ bytes: new TextEncoder().encode(taggedArticle), mediaType: "text/html" }),
      "journal.example.test/articles/42/full": () => ({ bytes: new TextEncoder().encode(taggedArticle), mediaType: "text/html" }),
      "mirror.example.test/paper": () => ({ bytes: new TextEncoder().encode(taggedArticle), mediaType: "text/html" }),
    });
    const store = new MaterialStore(root, fetch);
    const copy = await store.saveFromFeed({ url: "https://feeds.example.test/jr/42", title: "Calibrated abstention", content: { plain: "The feed's copy." }, meta: { doi: "10.1234/JR.2026.0042" } });
    const page = await store.openUrl("https://journal.example.test/articles/42");
    expect(page).toMatchObject({ ok: true, material: { id: copy.id, url: "https://journal.example.test/articles/42", problems: [], meta: { doi: "10.1234/jr.2026.0042" }, aliases: ["https://feeds.example.test/jr/42"] } });
    expect(page).not.toHaveProperty("existing");
    for (const link of ["https://journal.example.test/articles/42/full", "https://mirror.example.test/paper", "https://feeds.example.test/jr/42"]) {
      expect(await store.openUrl(link)).toMatchObject({ ok: true, existing: true, material: { id: copy.id } });
    }
    expect(fetch.calls).toEqual(["https://journal.example.test/articles/42", "https://journal.example.test/articles/42/full", "https://mirror.example.test/paper"]);
    expect((await store.get(copy.id))?.aliases).toEqual(["https://feeds.example.test/jr/42", "https://journal.example.test/articles/42/full", "https://mirror.example.test/paper"]);
    expect((await store.list()).map((m) => m.id)).toEqual([copy.id]);
  });

  it("keeps the other names on the record, so they survive a restart, and loads records written without them", async () => {
    const fetch = sitePages({ "arxiv.org/html/2409.12345": html("Retrieval Without Regret") });
    const store = new MaterialStore(root, fetch);
    const read = await store.openUrl("https://arxiv.org/html/2409.12345");
    if (!read.ok) throw new Error(read.message);
    await store.openUrl("https://arxiv.org/abs/2409.12345");
    const path = join(root, "materials", `${read.material.id}.json`);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ aliases: ["https://arxiv.org/abs/2409.12345"] });
    expect(await new MaterialStore(root, fetch).openUrl("https://arxiv.org/abs/2409.12345")).toMatchObject({ ok: true, existing: true, material: { id: read.material.id } });

    const { writeFile } = await import("node:fs/promises");
    const { aliases: _aliases, ...legacy } = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify(legacy));
    const restarted = new MaterialStore(root, fetch);
    expect(await restarted.get(read.material.id)).toMatchObject({ id: read.material.id, title: "Retrieval Without Regret" });
    expect(await restarted.get(read.material.id)).not.toHaveProperty("aliases");
    expect(await restarted.openUrl("https://arxiv.org/abs/2409.12345v1")).toMatchObject({ ok: true, existing: true, material: { id: read.material.id, aliases: ["https://arxiv.org/abs/2409.12345v1"] } });
    expect(fetch.calls).toHaveLength(1);
    // A deleted material is no other link's material any more.
    await restarted.delete([read.material.id]);
    expect(await restarted.openUrl("https://arxiv.org/abs/2409.12345")).toMatchObject({ ok: false });
  });

  it("gives a feed's copy the id of its link without tracking parameters, so the page read later replaces it", async () => {
    const fetch = countingFetcher(() => article("Cache keys, the full post"));
    const store = new MaterialStore(root, fetch);
    const copy = await store.saveFromFeed({ url: "https://example.test/cache?utm_source=rss", title: "Cache keys", content: { plain: "Hello from the feed" } });
    const page = await store.openUrl("https://example.test/cache");
    expect(page).toMatchObject({ ok: true, material: { id: copy.id, title: "Cache keys, the full post", problems: [] } });
    expect((await store.list()).map((m) => m.id)).toEqual([copy.id]);
  });
});

describe("MaterialStore versions", () => {
  const page = (title: string, body = "") => ({ bytes: new TextEncoder().encode(article(title).replace("</article>", `${body}</article>`)), mediaType: "text/html" });

  it("records which version of an arXiv paper was read: the one its link asks for, else the one the rendering stamps", async () => {
    const pdf = new Uint8Array(await readFile(join(__dirname, "__fixtures__", "two-pages.pdf")));
    const answers: Record<string, () => { bytes: Uint8Array; mediaType: string }> = {
      "/html/2409.12345": () => page("Retrieval Without Regret", '<div class="ltx_page_logo">arXiv:2409.12345v3 [cs.CL] 2 Oct 2026</div><a href="/abs/2409.12345v3">abs</a>'),
      "/abs/2409.11111v2": () => page("Calibrated abstention", ["v1", "v2", "v3", "v4"].map((v) => `<a href="/abs/2409.11111${v}">[${v}]</a>`).join("")),
      "/pdf/2409.22222": () => ({ bytes: pdf, mediaType: "application/pdf" }),
      "/post": () => page("A post", "<p>See arXiv:2409.12345v5.</p>"),
    };
    const store = new MaterialStore(root, async (url) => ({ ...answers[url.pathname]!(), finalUrl: url.toString() }));
    const read = async (link: string) => { const result = await store.openUrl(link); if (!result.ok) throw new Error(result.message); return result.material; };
    const html = await read("https://arxiv.org/html/2409.12345");
    expect(html).toMatchObject({ arxivVersion: 3, meta: { arxivId: "2409.12345" } });
    expect(await read("https://arxiv.org/abs/2409.11111v2")).toMatchObject({ arxivVersion: 2, meta: { arxivId: "2409.11111" } });
    // A PDF with no stamp in its text layer, and a page elsewhere that quotes a paper, have no version.
    expect(await read("https://arxiv.org/pdf/2409.22222")).not.toHaveProperty("arxivVersion");
    expect(await read("https://blog.example.test/post")).not.toHaveProperty("arxivVersion");
    // The version read stays when the paper is opened by another version's link.
    expect(await read("https://arxiv.org/abs/2409.12345v4")).toMatchObject({ id: html.id, arxivVersion: 3 });
    expect(JSON.parse(await readFile(join(root, "materials", `${html.id}.json`), "utf8"))).toMatchObject({ arxivVersion: 3 });
  });

  it("loads a record written before captures had a hash and papers a version", async () => {
    const { createHash } = await import("node:crypto");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const url = "https://arxiv.org/html/2409.12345";
    const id = createHash("sha256").update(url).digest("hex").slice(0, 16);
    const html = article("Retrieval Without Regret");
    // As alpha.4 wrote it: a capture with no sha256 or fetchedAt, no arxivVersion, no aliases.
    const fixture = {
      id, url, finalUrl: url, mediaType: "text/html", fetchedAt: "2026-09-18T12:00:00.000Z", origin: "feed",
      title: "Retrieval Without Regret", markdown: "Two harnesses cache the tokenised prompt.", readingMinutes: 1,
      quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "strong", safety: "safe", warnings: [] }, problems: [],
      capture: { byteLength: Buffer.byteLength(html), mediaType: "text/html" },
      extracted: { kind: "preprint", title: "Retrieval Without Regret", arxivId: "2409.12345", url, accessed: "2026-09-18T12:00:00.000Z" },
      views: [{ id: "web", label: "Web page", url, mediaType: "text/html", status: "ready", fetchedAt: "2026-09-18T12:00:00.000Z", byteLength: Buffer.byteLength(html) }], primaryView: "web",
    };
    await mkdir(join(root, "materials"), { recursive: true });
    await writeFile(join(root, "materials", `${id}.json`), JSON.stringify(fixture));
    await writeFile(join(root, "materials", `${id}.html`), html);
    const fetch = countingFetcher(() => html);
    const store = new MaterialStore(root, fetch);
    const loaded = await store.get(id);
    expect(loaded).toMatchObject({ id, title: "Retrieval Without Regret", capture: { byteLength: fixture.capture.byteLength, mediaType: "text/html" } });
    expect(loaded?.capture).not.toHaveProperty("sha256");
    expect(loaded).not.toHaveProperty("arxivVersion");
    expect((await store.list()).map((m) => m.id)).toEqual([id]);
    expect(await store.openUrl("https://arxiv.org/abs/2409.12345v1")).toMatchObject({ ok: true, existing: true, material: { id } });
    expect((await store.refreshMetadata(id)).meta.arxivId).toBe("2409.12345");
    expect(fetch.calls).toEqual([]);
  });
});

describe("MaterialStore overrides", () => {
  it("lays the metadata over the record and the list, with tags and rebuiltAs", async () => {
    const db = openDatabase(":memory:");
    const meta = new MetaStore(db);
    const store = new MaterialStore(root, pageFetcher("Cache keys"), { meta });
    const opened = await store.openUrl("https://example.test/cache");
    if (!opened.ok) throw new Error(opened.message);
    const { id } = opened.material;
    expect(opened.material.tags).toEqual([]);
    expect(opened.material).not.toHaveProperty("overrides");
    expect(opened.material).toMatchObject({ kind: "webpage", extracted: { kind: "webpage", title: "Cache keys", url: "https://example.test/cache" }, meta: { kind: "webpage", title: "Cache keys" } });
    const overrides = { title: "Cache keys, annotated", creators: [{ role: "author" as const, name: "Ada" }], date: "2026-09-01T00:00:00.000Z", tags: ["systems"], note: "keep", kind: "blogPost" as const };
    await meta.update(id, overrides);
    const record = (await store.get(id))!;
    expect(record).toMatchObject({ title: "Cache keys, annotated", byline: "Ada", publishedAt: "2026-09-01T00:00:00.000Z", tags: ["systems"], kind: "blogPost", overrides, meta: { ...overrides, url: "https://example.test/cache" } });
    expect(record.extracted).toMatchObject({ kind: "webpage", title: "Cache keys" });
    expect(JSON.parse(await readFile(join(root, "materials", `${id}.json`), "utf8"))).toMatchObject({ title: "Cache keys", extracted: { kind: "webpage", title: "Cache keys" } });
    expect((await store.list())[0]).toMatchObject({ id, title: "Cache keys, annotated", byline: "Ada", tags: ["systems"], kind: "blogPost" });
    expect((await store.list())[0]).not.toHaveProperty("rebuiltAs");
    // A partial date is kept on meta.date but yields no publishedAt; clearing the title falls back to the extracted one.
    await meta.update(id, { date: "2026-09", title: "" });
    expect(await store.get(id)).toMatchObject({ title: "Cache keys", meta: { date: "2026-09" } });
    expect(await store.get(id)).not.toHaveProperty("publishedAt");

    const artifact = await store.saveArtifact({ title: "Cache keys (rebuilt)", markdown: "# Cache keys\n\nClean.", lineage: [id] });
    expect(artifact.tags).toEqual([]);
    expect((await store.setRebuiltAs(id, artifact.id)).rebuiltAs).toBe(artifact.id);
    expect((await store.list()).find((m) => m.id === id)?.rebuiltAs).toBe(artifact.id);
    expect((await store.get(id))?.title).toBe("Cache keys");
    await expect(store.setRebuiltAs(id, "0000000000000000")).rejects.toThrow(/Artifact 0000000000000000 is not in the library/);
    await expect(store.setRebuiltAs(id, id)).rejects.toThrow(/is not in the library/);
    await expect(store.setRebuiltAs("0000000000000000", artifact.id)).rejects.toThrow(/Material 0000000000000000 is not in the library/);

    await store.delete([id]);
    expect(meta.get(id)).toBeUndefined();
    expect((await store.list()).map((m) => m.id)).toEqual([artifact.id]);
    db.close();
  });
});

const taggedArticle = `<!doctype html><html lang="en"><head><title>Calibrated abstention</title>
<meta name="citation_title" content="Calibrated Abstention for Long-Context QA"><meta name="citation_author" content="Lindqvist, Mara"><meta name="citation_author" content="Nowak, Tomasz">
<meta name="citation_journal_title" content="Journal of Retrieval"><meta name="citation_publication_date" content="2026/05/12"><meta name="citation_doi" content="10.1234/jr.2026.0042"></head>
<body><article><h1>Calibrated abstention</h1>${"<p>Two harnesses cache the tokenised prompt keyed on the question text alone, so a changed system prompt silently reuses the old one. The fix is a cache key that includes the full rendered prompt hash.</p>".repeat(12)}</article></body></html>`;

describe("MaterialStore metadata", () => {
  it("extracts the declared metadata of a page into the record, derives byline and publishedAt, and searches the new fields", async () => {
    const store = new MaterialStore(root, async (url) => ({ bytes: new TextEncoder().encode(taggedArticle), mediaType: "text/html", finalUrl: url.toString() }));
    const opened = await store.openUrl("https://journal.example.test/articles/42");
    if (!opened.ok) throw new Error(opened.message);
    expect(opened.material).toMatchObject({
      kind: "journalArticle", title: "Calibrated Abstention for Long-Context QA", byline: "Mara Lindqvist, Tomasz Nowak", publishedAt: "2026-05-12T00:00:00.000Z",
      meta: { kind: "journalArticle", publication: "Journal of Retrieval", doi: "10.1234/jr.2026.0042", date: "2026-05-12", accessed: opened.material.fetchedAt, creators: [{ family: "Lindqvist" }, { family: "Nowak" }] },
    });
    expect((await store.list())[0]).toMatchObject({ kind: "journalArticle", byline: "Mara Lindqvist, Tomasz Nowak", publishedAt: "2026-05-12T00:00:00.000Z" });
    expect((await store.search("nowak retrieval")).map((m) => m.id)).toEqual([opened.material.id]);
    expect((await store.search("10.1234/jr.2026.0042")).map((m) => m.id)).toEqual([opened.material.id]);
    expect(await store.search("nowak nothing")).toEqual([]);
  });

  it("derives the extracted layer of a record saved before the model at read time, and refreshMetadata persists a real one from the capture", async () => {
    const store = new MaterialStore(root, async (url) => ({ bytes: new TextEncoder().encode(taggedArticle), mediaType: "text/html", finalUrl: url.toString() }));
    const opened = await store.openUrl("https://journal.example.test/articles/42");
    if (!opened.ok) throw new Error(opened.message);
    const { id } = opened.material;
    const path = join(root, "materials", `${id}.json`);
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const { extracted: _extracted, ...legacy } = stored;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({ ...legacy, title: "Calibrated abstention", byline: "Mara Lindqvist and Tomasz Nowak", publishedAt: "2026-05-12T00:00:00.000Z" }));
    const derived = (await store.get(id))!;
    expect(derived).toMatchObject({ kind: "webpage", title: "Calibrated abstention", byline: "Mara Lindqvist, Tomasz Nowak", publishedAt: "2026-05-12T00:00:00.000Z", extracted: { kind: "webpage", creators: [{ name: "Mara Lindqvist" }, { name: "Tomasz Nowak" }] } });
    expect(derived.meta.doi).toBeUndefined();
    const refreshed = await store.refreshMetadata(id);
    expect(refreshed).toMatchObject({ kind: "journalArticle", title: "Calibrated Abstention for Long-Context QA", meta: { doi: "10.1234/jr.2026.0042" } });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ extracted: { kind: "journalArticle", doi: "10.1234/jr.2026.0042" } });
    await expect(store.refreshMetadata("0000000000000000")).rejects.toThrow(/is not in the library/);
  });

  it("keeps what the page declared when an item adds to a page whose capture was not kept, or whose PDF is now its primary view", async () => {
    const pdf = new Uint8Array(await readFile(join(__dirname, "__fixtures__", "two-pages.pdf")));
    let keep = false;
    const store = new MaterialStore(root, async (url) => (url.pathname.endsWith(".pdf")
      ? { bytes: pdf, mediaType: "application/pdf", finalUrl: url.toString() }
      : { bytes: new TextEncoder().encode(taggedArticle), mediaType: "text/html", finalUrl: url.toString() }), { keepCapture: () => keep });
    const declared = { kind: "journalArticle", title: "Calibrated Abstention for Long-Context QA", publication: "Journal of Retrieval", doi: "10.1234/jr.2026.0042", date: "2026-05-12", creators: [{ family: "Lindqvist" }, { family: "Nowak" }] };
    const item = { abstract: "From the feed.", publication: "Retrieval Weekly", creators: [{ role: "author" as const, name: "Someone Else" }] };

    const uncaptured = await store.openUrl("https://journal.example.test/articles/42");
    if (!uncaptured.ok) throw new Error(uncaptured.message);
    expect(await store.captureBytes(uncaptured.material.id)).toBeUndefined();
    // As with the page at hand: the page's tags win over the item's, and the item fills what the page left out.
    expect(await store.openUrl("https://journal.example.test/articles/42", "feed", item)).toMatchObject({ ok: true, existing: true, material: { kind: "journalArticle", byline: "Mara Lindqvist, Tomasz Nowak", meta: { ...declared, abstract: "From the feed." } } });
    expect(await store.exportBibtex([uncaptured.material.id])).toContain("doi = {10.1234/jr.2026.0042}");

    keep = true;
    const captured = await store.openUrl("https://journal.example.test/articles/43");
    if (!captured.ok) throw new Error(captured.message);
    const { id } = captured.material;
    await store.registerView(id, { id: "pdf", label: "PDF", url: "https://journal.example.test/articles/43.pdf", mediaType: "application/pdf", status: "available" });
    expect((await store.fetchView(id, "pdf")).ok).toBe(true);
    expect((await store.setPrimaryView(id, "pdf")).mediaType).toBe("application/pdf");
    expect(await store.openUrl("https://journal.example.test/articles/43", "feed", item)).toMatchObject({ ok: true, existing: true, material: { id, primaryView: "pdf", kind: "journalArticle", meta: { ...declared, abstract: "From the feed." } } });
  });

  it("merges the item's metadata under the page's when a subscription item is read", async () => {
    const store = new MaterialStore(root, pageFetcher("Retrieval Without Regret"));
    const item = { kind: "preprint" as const, arxivId: "2409.12345", publication: "arXiv", creators: [{ role: "author" as const, name: "Mara Lindqvist" }], abstract: "From the Atom feed.", extra: "arXiv: 2409.12345 [cs.CL]", date: "2026-09-17T17:59:12.000Z" };
    const opened = await store.openUrl("https://arxiv.org/html/2409.12345v1", "feed", item);
    if (!opened.ok) throw new Error(opened.message);
    expect(opened.material).toMatchObject({ kind: "preprint", title: "Retrieval Without Regret", byline: "Mara Lindqvist", publishedAt: "2026-09-17T17:59:12.000Z", meta: { arxivId: "2409.12345", publication: "arXiv", abstract: "From the Atom feed.", extra: "arXiv: 2409.12345 [cs.CL]" } });
    expect(JSON.parse(await readFile(join(root, "materials", `${opened.material.id}.json`), "utf8"))).toMatchObject({ itemMeta: item });
    expect((await store.refreshMetadata(opened.material.id)).meta.abstract).toBe("From the Atom feed.");
    expect(await store.exportBibtex([opened.material.id])).toMatch(/^@misc\{lindqvist2026retrieval,\n {2}author = \{Mara Lindqvist\},\n {2}title = \{\{Retrieval Without Regret\}\},\n {2}eprint = \{2409\.12345\},\n {2}archivePrefix = \{arXiv\},\n {2}primaryClass = \{cs\.CL\}/);
  });

  it("exports BibTeX in the order given, skipping unknown ids, and refuses when none resolves", async () => {
    const store = new MaterialStore(root, async (url) => ({ bytes: new TextEncoder().encode(taggedArticle), mediaType: "text/html", finalUrl: url.toString() }));
    const first = await store.openUrl("https://journal.example.test/articles/42");
    const second = await store.openFile({ name: "notes.md", mediaType: "", bytes: new TextEncoder().encode("# Notes\n\nText.") });
    if (!first.ok || !second.ok) throw new Error("setup");
    const out = await store.exportBibtex([second.material.id, "0000000000000000", first.material.id]);
    expect(out.split("\n\n").map((entry) => entry.split("\n")[0])).toEqual([`@misc{notes,`, "@article{lindqvist2026calibrated,"]);
    await expect(store.exportBibtex(["0000000000000000"])).rejects.toThrow(/None of these materials is in the library: 0000000000000000/);
    expect(await store.has(first.material.id)).toBe(true);
    expect(await store.has("0000000000000000")).toBe(false);
    expect(await store.has("../x")).toBe(false);
  });
});

describe("MaterialStore PDFs", () => {
  it("stores a dropped PDF next to its record and serves the bytes back", async () => {
    const store = new MaterialStore(root);
    const bytes = new Uint8Array(await readFile(join(__dirname, "__fixtures__", "two-pages.pdf")));
    const result = await store.openFile({ name: "paper.pdf", mediaType: "", bytes });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.mediaType).toBe("application/pdf");
    expect(result.material.title).toBe("Attention is not all you need");
    expect(result.material.byline).toBe("A. Researcher");
    expect(result.material.pdf).toEqual({ pages: 2, byteLength: bytes.byteLength, textLayer: "available" });
    expect(result.material.plain).toContain("Second page");
    expect(result.material.reader).toBeUndefined();
    const stored = await store.bytes(result.material.id);
    expect(stored?.byteLength).toBe(bytes.byteLength);
    expect(await store.bytes("0000000000000000")).toBeUndefined();
    expect((await store.list())[0]?.title).toBe("Attention is not all you need");
  });

  it("names a PDF without an Info title after its file and reports a missing text layer", async () => {
    const store = new MaterialStore(root);
    const source = new TextDecoder("latin1").decode(await readFile(join(__dirname, "__fixtures__", "two-pages.pdf")));
    // Blank the Info title and the page text so pdf.js sees an untitled, image-only document. Byte lengths are unchanged, so the xref stays valid.
    const untitled = source.replace("/Title (Attention is not all you need)", "/Title (                             )").replace(/\(([^)]*)\) Tj/g, (m) => `(${" ".repeat(m.length - 5)}) Tj`);
    const bytes = Uint8Array.from(untitled, (c) => c.charCodeAt(0));
    const result = await store.openFile({ name: "scan-2024.pdf", mediaType: "application/pdf", bytes });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.title).toBe("scan-2024");
    expect(result.material.pdf?.textLayer).toBe("absent");
  });

  it("rejects bytes that only claim to be a PDF", async () => {
    const store = new MaterialStore(root);
    const result = await store.openFile({ name: "broken.pdf", mediaType: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.7 nothing here") });
    expect(result).toMatchObject({ ok: false, code: "PDF_INVALID" });
  });
});

describe("MaterialStore corpus import", () => {
  it("imports gzipped snapshots once and reports per-slug failures", async () => {
    const { gzipSync } = await import("node:zlib");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const corpus = join(root, "corpus");
    const html = `<!doctype html><html><head><title>Cache keys</title></head><body><article><h1>Cache keys</h1>${"<p>Two harnesses cache the tokenised prompt keyed on the question text alone, so a changed system prompt silently reuses the old one.</p>".repeat(12)}</article></body></html>`;
    await mkdir(join(corpus, "good"), { recursive: true });
    await writeFile(join(corpus, "good", "page.html.gz"), gzipSync(Buffer.from(html)));
    await writeFile(join(corpus, "good", "meta.json"), JSON.stringify({ url: "https://example.test/cache", finalUrl: "https://example.test/cache", fetchedAt: "2026-09-17T00:00:00.000Z" }));
    await mkdir(join(corpus, "broken"), { recursive: true });
    await writeFile(join(corpus, "broken", "meta.json"), "{ not json");
    const store = new MaterialStore(root);
    const first = await store.importSnapshots(corpus);
    expect(first).toMatchObject({ imported: 1, skipped: 0 });
    expect(first.failed.map((f) => f.slug)).toEqual(["broken"]);
    expect((await store.list()).map((m) => m.title)).toEqual(["Cache keys"]);
    expect((await store.list())[0]?.fetchedAt).toBe("2026-09-17T00:00:00.000Z");
    expect((await store.get((await store.list())[0]!.id))?.capture?.fetchedAt).toBe("2026-09-17T00:00:00.000Z");
    const second = await store.importSnapshots(corpus);
    expect(second).toMatchObject({ imported: 0, skipped: 1 });
  });
});

describe("imageUrlsOf", () => {
  it("lists reader image sources in order, once each, http(s) only", () => {
    const payload = JSON.stringify({ type: "root", children: [
      { type: "paragraph", children: [{ type: "image", url: "https://x.test/a.png", alt: "" }, { type: "image", url: "https://x.test/a.png", alt: "" }] },
      { type: "figure", media: [{ type: "image", url: "https://x.test/b.png", alt: "" }], caption: [], credit: [] },
      { type: "paragraph", children: [{ type: "image", url: "data:image/png;base64,AAAA", alt: "" }] },
    ] });
    expect(imageUrlsOf({ reader: { schema: "reader.document.v2", payload } })).toEqual(["https://x.test/a.png", "https://x.test/b.png"]);
    expect(imageUrlsOf({})).toEqual([]);
  });
});

describe("imageReferencesOf", () => {
  const image = (n: number) => ({ type: "image", url: `https://x.test/${n}.png`, alt: "" });
  const cell = (n: number) => ({ type: "tableCell", align: null, colSpan: 1, rowSpan: 1, header: false, scope: null, children: [{ type: "paragraph", children: [image(n)] }] });

  it("lists every picture of the reader document, past the prefetch cap and in every container, http(s) only", () => {
    const payload = JSON.stringify({ type: "root", losses: [], children: [
      { type: "paragraph", children: Array.from({ length: 95 }, (_, n) => image(n)) },
      { type: "table", caption: [], head: null, bodies: [], foot: { type: "tableSection", children: [{ type: "tableRow", children: [cell(95)] }] } },
      { type: "figure", media: [{ type: "image", url: "quire-figure://8667175ac66aac06/1.png", alt: "" }], caption: [], credit: [] },
    ] });
    const reader = { schema: "reader.document.v2" as const, payload };
    expect(imageUrlsOf({ reader })).toHaveLength(80);
    const all = imageReferencesOf({ reader }, "https://x.test/post");
    expect(all).toHaveLength(96);
    expect(all).toContain("https://x.test/95.png");
    expect(all).not.toContain("quire-figure://8667175ac66aac06/1.png");
  });

  it("reads the Markdown the reader falls back to with the reader's own parser: escapes resolved, code left alone", () => {
    const markdown = "Before.\n\n![Chart](https://i0.wp.com/acoup.blog/chart.png?resize=926%2C659\\&ssl=1)\n\nAfter `![not a picture](https://x.test/code.png)`.\n";
    const chart = "https://i0.wp.com/acoup.blog/chart.png?resize=926%2C659&ssl=1";
    expect(imageReferencesOf({ markdown }, "https://acoup.blog/post")).toEqual([chart]);
    // A reader document that cannot be read renders the Markdown instead, so its pictures are the Markdown's.
    expect(imageReferencesOf({ reader: { schema: "reader.document.v2", payload: "{not json" }, markdown }, "https://acoup.blog/post")).toEqual([chart]);
    expect(imageReferencesOf({}, "https://acoup.blog/post")).toEqual([]);
  });
});

describe("MaterialStore.imageReferences", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const fetcher = async (url: URL) => (url.pathname.endsWith(".md")
    ? { bytes: encode("# Cache keys\n\n![Only in this view](https://img.test/view-only.png)\n"), mediaType: "text/markdown", finalUrl: url.toString() }
    : { bytes: encode(article("Cache keys")), mediaType: "text/html", finalUrl: url.toString() });

  it("reads every picture of the record, its stored views and its kept revisions, for the given materials or for all of them", async () => {
    const store = new MaterialStore(root, fetcher);
    // A dropped Markdown file with 95 pictures, more than the 80 a save prefetches.
    const gallery = await store.openFile({ name: "gallery.md", mediaType: "", bytes: encode(`# Gallery\n\n${Array.from({ length: 95 }, (_, n) => `![${n}](https://img.test/${n}.png)`).join("\n\n")}\n`) });
    if (!gallery.ok) throw new Error(gallery.message);
    // A page without pictures, with a stored Markdown view that has one.
    const page = await store.openUrl("https://example.test/cache");
    if (!page.ok) throw new Error(page.message);
    await store.registerView(page.material.id, { id: "markdown", label: "Markdown", url: "https://example.test/cache.md", mediaType: "text/markdown", status: "available" });
    expect(await store.fetchView(page.material.id, "markdown")).toMatchObject({ ok: true });
    // A feed's Markdown-only copy, its picture's link escaped the way GFM output writes it.
    const copy = await store.saveFromFeed({ url: "https://acoup.blog/post", title: "Post", content: { markdown: "Intro.\n\n![Chart](https://i0.wp.com/acoup.blog/chart.png?resize=926%2C659\\&ssl=1)\n" } });
    expect(copy.reader).toBeUndefined();
    // An artifact whose first version showed another picture than its current one.
    const artifact = await store.saveArtifact({ title: "Synthesis", source: "![First](https://img.test/first.png)", lineage: [page.material.id] });
    await store.updateArtifact(artifact.id, { source: "![Second](https://img.test/second.png)" });

    expect((await store.imageReferences([gallery.material.id])).size).toBe(95);
    expect([...(await store.imageReferences([page.material.id]))]).toEqual(["https://img.test/view-only.png"]);
    expect([...(await store.imageReferences([copy.id]))]).toEqual(["https://i0.wp.com/acoup.blog/chart.png?resize=926%2C659&ssl=1"]);
    expect([...(await store.imageReferences([artifact.id]))].sort()).toEqual(["https://img.test/first.png", "https://img.test/second.png"]);
    expect((await store.imageReferences()).size).toBe(95 + 1 + 1 + 2);
    expect((await store.imageReferences(["0000000000000000"])).size).toBe(0);
    await expect(store.imageReferences(["../x"])).rejects.toThrow("Not a material id: ../x");
  });
});

describe("MaterialStore.search", () => {
  it("matches every word across title, byline and body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quire-search-"));
    const store = new MaterialStore(dir);
    const result = await store.openFile({ name: "notes.md", mediaType: "text/markdown", bytes: new TextEncoder().encode("# Cache keys\n\nThe prompt template leaks the test set.") });
    expect(result.ok).toBe(true);
    expect((await store.search("prompt leaks")).map((m) => m.title)).toEqual(["Cache keys"]);
    expect((await store.search("cache nothing")).length).toBe(0);
    expect(await store.search("   ")).toEqual([]);
  });
});

describe("withoutTitleHeading", () => {
  it("drops a leading H1 that repeats the title and keeps any other", () => {
    expect(withoutTitleHeading("# A  Title\n\nBody", "a title")).toBe("Body");
    expect(withoutTitleHeading("# Other\n\nBody", "A title")).toBe("# Other\n\nBody");
    expect(withoutTitleHeading("Body", "A title")).toBe("Body");
  });
});

describe("MaterialStore artifact versions", () => {
  it("keeps every version of an artifact, shows an earlier one, and restores it as the newest", async () => {
    const store = new MaterialStore(root);
    const opened = await store.openFile({ name: "note.md", mediaType: "", bytes: new TextEncoder().encode("# Note\n\nText.\n") });
    if (!opened.ok) throw new Error(opened.message);
    const first = "export default function Chart() { return <p>First</p>; }";
    const saved = await store.saveArtifact({ title: "Chart", type: "react", source: first, lineage: [opened.material.id] });
    expect(saved).toMatchObject({ mediaType: "application/vnd.quire.artifact+react", artifact: { type: "react", version: 1 }, plain: "First" });
    await store.updateArtifact(saved.id, { edit: { oldText: "First", newText: "Second" } });
    await store.updateArtifact(saved.id, { edit: { oldText: "Second", newText: "Third" }, title: "Chart, final" });

    expect((await store.artifactAt(saved.id))?.source).toContain("Third");
    expect(await store.artifactAt(saved.id, 1)).toMatchObject({ source: first, title: "Chart", info: { version: 1 } });
    expect(await store.artifactAt(saved.id, 9)).toBeUndefined();
    expect((await store.artifactVersionContent(saved.id, 2))?.artifactBody).toEqual({ type: "react", source: first.replace("First", "Second"), version: 2 });

    const restored = await store.restoreArtifact(saved.id, 1);
    expect(restored).toMatchObject({ title: "Chart", artifact: { version: 4 }, artifactSource: first });
    expect((await store.artifactAt(saved.id, 3))?.source).toContain("Third");
    await expect(store.restoreArtifact(saved.id, 7)).rejects.toThrow(/not kept/);
    await expect(store.saveArtifact({ title: "Bad", type: "react", source: "import x from 'axios';\nexport default () => x;", lineage: [opened.material.id] })).rejects.toThrow(/axios/);
  });
});
