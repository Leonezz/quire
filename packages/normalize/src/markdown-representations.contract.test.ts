import { describe, expect, it } from "vitest";

import { createMarkdownRepresentations } from "./representations";

describe("scholarly Markdown representations", () => {
  it("preserves headings, code, links, images, and TeX as structured reader nodes", () => {
    const result = createMarkdownRepresentations({
      baseUri: "https://example.test/paper/",
      content: [
        "# Paper",
        "",
        "## Results",
        "",
        "See [evidence](./evidence) and ![plot](./plot.png). Inline $x_1$.",
        "",
        "```python",
        'print("evidence")',
        "```",
        "",
        "$$",
        "x = 1",
        "$$",
      ].join("\n"),
      maxDepth: 100,
      maxNodes: 10_000,
      maxOutputBytes: 1024 * 1024,
      outputBudgetErrorCode: "SOURCE_REPRESENTATION_BUDGET_EXCEEDED",
    });
    const reader = result.representations.find((value) => value.schema === "reader.document.v2");
    expect(reader).toBeDefined();
    const document = JSON.parse(reader!.content);
    expect(document.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ depth: 1, type: "heading" }),
      expect.objectContaining({ depth: 2, type: "heading" }),
      expect.objectContaining({ lang: "python", type: "code", value: expect.stringContaining("evidence") }),
      expect.objectContaining({ display: true, format: "tex", type: "math", value: "x = 1" }),
    ]));
    expect(JSON.stringify(document)).toContain("https://example.test/paper/evidence");
    expect(JSON.stringify(document)).toContain("https://example.test/paper/plot.png");
    expect(JSON.stringify(document)).toContain('"display":false');
  });

  it("drops credentialed links instead of exposing them to the reader", () => {
    const result = createMarkdownRepresentations({
      content: "[secret](https://user:password@example.test/private)",
      maxDepth: 20,
      maxNodes: 100,
      maxOutputBytes: 64 * 1024,
      outputBudgetErrorCode: "SOURCE_REPRESENTATION_BUDGET_EXCEEDED",
    });
    expect(result.representations.find((value) => value.schema === "reader.document.v2")?.content).not.toContain("password");
  });

  it("removes unsafe URL attributes from raw HTML in every derived representation", () => {
    const result = createMarkdownRepresentations({
      content: [
        '<a href="https://user:password@example.test/private">credential link</a>',
        '<img alt="unsafe image" src="javascript:alert(1)">',
        '<a href="javascript:alert(1)">script link</a>',
        '[<span data-source="https://user:password@example.test/private">nested label</span>](javascript:alert(1))',
      ].join("\n\n"),
      maxDepth: 20,
      maxNodes: 100,
      maxOutputBytes: 64 * 1024,
      outputBudgetErrorCode: "SOURCE_REPRESENTATION_BUDGET_EXCEEDED",
    });

    for (const representation of result.representations) {
      expect(representation.content).not.toContain("password");
      expect(representation.content).not.toContain("javascript:");
      expect(representation.content).not.toContain("user:");
    }
    const selection = result.representations.find((value) => value.schema === "selection.text.v1");
    expect(selection?.content).toContain("credential link");
    expect(selection?.content).toContain("script link");
    expect(selection?.content).toContain("nested label");
  });

  it("resolves safe reference-style links and images without retaining unsafe definitions", () => {
    const result = createMarkdownRepresentations({
      baseUri: "https://example.test/paper/",
      content: [
        "Read the [DOI][paper], inspect ![architecture][figure], and keep [blocked][secret] as text.",
        "",
        '[paper]: https://doi.org/10.1000/reference.example "Canonical record"',
        '[figure]: ./figures/system.png "System diagram"',
        "[secret]: https://user:password@example.test/private",
      ].join("\n"),
      maxDepth: 20,
      maxNodes: 100,
      maxOutputBytes: 64 * 1024,
      outputBudgetErrorCode: "SOURCE_REPRESENTATION_BUDGET_EXCEEDED",
    });

    const readerV1 = result.representations.find((value) => value.schema === "reader.document.v1");
    const readerV2 = result.representations.find((value) => value.schema === "reader.document.v2");
    const agent = result.representations.find((value) => value.schema === "agent.gfm.v1");
    const selection = result.representations.find((value) => value.schema === "selection.text.v1");
    for (const representation of result.representations) {
      expect(representation.content).not.toContain("password");
      expect(representation.content).not.toContain("user:");
    }
    expect(readerV1?.content).toContain("https://doi.org/10.1000/reference.example");
    expect(readerV1?.content).toContain("https://example.test/paper/figures/system.png");
    expect(readerV2?.content).toContain("https://doi.org/10.1000/reference.example");
    expect(readerV2?.content).toContain("https://example.test/paper/figures/system.png");
    expect(agent?.content).toContain("https://doi.org/10.1000/reference.example");
    expect(agent?.content).toContain("https://example.test/paper/figures/system.png");
    expect(selection?.content).toContain("DOI");
    expect(selection?.content).toContain("architecture");
    expect(selection?.content).toContain("blocked");
  });

  it("preserves parenthesized and bracketed TeX delimiters across representations", () => {
    const result = createMarkdownRepresentations({
      content: [
        "Inline \\(x_1 + \\text{*phase*}\\) remains mathematical.",
        "",
        "\\[",
        "z = x^2",
        "\\]",
      ].join("\n"),
      maxDepth: 20,
      maxNodes: 100,
      maxOutputBytes: 64 * 1024,
      outputBudgetErrorCode: "SOURCE_REPRESENTATION_BUDGET_EXCEEDED",
    });

    const readerV1 = JSON.parse(result.representations.find((value) => value.schema === "reader.document.v1")!.content);
    const readerV2 = JSON.parse(result.representations.find((value) => value.schema === "reader.document.v2")!.content);
    const agent = result.representations.find((value) => value.schema === "agent.gfm.v1")!;
    const selection = result.representations.find((value) => value.schema === "selection.text.v1")!;
    expect(JSON.stringify(readerV1)).toContain("\\\\(x_1 + \\\\text{*phase*}\\\\)");
    expect(JSON.stringify(readerV1)).toContain("z = x^2");
    expect(readerV2.children[0].children).toEqual(expect.arrayContaining([
      expect.objectContaining({ display: false, format: "tex", type: "math", value: "x_1 + \\text{*phase*}" }),
    ]));
    expect(readerV2.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ display: true, format: "tex", type: "math", value: "z = x^2" }),
    ]));
    expect(agent.content).toContain("\\(x_1 + \\text{*phase*}\\)");
    expect(agent.content).toContain("\\[\nz = x^2\n\\]");
    expect(selection.content).toContain("\\(x_1 + \\text{*phase*}\\)");
    expect(selection.content).toContain("\\[\nz = x^2\n\\]");
  });

  it("preserves GFM table sections, header cells, and column alignment", () => {
    const result = createMarkdownRepresentations({
      content: [
        "| Method | Score | Note |",
        "| :--- | ---: | :---: |",
        "| Agent | 0.92 | stable |",
      ].join("\n"),
      maxDepth: 20,
      maxNodes: 100,
      maxOutputBytes: 64 * 1024,
      outputBudgetErrorCode: "SOURCE_REPRESENTATION_BUDGET_EXCEEDED",
    });

    const readerV2 = JSON.parse(result.representations.find((value) => value.schema === "reader.document.v2")!.content);
    const agent = result.representations.find((value) => value.schema === "agent.gfm.v1")!;
    const table = readerV2.children.find((node: { type: string }) => node.type === "table");
    expect(table).toEqual(expect.objectContaining({
      bodies: [expect.objectContaining({
        children: [expect.objectContaining({
          children: [
            expect.objectContaining({ align: "left", header: false }),
            expect.objectContaining({ align: "right", header: false }),
            expect.objectContaining({ align: "center", header: false }),
          ],
          type: "tableRow",
        })],
        type: "tableSection",
      })],
      head: expect.objectContaining({
        children: [expect.objectContaining({
          children: [
            expect.objectContaining({ align: "left", header: true }),
            expect.objectContaining({ align: "right", header: true }),
            expect.objectContaining({ align: "center", header: true }),
          ],
          type: "tableRow",
        })],
        type: "tableSection",
      }),
      type: "table",
    }));
    expect(agent.content.split("\n")[1]).toMatch(/^\| :--+ \| --+: \| :--+: \|$/u);
  });
});
