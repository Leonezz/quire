import { describe, expect, it } from "vitest";
import type { MaterialSummary } from "../../shared/contracts";
import { filterOf, inCut } from "./useLibrary";

const material = (over: Partial<MaterialSummary>): MaterialSummary => ({
  id: "m", url: "https://example.org", title: "T", fetchedAt: "2026-01-01T00:00:00Z", readingMinutes: 3, origin: "web", mediaType: "text/html",
  quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "strong", safety: "safe", warnings: [] }, tags: [], kind: "webpage", ...over,
});

describe("library cuts", () => {
  it("puts web, blog, newsletter, news and markdown files under Articles", () => {
    expect(inCut(material({ kind: "blogPost" }), "articles")).toBe(true);
    expect(inCut(material({ kind: "document", mediaType: "text/markdown", origin: "file" }), "articles")).toBe(true);
    expect(inCut(material({ kind: "preprint" }), "articles")).toBe(false);
    expect(inCut(material({ kind: "note", origin: "agent" }), "articles")).toBe(false);
  });
  it("puts preprints, journal and conference papers and PDFs under Papers", () => {
    expect(inCut(material({ kind: "journalArticle" }), "papers")).toBe(true);
    expect(inCut(material({ kind: "document", mediaType: "application/pdf", origin: "file" }), "papers")).toBe(true);
    expect(inCut(material({ kind: "webpage" }), "papers")).toBe(false);
  });
  it("maps the sort and the focus onto the engine's filter", () => {
    expect(filterOf({ cut: "artifacts", tag: undefined }, "oldest", " ")).toEqual({ kind: "artifact", sort: "fetched" });
    expect(filterOf({ cut: "all", tag: "react" }, "title", "hooks")).toEqual({ kind: "all", sort: "title", tag: "react", query: "hooks" });
  });
});
