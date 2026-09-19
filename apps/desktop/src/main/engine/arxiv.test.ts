import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arxivCategoryFromInput, arxivEntryMetaOf, arxivIdOf, arxivItemsOf, arxivQueryUrl, isArxivCategory } from "./arxiv";
import { parseFeed } from "./feeds";

describe("arXiv categories", () => {
  it("recognises known archives with or without a subject class", () => {
    expect(isArxivCategory("cs.CL")).toBe(true);
    expect(isArxivCategory("hep-th")).toBe(true);
    expect(isArxivCategory("math.PR")).toBe(true);
    expect(isArxivCategory("cs.cl")).toBe(false);
    expect(isArxivCategory("biology.XX")).toBe(false);
    expect(isArxivCategory("cs.CLX")).toBe(false);
  });

  it("extracts the category from the forms people paste", () => {
    expect(arxivCategoryFromInput("cs.CL")).toBe("cs.CL");
    expect(arxivCategoryFromInput("  arxiv:cs.CL ")).toBe("cs.CL");
    expect(arxivCategoryFromInput("https://arxiv.org/list/cs.CL/recent")).toBe("cs.CL");
    expect(arxivCategoryFromInput("https://arxiv.org/list/stat.ML/new?skip=0")).toBe("stat.ML");
    expect(arxivCategoryFromInput("https://arxiv.org/abs/2409.12345")).toBeUndefined();
    expect(arxivCategoryFromInput("https://example.test/feed")).toBeUndefined();
    expect(arxivCategoryFromInput("cache")).toBeUndefined();
  });

  it("builds the export API query and strips versions from ids", () => {
    expect(arxivQueryUrl("cs.CL")).toBe("https://export.arxiv.org/api/query?search_query=cat:cs.CL&sortBy=submittedDate&sortOrder=descending&max_results=50");
    expect(arxivIdOf("http://arxiv.org/abs/2409.12345v1")).toBe("2409.12345");
    expect(arxivIdOf("https://arxiv.org/pdf/2409.12345v3")).toBe("2409.12345");
    expect(arxivIdOf("https://arxiv.org/abs/hep-th/9901001v2")).toBe("hep-th/9901001");
    expect(arxivIdOf("https://example.test/")).toBeUndefined();
  });
});

describe("arxivItemsOf", () => {
  it("maps the API's Atom answer to papers with abstracts and version-free abs links", async () => {
    const bytes = new Uint8Array(await readFile(join(__dirname, "__fixtures__", "arxiv-cs-cl.atom")));
    const feed = parseFeed(bytes, "application/atom+xml", arxivQueryUrl("cs.CL"));
    const items = arxivItemsOf(feed);
    expect(items.map((item) => item.externalId)).toEqual(["2409.12345", "2409.11876", "2409.10021"]);
    expect(items.map((item) => item.link)).toEqual(["https://arxiv.org/abs/2409.12345", "https://arxiv.org/abs/2409.11876", "https://arxiv.org/abs/2409.10021"]);
    expect(items[0]!.title).toBe("Retrieval Without Regret: Calibrated Abstention for Long-Context Question Answering");
    expect(items[0]!.gist.startsWith("Long-context language models answer many questions from the prompt alone")).toBe(true);
    expect(items[0]!.publishedAt).toBe("2026-09-17T17:59:12.000Z");
    expect(items[1]!.publishedAt).toBe("2026-09-16T09:11:05.000Z");
    expect(items[0]).toMatchObject({ readingMinutes: 20, signals: { math: true }, summaryOnly: false });
    expect(items[0]!.content).toBeUndefined();
    // Without the Atom bytes only what the link says is known.
    expect(items[0]!.meta).toEqual({ kind: "preprint", publication: "arXiv", arxivId: "2409.12345", extra: "arXiv: 2409.12345", date: "2026-09-17T17:59:12.000Z" });
  });

  it("reads authors, the abstract, the published date and the primary category from the Atom entries", async () => {
    const bytes = new Uint8Array(await readFile(join(__dirname, "__fixtures__", "arxiv-cs-cl.atom")));
    const feed = parseFeed(bytes, "application/atom+xml", arxivQueryUrl("cs.CL"));
    const items = arxivItemsOf(feed, bytes);
    expect(items[0]!.meta).toEqual({
      kind: "preprint", arxivId: "2409.12345", publication: "arXiv",
      creators: [{ role: "author", name: "Mara Lindqvist" }, { role: "author", name: "Tomasz Nowak" }],
      abstract: "Long-context language models answer many questions from the prompt alone, yet they retrieve anyway, paying latency for evidence they do not use. We study when retrieval helps and propose a calibrated abstention rule that predicts, from the model's own token-level uncertainty, whether the retrieved passages will change the answer. On three long-context benchmarks the rule skips 41% of retrievals with no loss in exact match, and its errors concentrate on questions the model answers wrongly with or without evidence.",
      date: "2026-09-17T17:59:12Z", extra: "arXiv: 2409.12345 [cs.CL]",
    });
    expect(items[2]!.meta?.creators?.map((c) => c.name)).toEqual(["Priya Raman", "Elena Fischer", "Kwame Mensah"]);
    const entries = arxivEntryMetaOf(bytes);
    expect([...entries.keys()]).toEqual(["2409.12345", "2409.11876", "2409.10021"]);
    expect(arxivEntryMetaOf(new TextEncoder().encode("<feed><entry><id>x</id><summary>a &amp; b</summary></entry></feed>")).size).toBe(0);
    expect(arxivEntryMetaOf(new TextEncoder().encode("<feed><entry><id>http://arxiv.org/abs/2409.00001v1</id><summary>a &amp; b &#x27;c&#39;</summary></entry></feed>")).get("2409.00001")).toEqual({ kind: "preprint", arxivId: "2409.00001", publication: "arXiv", abstract: "a & b 'c'", extra: "arXiv: 2409.00001" });
  });
});
