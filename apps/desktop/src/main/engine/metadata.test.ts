import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyOverrides, bylineOf, creatorsFromByline, extractMetadata, normalizeDate, normalizeDoi, publishedAtOf } from "./metadata";

const fixture = (name: string) => readFile(join(__dirname, "__fixtures__", "metadata", name), "utf8");
const FETCHED = "2026-09-18T12:00:00.000Z";

describe("extractMetadata", () => {
  it("reads Highwire tags first: structured authors, a journal, pages, a normalised DOI and date", async () => {
    const meta = extractMetadata({ html: await fixture("highwire-journal.html"), url: "https://journal.example.test/articles/42", mediaType: "text/html", origin: "web", fetchedAt: FETCHED, fallback: { title: "Calibrated abstention | Journal of Retrieval", byline: "Web Team", publishedAt: "2026-05-01T00:00:00.000Z", lang: "en" } });
    expect(meta).toEqual({
      kind: "journalArticle",
      title: "Calibrated Abstention for Long-Context Question Answering",
      creators: [{ role: "author", name: "Mara Lindqvist", given: "Mara", family: "Lindqvist" }, { role: "author", name: "Tomasz Nowak", given: "Tomasz", family: "Nowak" }],
      date: "2026-05-12", publication: "Journal of Retrieval", volume: "12", issue: "3", pages: "201-219",
      doi: "10.1234/jr.2026.0042", issn: "1234-5678", publisher: "Retrieval Press", language: "en",
      abstract: "We study when retrieval helps and propose a calibrated abstention rule.",
      url: "https://journal.example.test/articles/42", accessed: FETCHED,
    });
  });

  it("marks an arXiv abstract page as a preprint with the version-free id, and merges the item's data under the page's", async () => {
    const item = { kind: "preprint" as const, creators: [{ role: "author" as const, name: "Item Author" }], abstract: "Item abstract", publication: "arXiv", extra: "arXiv: 2409.12345 [cs.CL]", date: "2026-09-17T17:59:12.000Z" };
    const meta = extractMetadata({ html: await fixture("arxiv-abs.html"), url: "https://arxiv.org/abs/2409.12345v1", mediaType: "text/html", origin: "feed", fetchedAt: FETCHED, item, fallback: { title: "[2409.12345] Retrieval Without Regret", byline: "Mara Lindqvist, Tomasz Nowak" } });
    expect(meta).toMatchObject({
      kind: "preprint", arxivId: "2409.12345", title: "Retrieval Without Regret: Calibrated Abstention for Long-Context Question Answering",
      creators: [{ name: "Mara Lindqvist", family: "Lindqvist" }, { name: "Tomasz Nowak", family: "Nowak" }],
      date: "2026-09-17", abstract: "Long-context language models answer many questions from the prompt alone, yet they retrieve anyway.",
      publication: "arXiv", extra: "arXiv: 2409.12345 [cs.CL]", language: "en",
    });
    expect(meta.doi).toBeUndefined();
  });

  it("lets the item fill creators and abstract when the page has none, but the page's title and date win", () => {
    const item = { kind: "preprint" as const, creators: [{ role: "author" as const, name: "Mara Lindqvist" }], abstract: "From the feed", arxivId: "2409.12345", publication: "arXiv", title: "Feed title", date: "2026-09-17" };
    const meta = extractMetadata({ html: "<html><head><title>x</title></head></html>", url: "https://arxiv.org/html/2409.12345v1", mediaType: "text/html", origin: "feed", fetchedAt: FETCHED, item, fallback: { title: "Page title", byline: "Posted by someone", publishedAt: "2026-09-18T00:00:00.000Z" } });
    expect(meta).toMatchObject({ kind: "preprint", title: "Page title", date: "2026-09-18T00:00:00.000Z", creators: [{ role: "author", name: "Mara Lindqvist" }], abstract: "From the feed", arxivId: "2409.12345", publication: "arXiv" });
  });

  it("reads JSON-LD inside @graph: a BlogPosting with two authors, its publisher and blog, and no abstract", async () => {
    const meta = extractMetadata({ html: await fixture("jsonld-blog.html"), url: "https://systems.example.test/posts/cache-keys", mediaType: "text/html", origin: "web", fetchedAt: FETCHED, fallback: { title: "Cache keys", byline: "Ada Lovelace" } });
    expect(meta).toEqual({
      kind: "blogPost", title: "Cache keys, revisited",
      creators: [{ role: "author", name: "Ada Lovelace", given: "Ada", family: "Lovelace" }, { role: "author", name: "Systems Notes Editors" }],
      date: "2026-09-14T07:30:00.000Z", publisher: "Systems Notes Press", publication: "Systems Notes", language: "en-GB",
      url: "https://systems.example.test/posts/cache-keys", accessed: FETCHED,
    });
  });

  it("falls back to og:site_name, the plain author tag and <html lang> on a bare page", async () => {
    const meta = extractMetadata({ html: await fixture("bare-page.html"), url: "https://beweise.example.test/p/1", mediaType: "text/html", origin: "web", fetchedAt: FETCHED, fallback: { title: "Beweise, die man nicht braucht", byline: "Emmy Noether and Someone Else" } });
    expect(meta).toEqual({
      kind: "webpage", title: "Beweise, die man nicht braucht", creators: [{ role: "author", name: "Emmy Noether" }], publication: "Beweise", language: "de",
      url: "https://beweise.example.test/p/1", accessed: FETCHED,
    });
  });

  it("builds the layer from the extractor's fallback alone, splitting the byline and inferring the kind from origin and media type", () => {
    const fallback = { title: "Attention is not all you need", byline: "By A. Researcher, B. Author & C. Writer · D. Editor", publishedAt: "2024-05-12T00:00:00.000Z", lang: "en" };
    expect(extractMetadata({ url: "https://file.local/paper.pdf", mediaType: "application/pdf", origin: "file", fetchedAt: FETCHED, fallback })).toEqual({
      kind: "document", title: "Attention is not all you need",
      creators: [{ role: "author", name: "A. Researcher" }, { role: "author", name: "B. Author" }, { role: "author", name: "C. Writer" }, { role: "author", name: "D. Editor" }],
      date: "2024-05-12T00:00:00.000Z", language: "en", url: "https://file.local/paper.pdf", accessed: FETCHED,
    });
    expect(extractMetadata({ url: "quire://artifact/x", mediaType: "text/markdown", origin: "agent", fetchedAt: FETCHED, fallback: { title: "Synthesis" } }).kind).toBe("note");
    expect(extractMetadata({ url: "https://blog.example.test/a", mediaType: "text/html", origin: "feed", fetchedAt: FETCHED, fallback: { title: "A" } }).kind).toBe("blogPost");
    expect(extractMetadata({ url: "https://blog.example.test/a", mediaType: "text/html", origin: "feed", fetchedAt: FETCHED, fallback: { title: "A" }, item: { kind: "newsletter", publication: "Systems Weekly" } })).toMatchObject({ kind: "newsletter", publication: "Systems Weekly" });
    expect(extractMetadata({ url: "https://example.test/", mediaType: "text/html", origin: "web", fetchedAt: FETCHED, fallback: {} })).toEqual({ kind: "webpage", url: "https://example.test/", accessed: FETCHED });
  });
});

