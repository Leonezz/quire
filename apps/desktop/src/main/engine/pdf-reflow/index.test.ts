import { readerDocumentV2Schema } from "@read/normalize/contract";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MaterialViewContent } from "../../../shared/contracts";
import { buildTextView, type FigureSink } from "./index";
import type { BlockJudge } from "./judge";

const fixture = (name: string) => readFile(join(__dirname, "..", "__fixtures__", name)).then((buffer) => new Uint8Array(buffer));

function sinkOf(): FigureSink & { written: Map<number, Uint8Array> } {
  const written = new Map<number, Uint8Array>();
  return { written, write: async (id, index, png) => { written.set(index, png); return `quire-figure://${id}/${index}.png`; } };
}

function checkAnchors(content: MaterialViewContent) {
  const plain = content.plain ?? "";
  for (const anchor of content.anchors ?? []) {
    expect(anchor.end).toBeGreaterThan(anchor.start);
    expect(plain.slice(anchor.start, anchor.end)).not.toMatch(/^\s|\s$|\n/);
    for (const value of anchor.rect) { expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(1); }
  }
}

describe("buildTextView", () => {
  it("reflows the two-page fixture into two paragraphs with anchors on each page", async () => {
    const content = await buildTextView(await fixture("two-pages.pdf"), "0123456789abcdef", { figures: sinkOf() });
    expect(content).toMatchObject({ view: "text", mediaType: "text/x-quire-reflow", readingMinutes: 1, problems: [] });
    expect(content.plain).toBe("Attention is not all you need\n\nSecond page: results and discussion");
    expect(content.report).toEqual({ pages: 2, columns: 1, furnitureLines: 0, headings: 0, paragraphs: 2, figures: 0, degradedPages: [] });
    expect(content.anchors?.map((anchor) => anchor.page)).toEqual([1, 2]);
    expect(content.quality).toMatchObject({ completeness: "declared_full", conformance: "conformant", identityConfidence: "derived", safety: "safe" });
    expect(readerDocumentV2Schema.safeParse(JSON.parse(content.reader?.payload ?? "null")).success).toBe(true);
    checkAnchors(content);
  });

  it("reads a real two-column arXiv paper in order, without its watermark, with headings, tables and anchors", async () => {
    const sink = sinkOf();
    const content = await buildTextView(await fixture("arxiv-two-column.pdf"), "8667175ac66aac06", { figures: sink });
    const report = content.report!;
    expect(report.pages).toBe(25);
    expect(report.columns).toBe(2);
    expect(report.furnitureLines).toBeGreaterThan(0);
    expect(report.degradedPages).toEqual([]);
    const plain = content.plain ?? "";
    const lines = plain.split("\n\n");
    expect(lines.some((entry) => /^arXiv:\d{4}\.\d{5}/.test(entry))).toBe(false);
    expect(lines.filter((entry) => /^Harm Laundering in GPT Models/.test(entry))).toHaveLength(1);
    const document = JSON.parse(content.reader?.payload ?? "null");
    expect(readerDocumentV2Schema.safeParse(document).success).toBe(true);
    const markdown = content.markdown ?? "";
    expect(markdown.startsWith("# Harm Laundering in GPT Models")).toBe(true);
    expect(markdown).toContain("\n# 1 Introduction\n");
    expect(markdown).toContain("\n# 2 Related Work\n");
    expect(markdown).toContain("\n## 4.2 Medical Misattribution and Erasure\n");
    expect(lines.find((entry) => entry.startsWith("Safety evaluations"))).toBeDefined();
    expect(lines.indexOf("Abstract")).toBeLessThan(lines.findIndex((entry) => entry.startsWith("Safety evaluations")));
    // The introduction crosses the column break on page 1: its first sentence must read straight through.
    expect(plain).toContain("The standard metric for safety improvement in large language models is toxicity score reduction.");
    checkAnchors(content);
    expect(content.anchors!.length).toBeGreaterThan(1000);
    expect(report.figures).toBeGreaterThanOrEqual(15);
    if (content.problems.some((problem) => problem.code === "TEXT_VIEW_NO_FIGURES")) {
      console.warn("figure crops skipped: @napi-rs/canvas is not available to pdf.js in this environment");
      return;
    }
    expect(content.problems).toEqual([]);
    expect(sink.written.size).toBe(report.figures);
    const png = sink.written.get(1)!;
    expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(markdown).toContain("![Table 1: Constructs used in this paper, with corpus examples.](quire-figure://8667175ac66aac06/");
  }, 60_000);

  it("applies a judge's confident verdicts, reports them, and keeps the rules' result when the judge fails", async () => {
    const drop: BlockJudge = { provider: "jev", judge: async (pages) => ({ verdicts: pages.flatMap((page) => page.blocks.filter((block) => !block.certain && block.page === 2).map((block) => ({ id: block.id, kind: "furniture" as const, confidence: 0.9 }))), usage: { requests: 2, inputTokens: 300, outputTokens: 4, latencyMs: 10 } }) };
    const judged = await buildTextView(await fixture("two-pages.pdf"), "0123456789abcdef", { figures: sinkOf(), judge: drop });
    expect(judged.plain).toBe("Attention is not all you need");
    expect(judged.report).toMatchObject({ furnitureLines: 1, paragraphs: 1, judged: { provider: "jev", asked: 2, changed: 1 } });
    expect(judged.report?.judged?.error).toBeUndefined();
    const failing: BlockJudge = { provider: "jev", judge: async () => { throw new Error("Jev answered HTTP 503"); } };
    const fallen = await buildTextView(await fixture("two-pages.pdf"), "0123456789abcdef", { figures: sinkOf(), judge: failing });
    expect(fallen.plain).toBe("Attention is not all you need\n\nSecond page: results and discussion");
    expect(fallen.report?.judged).toEqual({ provider: "jev", asked: 2, changed: 0, error: "Jev answered HTTP 503" });
    const partial: BlockJudge = { provider: "jev", judge: async () => ({ verdicts: [], error: "Jev failed on 1 of 2 requests (page 2); those pages keep the rules' result. Jev answered HTTP 429" }) };
    expect((await buildTextView(await fixture("two-pages.pdf"), "0123456789abcdef", { figures: sinkOf(), judge: partial })).report?.judged).toMatchObject({ changed: 0, error: expect.stringContaining("page 2") });
  });

  it("refuses a PDF without any usable text", async () => {
    const source = new TextDecoder("latin1").decode(await fixture("two-pages.pdf"));
    const blank = source.replace(/\(([^)]*)\) Tj/g, (match) => `(${" ".repeat(match.length - 5)}) Tj`);
    const bytes = Uint8Array.from(blank, (char) => char.charCodeAt(0));
    await expect(buildTextView(bytes, "0123456789abcdef", { figures: sinkOf() })).rejects.toMatchObject({ code: "TEXT_VIEW_NO_TEXT" });
  });
});
