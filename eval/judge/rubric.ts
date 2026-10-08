// The judge's rubric: the prompt a backend answers, the JSON schema its answer must fit, and the
// strict parser for that answer. Two prompts: the text rubric (seven dimensions, SOURCE vs EXTRACTED)
// and the visual rubric v4 (nine dimensions: the texts plus screenshots of the reader and of the
// original page, and the capture's measured facts). A rubric version is part of every cache key, so
// bump the one whose prompt or schema changes and every case of that mode is judged again.
import { RENDERING_PROBLEM_KINDS, type RenderingProblemKind } from "../../apps/desktop/src/shared/contracts";
import type { ImagePlan, JudgeMode, SideCount, VisualInput } from "./visual";

/** The visual rubric (v4), the default mode's. */
export const RUBRIC_VERSION = "2026-10-09.5";
/** The text rubric, unchanged since before the visual mode, so text-mode results stay cached. */
export const TEXT_RUBRIC_VERSION = "2026-09-23.3";
export const rubricVersionFor = (mode: JudgeMode): string => (mode === "visual" ? RUBRIC_VERSION : TEXT_RUBRIC_VERSION);
export const VERDICTS = ["PASS", "MINOR", "MAJOR"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const SEVERITIES = ["minor", "major"] as const;
export type Severity = (typeof SEVERITIES)[number];
/** The kinds the judge may report: the same vocabulary the app's "Report rendering problem" form uses. */
export const PROBLEM_KINDS: readonly RenderingProblemKind[] = RENDERING_PROBLEM_KINDS;
export const EVIDENCE_MAX_CHARS = 200;

export const TILE_IMAGES = ["rendered", "reference"] as const;
export type TileImage = (typeof TILE_IMAGES)[number];
/** Where a visual issue shows: tile n (1-based, top to bottom) of the rendered reader or of the reference page. */
export interface TileRef { image: TileImage; tile: number }
/** `where` is absent in text mode; in visual mode every issue carries it (null when the problem shows only in the texts). */
export interface JudgeIssue { kind: RenderingProblemKind; severity: Severity; evidence: string; note: string; where?: TileRef | null }
export interface JudgeAnswer { verdict: Verdict; issues: JudgeIssue[]; summary: string }

/** What `codex exec --output-schema` enforces; parseAnswer re-checks it so a wrong answer never counts as a verdict. */
export const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "issues", "summary"],
  properties: {
    verdict: { type: "string", enum: [...VERDICTS] },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "severity", "evidence", "note"],
        properties: {
          kind: { type: "string", enum: [...PROBLEM_KINDS] },
          severity: { type: "string", enum: [...SEVERITIES] },
          evidence: { type: "string", description: `A verbatim quote of at most ${EVIDENCE_MAX_CHARS} characters from SOURCE or EXTRACTED` },
          note: { type: "string", description: "What is wrong, in one sentence" },
        },
      },
    },
    summary: { type: "string", description: "One or two sentences on how the extraction reads overall" },
  },
} as const;

const ISSUE_PROPERTIES = ANSWER_SCHEMA.properties.issues.items.properties;
/** The visual rubric's schema: each issue also says where it shows. Strict structured output needs every property required, so `where` is nullable rather than optional. */
export const VISUAL_ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "issues", "summary"],
  properties: {
    verdict: ANSWER_SCHEMA.properties.verdict,
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "severity", "evidence", "note", "where"],
        properties: {
          ...ISSUE_PROPERTIES,
          evidence: { type: "string", description: `A verbatim quote of at most ${EVIDENCE_MAX_CHARS} characters from SOURCE, EXTRACTED or RENDERED TEXT; for a problem seen in a tile, the visible text nearest to it` },
          where: {
            description: "The tile where the problem shows, or null when it shows only in the texts",
            anyOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: ["image", "tile"],
                properties: {
                  image: { type: "string", enum: [...TILE_IMAGES] },
                  tile: { type: "integer", minimum: 1, description: "1-based tile number within that image's tiles" },
                },
              },
            ],
          },
        },
      },
    },
    summary: { type: "string", description: "One or two sentences on how the reader page reads overall" },
  },
} as const;

