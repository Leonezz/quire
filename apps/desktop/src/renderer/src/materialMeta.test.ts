import { describe, expect, it } from "vitest";
import { citationMarkdown, displayDate, headerParts, isOverridden, isValidDate, parseCreatorName, publicationLabel } from "./materialMeta";

describe("materialMeta", () => {
  it("accepts partial ISO dates and full timestamps only", () => {
    for (const ok of ["2024", "2024-05", "2024-05-21", "2024-05-21T10:00:00.000Z"]) expect(isValidDate(ok)).toBe(true);
    for (const bad of ["05/2024", "2024-13", "2024-5", "May 2024", "2024-05-32", ""]) expect(isValidDate(bad)).toBe(false);
  });

  it("shows a date at the precision it has", () => {
    expect(displayDate("2024")).toBe("2024");
    expect(displayDate("2024-05")).toMatch(/May 2024/);
    expect(displayDate("2024-05-21")).toMatch(/May 21, 2024|21 May 2024/);
    expect(displayDate("2015-05-21T00:00:00.000Z")).toMatch(/May 21, 2015|21 May 2015/);
    expect(displayDate(undefined)).toBe("");
  });

  it("parses Family, Given and keeps anything else as a display name", () => {
    expect(parseCreatorName("Lovelace, Ada", "author")).toEqual({ role: "author", name: "Lovelace, Ada", given: "Ada", family: "Lovelace" });
    expect(parseCreatorName("  Ada   Lovelace ", "editor")).toEqual({ role: "editor", name: "Ada Lovelace" });
    expect(parseCreatorName("Vaswani et al.", "author")).toEqual({ role: "author", name: "Vaswani et al." });
  });

  it("formats a Markdown citation from whatever parts exist", () => {
    const meta = { title: "Attention Is All You Need", creators: [{ role: "author" as const, name: "Vaswani, Ashish", given: "Ashish", family: "Vaswani" }, { role: "author" as const, name: "Noam Shazeer" }], date: "2017-06-12", publication: "NeurIPS", url: "https://arxiv.org/abs/1706.03762" };
    expect(citationMarkdown(meta, { title: "x", url: "y" })).toBe("Ashish Vaswani and Noam Shazeer (2017). *Attention Is All You Need*. NeurIPS. <https://arxiv.org/abs/1706.03762>");
    expect(citationMarkdown({}, { title: "Untitled page", url: "https://example.org" })).toBe("*Untitled page*. <https://example.org>");
    expect(citationMarkdown({ creators: [{ role: "author", name: "A" }, { role: "author", name: "B" }, { role: "author", name: "C" }, { role: "author", name: "D" }] }, { title: "T", url: "" })).toBe("A et al. *T*.");
  });

  it("builds the reader header from creators, publication and date", () => {
    expect(headerParts({ creators: [{ role: "author", name: "Ada" }, { role: "author", name: "Grace" }], publication: "Systems Weekly", date: "2024" })).toEqual(["Ada, Grace", "Systems Weekly", "2024"]);
    expect(headerParts({})).toEqual([]);
  });

  it("names the publication field per kind and tells an override from a restatement", () => {
    expect(publicationLabel("journalArticle")).toBe("Journal");
    expect(publicationLabel("blogPost")).toBe("Blog");
    expect(publicationLabel("report")).toBe("Publication");
    expect(isOverridden({ title: "A" }, { title: "A" }, "title")).toBe(false);
    expect(isOverridden({ title: "A" }, { title: "B" }, "title")).toBe(true);
    expect(isOverridden({ title: "A" }, undefined, "title")).toBe(false);
  });
});
