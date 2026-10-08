// The visual mode without any CLI: loading a capture (and failing loudly without one), capping the
// tiles per call, the v4 prompt (images paragraph, omitted tiles, facts, rendered text), the schema
// and parser with `where`, the cache key's sensitivity, and one opinion with a fake backend.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RenderManifest, RenderMetrics } from "../render/types";
import type { JudgeBackend } from "./backends/types";
import { cacheKey, isJudged } from "./cache";
import { captureExists, checkCaptures, renderCommand } from "./captures.mjs";
import { askOpinion } from "./judge-case";
import { caseKey, judgeCase, policyKey, type EffectivePolicy } from "./policy";
import { MODES, resolveMaxImages, resolveMode } from "./policy-config.mjs";
import { AnswerFormatError, buildPrompt, buildVisualPrompt, evidenceOccurs, parseAnswer, RUBRIC_VERSION, TEXT_RUBRIC_VERSION, VISUAL_ANSWER_SCHEMA, VISUAL_DIMENSIONS, type PromptInput } from "./rubric";
import { DEFAULT_MAX_IMAGES, JUDGE_MODES, loadCapture, MissingCaptureError, planImages, type VisualInput } from "./visual";

const metrics = (overrides: Partial<RenderMetrics> = {}): RenderMetrics => ({
  images: { total: 4, broken: 0, brokenSrc: [] },
  overflow: { count: 0, samples: [] },
  rawMarkup: { count: 0, samples: [] },
  mathErrors: 0, unmarkedLists: 0, emptyCellTables: { count: 0, samples: [] }, emptyHeadings: 0, duplicateTitleHeadings: 0,
  counts: { codeBlocks: 2, tables: 1, figures: 3, lists: 4, footnotes: 0, headings: 6, words: 2400 },
  height: 14_000,
  ...overrides,
});
const tiles = (side: string, count: number) => Array.from({ length: count }, (_, index) => `/cap/${side}-${String(index + 1).padStart(2, "0")}.png`);
const visual = (overrides: Partial<VisualInput> = {}): VisualInput => ({
  manifestKey: "mk-1", renderedTiles: tiles("rendered", 8), referenceTiles: tiles("reference", 6), metrics: metrics(), warnings: [],
  truncated: { rendered: false, reference: false }, failedReferenceRequests: 0, renderedText: "Intro paragraph.\n\nThe figure caption reads Figure 2.", renderedTextTruncated: false,
  viewport: { width: 1280, height: 1600 }, ...overrides,
});
const input = (overrides: Partial<PromptInput> = {}): PromptInput => ({ slug: "s", url: "https://x.test/p", source: "# Title\n\nBy Ada\n\nBody text.", extracted: "# Title\n\nBody text.", truncated: { source: false, extracted: false }, visual: visual(), ...overrides });
const SINGLE: EffectivePolicy = { policy: "single", judge: { backend: "codex", model: "default" } };

describe("planImages", () => {
  it("sends rendered tiles first up to 7 of 10, then reference tiles in the rest, always from the top", () => {
    const plan = planImages(visual());
    expect(plan.rendered).toEqual({ sent: 7, total: 8 });
    expect(plan.reference).toEqual({ sent: 3, total: 6 });
    expect(plan.images).toEqual([...tiles("rendered", 7), ...tiles("reference", 3)]);
    expect(plan.maxImages).toBe(DEFAULT_MAX_IMAGES);
  });

  it("gives the rendered side the reference's unused share, and the reference what rendered leaves", () => {
    expect(planImages(visual({ referenceTiles: tiles("reference", 1) })).rendered).toEqual({ sent: 8, total: 8 });
    const short = planImages(visual({ renderedTiles: tiles("rendered", 3) }));
    expect(short.rendered).toEqual({ sent: 3, total: 3 });
    expect(short.reference).toEqual({ sent: 6, total: 6 });
    expect(planImages(visual({ renderedTiles: tiles("rendered", 20), referenceTiles: [] })).images).toHaveLength(10);
    expect(planImages(visual(), 4)).toMatchObject({ rendered: { sent: 3 }, reference: { sent: 1 } });
  });

  it("rejects a cap that is not a positive integer", () => {
    expect(() => planImages(visual(), 0)).toThrow(/positive integer/);
  });
});