export interface PromptInput {
  slug: string;
  url: string;
  source: string;
  extracted: string;
  /** Which inputs were cut to fit the prompt; the judge is told not to count the missing tail as lost content. */
  truncated: { source: boolean; extracted: boolean };
  /** The render capture: present in visual mode, absent in text mode. */
  visual?: VisualInput;
}

const KIND_GLOSSARY: Record<RenderingProblemKind, string> = {
  missing_content: "body text, sections or the ending are missing from EXTRACTED",
  extra_content: "navigation, related posts, comments, author cards, share or subscribe blocks kept as body",
  wrong_order: "paragraphs or sections out of order",
  code_or_math: "code blocks or formulas broken (fences lost, newlines collapsed, raw delimiters, un-rendered LaTeX)",
  tables: "tables mangled or dropped",
  images: "figures missing, duplicated or wrong; broken image/card markup such as literal \\[ ... ]\\( ... )",
  metadata: "wrong or missing title, author or date (includes the title repeated as a second body heading)",
  layout: "headings, lists, quotes or footnotes wrong (permalink cruft in headings, paragraphs merged, lists flattened)",
  other: "anything else that hurts reading",
};

const SOURCE_LINE = "SOURCE is the captured page as structured text (the whole page: navigation, chrome, comments and the article).";
const EXTRACTED_LINE = "EXTRACTED is what the extractor produced: first a metadata block with the title, byline and publishedAt it recorded ('(none)' when it found nothing; publishedAt is an ISO timestamp, so a date that matches the page's day in any time zone is right), then the article as markdown. The markdown begins with the title as its H1 by design; that is not a duplicate. A duplicate is a second body heading repeating the title.";
const MARKDOWN_LINE = "The markdown is the GFM representation the reading agent is given; the reader itself renders a document model. Inline HTML that markdown must escape (MathML, <table>, <figure>) counts against Element-fidelity only when the text content is lost, doubled (a formula's TeX annotation printed next to its symbols) or unreadable; escaped tags around otherwise intact text are a minor issue.";
const TEXT_DIMENSIONS = [
  "1. Title — the article's own title, not padded with the site name or UI text, not the wrong heading.",
  "2. Byline — the author(s) when the page shows one; absent bylines are correct when the page has none.",
  "3. Date — the publication date when the page shows one, exactly (watch CJK dates like 2019年9月5日).",
  "4. Body-start — EXTRACTED begins with the article's first real paragraph, not tag pills, widgets or avatar cards.",
  "5. Body-end — EXTRACTED ends where the article ends, not with related posts, bio cards, newsletter or share blocks.",
  "6. Completeness — every section of the article is present in order; nothing skipped, nothing repeated.",
  "7. Element-fidelity — code, math, tables, images, lists, quotes, footnotes and headings survive intact.",
];
/** The two dimensions the visual rubric adds. */
export const VISUAL_DIMENSIONS = [
  "8. Rendering — the reader page shows every element correctly: no raw markup, broken images, horizontal overflow, unrendered math, mangled tables, collapsed code.",
  "9. Visual fidelity — the figures, tables, code and math the original shows are present and readable in the reader.",
];
const KIND_LINES = () => PROBLEM_KINDS.map((kind) => `- ${kind}: ${KIND_GLOSSARY[kind]}`);
const SEVERITY_RULES = [
  "- severity is major when a reader would notice it as broken or would miss content; minor when it is cosmetic.",
  "- Report a dimension scored 0 as a major issue and a dimension scored 1 as a minor issue; report nothing when the extraction is clean.",
  "- Judge reading quality, not markdown style: raw HTML that would render correctly is not a defect.",
];

