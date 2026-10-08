// One opinion: build the prompt (text, or visual with the capture's tiles attached), run a backend,
// parse its answer strictly, verify the evidence quotes. Never throws for a bad answer or a failed call: that is an OpinionFailure with the reason
// and the raw text, and the policy decides what a failure means for the case.
import type { BackendId, Opinion } from "./cache";
import { BackendRunError, type BackendRunMeta, type JudgeBackend } from "./backends/types";
import { AnswerFormatError, ANSWER_SCHEMA, buildPrompt, buildVisualPrompt, evidenceOccurs, parseAnswer, VISUAL_ANSWER_SCHEMA, type PromptInput, type SentTiles } from "./rubric";
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

interface Call { prompt: string; schema: object; images: string[]; tiles: SentTiles | undefined; texts: string[] }

/** What one backend call carries: the text rubric's prompt, or (with a capture) the visual one with its tiles. */
function callFor(input: PromptInput, maxImages: number): Call {
  if (!input.visual) return { prompt: buildPrompt(input), schema: ANSWER_SCHEMA, images: [], tiles: undefined, texts: [input.source, input.extracted] };
  const plan = planImages(input.visual, maxImages);
  return { prompt: buildVisualPrompt(input, plan), schema: VISUAL_ANSWER_SCHEMA, images: plan.images, tiles: { rendered: plan.rendered.sent, reference: plan.reference.sent }, texts: [input.source, input.extracted, input.visual.renderedText] };
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
    const answer = parseAnswer(raw, call.tiles);
    const issues = answer.issues.map((issue) => ({ ...issue, verified: evidenceOccurs(issue.evidence, ...call.texts) }));
    return { ok: true, opinion: { ...base, ...meta, ...(call.images.length ? { images: call.images.length } : {}), verdict: answer.verdict, issues, summary: answer.summary, wallMs: Date.now() - started } };
  } catch (error) {
    if (error instanceof AnswerFormatError) return fail(error.message, meta, raw);
    throw error;
  }
}
