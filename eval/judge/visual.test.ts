// The visual mode without any CLI: loading a capture (and failing loudly without one or with a stale
// one), capping the tiles per call, the v6 prompt (the standard's boundary, layers and severity, the
// images paragraph, facts and inventories, rendered text), the v6 schema and parser, the cache key's
// sensitivity, and one opinion with a fake backend (validated issues, computed layer verdicts).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Embed, ReferenceImage, RenderedCode, RenderedImage, RenderedTable, RenderManifest, RenderMetrics } from "../render/types";
import type { JudgeBackend } from "./backends/types";
import { cacheKey, isJudged } from "./cache";
import { captureExists, checkCaptures, renderCommand } from "./captures.mjs";
import { askOpinion } from "./judge-case";
import { caseKey, judgeCase, policyKey, type EffectivePolicy } from "./policy";
import { MODES, resolveMaxImages, resolveMode } from "./policy-config.mjs";
import { AnswerFormatError, buildPrompt, evidenceOccurs, LAYERS, parseAnswer, RUBRIC_VERSION, TEXT_RUBRIC_VERSION, VISUAL_ANSWER_SCHEMA, type PromptInput } from "./rubric";
import { ARTICLE_BOUNDARY, buildVisualPrompt, INVENTORY_MAX, SEVERITY_RULES, SOURCES_OF_TRUTH, THREE_LAYERS } from "./visual-prompt";
import { DEFAULT_MAX_IMAGES, JUDGE_MODES, loadCapture, MissingCaptureError, planImages, type VisualInput } from "./visual";