describe("loadCapture", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  const manifest = (slug: string, extra: Partial<RenderManifest> = {}): RenderManifest => ({
    slug, id: "id", url: "https://x.test/p", key: "mk-real", capturedAt: "2026-10-08T00:00:00.000Z", viewport: { width: 1280, height: 1600, deviceScaleFactor: 1 },
    rendered: { tiles: ["rendered-01.png", "rendered-02.png"], height: 3000, truncated: false, textPath: "rendered.txt", metrics: metrics({ images: { total: 2, broken: 1, brokenSrc: ["https://x.test/a.png"] } }) },
    reference: { tiles: ["reference-01.png"], height: 1500, truncated: true, failedRequests: 2 },
    warnings: ["images timed out"], ...extra,
  });
  const write = (slug: string, body: unknown, files = ["rendered-01.png", "rendered-02.png", "reference-01.png", "rendered.txt"]) => {
    dir = mkdtempSync(join(tmpdir(), "judge-visual-"));
    mkdirSync(join(dir, slug));
    writeFileSync(join(dir, slug, "manifest.json"), typeof body === "string" ? body : JSON.stringify(body));
    for (const file of files) writeFileSync(join(dir, slug, file), file === "rendered.txt" ? "x".repeat(25_000) : "png");
    return dir;
  };

  it("reads the manifest into absolute tile paths, the facts and the capped rendered text", () => {
    const root = write("s", manifest("s"));
    const loaded = loadCapture(root, "s");
    expect(loaded.renderedTiles).toEqual([join(root, "s", "rendered-01.png"), join(root, "s", "rendered-02.png")]);
    expect(loaded.referenceTiles).toEqual([join(root, "s", "reference-01.png")]);
    expect(loaded).toMatchObject({ manifestKey: "mk-real", truncated: { rendered: false, reference: true }, failedReferenceRequests: 2, warnings: ["images timed out"], renderedTextTruncated: true, viewport: { width: 1280, height: 1600 } });
    expect(loaded.metrics.images.brokenSrc).toEqual(["https://x.test/a.png"]);
    expect(captureExists(root, "s")).toBe(true);
  });

  it("fails a case without a capture with the command that makes one", () => {
    dir = mkdtempSync(join(tmpdir(), "judge-visual-"));
    expect(() => loadCapture(dir, "lilian-attention")).toThrow(MissingCaptureError);
    expect(() => loadCapture(dir, "lilian-attention")).toThrow("no render capture for lilian-attention: run pnpm --filter @read/eval render lilian-attention");
    expect(captureExists(dir, "lilian-attention")).toBe(false);
  });

  it.each([
    ["a manifest that is not JSON", "{", undefined, /is not JSON/],
    ["another slug's manifest", manifest("other"), undefined, /slug is "other"/],
    ["a manifest without tiles", { ...manifest("s"), rendered: { metrics: metrics() } }, undefined, /rendered.tiles/],
    ["a missing tile file", manifest("s"), ["rendered-01.png", "reference-01.png", "rendered.txt"], /tile rendered-02.png is missing/],
    ["a missing rendered text", manifest("s"), ["rendered-01.png", "rendered-02.png", "reference-01.png"], /rendered.txt is missing/],
  ])("treats %s as no capture", (_label, body, files, message) => {
    const root = write("s", body, files);
    expect(() => loadCapture(root, "s")).toThrow(MissingCaptureError);
    expect(() => loadCapture(root, "s")).toThrow(message);
  });
});

describe("checkCaptures (run.mjs preflight)", () => {
  const has = (present: string[]) => (slug: string) => present.includes(slug);
  it("stops the run when none of the selected cases has a capture, naming the command", () => {
    expect(checkCaptures(["a", "b"], has([]), true).error).toBe("no render capture for a, b: run pnpm --filter @read/eval render a b (or pass --mode text)");
    expect(checkCaptures(["a", "b"], has([]), false).error).toBe("no render capture for any of the 2 snapshots: run pnpm --filter @read/eval render (or pass --mode text)");
  });
  it("warns about the missing ones when some have a capture", () => {
    expect(checkCaptures(["a", "b"], has(["a"]), true)).toEqual({ present: ["a"], missing: ["b"], warning: "no render capture for b: those cases will fail; run pnpm --filter @read/eval render b" });
    expect(checkCaptures(["a"], has(["a"]), true)).toEqual({ present: ["a"], missing: [] });
    expect(renderCommand([])).toBe("pnpm --filter @read/eval render");
  });
});

