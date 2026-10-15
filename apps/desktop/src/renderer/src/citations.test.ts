import { describe, expect, it } from "vitest";
import { citedIds, citationIds, numberSources, quoteBefore, splitCitations } from "./citations";

const A = "0123456789abcdef";
const B = "fedcba9876543210";
const C = "aaaaaaaaaaaaaaaa";

describe("citation runs", () => {
  it("reads one id, several in a bracket, and brackets back to back", () => {
    expect(citationIds(`[${A}]`)).toEqual([A]);
    expect(citationIds(`[${A}, ${B}]`)).toEqual([A, B]);
    expect(citationIds(`[${A}; ${B}]`)).toEqual([A, B]);
    expect(citationIds(`[${A}][${B}][${A}]`)).toEqual([A, B]);
  });

  it("splits text into plain runs and citations, carrying the quote before each and swallowing the space before the mark", () => {
    const text = `As the author puts it, "the quick brown fox jumps" [${A}]. Also [${A}, ${B}].`;
    expect(splitCitations(text)).toEqual([
      `As the author puts it, "the quick brown fox jumps"`, { ids: [A], quote: "the quick brown fox jumps" }, ". Also", { ids: [A, B] }, ".",
    ]);
    expect(splitCitations("no citations here")).toEqual(["no citations here"]);
    expect(splitCitations(`not an id [${A.slice(0, 15)}] nor (${A})`)).toEqual([`not an id [${A.slice(0, 15)}] nor (${A})`]);
  });

  it("keeps the quote rule: quotation marks right before, at least twelve characters", () => {
    expect(quoteBefore(`“a long enough passage” — [`, 26)).toBe("a long enough passage");
    expect(quoteBefore(`"too short" [`, 12)).toBeUndefined();
  });
});

describe("numberSources", () => {
  it("numbers cited ids by first appearance, then lineage ids drawn on but not cited", () => {
    const markdown = `First [${B}]. Then [${A}, ${B}].\n\n\`\`\`\n[${C}] in code is not a citation\n\`\`\`\n\nInline \`[${C}]\` neither.`;
    expect(citedIds(markdown)).toEqual([B, A]);
    expect(numberSources(markdown, [A, C])).toEqual([
      { id: B, number: 1, cited: true, listed: false },
      { id: A, number: 2, cited: true, listed: true },
      { id: C, number: 3, cited: false, listed: true },
    ]);
  });
});