function truncationNoteOf(input: PromptInput): string {
  return input.truncated.source || input.truncated.extracted
    ? `\nTRUNCATION: ${[input.truncated.source ? "SOURCE" : "", input.truncated.extracted ? "EXTRACTED" : ""].filter(Boolean).join(" and ")} ${input.truncated.source && input.truncated.extracted ? "were" : "was"} cut at the end to fit this prompt. Do not report the missing tail as lost content; judge the ending only from what both inputs show.\n`
    : "";
}

/** The text rubric's prompt (TEXT_RUBRIC_VERSION): SOURCE and EXTRACTED only. Its wording is frozen with that version. */
export function buildPrompt(input: PromptInput): string {
  return [
    "You are judging how well an article extractor turned a web page into reader markdown.",
    "Everything you need is in this message. Do not run commands, read files or browse; answer from the two inputs only.",
    "",
    `Case: ${input.slug} — ${input.url}`,
    "",
    SOURCE_LINE,
    EXTRACTED_LINE,
    MARKDOWN_LINE,
    truncationNoteOf(input),
    "Score the extraction on seven dimensions, each 0 (wrong or missing), 1 (partly right), 2 (right):",
    ...TEXT_DIMENSIONS,
    "",
    "Fold the scores into one verdict:",
    "- PASS: every dimension ≥ 1, total ≥ 11, and no 0 on Completeness or Element-fidelity.",
    "- MAJOR: a 0 on Completeness or Element-fidelity, or two or more 0s anywhere.",
    "- MINOR: everything else.",
    "",
    "List every defect you see as an issue with a kind from this vocabulary:",
    ...KIND_LINES(),
    "",
    "Rules for issues:",
    `- evidence must be a verbatim quote of at most ${EVIDENCE_MAX_CHARS} characters copied from SOURCE or EXTRACTED (the text that shows the problem); never paraphrase.`,
    ...SEVERITY_RULES,
    "",
    "Answer with JSON only, matching the schema you were given: { verdict, issues: [{ kind, severity, evidence, note }], summary }.",
    "",
    "===== SOURCE =====",
    input.source,
    "===== END SOURCE =====",
    "",
    "===== EXTRACTED =====",
    input.extracted,
    "===== END EXTRACTED =====",
  ].join("\n");
}