describe("helpers", () => {
  it("normalises dates to ISO, keeping partial ones partial", () => {
    expect(normalizeDate("2024/5/2")).toBe("2024-05-02");
    expect(normalizeDate("2024-05")).toBe("2024-05");
    expect(normalizeDate("2024")).toBe("2024");
    expect(normalizeDate("2024-05-12T10:00:00+02:00")).toBe("2024-05-12T08:00:00.000Z");
    expect(normalizeDate("May 12, 2024")).toMatch(/^2024-05-12/);
    expect(normalizeDate("yesterday")).toBeUndefined();
    expect(normalizeDate("  ")).toBeUndefined();
  });

  it("normalises DOIs and rejects what is not one", () => {
    expect(normalizeDoi("https://doi.org/10.1234/ABC.1")).toBe("10.1234/abc.1");
    expect(normalizeDoi("doi:10.1234/abc")).toBe("10.1234/abc");
    expect(normalizeDoi("not a doi")).toBeUndefined();
  });

  it("derives the byline from creators and publishedAt from a complete date only", () => {
    expect(bylineOf([{ role: "author", name: "A" }, { role: "editor", name: "E" }, { role: "author", name: "B" }])).toBe("A, B");
    expect(bylineOf([{ role: "editor", name: "E" }, { role: "translator", name: "T" }])).toBe("E (ed.)");
    expect(bylineOf([{ role: "translator", name: "T" }])).toBe("T");
    expect(bylineOf([])).toBeUndefined();
    expect(publishedAtOf("2026-09-14T00:00:00.000Z")).toBe("2026-09-14T00:00:00.000Z");
    expect(publishedAtOf("2026-09-14")).toBe("2026-09-14T00:00:00.000Z");
    expect(publishedAtOf("2026-09")).toBeUndefined();
    expect(publishedAtOf(undefined)).toBeUndefined();
    expect(creatorsFromByline("by Ada Lovelace and Charles Babbage")).toEqual([{ role: "author", name: "Ada Lovelace" }, { role: "author", name: "Charles Babbage" }]);
  });

  it("applies overrides: present values replace, empty ones fall through to the extracted layer", () => {
    const extracted = { kind: "webpage" as const, title: "T", creators: [{ role: "author" as const, name: "A" }], date: "2026" };
    expect(applyOverrides(extracted, undefined)).toEqual(extracted);
    expect(applyOverrides(extracted, { title: "Mine", creators: [], date: "", tags: ["x"], kind: "blogPost" })).toEqual({ kind: "blogPost", title: "Mine", creators: [{ role: "author", name: "A" }], date: "2026", tags: ["x"] });
  });
});