describe("mode and maxImages (config.json + --mode)", () => {
  it("defaults to visual and 10 images, reads config.json, and lets --mode win", () => {
    expect(MODES).toEqual([...JUDGE_MODES]);
    expect(resolveMode({}, undefined)).toBe("visual");
    expect(resolveMode({ mode: "text" }, undefined)).toBe("text");
    expect(resolveMode({ mode: "text" }, "visual")).toBe("visual");
    expect(() => resolveMode({}, "pixels")).toThrow(/mode must be one of visual\|text/);
    expect(resolveMaxImages({})).toBe(10);
    expect(resolveMaxImages({ maxImages: 6 })).toBe(6);
    expect(() => resolveMaxImages({ maxImages: 0 })).toThrow(/maxImages must be a positive integer/);
  });
});

describe("buildVisualPrompt (rubric v4)", () => {
  const prompt = (overrides: Partial<VisualInput> = {}, max = 10) => { const case_ = input({ visual: visual(overrides) }); return buildVisualPrompt(case_, planImages(case_.visual!, max)); };

  it("adds the two dimensions and the v4 fold, and keeps the text rubric's seven", () => {
    const text = prompt();
    for (const line of VISUAL_DIMENSIONS) expect(text).toContain(line);
    expect(text).toContain("8. Rendering — the reader page shows every element correctly: no raw markup, broken images, horizontal overflow, unrendered math, mangled tables, collapsed code.");
    expect(text).toContain("9. Visual fidelity — the figures, tables, code and math the original shows are present and readable in the reader.");
    expect(text).toContain("7. Element-fidelity");
    expect(text).toContain("- MAJOR: a 0 on Completeness, Element-fidelity, Rendering or Visual fidelity.");
    expect(text).toContain("- PASS: every dimension ≥ 1 and a total ≥ 15 of 18.");
    expect(text).toContain("{ verdict, issues: [{ kind, severity, evidence, note, where }], summary }");
  });

  it("explains the tiles, their attachment order, and which were omitted by the cap", () => {
    const text = prompt();
    expect(text).toContain("RENDERED tiles 1–7 are the Quire reader exactly as a reader sees it (top to bottom, 1280 px wide); REFERENCE tiles 1–3 are the original page rendered from the snapshot with JavaScript off and network CSS/images — the reference may lack styles or images; never blame the extractor for what the reference itself lacks.");
    expect(text).toContain("The 10 images are attached in this order: images 1–7 are RENDERED tiles 1–7, then images 8–10 are REFERENCE tiles 1–3. Each tile is 1600 px of the page");
    expect(text).toContain("OMITTED: to stay within 10 images per call, rendered tile 8 of 8 and reference tiles 4–6 of 6 were captured but not attached.");
    expect(text).toContain("(rendered tiles 1–7, reference tiles 1–3)");
    const all = prompt({ renderedTiles: tiles("rendered", 2), referenceTiles: tiles("reference", 1) });
    expect(all).not.toContain("OMITTED");
    expect(all).toContain("images 1–2 are RENDERED tiles 1–2, then image 3 is REFERENCE tile 1.");
    expect(prompt({ truncated: { rendered: true, reference: false } })).toContain("CAPTURE CUT: the rendered page is 14000 px tall and its capture stops after 8 tiles.");
  });

  it("states the measured facts, samples included, and that they override impressions", () => {
    const text = prompt({
      metrics: metrics({ images: { total: 4, broken: 2, brokenSrc: ["https://x.test/a.png", "https://x.test/b.png"] }, overflow: { count: 1, samples: [{ path: "article > pre:nth-of-type(2)", width: 1840 }] }, rawMarkup: { count: 1, samples: [{ pattern: "$$", text: "where $$x^2$$ grows" }] }, mathErrors: 3 }),
      warnings: ["timed out waiting for images"], failedReferenceRequests: 5,
    });
    expect(text).toContain("FACTS measured in the rendered reader page by the capture program (ground truth, not opinions):");
    expect(text).toContain("- Images: 4 in the article, 2 broken (failed to load): https://x.test/a.png; https://x.test/b.png.");
    expect(text).toContain("- Horizontal overflow: 1 element wider than the reading column: article > pre:nth-of-type(2) (1840 px).");
    expect(text).toContain('- Raw markup visible as text: 1 — "$$" in "where $$x^2$$ grows"');
    expect(text).toContain("- Math that failed to render: 3.");
    expect(text).toContain("- The reader shows 2 code blocks, 1 table, 3 figures, 4 lists, 0 footnotes and 2400 words; the article is 14000 px tall.");
    expect(text).toContain("- Reference page: 5 network requests failed while it loaded");
    expect(text).toContain("- Capture warnings: timed out waiting for images.");
    expect(text).toContain("Facts override impressions");
    expect(text).toContain("A non-zero broken-image, raw-markup, unmarked-list or empty-cell-table fact must appear as an issue unless the reference shows the same defect.");
  });

  it("carries SOURCE, EXTRACTED and RENDERED TEXT, and says when the rendered text was cut", () => {
    const text = prompt();
    expect(text).toContain("===== SOURCE =====\n# Title\n\nBy Ada\n\nBody text.\n===== END SOURCE =====");
    expect(text).toContain("===== RENDERED TEXT =====\nIntro paragraph.\n\nThe figure caption reads Figure 2.\n===== END RENDERED TEXT =====");
    expect(text).toContain("RENDERED TEXT is the reader page's visible text (innerText), in reading order. It is there only so visual problems can be quoted");
    expect(prompt({ renderedTextTruncated: true })).toContain("in reading order, cut at the end to fit this prompt.");
    expect(text).toContain("never judge how anything looks from it");
    expect(text).toContain("How to look: go through every RENDERED tile top to bottom.");
    expect(text).toContain("the RENDERED tile where the defect is visible; a REFERENCE tile only for something the reader lacks entirely");
  });

  it("is not the text prompt, which stays free of images", () => {
    const text = buildPrompt(input({ visual: undefined }));
    expect(text).not.toContain("RENDERED");
    expect(text).not.toContain("8. Rendering");
    expect(() => buildVisualPrompt(input({ visual: undefined }), planImages(visual()))).toThrow(/has no render capture/);
  });
});