const metrics = (overrides: Partial<RenderMetrics> = {}): RenderMetrics => ({
  images: { total: 4, broken: 0, brokenSrc: [] },
  overflow: { count: 0, samples: [] },
  rawMarkup: { count: 0, samples: [] },
  mathErrors: 0, unmarkedLists: 0, collapsedCode: 0, emptyCellTables: { count: 0, samples: [] }, emptyHeadings: 0, duplicateTitleHeadings: 0,
  counts: { codeBlocks: 2, tables: 1, figures: 3, lists: 4, footnotes: 0, headings: 6, words: 2400 },
  height: 14_000,
  ...overrides,
});
const tiles = (side: string, count: number) => Array.from({ length: count }, (_, index) => `/cap/${side}-${String(index + 1).padStart(2, "0")}.png`);
const readerImages = (): RenderedImage[] => [
  { id: "r1", tile: 1, src: "https://x.test/a.png", alt: "A diagram", caption: "Figure 1: the setup", broken: false },
  { id: "r2", tile: 3, src: "https://x.test/b.png", alt: "", caption: "", broken: true },
];
const originalImages = (): ReferenceImage[] => [
  { id: "o1", tile: 1, src: "https://x.test/a.png", candidates: [], alt: "A diagram", width: 640, height: 420, matchedBy: "r1" },
  { id: "o2", tile: 4, src: "https://x.test/c.png", candidates: ["https://x.test/c@2x.png"], alt: "Loss curve", width: 800, height: 500, matchedBy: null },
];
const embeds = (): Embed[] => [
  { kind: "iframe", tag: "iframe", src: "https://www.youtube.com/embed/v", host: "www.youtube.com", context: "Training setup and the results we got from it", representedInReader: false },
  { kind: "tweet", tag: "blockquote", src: "https://twitter.com/a/status/1", host: "twitter.com", context: "As announced", representedInReader: true },
];
const tables = (): RenderedTable[] => [{ id: "t1", tile: 4, rows: 5, cols: 4, cells: 20, emptyCells: 13, head: "Metric | Chrome UX Report | PageSpeed" }, { id: "t2", tile: 5, rows: 3, cols: 2, cells: 4, emptyCells: 0, head: "Language | Tokens" }];
const codeBlocks = (): RenderedCode[] => [{ id: "c1", tile: 2, lines: 6, chars: 140, collapsed: false, head: "import {onCLS} from 'web-vitals';" }, { id: "c2", tile: 3, lines: 1, chars: 212, collapsed: true, head: "def clipped_error(x): return tf.select(tf.abs(x) < 1.0," }];
const visual = (overrides: Partial<VisualInput> = {}): VisualInput => ({
  manifestKey: "mk-1", renderedTiles: tiles("rendered", 8), referenceTiles: tiles("reference", 6), metrics: metrics(), warnings: [],
  truncated: { rendered: false, reference: false }, failedReferenceRequests: 0, renderedText: "Intro paragraph.\n\nThe figure caption reads Figure 2.", renderedTextTruncated: false,
  viewport: { width: 1280, height: 1600 }, images: { rendered: readerImages(), reference: originalImages() }, embeds: embeds(), tables: tables(), code: codeBlocks(), ...overrides,
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
    rendered: { tiles: ["rendered-01.png", "rendered-02.png"], height: 3000, truncated: false, textPath: "rendered.txt", metrics: metrics({ images: { total: 2, broken: 1, brokenSrc: ["https://x.test/a.png"] } }), images: readerImages(), tables: tables(), code: codeBlocks() },
    reference: { tiles: ["reference-01.png"], height: 1500, truncated: true, failedRequests: 2, images: originalImages() },
    embeds: embeds(),
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
    expect(loaded.images).toEqual({ rendered: readerImages(), reference: originalImages() });
    expect(loaded.embeds).toEqual(embeds());
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
    ["a capture from before the table and code inventories", (() => { const old = manifest("s"); return { ...old, rendered: { ...old.rendered, code: undefined } }; })(), undefined, /no table\/code inventories .* re-capture it/],
    ["a capture from before the inventories", (() => { const { embeds: _embeds, ...old } = manifest("s"); return { ...old, rendered: { ...old.rendered, images: undefined } }; })(), undefined, /no image\/embed inventories .* re-capture it/],
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

describe("buildVisualPrompt (rubric v6)", () => {
  const prompt = (overrides: Partial<VisualInput> = {}, max = 10) => { const case_ = input({ visual: visual(overrides) }); return buildVisualPrompt(case_, planImages(case_.visual!, max)); };

  it("carries the standard: sources of truth, the boundary table, the three layers and the severity lists", () => {
    const text = prompt();
    for (const line of [...SOURCES_OF_TRUTH, ...ARTICLE_BOUNDARY, ...THREE_LAYERS, ...SEVERITY_RULES]) expect(text).toContain(line);
    expect(text).toContain("| Must keep (missing it is an issue) | Must drop (keeping it is a minor issue; dropping it is never an issue) |");
    expect(text).toContain("| Body content that needs JavaScript to show — interactive examples, embedded videos or tweets, dynamic charts: the reader must show the thing itself, or at least a link to it or a placeholder for it | Copyright, licence and trademark footers |");
    expect(text).toContain("| Callouts, notes, admonitions, key points | Author bio cards, avatar cards |");
    expect(text).toContain("| metadata (the extractor) | Title, author, publication date |");
    expect(text).toContain("The overall verdict is the worst of the three.");
    expect(text).toContain("Measured facts: the FACTS below");
    expect(text).toContain("An issue that contradicts a fact does not count.");
  });

  it("states the severity rules of the standard: title major, author/date minor, lost JS content major, boundary leftovers minor, dropped chrome and the reference's own defects not issues", () => {
    const text = prompt();
    expect(text).toContain("- the title is wrong (not this article's title, the site name or interface text mixed in, the wrong heading taken)");
    expect(text).toContain("- the author or the publication date is missing or wrong (when the page clearly shows one)");
    expect(text).toContain("- body content that needs JavaScript (an interactive example, an embed, a dynamic chart) is entirely gone from the reader, with not even a link or a placeholder");
    expect(text).toContain("- content outside the boundary left in the body (an author card, a subscribe block, a licence footer)");
    expect(text).toContain("- content outside the boundary that was dropped");
    expect(text).toContain("- a defect the original page has itself (the REFERENCE tiles show it broken the same way)");
    expect(text).toContain("- differences in how the markdown is written, as long as the reader displays it correctly");
    expect(text.indexOf("major — information is lost")).toBeLessThan(text.indexOf("- the title is wrong"));
    expect(text.indexOf("- the title is wrong")).toBeLessThan(text.indexOf("minor — the information is all there"));
    expect(text.indexOf("minor — the information is all there")).toBeLessThan(text.indexOf("- the author or the publication date"));
    expect(text).not.toMatch(/Score the|dimension|Fold the scores/);
  });

  it("lists the reader images, the original images with their matches and the embeds with ids", () => {
    const text = prompt();
    expect(text).toContain('- r1 (tile 1, alt "A diagram", caption "Figure 1: the setup")');
    expect(text).toContain("- r2 (tile 3, BROKEN)");
    expect(text).toContain('- o1 (tile 1, 640×420, alt "A diagram") ↔ r1');
    expect(text).toContain('- o2 (tile 4, 800×500, alt "Loss curve") — not in the reader');
    expect(text).toContain('- e1 iframe www.youtube.com, after "Training setup and the results we got from it", shown in reader: no');
    expect(text).toContain('- e2 tweet <blockquote> twitter.com, after "As announced", shown in reader: yes');
    expect(text).toContain('- t1 (tile 4, 5×4, 13 of 20 cells empty — EMPTY CELLS, first row "Metric | Chrome UX Report | PageSpeed")');
    expect(text).toContain('- t2 (tile 5, 3×2, 0 of 4 cells empty, first row "Language | Tokens")');
    expect(text).toContain('- c1 (tile 2) 6 lines: "import {onCLS} from \'web-vitals\';"');
    expect(text).toContain('- c2 (tile 3) shown as ONE line of 212 chars: "def clipped_error(x): return tf.select(tf.abs(x) < 1.0,"');
    expect(text).toContain("- Code blocks shown as one long line (several lines run together): 0.");
    const empty = prompt({ images: { rendered: [], reference: [] }, embeds: [], tables: [], code: [] });
    expect(empty).toContain("- (none: the reader page shows no tables)");
    expect(empty).toContain("- (none: the reader page shows no code blocks)");
    expect(empty).toContain("- (none: the reader page shows no images)");
    expect(empty).toContain("- (none: the snapshot has no JavaScript or plugin content)");
    const many = prompt({ images: { rendered: Array.from({ length: INVENTORY_MAX + 3 }, (_, i) => ({ ...readerImages()[0]!, id: `r${i + 1}` })), reference: [] } });
    expect(many).toContain(`- r${INVENTORY_MAX} (`);
    expect(many).not.toContain(`- r${INVENTORY_MAX + 1} (`);
    expect(many).toContain("- … and 3 more reader images not listed");
  });

  it("tells the model how refs work: image issues cite ids, missing needs an unmatched original, unshown embeds are major content issues", () => {
    const text = prompt();
    expect(text).toContain("- refs: the ids of the images (r…, o…), embeds (e…), tables (t…) and code blocks (c…) the issue is about, from the inventories above; [] when it is about none. An issue about a specific image, embed, table or code block must cite its id.");
    expect(text).toContain("Claiming an image is missing requires an original image id that has no match");
    expect(text).toContain("- Every embed that belongs to the article and is not shown in the reader (shown in reader: no) is a major content issue citing its e id.");
    expect(text).toContain("{ issues: [{ layer, kind, severity, subject, evidence, where, refs, note }], summary }");
    expect(text).toContain("- subject: for a metadata issue, what it is about: \"title\", \"author\" or \"date\" — every metadata issue must name it; null for every other issue. A wrong title is a major metadata issue; a missing or wrong author or date is a minor metadata issue, never a content issue.");
    expect(text).toContain("a missing or wrong byline or date is a metadata issue, never missing content");
    expect(text).toContain("- Absent from EXTRACTED or incomplete there → content (the extractor must be fixed). Examples: a missing figure; a missing callout; ✓/✗ icons that were not extracted, so the table cells are empty; an embed left without even a link.");
    expect(text).toContain("- Intact in EXTRACTED but shown wrong by the reader → rendering (the reader must be fixed). Examples: an image that fails to load; a formula that is not typeset; code whose line breaks are in EXTRACTED but lost on display; a list shown without markers; content wider than the column.");
    expect(text).toContain("Do not grade: the verdicts are computed from your issues.");
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
    expect(text).not.toContain("ARTICLE BOUNDARY");
    expect(() => buildVisualPrompt(input({ visual: undefined }), planImages(visual()))).toThrow(/has no render capture/);
  });
});

describe("the visual answer (v6): schema and parser", () => {
  const issue = (extra: Record<string, unknown> = {}) => ({ layer: "rendering", kind: "images", severity: "major", subject: null, evidence: "Figure 2", note: "the figure is a broken image", where: { image: "rendered", tile: 3 }, refs: ["r2"], ...extra });
  const answer = (...issues: unknown[]) => JSON.stringify({ issues, summary: "A figure is broken." });

  it("has no verdict and requires every issue property (strict structured output), where nullable, refs a list", () => {
    expect(VISUAL_ANSWER_SCHEMA.required).toEqual(["issues", "summary"]);
    expect(VISUAL_ANSWER_SCHEMA.properties).not.toHaveProperty("verdict");
    const item = VISUAL_ANSWER_SCHEMA.properties.issues.items;
    expect(item.required).toEqual(["layer", "kind", "severity", "subject", "evidence", "where", "refs", "note"]);
    expect(item.properties.subject.anyOf).toEqual([{ type: "null" }, { type: "string", enum: ["title", "author", "date"] }]);
    expect(Object.keys(item.properties).sort()).toEqual([...item.required].sort());
    expect(item.properties.layer.enum).toEqual([...LAYERS]);
    expect(item.properties.where.anyOf[0]).toEqual({ type: "null" });
    expect(item.properties.where.anyOf[1]).toMatchObject({ type: "object", additionalProperties: false, required: ["image", "tile"], properties: { image: { enum: ["rendered", "reference"] }, tile: { type: "integer", minimum: 1 } } });
    expect(item.properties.refs).toMatchObject({ type: "array", items: { type: "string" } });
  });

  it("accepts layer, tile references (attached or not: validation judges that), null where and refs, deduping refs", () => {
    const parsed = parseAnswer(answer(issue(), issue({ where: { image: "reference", tile: 9 }, refs: ["o2", "o2", " "] }), issue({ layer: "content", where: null, refs: [] })), "visual");
    expect(parsed.issues.map((item) => [item.layer, item.where, item.refs, item.subject])).toEqual([["rendering", { image: "rendered", tile: 3 }, ["r2"], null], ["rendering", { image: "reference", tile: 9 }, ["o2"], null], ["content", null, [], null]]);
    expect(parseAnswer(answer(issue({ kind: "metadata", subject: "date" })), "visual").issues[0]?.subject).toBe("date");
    expect(parsed).not.toHaveProperty("verdict");
  });

  it.each([
    ["a verdict (v6 answers have none)", JSON.stringify({ verdict: "MAJOR", issues: [], summary: "s" }), /unexpected keys: verdict/],
    ["a missing layer", answer(issue({ layer: undefined })), /layer undefined is not one of content, metadata, rendering/],
    ["an unknown layer", answer(issue({ layer: "display" })), /layer "display"/],
    ["a missing where", answer((({ where: _where, ...rest }) => rest)(issue())), /where is missing/],
    ["a missing refs", answer((({ refs: _refs, ...rest }) => rest)(issue())), /refs is missing/],
    ["a missing subject", answer((({ subject: _subject, ...rest }) => rest)(issue())), /subject is missing/],
    ["an unknown subject", answer(issue({ subject: "byline" })), /subject "byline" is not title\|author\|date\|null/],
    ["refs that are not strings", answer(issue({ refs: [2] })), /refs is not a list of ids/],
    ["tile 0", answer(issue({ where: { image: "rendered", tile: 0 } })), /tile 0 is not a positive integer/],
    ["a fractional tile", answer(issue({ where: { image: "rendered", tile: 1.5 } })), /tile 1.5/],
    ["an unknown image", answer(issue({ where: { image: "source", tile: 1 } })), /image "source" is not rendered\|reference/],
    ["extra keys in where", answer(issue({ where: { image: "rendered", tile: 1, x: 3 } })), /unexpected keys: x/],
    ["a string where", answer(issue({ where: "rendered 3" })), /neither null nor an object/],
  ])("rejects %s", (_label, text, message) => {
    expect(() => parseAnswer(text, "visual")).toThrow(AnswerFormatError);
    expect(() => parseAnswer(text, "visual")).toThrow(message);
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
  const brokenFigure = { layer: "rendering", kind: "images", severity: "major", subject: null, evidence: "The figure caption reads Figure 2.", note: "broken figure", where: { image: "rendered", tile: 3 }, refs: ["r2"] };
  const layoutNit = { layer: "content", kind: "layout", severity: "minor", subject: null, evidence: "Body text.", note: "n", where: null, refs: [] };
  const claimsPresentMissing = { layer: "content", kind: "images", severity: "major", subject: null, evidence: "Body text.", note: "the diagram is missing", where: { image: "reference", tile: 1 }, refs: ["o1"] };
  const good = JSON.stringify({ issues: [brokenFigure, layoutNit, claimsPresentMissing], summary: "One figure is broken." });

  it("attaches the planned tiles, uses the visual schema, validates every issue and computes the layer verdicts", async () => {
    const seen: { images?: string[]; schema?: object; prompt?: string }[] = [];
    const outcome = await askOpinion(fake(good, seen), input(), 1000);
    expect(seen[0]?.images).toEqual([...tiles("rendered", 7), ...tiles("reference", 3)]);
    expect(seen[0]?.schema).toBe(VISUAL_ANSWER_SCHEMA);
    expect(seen[0]?.prompt).toContain("===== RENDERED TEXT =====");
    if (!outcome.ok) throw new Error(outcome.failure.error);
    expect(outcome.opinion.images).toBe(10);
    expect(outcome.opinion.issues).toEqual([
      { ...brokenFigure, verified: true },
      { ...layoutNit, verified: true },
      { ...claimsPresentMissing, verified: true, invalid: { reason: "contradicts-image-facts", detail: "o1 is in the reader as r1, not broken" } },
    ]);
    // The invalid content-layer major issue does not count: content is MINOR from the layout nit alone.
    expect(outcome.opinion.layers).toEqual({ content: "MINOR", metadata: "PASS", rendering: "MAJOR" });
    expect(outcome.opinion.verdict).toBe("MAJOR");
  });

  it("puts author and date issues in the metadata layer as minor and title issues as major, whatever the model said; a metadata issue without a subject is invalid", async () => {
    const raw = JSON.stringify({ summary: "s", issues: [
      { layer: "content", kind: "missing_content", severity: "major", subject: "author", evidence: "By Ada", note: "the author card is gone", where: null, refs: [] },
      { layer: "metadata", kind: "metadata", severity: "minor", subject: "title", evidence: "# Title", note: "the title has the site name", where: null, refs: [] },
      { layer: "metadata", kind: "metadata", severity: "major", subject: "date", evidence: "Body text.", note: "the date is missing", where: null, refs: [] },
      { layer: "content", kind: "metadata", severity: "minor", subject: null, evidence: "By Ada", note: "something about metadata", where: null, refs: [] },
    ] });
    const outcome = await askOpinion(fake(raw, []), input(), 1000);
    if (!outcome.ok) throw new Error(outcome.failure.error);
    expect(outcome.opinion.issues.map((item) => [item.layer, item.kind, item.severity, item.originalSeverity, item.invalid?.reason])).toEqual([
      ["metadata", "missing_content", "minor", "major", undefined],
      ["metadata", "metadata", "major", "minor", undefined],
      ["metadata", "metadata", "minor", "major", undefined],
      ["metadata", "metadata", "minor", undefined, "metadata-without-subject"],
    ]);
    expect(outcome.opinion.layers).toEqual({ content: "PASS", metadata: "MAJOR", rendering: "PASS" });
  });

  it("sets the layer from the facts before the verdicts: a missing original figure is content, whatever the model said", async () => {
    const raw = JSON.stringify({ summary: "s", issues: [{ layer: "rendering", kind: "images", severity: "major", subject: null, evidence: "Body text.", note: "the loss curve is missing", where: null, refs: ["o2"] }] });
    const outcome = await askOpinion(fake(raw, []), input(), 1000);
    if (!outcome.ok) throw new Error(outcome.failure.error);
    expect(outcome.opinion.issues[0]).toMatchObject({ layer: "content", originalLayer: "rendering" });
    expect(outcome.opinion.layers).toEqual({ content: "MAJOR", metadata: "PASS", rendering: "PASS" });
  });

  it("keeps an issue on a tile that was not attached as invalid instead of failing the opinion", async () => {
    const bad = JSON.stringify({ issues: [{ ...brokenFigure, where: { image: "rendered", tile: 9 } }], summary: "s" });
    const outcome = await askOpinion(fake(bad, []), input(), 1000);
    if (!outcome.ok) throw new Error(outcome.failure.error);
    expect(outcome.opinion.issues[0]?.invalid).toEqual({ reason: "tile-not-sent", detail: "rendered tile 9 was not attached (7 rendered tiles sent)" });
    expect(outcome.opinion.verdict).toBe("PASS");
  });

  it("records an answer with a verdict (the v5 shape) as a failed opinion, with the raw answer", async () => {
    const old = JSON.stringify({ verdict: "MAJOR", issues: [], summary: "s" });
    const outcome = await askOpinion(fake(old, []), input(), 1000);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toMatchObject({ error: expect.stringMatching(/unexpected keys: verdict/), rawAnswer: old });
  });

  it("sends no images and the text schema in text mode", async () => {
    const seen: { images?: string[] }[] = [];
    await askOpinion(fake(JSON.stringify({ verdict: "PASS", issues: [], summary: "ok" }), seen), input({ visual: undefined }), 1000);
    expect(seen[0]).not.toHaveProperty("images");
  });

  it("judgeCase stamps the mode, the visual rubric, the layers and what of the capture it used, inventories included", async () => {
    const result = await judgeCase(input(), { policy: { policy: "single", judge: { backend: "claude", model: "fake" } }, backend: () => fake(good, []), timeoutMs: 1000, maxImages: 10 });
    if (!isJudged(result)) throw new Error(result.error);
    expect(result).toMatchObject({ mode: "visual", rubricVersion: RUBRIC_VERSION, verdict: "MAJOR", layers: { content: "MINOR", metadata: "PASS", rendering: "MAJOR" } });
    expect(result.render).toMatchObject({ manifestKey: "mk-1", sent: { rendered: 7, reference: 3 }, tiles: { rendered: tiles("rendered", 8).map((path) => path.slice(5)) }, images: { rendered: readerImages(), reference: originalImages() }, embeds: embeds() });
    expect(result.key).toBe(caseKey(input(), { policy: "single", judge: { backend: "claude", model: "fake" } }, 10));
  });
});
