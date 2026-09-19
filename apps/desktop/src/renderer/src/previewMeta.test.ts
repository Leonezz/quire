import { describe, expect, it } from "vitest";
import type { MaterialRecord } from "../../shared/contracts";
import { applyOverrides, extractedOf, kindOfRecord, mergeOverrides } from "./previewMeta";

describe("preview metadata model", () => {
  it("merges like the engine: undefined keeps, empty clears, values replace", () => {
    const current = { title: "Mine", creators: [{ role: "author" as const, name: "A" }], tags: ["x"] };
    expect(mergeOverrides(current, { shortTitle: "Short" })).toEqual({ ...current, shortTitle: "Short" });
    expect(mergeOverrides(current, { title: "" })).toEqual({ creators: current.creators, tags: ["x"] });
    expect(mergeOverrides(current, { creators: [] })).toEqual({ title: "Mine", tags: ["x"] });
    expect(mergeOverrides(current, { creators: [{ role: "editor", name: "Lovelace, Ada" }] }).creators).toEqual([{ role: "editor", name: "Lovelace, Ada", given: "Ada", family: "Lovelace" }]);
    expect(mergeOverrides(current, { tags: ["A", "a", " b "] }).tags).toEqual(["A", "b"]);
    expect(mergeOverrides({}, { date: "2024-05" }).date).toBe("2024-05");
    expect(() => mergeOverrides({}, { date: "05/2024" })).toThrow(/YYYY-MM/);
    expect(() => mergeOverrides({}, { kind: "poem" as never })).toThrow(/Unknown material type/);
    expect(() => mergeOverrides({}, { creators: [{ role: "author", name: " " }] })).toThrow(/needs a name/);
  });

  it("lays overrides over the extracted values and derives extracted from a legacy record", () => {
    expect(applyOverrides({ title: "E", date: "2020" }, { title: "O" })).toEqual({ title: "O", date: "2020" });
    const legacy = { id: "m", url: "https://arxiv.org/abs/1", finalUrl: "https://arxiv.org/abs/1", title: "T", byline: "A and B", publishedAt: "2020-01-02T00:00:00.000Z", fetchedAt: "2026-09-18T00:00:00.000Z", readingMinutes: 1, origin: "web", mediaType: "text/html", lang: "en", quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "strong", safety: "safe", warnings: [] }, tags: [], problems: [] } as unknown as MaterialRecord;
    expect(extractedOf(legacy)).toEqual({ kind: "preprint", title: "T", creators: [{ role: "author", name: "A" }, { role: "author", name: "B" }], date: "2020-01-02", accessed: "2026-09-18", language: "en", url: "https://arxiv.org/abs/1" });
    expect(kindOfRecord({ origin: "agent", mediaType: "text/markdown", url: "agent://x" })).toBe("note");
    expect(kindOfRecord({ origin: "feed", mediaType: "text/html", url: "https://blog.example" })).toBe("blogPost");
    expect(kindOfRecord({ origin: "web", mediaType: "application/pdf", url: "https://x/y.pdf" })).toBe("document");
  });
});
