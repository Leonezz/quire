// One opinion: build the prompt (text, or visual with the capture's tiles attached), run a backend,
// parse its answer strictly, then validate every issue and compute the verdicts (verdict.ts): the
// model lists issues, the program decides which count. Never throws for a bad answer or a failed
// call: that is an OpinionFailure with the reason and the raw text, and the policy decides what a
// failure means for the case.
import type { BackendId, JudgedIssue, Opinion } from "./cache";
import { BackendRunError, type BackendRunMeta, type JudgeBackend } from "./backends/types";
import { AnswerFormatError, ANSWER_SCHEMA, buildPrompt, parseAnswer, VISUAL_ANSWER_SCHEMA, type JudgeIssue, type PromptInput } from "./rubric";
import type { MergeFacts } from "./merge";
import { evidenceOccurs, layerVerdicts, normalizeIssue, overallVerdict, validateIssue, type FactInventory } from "./verdict";
import { buildVisualPrompt } from "./visual-prompt";
import { DEFAULT_MAX_IMAGES, planImages } from "./visual";

export interface OpinionFailure extends BackendRunMeta {
  backend: BackendId;
  model: string;
  error: string;
  /** The answer text when there was one but it did not fit the schema. */
  rawAnswer?: string;
  wallMs: number;
}
export type OpinionOutcome = { ok: true; opinion: Opinion } | { ok: false; failure: OpinionFailure };

const RAW_MAX = 4_000;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface Call { prompt: string; schema: object; images: string[]; mode: "text" | "visual"; texts: string[]; facts: FactInventory | undefined }

/** What an opinion's issues are checked against: the texts their quotes must occur in, and (visual mode) the capture's facts. */
export interface ScoringContext { mode: "text" | "visual"; texts: string[]; facts: FactInventory | undefined }

/** The scoring context of a case: the same texts and facts a judge call checks its answer against. */
export function scoringContextOf(input: PromptInput, maxImages: number): ScoringContext {
  const { mode, texts, facts } = callFor(input, maxImages);
  return { mode, texts, facts };
}

/** An opinion's reported issues judged (normalized, validated) and its verdicts computed; pure, so a stored opinion can be scored again. */
export function scoreIssues(reported: readonly JudgeIssue[], context: ScoringContext): Pick<Opinion, "issues" | "layers" | "verdict"> {
  const issues = reported.map((issue) => judgeIssue(issue, context.texts, context.facts));
  const layers = layerVerdicts(issues, context.mode === "visual");
  return { issues, layers, verdict: overallVerdict(layers) };
}

/** What one backend call carries: the text rubric's prompt, or (with a capture) the visual one with its tiles and the facts its issues are checked against. */
function callFor(input: PromptInput, maxImages: number): Call {
  if (!input.visual) return { prompt: buildPrompt(input), schema: ANSWER_SCHEMA, images: [], mode: "text", texts: [input.source, input.extracted], facts: undefined };
  const plan = planImages(input.visual, maxImages);
  const facts: FactInventory = { rendered: input.visual.images.rendered, reference: input.visual.images.reference, embeds: input.visual.embeds, tables: input.visual.tables, code: input.visual.code, extracted: input.extracted, sent: { rendered: plan.rendered.sent, reference: plan.reference.sent } };
  return { prompt: buildVisualPrompt(input, plan), schema: VISUAL_ANSWER_SCHEMA, images: plan.images, mode: "visual", texts: [input.source, input.extracted, input.visual.renderedText], facts };
}

/** An issue with its checks: metadata normalized by subject (§5) and the layer the facts decide (§3), whether the quote is verbatim, and why it does not count when it does not. */
export function judgeIssue(reported: JudgeIssue, texts: readonly string[], facts: FactInventory | undefined): JudgedIssue {
  const issue = normalizeIssue(reported, facts);
  const invalid = validateIssue(issue, texts, facts);
  return { ...issue, verified: evidenceOccurs(issue.evidence, ...texts), ...(invalid ? { invalid } : {}) };
}

/** The facts cross-confirmation leans on (visual mode); undefined in text mode. */
export function mergeFactsOf(input: PromptInput): MergeFacts | undefined {
  if (!input.visual) return undefined;
  return { rendered: input.visual.images.rendered, reference: input.visual.images.reference, embeds: input.visual.embeds, tables: input.visual.tables, code: input.visual.code, extracted: input.extracted, metrics: input.visual.metrics };
}

/** Asks one backend for its opinion on a case; in visual mode with at most maxImages tiles attached. */
export async function askOpinion(backend: JudgeBackend, input: PromptInput, timeoutMs: number, maxImages = DEFAULT_MAX_IMAGES): Promise<OpinionOutcome> {
  const started = Date.now();
  const base = { backend: backend.id, model: backend.model };
  const fail = (error: string, meta: BackendRunMeta = {}, rawAnswer?: string): OpinionOutcome => ({ ok: false, failure: { ...base, ...meta, error, ...(rawAnswer !== undefined ? { rawAnswer: rawAnswer.slice(0, RAW_MAX) } : {}), wallMs: Date.now() - started } });
  const call = callFor(input, maxImages);
  let output;
  try {
    output = await backend.run({ prompt: call.prompt, schema: call.schema, timeoutMs, ...(call.images.length ? { images: call.images } : {}) });
  } catch (error) {
    if (error instanceof BackendRunError) return fail(error.message, error.meta);
    return fail(`${backend.id} could not start: ${errorText(error)}`);
  }
  const { raw, ...meta } = output;
  try {
    const answer = parseAnswer(raw, call.mode);
    const scored = scoreIssues(answer.issues, call);
    return { ok: true, opinion: { ...base, ...meta, ...(call.images.length ? { images: call.images.length } : {}), ...scored, summary: answer.summary, wallMs: Date.now() - started } };
  } catch (error) {
    if (error instanceof AnswerFormatError) return fail(error.message, meta, raw);
    throw error;
  }
}