const range = (count: number) => (count === 1 ? "1" : `1–${count}`);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const clipText = (text: string, max: number) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`; };
const listOf = (items: readonly string[], max = 6) => `${items.slice(0, max).join("; ")}${items.length > max ? `; and ${items.length - max} more` : ""}`;

/** The images paragraph: what the tiles are, in which order they are attached, and which were left out. */
export function describeImages(plan: ImagePlan, visual: Pick<VisualInput, "truncated" | "viewport" | "metrics">): string[] {
  const { rendered, reference } = plan;
  const span = (from: number, count: number, label: string) => (count === 1 ? `image ${from} is ${label} tile 1` : `images ${from}–${from + count - 1} are ${label} tiles 1–${count}`);
  const order = [
    rendered.sent ? span(1, rendered.sent, "RENDERED") : "",
    reference.sent ? `${rendered.sent ? "then " : ""}${span(rendered.sent + 1, reference.sent, "REFERENCE")}` : "",
  ].filter(Boolean).join(", ");
  const omitted = (label: string, side: SideCount) => (side.sent < side.total ? `${label} tile${side.total - side.sent === 1 ? ` ${side.total}` : `s ${side.sent + 1}–${side.total}`} of ${side.total}` : "");
  const left = [omitted("rendered", rendered), omitted("reference", reference)].filter(Boolean);
  const cut = [visual.truncated.rendered ? `the rendered page is ${visual.metrics.height} px tall and its capture stops after ${plural(rendered.total, "tile")}` : "", visual.truncated.reference ? `the reference capture stops after ${plural(reference.total, "tile")}` : ""].filter(Boolean);
  return [
    `RENDERED tiles ${rendered.sent ? range(rendered.sent) : "(none)"} are the Quire reader exactly as a reader sees it (top to bottom, ${visual.viewport.width} px wide); REFERENCE tiles ${reference.sent ? range(reference.sent) : "(none)"} are the original page rendered from the snapshot with JavaScript off and network CSS/images — the reference may lack styles or images; never blame the extractor for what the reference itself lacks.`,
    `The ${plural(plan.images.length, "image")} are attached in this order: ${order || "none"}. Each tile is ${visual.viewport.height} px of the page; consecutive tiles continue it without overlap.`,
    ...(left.length ? [`OMITTED: to stay within ${plan.maxImages} images per call, ${left.join(" and ")} ${rendered.total - rendered.sent + reference.total - reference.sent > 1 ? "were" : "was"} captured but not attached. Judge that part of the page from the texts and the facts, which cover the whole page; do not report it as missing.`] : []),
    ...(cut.length ? [`CAPTURE CUT: ${cut.join("; ")}. Judge what lies below the last tile from the texts and the facts only.`] : []),
  ];
}

/** The capture's measured facts about the rendered page, one line each. */
export function describeFacts(visual: Pick<VisualInput, "metrics" | "warnings" | "failedReferenceRequests">): string[] {
  const { images, overflow, rawMarkup, mathErrors, unmarkedLists, emptyCellTables, emptyHeadings, duplicateTitleHeadings, counts, height } = visual.metrics;
  return [
    `- Images: ${images.total} in the article, ${images.broken} broken (failed to load)${images.broken ? `: ${listOf(images.brokenSrc.map((src) => clipText(src, 160)))}` : ""}.`,
    `- Horizontal overflow: ${plural(overflow.count, "element")} wider than the reading column${overflow.count ? `: ${listOf(overflow.samples.map((sample) => `${sample.path} (${sample.width} px)`))}` : ""}.`,
    `- Raw markup visible as text: ${rawMarkup.count}${rawMarkup.count ? ` — ${listOf(rawMarkup.samples.map((sample) => `${JSON.stringify(sample.pattern)} in "${clipText(sample.text, 120)}"`))} (the samples are verbatim rendered text and may be quoted as evidence)` : ""}.`,
    `- Math that failed to render: ${mathErrors}.`,
    `- Lists whose items show no bullet or number: ${unmarkedLists} of ${counts.lists}.`,
    `- Tables with a quarter or more of their cells empty: ${emptyCellTables.count}${emptyCellTables.count ? ` — ${listOf(emptyCellTables.samples.map((sample) => `table ${sample.table} (${sample.empty} of ${sample.cells} cells empty)`))}` : ""}.`,
    `- Headings: ${counts.headings} (${emptyHeadings} empty, ${duplicateTitleHeadings} repeating the title).`,
    `- The reader shows ${plural(counts.codeBlocks, "code block")}, ${plural(counts.tables, "table")}, ${plural(counts.figures, "figure")}, ${plural(counts.lists, "list")}, ${plural(counts.footnotes, "footnote")} and ${counts.words} words; the article is ${height} px tall.`,
    `- Reference page: ${plural(visual.failedReferenceRequests, "network request")} failed while it loaded${visual.failedReferenceRequests ? " (missing styles or images in the reference are expected)" : ""}.`,
    ...(visual.warnings.length ? [`- Capture warnings: ${listOf(visual.warnings.map((warning) => clipText(warning, 200)))}.`] : []),
  ];
}

/** The visual rubric's prompt (RUBRIC_VERSION, v4): the texts, the attached tiles, and the measured facts. */
export function buildVisualPrompt(input: PromptInput, plan: ImagePlan): string {
  const { visual } = input;
  if (!visual) throw new Error(`buildVisualPrompt: ${input.slug} has no render capture`);
  const tiles = `rendered tiles ${plan.rendered.sent ? range(plan.rendered.sent) : "none"}, reference tiles ${plan.reference.sent ? range(plan.reference.sent) : "none"}`;
  return [
    "You are judging how well Quire turned a web page into a reader page: what its article extractor kept, and how the reader displays it.",
    "Everything you need is in this message and its attached images. Do not run commands, read files or browse; answer from these inputs only.",
    "",
    `Case: ${input.slug} — ${input.url}`,
    "",
    "TEXTS",
    SOURCE_LINE,
    EXTRACTED_LINE,
    MARKDOWN_LINE,
    `RENDERED TEXT is the reader page's visible text (innerText), in reading order${visual.renderedTextTruncated ? ", cut at the end to fit this prompt" : ""}. It is there only so visual problems can be quoted: formulas show in it with duplicated or split symbols and table cells on separate lines even when they render correctly, so never judge how anything looks from it. SOURCE and EXTRACTED decide completeness; the RENDERED tiles and the FACTS decide rendering.`,
    truncationNoteOf(input),
    "IMAGES",
    ...describeImages(plan, visual),
    "How to look: go through every RENDERED tile top to bottom. Elements continue across tiles, so before calling a figure, table, formula or list missing or broken, find where it belongs and check the tiles before and after. Compare with the REFERENCE tiles for what the original shows: list markers (bullets, numbers), what table cells contain (text, check marks, icons), figure images, code layout and line breaks, formula typesetting.",
    "",
    "FACTS measured in the rendered reader page by the capture program (ground truth, not opinions):",
    ...describeFacts(visual),
    "Facts override impressions: when a tile seems to contradict a fact, the fact is right. A non-zero broken-image, raw-markup, unmarked-list or empty-cell-table fact must appear as an issue unless the reference shows the same defect. Overflow and math errors are defects when a reader would see them (a scrollable code block is fine; text cut off at the column edge is not).",
    "",
    "Score the reader page on nine dimensions, each 0 (wrong or missing), 1 (partly right), 2 (right):",
    ...TEXT_DIMENSIONS,
    ...VISUAL_DIMENSIONS,
    "",
    "Fold the scores into one verdict:",
    "- MAJOR: a 0 on Completeness, Element-fidelity, Rendering or Visual fidelity.",
    "- PASS: every dimension ≥ 1 and a total ≥ 15 of 18.",
    "- MINOR: everything else.",
    "",
    "List every defect you see as an issue with a kind from this vocabulary:",
    ...KIND_LINES(),
    "",
    "Rules for issues:",
    `- evidence must be a verbatim quote of at most ${EVIDENCE_MAX_CHARS} characters copied from SOURCE, EXTRACTED or RENDERED TEXT; never paraphrase. For a problem you see in a tile, quote the visible text nearest to it (the broken block's first words, its caption, or the heading above it).`,
    `- where names the tile the problem shows in, { "image": "rendered" | "reference", "tile": n } with n among the tiles attached (${tiles}): the RENDERED tile where the defect is visible; a REFERENCE tile only for something the reader lacks entirely; null when the problem shows only in the texts. Report a visual problem only after seeing it in a tile.`,
    "- Visual problems use the same kinds: a broken, missing or doubled image → images; raw markup, unrendered math or collapsed code → code_or_math; a mangled table → tables; horizontal overflow, broken headings, lists or spacing → layout.",
    ...SEVERITY_RULES,
    "- A difference that comes from the reference lacking styles, scripts or images (unstyled layout, empty image boxes, a consent banner) is not a defect of the reader.",
    "",
    "Answer with JSON only, matching the schema you were given: { verdict, issues: [{ kind, severity, evidence, note, where }], summary }.",
    "",
    "===== SOURCE =====",
    input.source,
    "===== END SOURCE =====",
    "",
    "===== EXTRACTED =====",
    input.extracted,
    "===== END EXTRACTED =====",
    "",
    "===== RENDERED TEXT =====",
    visual.renderedText,
    "===== END RENDERED TEXT =====",
  ].join("\n");
}

