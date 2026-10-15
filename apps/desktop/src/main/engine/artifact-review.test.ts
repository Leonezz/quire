import { describe, expect, it } from "vitest";
import { reviewArtifact } from "./artifact-review";

const A = "0123456789abcdef";
const B = "fedcba9876543210";

describe("reviewArtifact", () => {
  it("has nothing to say about a well-made synthesis", () => {
    const source = `# Tuning retrieval\n\nRerankers are the largest single gain, and chunking is a trade-off.\n\n## Rerankers are the largest single gain\n\nnDCG went "from 0.41 to 0.58" [${A}].\n\n> [!TIP] Key takeaways\n>\n> - Add a reranker first.\n`;
    expect(reviewArtifact({ type: "markdown", title: "Tuning retrieval: what moves quality", source, lineage: [A] })).toEqual([]);
  });

  it("flags a missing lead, empty headings, a references list and unquoted citations, most important first", () => {
    const source = `## Introduction\n\nIt is important to note that rerankers help [${A}]. Chunks matter [${A}]. Judges drift [${B}]. Overlap helps [${A}].\n\n## References\n\n- ${A}\n`;
    const notes = reviewArtifact({ type: "markdown", title: "Summary", source, lineage: [A, B] });
    expect(notes.join("\n")).toMatch(/not a title a reader can find again/);
    expect(notes.join("\n")).toMatch(/Open with a lead/);
    expect(notes.join("\n")).toMatch(/"Introduction" says nothing/);
    expect(notes.join("\n")).toMatch(/hand-written references/);
    expect(notes.join("\n")).toMatch(/Only 0 of 4 citations follow an exact quote/);
    expect(notes.length).toBeLessThanOrEqual(6);
  });

  it("asks for citations when the sources are listed but nothing cites them, in Chinese text too", () => {
    const notes = reviewArtifact({ type: "markdown", title: "检索调优的三个结论", source: "重排序带来最大提升。综上所述，应当先加重排序。", lineage: [A] });
    expect(notes.join("\n")).toMatch(/No claim carries a citation/);
    expect(notes.join("\n")).toMatch(/综上所述/);
  });

  it("flags fixed colours and missing source links in a component", () => {
    const notes = reviewArtifact({ type: "react", title: "Reranker gains by corpus", source: "export default () => <div className=\"bg-white text-gray-900\" style={{ color: '#333' }}>Gain</div>;", lineage: [A] });
    expect(notes.join("\n")).toMatch(/bg-white/);
    expect(notes.join("\n")).toMatch(/<Cite/);
  });
});
