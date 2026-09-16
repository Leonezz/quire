import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const linkedom = vi.hoisted(() => ({
  parseHTML: vi.fn(() => {
    throw new Error("LINKEDOM_PARSE_CALLED");
  }),
}));

vi.mock("linkedom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("linkedom")>()),
  parseHTML: linkedom.parseHTML,
}));

import { normalizeArticleCapture } from "./article";

function articleCapture(html: string, maxDepth = 40, maxNodes = 10_000) {
  const bytes = new TextEncoder().encode(html);
  return {
    budget: {
      maxBytes: 4 * 1024 * 1024,
      maxDepth,
      maxNodes,
      maxOutputBytes: 4 * 1024 * 1024,
    },
    capture: {
      baseLocator: "https://example.test/research/result",
      bytes,
      contentIdentity:
        `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const,
      mediaType: "text/html",
    },
  };
}

describe("article HTML pre-parse budget", () => {
  beforeEach(() => {
    linkedom.parseHTML.mockClear();
  });

  it("rejects one million short elements before constructing a DOM", () => {
    const result = normalizeArticleCapture(
      articleCapture("<br>".repeat(1_000_000)),
    );

    expect(result).toMatchObject({
      ok: false,
      problems: [
        expect.objectContaining({
          code: "SOURCE_REPRESENTATION_BUDGET_EXCEEDED",
        }),
      ],
    });
    expect(linkedom.parseHTML).not.toHaveBeenCalled();
  });

  it("rejects extreme lexical nesting before constructing a DOM", () => {
    const html = `${"<div>".repeat(41)}evidence${"</div>".repeat(41)}`;
    const result = normalizeArticleCapture(articleCapture(html));

    expect(result).toMatchObject({
      ok: false,
      problems: [
        expect.objectContaining({
          code: "SOURCE_REPRESENTATION_BUDGET_EXCEEDED",
        }),
      ],
    });
    expect(linkedom.parseHTML).not.toHaveBeenCalled();
  });

  it("does not let an abruptly closed comment bypass the pre-parse node limit", () => {
    const result = normalizeArticleCapture(
      articleCapture(`<!-->${"<br>".repeat(10_001)}`),
    );

    expect(result).toMatchObject({
      ok: false,
      problems: [
        expect.objectContaining({
          code: "SOURCE_REPRESENTATION_BUDGET_EXCEEDED",
        }),
      ],
    });
    expect(linkedom.parseHTML).not.toHaveBeenCalled();
  });

  it.each([
    `<svg><foreignObject>${"<div/>".repeat(41)}</foreignObject></svg>`,
    `<math><annotation-xml encoding="text/html">${"<div/>".repeat(41)}</annotation-xml></math>`,
    `<math><annotation-xml encoding="text&#x2f;html">${"<div/>".repeat(41)}</annotation-xml></math>`,
    `<math><annotation-xml encoding="text&#47;html">${"<div/>".repeat(41)}</annotation-xml></math>`,
    `<math><annotation-xml encoding=" application&sol;xhtml&plus;xml ">${"<div/>".repeat(41)}</annotation-xml></math>`,
    `<math><annotation-xml encoding="text&#${"0".repeat(20_000)}47;html">${"<div/>".repeat(41)}</annotation-xml></math>`,
  ])("enforces HTML depth inside a foreign-content integration point", (html) => {
    const result = normalizeArticleCapture(articleCapture(html));

    expect(result).toMatchObject({
      ok: false,
      problems: [
        expect.objectContaining({
          code: "SOURCE_REPRESENTATION_BUDGET_EXCEEDED",
        }),
      ],
    });
    expect(linkedom.parseHTML).not.toHaveBeenCalled();
  });

  it("rejects malformed optional-end-tag depth before constructing a DOM", () => {
    const result = normalizeArticleCapture(
      articleCapture("<h1><p/><optgroup></dt>".repeat(60)),
    );

    expect(result).toMatchObject({
      ok: false,
      problems: [
        expect.objectContaining({
          code: "SOURCE_REPRESENTATION_BUDGET_EXCEEDED",
        }),
      ],
    });
    expect(linkedom.parseHTML).not.toHaveBeenCalled();
  });

  it.each([
    "<h1></table>".repeat(60),
    "<h1>".repeat(60),
    "<tr><li>".repeat(60),
    "<tfoot><tbody>".repeat(60),
    "<colgroup>".repeat(60),
    `${"<div>".repeat(39)}<td><th>`,
  ])("rejects parser-repaired malformed depth before constructing a DOM", (html) => {
    const result = normalizeArticleCapture(articleCapture(html));

    expect(result).toMatchObject({
      ok: false,
      problems: [
        expect.objectContaining({
          code: "SOURCE_REPRESENTATION_BUDGET_EXCEEDED",
        }),
      ],
    });
    expect(linkedom.parseHTML).not.toHaveBeenCalled();
  });

  it("rejects ambiguous formatting reconstruction before constructing a DOM", () => {
    const result = normalizeArticleCapture(
      articleCapture("<b><i></b><div>x</div>", 2),
    );

    expect(result).toMatchObject({
      ok: false,
      problems: [
        expect.objectContaining({
          code: "SOURCE_REPRESENTATION_BUDGET_EXCEEDED",
        }),
      ],
    });
    expect(linkedom.parseHTML).not.toHaveBeenCalled();
  });

  it("rejects implicit table and text nodes before constructing a DOM", () => {
    const result = normalizeArticleCapture(
      articleCapture("<table><tr><td>x</td></tr></table>", 4, 4),
    );

    expect(result).toMatchObject({
      ok: false,
      problems: [
        expect.objectContaining({
          code: "SOURCE_REPRESENTATION_BUDGET_EXCEEDED",
        }),
      ],
    });
    expect(linkedom.parseHTML).not.toHaveBeenCalled();
  });
});
