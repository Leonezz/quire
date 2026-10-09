// The judge's rubric: the JSON schemas its answers must fit, the strict parser for those answers,
// and the text-mode prompt. Two modes:
//   visual (default, RUBRIC_VERSION): the evaluation standard v6 (docs/design/eval-rubric.md; the
//     prompt is visual-prompt.ts). The model only lists issues, each in a layer with evidence, tile
//     and the ids of the images/embeds it is about; verdict.ts decides which issues are valid and
//     computes the per-layer and overall verdicts.
//   text (TEXT_RUBRIC_VERSION): SOURCE vs EXTRACTED only. Its prompt and schema are frozen (the
//     model still answers a verdict, which the program ignores); since rubric v6 its verdict too is
//     computed from the valid issues, over the content and metadata layers.
// A rubric version is part of every cache key, so bump the one whose prompt, schema or verdict rule
// changes and every case of that mode is judged again.
import { RENDERING_PROBLEM_KINDS, type RenderingProblemKind } from "../../apps/desktop/src/shared/contracts";
import { LAYERS, SEVERITIES, SUBJECTS, TILE_IMAGES, VERDICTS, type JudgeIssue, type Layer, type Severity, type Subject, type TileImage, type TileRef, type Verdict } from "./verdict";
import type { VisualInput } from "./visual";

export { LAYERS, SEVERITIES, SUBJECTS, TILE_IMAGES, VERDICTS, evidenceOccurs } from "./verdict";
export type { JudgeIssue, Layer, Severity, SentTiles, Subject, TileImage, TileRef, Verdict } from "./verdict";

/** The visual rubric (standard v6 with the 2026-10-10 metadata subject and cross-confirmation), the default mode's. */
export const RUBRIC_VERSION = "2026-10-10.12";
/** The text rubric: prompt and schema unchanged since 2026-09-23.3; bumped when v6 moved its verdict to the program, and again for cross-confirmation of two opinions. */
export const TEXT_RUBRIC_VERSION = "2026-10-10.11-text";
export const rubricVersionFor = (mode: "visual" | "text"): string => (mode === "visual" ? RUBRIC_VERSION : TEXT_RUBRIC_VERSION);
/** The kinds the judge may report: the same vocabulary the app's "Report rendering problem" form uses. */
export const PROBLEM_KINDS: readonly RenderingProblemKind[] = RENDERING_PROBLEM_KINDS;
export const EVIDENCE_MAX_CHARS = 200;

export interface JudgeAnswer { issues: JudgeIssue[]; summary: string }

/** The text rubric's schema, frozen with its prompt: what `codex exec --output-schema` enforces; parseAnswer re-checks it. */
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

/**
 * The visual rubric's schema (v6): issues and a summary, no verdict. Strict structured output needs
 * every property required, so `where` is nullable rather than optional and `refs` may be empty.
 */
