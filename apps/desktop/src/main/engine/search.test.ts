import { describe, expect, it } from "vitest";
import type { ItemRecord, MaterialSummary } from "../../shared/contracts";
import { itemHits, materialHits, mergeHits, searchWords } from "./search";

const material = (over: Partial<MaterialSummary>): MaterialSummary => ({
  id: "0123456789abcdef", url: "https://www.example.com/post", title: "A post", fetchedAt: "2026-09-18T10:00:00Z", readingMinutes: 3, origin: "web", mediaType: "text/html",
  quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "strong", safety: "safe", warnings: [] }, tags: [], ...over,
});
const item = (over: Partial<ItemRecord>): ItemRecord => ({
  id: "i1", sourceId: "s1", sourceTitle: "Systems Notes", sourceKind: "feed", title: "Cache keys", gist: "", link: "https://x/y", publishedAt: "2026-09-17T08:00:00Z", fetchedAt: "2026-09-17T09:00:00Z", readingMinutes: 4, signals: {}, summaryOnly: false, ...over,
});

describe("search", () => {
  it("caps the query at eight words and drops blanks", () => {
    expect(searchWords("  a  b ")).toEqual(["a", "b"]);
    expect(searchWords("1 2 3 4 5 6 7 8 9 10")).toHaveLength(8);
  });
  it("labels material hits with byline or host and a date, and yields nothing for an empty query", () => {
    expect(materialHits("", [material({})])).toEqual([]);
    expect(materialHits("post", [material({}), material({ id: "fedcba9876543210", byline: "Ann", publishedAt: "2026-01-02T00:00:00Z" })]).map((hit) => hit.subtitle)).toEqual(["example.com · 2026-09-18", "Ann · 2026-01-02"]);
  });
  it("labels item hits with the source and puts materials first, capped at fifty", () => {
    expect(itemHits([item({})])[0]).toEqual({ kind: "item", id: "i1", title: "Cache keys", subtitle: "Systems Notes · 2026-09-17" });
    const many = Array.from({ length: 60 }, (_, index) => material({ id: index.toString(16).padStart(16, "0") }));
    const merged = mergeHits(materialHits("post", many), itemHits([item({})]));
    expect(merged).toHaveLength(50);
    expect(merged[0]?.kind).toBe("material");
  });
});
