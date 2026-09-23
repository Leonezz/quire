// One opinion: build the prompt, run a backend, parse its answer strictly, verify the evidence
// quotes. Never throws for a bad answer or a failed call: that is an OpinionFailure with the reason
// and the raw text, and the policy decides what a failure means for the case.
import type { BackendId, Opinion } from "./cache";
import { BackendRunError, type BackendRunMeta, type JudgeBackend } from "./backends/types";
import { AnswerFormatError, ANSWER_SCHEMA, buildPrompt, evidenceOccurs, parseAnswer, type PromptInput } from "./rubric";

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

/** Asks one backend for its opinion on a case. */
export async function askOpinion(backend: JudgeBackend, input: PromptInput, timeoutMs: number): Promise<OpinionOutcome> {
  const started = Date.now();
  const base = { backend: backend.id, model: backend.model };
  const fail = (error: string, meta: BackendRunMeta = {}, rawAnswer?: string): OpinionOutcome => ({ ok: false, failure: { ...base, ...meta, error, ...(rawAnswer !== undefined ? { rawAnswer: rawAnswer.slice(0, RAW_MAX) } : {}), wallMs: Date.now() - started } });
  let output;
  try {
    output = await backend.run({ prompt: buildPrompt(input), schema: ANSWER_SCHEMA, timeoutMs });
  } catch (error) {
    if (error instanceof BackendRunError) return fail(error.message, error.meta);
    return fail(`${backend.id} could not start: ${errorText(error)}`);
  }
  const { raw, ...meta } = output;
  try {
    const answer = parseAnswer(raw);
    const issues = answer.issues.map((issue) => ({ ...issue, verified: evidenceOccurs(issue.evidence, input.source, input.extracted) }));
    return { ok: true, opinion: { ...base, ...meta, verdict: answer.verdict, issues, summary: answer.summary, wallMs: Date.now() - started } };
  } catch (error) {
    if (error instanceof AnswerFormatError) return fail(error.message, meta, raw);
    throw error;
  }
}
