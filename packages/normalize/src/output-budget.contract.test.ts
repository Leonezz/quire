import { describe, expect, it } from "vitest";

import {
  htmlStructureWithinBudget,
  jsonByteLengthWithin,
} from "./output-budget";
import { readerDocumentV2FromHtml } from "./reader-document-v2";
import { createRepresentations } from "./representations";

const ERROR_CODE = "SOURCE_REPRESENTATION_BUDGET_EXCEEDED";

function representationInput(content: string, maxOutputBytes: number) {
  return {
    baseUri: "https://example.test/article",
    content,
    maxDepth: 40,
    maxNodes: 10_000,
    maxOutputBytes,
    mediaType: "text/html",
    outputBudgetErrorCode: ERROR_CODE,
    producerKey: "generic",
    title: "Bounded output",
  } as const;
}

describe("content normalization output budgets", () => {
  it("counts parser-visible nodes without treating markup-looking text as elements", () => {
    const html = `<!doctype html PUBLIC "<not-a-node>" "quoted">
      <!-- <not-a-node><not-a-node> -->
      <html data-template="> <not-a-node>">
        <head>
          <title>Reader title: 2 < 3 and <not-a-node></title>
          <style>.note::before { content: "<not-a-node>"; }</style>
        </head>
        <body>
          <script>const template = "<not-a-node>";</script>
          <textarea>Literal <not-a-node> text</textarea>
          <p data-example="<not-a-node> > text">Evidence.</p>
        </body>
      </html>`;

    expect(htmlStructureWithinBudget(html, 4, 27)).toBe(true);
    expect(htmlStructureWithinBudget(html, 4, 26)).toBe(false);
  });

  it("does not let malformed HTML comment endings hide following elements", () => {
    expect(
      htmlStructureWithinBudget("<!--><br><!--><br>", 3, 1),
    ).toBe(false);
    expect(
      htmlStructureWithinBudget("<!-- note --!><br><br>", 3, 1),
    ).toBe(false);
  });

  it("does not treat quotes as structure inside an HTML bogus comment", () => {
    expect(
      htmlStructureWithinBudget('<!bogus "<x><br>"><br>', 3, 1),
    ).toBe(false);
  });

  it("switches back to HTML parsing inside SVG and MathML integration points", () => {
    const selfClosingDivs = "<div/>".repeat(41);
    const encodedMathMlIntegrationPoints = [
      "text&#x2f;html",
      "text&#47;html",
      " \tTeXt&#X00002F;HtMl \n",
      " application&sol;xhtml&plus;xml ",
      `text&#${"0".repeat(20_000)}47;html`,
    ];

    expect(
      htmlStructureWithinBudget(
        `<svg><foreignObject>${selfClosingDivs}</foreignObject></svg>`,
        40,
        100,
      ),
    ).toBe(false);
    expect(
      htmlStructureWithinBudget(
        `<math><annotation-xml encoding="text/html">${selfClosingDivs}</annotation-xml></math>`,
        40,
        100,
      ),
    ).toBe(false);
    for (const encoding of encodedMathMlIntegrationPoints)
      expect(
        htmlStructureWithinBudget(
          `<math><annotation-xml encoding="${encoding}">${selfClosingDivs}</annotation-xml></math>`,
          40,
          100,
        ),
      ).toBe(false);
  });

  it("does not let malformed optional-end-tag sequences hide DOM depth", () => {
    expect(
      htmlStructureWithinBudget(
        "<h1><p/><optgroup></dt>".repeat(60),
        40,
        1_000,
      ),
    ).toBe(false);
  });

  it("does not let unmatched end tags reset malformed heading depth", () => {
    expect(
      htmlStructureWithinBudget("<h1></table>".repeat(60), 40, 1_000),
    ).toBe(false);
  });

  it("tolerates a stray list-item close after parser-repaired TOC markup", () => {
    const html =
      '<nav><ol><li><a href="#part-1">Part 1</a></li><li><a href="#part-2">Part 2</a></li></ol></li><li><a href="#part-3">Part 3</a></li></nav><main><p>Article body.</p></main>';

    expect(htmlStructureWithinBudget(html, 5, 14)).toBe(true);
    expect(htmlStructureWithinBudget(html, 4, 14)).toBe(false);
    expect(htmlStructureWithinBudget(html, 5, 13)).toBe(false);
    expect(
      htmlStructureWithinBudget("<h1></li>".repeat(60), 40, 1_000),
    ).toBe(false);
  });

  it("matches Linkedom heading nesting when optional closes are omitted", () => {
    expect(htmlStructureWithinBudget("<h1>".repeat(60), 40, 1_000)).toBe(
      false,
    );
  });

  it("does not apply table optional-end-tag rules through unrelated elements", () => {
    expect(
      htmlStructureWithinBudget("<tr><li>".repeat(60), 40, 1_000),
    ).toBe(false);
  });

  it.each([
    "<tfoot><tbody>".repeat(60),
    "<colgroup>".repeat(60),
  ])("matches Linkedom nesting for malformed table structure", (html) => {
    expect(htmlStructureWithinBudget(html, 40, 1_000)).toBe(false);
  });

  it("matches Linkedom's asymmetric table-cell repair", () => {
    const html = `${"<div>".repeat(39)}<td><th>`;

    expect(htmlStructureWithinBudget(html, 40, 1_000)).toBe(false);
  });

  it("does not discard formatting elements across an ambiguous end tag", () => {
    expect(
      htmlStructureWithinBudget("<b><i></b><div>x</div>", 2, 100),
    ).toBe(false);
  });

  it("ignores an unmatched adoption-agency end tag that cannot increase DOM depth", () => {
    expect(
      htmlStructureWithinBudget(
        "<div><p><em>evidence</font><span>detail</span></em></p></div>",
        5,
        8,
      ),
    ).toBe(true);
  });

  it("ignores end tags for void elements just as the HTML parser does", () => {
    expect(
      htmlStructureWithinBudget(
        "<div><p>first<br></br>second</p></div>",
        4,
        6,
      ),
    ).toBe(true);
  });

  it("budgets text, comments, doctypes, and implicit table structure", () => {
    const table = "<table><tr><td>x</td></tr></table>";

    expect(htmlStructureWithinBudget(table, 5, 5)).toBe(true);
    expect(htmlStructureWithinBudget(table, 4, 5)).toBe(false);
    expect(htmlStructureWithinBudget(table, 5, 4)).toBe(false);
    expect(htmlStructureWithinBudget("<table><td>x</table>", 5, 5)).toBe(
      true,
    );
    expect(htmlStructureWithinBudget("<table><col></table>", 3, 3)).toBe(
      true,
    );
    expect(htmlStructureWithinBudget("<p>x</p>", 2, 2)).toBe(true);
    expect(htmlStructureWithinBudget("<p>x</p>", 1, 2)).toBe(false);
    expect(htmlStructureWithinBudget("<!--a--><!--b-->", 1, 1)).toBe(false);
    expect(htmlStructureWithinBudget("<!doctype html><p>x</p>", 2, 2)).toBe(
      false,
    );
  });

  it("honors common optional HTML end tags when estimating depth", () => {
    const cases = [
      `<ul>${"<li>item".repeat(41)}</ul>`,
      `<dl>${"<dt>term<dd>definition".repeat(21)}</dl>`,
      `<select>${"<option>choice".repeat(41)}</select>`,
      `<table><tbody>${"<tr><td>cell".repeat(41)}</tbody></table>`,
      "<p>paragraph".repeat(41),
    ];

    for (const html of cases)
      expect(htmlStructureWithinBudget(html, 10, 200)).toBe(true);

    expect(
      htmlStructureWithinBudget("<ul><li>x</ul>".repeat(41), 3, 123),
    ).toBe(true);
    expect(
      htmlStructureWithinBudget("<table><tr><td>x</table>", 5, 5),
    ).toBe(true);

    expect(
      htmlStructureWithinBudget("<ul><li>".repeat(6), 10, 200),
    ).toBe(false);
  });

  it("matches JSON UTF-8 bytes for escaped strings, surrogate pairs, and omitted values", () => {
    const value = {
      array: [undefined, Number.NaN, -0, "\u0000\b\t\n\f\r\"\\"],
      omitted: undefined,
      text: `ASCII 中文 😀 ${"\ud800"} ${"\udc00"}`,
    };
    const serialized = JSON.stringify(value);

    expect(jsonByteLengthWithin(value, 8_192, ERROR_CODE)).toBe(Buffer.byteLength(serialized, "utf8"));
  });

  it("removes only a duplicate leading page title and preserves the first body block", () => {
    const result = readerDocumentV2FromHtml({
      baseUri: "https://example.test/article",
      html: "<h1>Bounded output</h1><p>First evidence block must survive.</p><h2>Method</h2>",
      maxDepth: 40,
      maxNodes: 10_000,
      maxOutputBytes: 8_192,
      outputBudgetErrorCode: ERROR_CODE,
      title: "Bounded output",
    });

    expect(result.document.children).toEqual([
      { children: [{ type: "text", value: "First evidence block must survive." }], type: "paragraph" },
      { children: [{ type: "text", value: "Method" }], depth: 2, type: "heading" },
    ]);
    expect(result.document.losses).toEqual([
      expect.objectContaining({ code: "DUPLICATE_PAGE_TITLE_REMOVED" }),
    ]);
  });

  it("rejects HTML before Turndown when transform input exceeds its conservative cap", () => {
    const input = representationInput(`<p>${"x".repeat(3_000)}</p>`, 1_024);

    expect(() => createRepresentations(input)).toThrowError(ERROR_CODE);
  });

  it("enforces one cumulative budget across all four representations", () => {
    const input = representationInput(`<p>${"bounded ".repeat(75)}</p>`, 2_500);

    expect(() => createRepresentations(input)).toThrowError(ERROR_CODE);
  });

  it("bounds long image URL, alt, and title fields while mapping Reader v2", () => {
    const html = `<figure><img src="https://example.test/${"u".repeat(2_000)}" alt="${"a".repeat(2_000)}" title="${"t".repeat(2_000)}"></figure>`;

    expect(() => readerDocumentV2FromHtml({
      baseUri: "https://example.test/article",
      html,
      maxDepth: 40,
      maxNodes: 10_000,
      maxOutputBytes: 1_024,
      outputBudgetErrorCode: ERROR_CODE,
      title: "Bounded output",
    })).toThrowError(ERROR_CODE);
  });

  it("bounds code and math payloads while mapping Reader v2", () => {
    const html = `<pre><code>${"c".repeat(2_000)}</code></pre><div class="math display">\\[${"m".repeat(2_000)}\\]</div>`;

    expect(() => readerDocumentV2FromHtml({
      baseUri: "https://example.test/article",
      html,
      maxDepth: 40,
      maxNodes: 10_000,
      maxOutputBytes: 1_024,
      outputBudgetErrorCode: ERROR_CODE,
      title: "Bounded output",
    })).toThrowError(ERROR_CODE);
  });

  it("bounds a loss-heavy unsupported-element tree during the audit traversal", () => {
    const html = "<custom><span>x</span></custom>".repeat(100);

    expect(() => readerDocumentV2FromHtml({
      baseUri: "https://example.test/article",
      html,
      maxDepth: 40,
      maxNodes: 10_000,
      maxOutputBytes: 512,
      outputBudgetErrorCode: ERROR_CODE,
      title: "Bounded output",
    })).toThrowError(ERROR_CODE);
  });
});