export class AnswerFormatError extends Error {
  constructor(message: string) { super(`judge answer rejected: ${message}`); this.name = "AnswerFormatError"; }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isVerdict = (value: unknown): value is Verdict => typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
const isSeverity = (value: unknown): value is Severity => typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
const isKind = (value: unknown): value is RenderingProblemKind => typeof value === "string" && (PROBLEM_KINDS as readonly string[]).includes(value);

/** The tiles attached to a visual call; `where` must name one of them. */
export interface SentTiles { rendered: number; reference: number }

function parseWhere(value: unknown, index: number, tiles: SentTiles): TileRef | null {
  if (value === null) return null;
  const at = `issues[${index}].where`;
  if (!isRecord(value)) throw new AnswerFormatError(`${at} is neither null nor an object`);
  const extra = Object.keys(value).filter((key) => key !== "image" && key !== "tile");
  if (extra.length) throw new AnswerFormatError(`${at} has unexpected keys: ${extra.join(", ")}`);
  const { image, tile } = value;
  if (typeof image !== "string" || !(TILE_IMAGES as readonly string[]).includes(image)) throw new AnswerFormatError(`${at}.image ${JSON.stringify(image)} is not rendered|reference`);
  const sent = tiles[image as TileImage];
  if (typeof tile !== "number" || !Number.isInteger(tile) || tile < 1 || tile > sent) throw new AnswerFormatError(`${at}.tile ${JSON.stringify(tile)} is not one of the ${sent} ${image} tile(s) attached`);
  return { image: image as TileImage, tile };
}

function parseIssue(value: unknown, index: number, tiles: SentTiles | undefined): JudgeIssue {
  if (!isRecord(value)) throw new AnswerFormatError(`issues[${index}] is not an object`);
  const { kind, severity, evidence, note } = value;
  if (!isKind(kind)) throw new AnswerFormatError(`issues[${index}].kind ${JSON.stringify(kind)} is not one of ${PROBLEM_KINDS.join(", ")}`);
  if (!isSeverity(severity)) throw new AnswerFormatError(`issues[${index}].severity ${JSON.stringify(severity)} is not minor|major`);
  if (typeof evidence !== "string") throw new AnswerFormatError(`issues[${index}].evidence is not a string`);
  if (typeof note !== "string") throw new AnswerFormatError(`issues[${index}].note is not a string`);
  const issue = { kind, severity, evidence: evidence.length > EVIDENCE_MAX_CHARS ? evidence.slice(0, EVIDENCE_MAX_CHARS) : evidence, note };
  if (!tiles) return issue;
  if (!("where" in value)) throw new AnswerFormatError(`issues[${index}].where is missing (null or { image, tile })`);
  return { ...issue, where: parseWhere(value.where, index, tiles) };
}

/**
 * Strict: the text must be one JSON object of exactly the schema's shape; anything else throws
 * AnswerFormatError. With `tiles` (visual mode) every issue must carry `where`, naming a tile that was attached.
 */
export function parseAnswer(text: string, tiles?: SentTiles): JudgeAnswer {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new AnswerFormatError(`not JSON (${error instanceof Error ? error.message : String(error)})`); }
  if (!isRecord(parsed)) throw new AnswerFormatError("top level is not an object");
  const extra = Object.keys(parsed).filter((key) => !["verdict", "issues", "summary"].includes(key));
  if (extra.length) throw new AnswerFormatError(`unexpected keys: ${extra.join(", ")}`);
  const { verdict, issues, summary } = parsed;
  if (!isVerdict(verdict)) throw new AnswerFormatError(`verdict ${JSON.stringify(verdict)} is not PASS|MINOR|MAJOR`);
  if (!Array.isArray(issues)) throw new AnswerFormatError("issues is not an array");
  if (typeof summary !== "string" || !summary.trim()) throw new AnswerFormatError("summary is not a non-empty string");
  return { verdict, issues: issues.map((issue, index) => parseIssue(issue, index, tiles)), summary };
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** Whether an evidence quote really occurs in any of the texts (SOURCE, EXTRACTED, RENDERED TEXT; whitespace-insensitive); false means the judge paraphrased. */
export function evidenceOccurs(evidence: string, ...texts: string[]): boolean {
  const needle = squash(evidence);
  if (!needle) return false;
  return texts.some((text) => squash(text).includes(needle));
}