describe("the visual answer: schema and parser with where", () => {
  const issue = (where: unknown, extra: Record<string, unknown> = {}) => ({ kind: "images", severity: "major", evidence: "Figure 2", note: "the figure is a broken image", where, ...extra });
  const answer = (...issues: unknown[]) => JSON.stringify({ verdict: "MAJOR", issues, summary: "A figure is broken." });
  const sent = { rendered: 7, reference: 3 };

  it("requires where on every issue, as null or a tile reference (strict structured output)", () => {
    const item = VISUAL_ANSWER_SCHEMA.properties.issues.items;
    expect(item.required).toEqual(["kind", "severity", "evidence", "note", "where"]);
    expect(item.properties.where.anyOf[0]).toEqual({ type: "null" });
    expect(item.properties.where.anyOf[1]).toMatchObject({ type: "object", additionalProperties: false, required: ["image", "tile"], properties: { image: { enum: ["rendered", "reference"] }, tile: { type: "integer", minimum: 1 } } });
  });

  it("accepts tile references within the tiles sent, and null", () => {
    const parsed = parseAnswer(answer(issue({ image: "rendered", tile: 7 }), issue({ image: "reference", tile: 1 }), issue(null)), sent);
    expect(parsed.issues.map((item) => item.where)).toEqual([{ image: "rendered", tile: 7 }, { image: "reference", tile: 1 }, null]);
  });

  it.each([
    ["a missing where", answer({ kind: "images", severity: "major", evidence: "e", note: "n" }), /where is missing/],
    ["a rendered tile past the ones sent", answer(issue({ image: "rendered", tile: 8 })), /tile 8 is not one of the 7 rendered tile/],
    ["a reference tile past the ones sent", answer(issue({ image: "reference", tile: 4 })), /tile 4 is not one of the 3 reference/],
    ["tile 0", answer(issue({ image: "rendered", tile: 0 })), /tile 0/],
    ["a fractional tile", answer(issue({ image: "rendered", tile: 1.5 })), /tile 1.5/],
    ["an unknown image", answer(issue({ image: "source", tile: 1 })), /image "source" is not rendered\|reference/],
    ["extra keys in where", answer(issue({ image: "rendered", tile: 1, x: 3 })), /unexpected keys: x/],
    ["a string where", answer(issue("rendered 3")), /neither null nor an object/],
  ])("rejects %s", (_label, text, message) => {
    expect(() => parseAnswer(text, sent)).toThrow(AnswerFormatError);
    expect(() => parseAnswer(text, sent)).toThrow(message);
  });

  it("text mode neither needs nor returns where", () => {
    expect(parseAnswer(answer({ kind: "images", severity: "major", evidence: "e", note: "n" })).issues[0]).not.toHaveProperty("where");
  });

  it("evidence counts as verbatim when it occurs in any of the texts, rendered text included", () => {
    expect(evidenceOccurs("caption reads Figure  2", "src", "md", "The figure caption reads Figure 2.")).toBe(true);
    expect(evidenceOccurs("caption reads Figure 2", "src", "md")).toBe(false);
  });
});