export const VISUAL_ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["issues", "summary"],
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["layer", "kind", "severity", "subject", "evidence", "where", "refs", "note"],
        properties: {
          layer: { type: "string", enum: [...LAYERS], description: "content and metadata: what the extractor kept; rendering: how the reader shows it" },
          kind: { type: "string", enum: [...PROBLEM_KINDS] },
          severity: { type: "string", enum: [...SEVERITIES] },
          subject: {
            description: "What a metadata issue is about (title, author or date); null for every other issue",
            anyOf: [{ type: "null" }, { type: "string", enum: [...SUBJECTS] }],
          },
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
          refs: { type: "array", items: { type: "string" }, description: "Ids of the reader images (r…), original images (o…) and embeds (e…) the issue is about; empty when none" },
          note: { type: "string", description: "What is wrong, in one sentence" },
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

export const KIND_GLOSSARY: Record<RenderingProblemKind, string> = {
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

export const SOURCE_LINE = "SOURCE is the captured page as structured text (the whole page: navigation, chrome, comments and the article).";
export const EXTRACTED_LINE = "EXTRACTED is what the extractor produced: first a metadata block with the title, byline and publishedAt it recorded ('(none)' when it found nothing; publishedAt is an ISO timestamp, so a date that matches the page's day in any time zone is right), then the article as markdown. The markdown begins with the title as its H1 by design; that is not a duplicate. A duplicate is a second body heading repeating the title.";
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
export const KIND_LINES = () => PROBLEM_KINDS.map((kind) => `- ${kind}: ${KIND_GLOSSARY[kind]}`);
const SEVERITY_RULES = [
  "- severity is major when a reader would notice it as broken or would miss content; minor when it is cosmetic.",
  "- Report a dimension scored 0 as a major issue and a dimension scored 1 as a minor issue; report nothing when the extraction is clean.",
  "- Judge reading quality, not markdown style: raw HTML that would render correctly is not a defect.",
];

export function truncationNoteOf(input: PromptInput): string {
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

export class AnswerFormatError extends Error {
  constructor(message: string) { super(`judge answer rejected: ${message}`); this.name = "AnswerFormatError"; }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isVerdict = (value: unknown): value is Verdict => typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
const isSeverity = (value: unknown): value is Severity => typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
const isKind = (value: unknown): value is RenderingProblemKind => typeof value === "string" && (PROBLEM_KINDS as readonly string[]).includes(value);
const isLayer = (value: unknown): value is Layer => typeof value === "string" && (LAYERS as readonly string[]).includes(value);

/** The shape of `where`: null or { image, tile ≥ 1 }. Whether the tile was attached is verdict.ts's check (an invalid issue, not a rejected answer). */
function parseWhere(value: unknown, index: number): TileRef | null {
  if (value === null) return null;
  const at = `issues[${index}].where`;
  if (!isRecord(value)) throw new AnswerFormatError(`${at} is neither null nor an object`);
  const extra = Object.keys(value).filter((key) => key !== "image" && key !== "tile");
  if (extra.length) throw new AnswerFormatError(`${at} has unexpected keys: ${extra.join(", ")}`);
  const { image, tile } = value;
  if (typeof image !== "string" || !(TILE_IMAGES as readonly string[]).includes(image)) throw new AnswerFormatError(`${at}.image ${JSON.stringify(image)} is not rendered|reference`);
  if (typeof tile !== "number" || !Number.isInteger(tile) || tile < 1) throw new AnswerFormatError(`${at}.tile ${JSON.stringify(tile)} is not a positive integer`);
  return { image: image as TileImage, tile };
}

function parseRefs(value: unknown, index: number): string[] {
  if (!Array.isArray(value) || value.some((ref) => typeof ref !== "string")) throw new AnswerFormatError(`issues[${index}].refs is not a list of ids`);
  return [...new Set(value.map((ref: string) => ref.trim()).filter(Boolean))];
}

/** Text mode has no layer in its answer: metadata issues are the metadata layer's, everything else the content's. */
const textLayerOf = (kind: RenderingProblemKind): Layer => (kind === "metadata" ? "metadata" : "content");

function parseIssue(value: unknown, index: number, mode: "text" | "visual"): JudgeIssue {
  if (!isRecord(value)) throw new AnswerFormatError(`issues[${index}] is not an object`);
  const { kind, severity, evidence, note } = value;
  if (!isKind(kind)) throw new AnswerFormatError(`issues[${index}].kind ${JSON.stringify(kind)} is not one of ${PROBLEM_KINDS.join(", ")}`);
  if (!isSeverity(severity)) throw new AnswerFormatError(`issues[${index}].severity ${JSON.stringify(severity)} is not minor|major`);
  if (typeof evidence !== "string") throw new AnswerFormatError(`issues[${index}].evidence is not a string`);
  if (typeof note !== "string") throw new AnswerFormatError(`issues[${index}].note is not a string`);
  const clipped = evidence.length > EVIDENCE_MAX_CHARS ? evidence.slice(0, EVIDENCE_MAX_CHARS) : evidence;
  if (mode === "text") return { layer: textLayerOf(kind), kind, severity, evidence: clipped, note };
  if (!isLayer(value.layer)) throw new AnswerFormatError(`issues[${index}].layer ${JSON.stringify(value.layer)} is not one of ${LAYERS.join(", ")}`);
  if (!("where" in value)) throw new AnswerFormatError(`issues[${index}].where is missing (null or { image, tile })`);
  if (!("refs" in value)) throw new AnswerFormatError(`issues[${index}].refs is missing ([] when the issue is about no image or embed)`);
  if (!("subject" in value)) throw new AnswerFormatError(`issues[${index}].subject is missing (title, author, date, or null)`);
  const { subject } = value;
  if (subject !== null && !(typeof subject === "string" && (SUBJECTS as readonly string[]).includes(subject))) throw new AnswerFormatError(`issues[${index}].subject ${JSON.stringify(subject)} is not title|author|date|null`);
  return { layer: value.layer, kind, severity, subject: subject as Subject | null, evidence: clipped, note, where: parseWhere(value.where, index), refs: parseRefs(value.refs, index) };
}

/**
 * Strict: the text must be one JSON object of exactly the mode's schema; anything else throws
 * AnswerFormatError. Text mode: { verdict, issues, summary } (the verdict is checked, then dropped:
 * the program computes it). Visual mode: { issues, summary }, every issue with layer, subject, where and refs.
 */
export function parseAnswer(text: string, mode: "text" | "visual" = "text"): JudgeAnswer {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new AnswerFormatError(`not JSON (${error instanceof Error ? error.message : String(error)})`); }
  if (!isRecord(parsed)) throw new AnswerFormatError("top level is not an object");
  const keys = mode === "text" ? ["verdict", "issues", "summary"] : ["issues", "summary"];
  const extra = Object.keys(parsed).filter((key) => !keys.includes(key));
  if (extra.length) throw new AnswerFormatError(`unexpected keys: ${extra.join(", ")}`);
  const { issues, summary } = parsed;
  if (mode === "text" && !isVerdict(parsed.verdict)) throw new AnswerFormatError(`verdict ${JSON.stringify(parsed.verdict)} is not PASS|MINOR|MAJOR`);
  if (!Array.isArray(issues)) throw new AnswerFormatError("issues is not an array");
  if (typeof summary !== "string" || !summary.trim()) throw new AnswerFormatError("summary is not a non-empty string");
  return { issues: issues.map((issue, index) => parseIssue(issue, index, mode)), summary };
}
