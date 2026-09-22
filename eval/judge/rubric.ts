// The judge's rubric: the prompt Codex answers, the JSON schema its answer must fit, and the strict
// parser for that answer. RUBRIC_VERSION is part of every cache key, so bump it whenever the prompt
// or the schema changes and every case is judged again.
import { RENDERING_PROBLEM_KINDS, type RenderingProblemKind } from "../../apps/desktop/src/shared/contracts";

export const RUBRIC_VERSION = "2026-09-23.3";
export const VERDICTS = ["PASS", "MINOR", "MAJOR"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const SEVERITIES = ["minor", "major"] as const;
export type Severity = (typeof SEVERITIES)[number];
/** The kinds the judge may report: the same vocabulary the app's "Report rendering problem" form uses. */
export const PROBLEM_KINDS: readonly RenderingProblemKind[] = RENDERING_PROBLEM_KINDS;
export const EVIDENCE_MAX_CHARS = 200;

export interface JudgeIssue { kind: RenderingProblemKind; severity: Severity; evidence: string; note: string }
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

export interface PromptInput {
  slug: string;
  url: string;
  source: string;
  extracted: string;
  /** Which inputs were cut to fit the prompt; the judge is told not to count the missing tail as lost content. */
  truncated: { source: boolean; extracted: boolean };
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

export function buildPrompt(input: PromptInput): string {
  const truncationNote = input.truncated.source || input.truncated.extracted
    ? `\nTRUNCATION: ${[input.truncated.source ? "SOURCE" : "", input.truncated.extracted ? "EXTRACTED" : ""].filter(Boolean).join(" and ")} ${input.truncated.source && input.truncated.extracted ? "were" : "was"} cut at the end to fit this prompt. Do not report the missing tail as lost content; judge the ending only from what both inputs show.\n`
    : "";
  return [
    "You are judging how well an article extractor turned a web page into reader markdown.",
    "Everything you need is in this message. Do not run commands, read files or browse; answer from the two inputs only.",
    "",
    `Case: ${input.slug} — ${input.url}`,
    "",
    "SOURCE is the captured page as structured text (the whole page: navigation, chrome, comments and the article).",
    "EXTRACTED is what the extractor produced: first a metadata block with the title, byline and publishedAt it recorded ('(none)' when it found nothing; publishedAt is an ISO timestamp, so a date that matches the page's day in any time zone is right), then the article as markdown. The markdown begins with the title as its H1 by design; that is not a duplicate. A duplicate is a second body heading repeating the title.",
    "The markdown is the GFM representation the reading agent is given; the reader itself renders a document model. Inline HTML that markdown must escape (MathML, <table>, <figure>) counts against Element-fidelity only when the text content is lost, doubled (a formula's TeX annotation printed next to its symbols) or unreadable; escaped tags around otherwise intact text are a minor issue.",
    truncationNote,
    "Score the extraction on seven dimensions, each 0 (wrong or missing), 1 (partly right), 2 (right):",
    "1. Title — the article's own title, not padded with the site name or UI text, not the wrong heading.",
    "2. Byline — the author(s) when the page shows one; absent bylines are correct when the page has none.",
    "3. Date — the publication date when the page shows one, exactly (watch CJK dates like 2019年9月5日).",
    "4. Body-start — EXTRACTED begins with the article's first real paragraph, not tag pills, widgets or avatar cards.",
    "5. Body-end — EXTRACTED ends where the article ends, not with related posts, bio cards, newsletter or share blocks.",
    "6. Completeness — every section of the article is present in order; nothing skipped, nothing repeated.",
    "7. Element-fidelity — code, math, tables, images, lists, quotes, footnotes and headings survive intact.",
    "",
    "Fold the scores into one verdict:",
    "- PASS: every dimension ≥ 1, total ≥ 11, and no 0 on Completeness or Element-fidelity.",
    "- MAJOR: a 0 on Completeness or Element-fidelity, or two or more 0s anywhere.",
    "- MINOR: everything else.",
    "",
    "List every defect you see as an issue with a kind from this vocabulary:",
    ...PROBLEM_KINDS.map((kind) => `- ${kind}: ${KIND_GLOSSARY[kind]}`),
    "",
    "Rules for issues:",
    `- evidence must be a verbatim quote of at most ${EVIDENCE_MAX_CHARS} characters copied from SOURCE or EXTRACTED (the text that shows the problem); never paraphrase.`,
    "- severity is major when a reader would notice it as broken or would miss content; minor when it is cosmetic.",
    "- Report a dimension scored 0 as a major issue and a dimension scored 1 as a minor issue; report nothing when the extraction is clean.",
    "- Judge reading quality, not markdown style: raw HTML that would render correctly is not a defect.",
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

function parseIssue(value: unknown, index: number): JudgeIssue {
  if (!isRecord(value)) throw new AnswerFormatError(`issues[${index}] is not an object`);
  const { kind, severity, evidence, note } = value;
  if (!isKind(kind)) throw new AnswerFormatError(`issues[${index}].kind ${JSON.stringify(kind)} is not one of ${PROBLEM_KINDS.join(", ")}`);
  if (!isSeverity(severity)) throw new AnswerFormatError(`issues[${index}].severity ${JSON.stringify(severity)} is not minor|major`);
  if (typeof evidence !== "string") throw new AnswerFormatError(`issues[${index}].evidence is not a string`);
  if (typeof note !== "string") throw new AnswerFormatError(`issues[${index}].note is not a string`);
  return { kind, severity, evidence: evidence.length > EVIDENCE_MAX_CHARS ? evidence.slice(0, EVIDENCE_MAX_CHARS) : evidence, note };
}

/** Strict: the text must be one JSON object of exactly the schema's shape; anything else throws AnswerFormatError. */
export function parseAnswer(text: string): JudgeAnswer {
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
  return { verdict, issues: issues.map(parseIssue), summary };
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** Whether an evidence quote really occurs in either input (whitespace-insensitive); false means the judge paraphrased. */
export function evidenceOccurs(evidence: string, source: string, extracted: string): boolean {
  const needle = squash(evidence);
  if (!needle) return false;
  return squash(source).includes(needle) || squash(extracted).includes(needle);
}
