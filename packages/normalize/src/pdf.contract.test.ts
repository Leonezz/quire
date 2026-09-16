import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { normalizePdfCapture } from "./module";

function identity(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function pdfCapture(extractedText: string, overrides: Record<string, unknown> = {}) {
  const bytes = new TextEncoder().encode("%PDF-1.7\nminimal fixture\n%%EOF\n");
  return {
    budget: {
      maxBytes: 1024 * 1024,
      maxOutputBytes: 128 * 1024,
    },
    capture: {
      baseLocator: "https://arxiv.org/pdf/2608.01234v1",
      bytes,
      contentIdentity: identity(bytes),
      mediaType: "application/pdf",
    },
    extraction: {
      pageCount: 2,
      text: extractedText,
    },
    title: "A bounded paper",
    ...overrides,
  } as const;
}

describe("PDF content normalization seam", () => {
  it("projects injected extraction text into the shared materialization contract", () => {
    const result = normalizePdfCapture(
      pdfCapture("Abstract\n\nThe evidence is reproducible."),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.pdf.materialization.provenance.captureIdentity).toBe(
      result.pdf.sourceFingerprint,
    );
    expect(result.pdf.materialization.representations.map(({ schema }) => schema)).toEqual(
      expect.arrayContaining([
        "reader.document.v2",
        "agent.gfm.v1",
        "selection.text.v1",
      ]),
    );
    const reader = result.pdf.materialization.representations.find(
      (representation) => representation.schema === "reader.document.v2",
    );
    expect(JSON.parse(reader?.content ?? "{}"), reader?.content).toMatchObject({
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: "Abstract\n\nThe evidence is reproducible." }],
        },
      ],
    });
    expect(
      result.pdf.materialization.representations.find(
        (representation) => representation.schema === "agent.gfm.v1",
      )?.content,
    ).toContain("# A bounded paper");
  });

  it("keeps extraction uncertainty visible without changing the raw capture identity", () => {
    const result = normalizePdfCapture(
      pdfCapture("First page only", {
        extraction: {
          pageCount: 2,
          extractedPageCount: 1,
          text: "First page only",
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pdf.pageCount).toBe(2);
    expect(result.pdf.materialization.quality.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SOURCE_PDF_TEXT_TRUNCATED" }),
      ]),
    );
    expect(result.pdf.materialization.provenance.captureIdentity).toBe(
      result.pdf.sourceFingerprint,
    );
  });

  it("records empty extraction as a readable but incomplete materialization", () => {
    const result = normalizePdfCapture(pdfCapture(""));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pdf.materialization.quality).toMatchObject({
      completeness: "none",
      conformance: "recoverable",
    });
    expect(result.pdf.materialization.quality.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SOURCE_PDF_TEXT_EMPTY" }),
      ]),
    );
    expect(
      result.pdf.materialization.representations.find(
        (representation) => representation.schema === "selection.text.v1",
      )?.content,
    ).toBe("");
  });

  it("fails closed when raw bytes or derived representations exceed their budgets", () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\n" + "x".repeat(2_000));
    const result = normalizePdfCapture({
      ...pdfCapture("A short extraction"),
      budget: { maxBytes: 64, maxOutputBytes: 128 * 1024 },
      capture: { ...pdfCapture("A short extraction").capture, bytes, contentIdentity: identity(bytes) },
    });
    expect(result).toMatchObject({
      ok: false,
      problems: [expect.objectContaining({ code: "SOURCE_PDF_TOO_LARGE" })],
    });

    const overBudget = normalizePdfCapture({
      ...pdfCapture("x".repeat(2_000)),
      budget: { maxBytes: 1024 * 1024, maxOutputBytes: 512 },
    });
    expect(overBudget.ok).toBe(false);
    expect(overBudget.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SOURCE_PDF_OUTPUT_BUDGET_EXCEEDED" }),
      ]),
    );
  });

  it("rejects a capture whose declared identity or media type is not trustworthy", () => {
    const input = pdfCapture("Evidence");
    const wrongIdentity = normalizePdfCapture({
      ...input,
      capture: {
        ...input.capture,
        contentIdentity: `sha256:${"0".repeat(64)}` as `sha256:${string}`,
      },
    });
    expect(wrongIdentity).toMatchObject({
      ok: false,
      problems: [
        expect.objectContaining({ code: "SOURCE_CAPTURE_IDENTITY_MISMATCH" }),
      ],
    });

    const wrongMediaType = normalizePdfCapture({
      ...input,
      capture: { ...input.capture, mediaType: "text/plain" },
    });
    expect(wrongMediaType).toMatchObject({
      ok: false,
      problems: [
        expect.objectContaining({ code: "SOURCE_PDF_MEDIA_TYPE_UNSUPPORTED" }),
      ],
    });
  });
});