describe("caseKey", () => {
  it("keeps the text key exactly as the text judge wrote it", () => {
    const text = input({ visual: undefined });
    expect(caseKey(text, SINGLE)).toBe(cacheKey(text.source, text.extracted, TEXT_RUBRIC_VERSION, policyKey(SINGLE)));
  });

  it("changes with the mode, the capture's key and the tiles sent, and is stable otherwise", () => {
    const base = caseKey(input(), SINGLE);
    expect(caseKey(input(), SINGLE)).toBe(base);
    expect(base).not.toBe(caseKey(input({ visual: undefined }), SINGLE));
    expect(caseKey(input({ visual: visual({ manifestKey: "mk-2" }) }), SINGLE)).not.toBe(base);
    expect(caseKey(input(), SINGLE, 8)).not.toBe(base);
    expect(caseKey(input({ visual: visual({ referenceTiles: tiles("reference", 2) }) }), SINGLE)).not.toBe(base);
    // Facts and rendered text come from the capture its key already names.
    expect(caseKey(input({ visual: visual({ renderedText: "other" }) }), SINGLE)).toBe(base);
    expect(base).toBe(cacheKey(input().source, input().extracted, RUBRIC_VERSION, `${policyKey(SINGLE)} visual mk-1 ${[...tiles("rendered", 7), ...tiles("reference", 3)].map((path) => path.slice(5)).join(",")}`));
  });
});

describe("a visual opinion with a fake backend", () => {
  const fake = (raw: string, seen: { images?: string[]; schema?: object; prompt?: string }[]): JudgeBackend => ({
    id: "claude", model: "fake", preflight: async () => {},
    run: async ({ images, schema, prompt }) => { seen.push({ ...(images ? { images } : {}), schema, prompt }); return { raw, tokens: 30_000 }; },
  });
  const good = JSON.stringify({ verdict: "MAJOR", issues: [{ kind: "images", severity: "major", evidence: "The figure caption reads Figure 2.", note: "broken figure", where: { image: "rendered", tile: 2 } }, { kind: "layout", severity: "minor", evidence: "Body text.", note: "n", where: null }], summary: "One figure is broken." });

  it("attaches the planned tiles, uses the visual schema, verifies quotes against the rendered text and keeps where", async () => {
    const seen: { images?: string[]; schema?: object; prompt?: string }[] = [];
    const outcome = await askOpinion(fake(good, seen), input(), 1000);
    expect(seen[0]?.images).toEqual([...tiles("rendered", 7), ...tiles("reference", 3)]);
    expect(seen[0]?.schema).toBe(VISUAL_ANSWER_SCHEMA);
    expect(seen[0]?.prompt).toContain("===== RENDERED TEXT =====");
    if (!outcome.ok) throw new Error(outcome.failure.error);
    expect(outcome.opinion.images).toBe(10);
    expect(outcome.opinion.issues).toEqual([
      { kind: "images", severity: "major", evidence: "The figure caption reads Figure 2.", note: "broken figure", where: { image: "rendered", tile: 2 }, verified: true },
      { kind: "layout", severity: "minor", evidence: "Body text.", note: "n", where: null, verified: true },
    ]);
  });

  it("records a tile outside the ones sent as a failed opinion, with the raw answer", async () => {
    const bad = good.replace('"tile":2', '"tile":9');
    const outcome = await askOpinion(fake(bad, []), input(), 1000);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toMatchObject({ error: expect.stringMatching(/tile 9 is not one of the 7 rendered/), rawAnswer: bad });
  });

  it("sends no images and the text schema in text mode", async () => {
    const seen: { images?: string[] }[] = [];
    await askOpinion(fake(JSON.stringify({ verdict: "PASS", issues: [], summary: "ok" }), seen), input({ visual: undefined }), 1000);
    expect(seen[0]).not.toHaveProperty("images");
  });

  it("judgeCase stamps the mode, the visual rubric and what of the capture it used", async () => {
    const result = await judgeCase(input(), { policy: { policy: "single", judge: { backend: "claude", model: "fake" } }, backend: () => fake(good, []), timeoutMs: 1000, maxImages: 10 });
    if (!isJudged(result)) throw new Error(result.error);
    expect(result).toMatchObject({ mode: "visual", rubricVersion: RUBRIC_VERSION, verdict: "MAJOR" });
    expect(result.render).toMatchObject({ manifestKey: "mk-1", sent: { rendered: 7, reference: 3 }, tiles: { rendered: tiles("rendered", 8).map((path) => path.slice(5)) } });
    expect(result.key).toBe(caseKey(input(), { policy: "single", judge: { backend: "claude", model: "fake" } }, 10));
  });
});
