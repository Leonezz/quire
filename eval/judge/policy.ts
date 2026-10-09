// How a case is judged under a policy: which backends are asked, in what order, and how their
// opinions fold into the case's verdict. Pure apart from the backends it is handed.
//
// Every verdict here is the program's (verdict.ts): per layer from the valid issues, the overall one
// the worst layer. A case with two opinions is cross-confirmed (merge.ts, docs/design/eval-rubric.md
// §6): their valid issues merge into one list, an issue both report counting once, a one-sided major
// issue counting as major only with a measured fact behind it; the case's verdicts come from that
// list, `resolution.from` is "merged", and `disputed` says the two opinions' own verdicts differ.
//
//   single              one opinion; its issues and verdicts are the case's.
//   screen-then-confirm the screener answers first. A verdict outside escalateOn (by default PASS)
//                       is final, the screener's alone. Otherwise the confirmer answers and the two
//                       are cross-confirmed. Any valid major issue makes the screener's verdict MAJOR,
//                       so a "PASS with a major issue" cannot happen. A failed screener fails the
//                       case. A failed confirmer also fails the case: JudgedCase has no field for a
//                       partial failure, and a screener-only verdict passed off as confirmed would be
//                       a silent downgrade. The error names the screener's verdict so it is not lost.
//   both                both answer (in parallel) and are cross-confirmed, the second backend in the
//                       confirmer's place. Either failing fails the case.
//
// The cache key covers the policy and every backend/model it names, so changing any of them
// re-judges every case; in visual mode also the mode, the capture's key and the tiles attached.
import { cacheKey, type BackendId, type FailedCase, type JudgedCase, type JudgedIssue, type JudgeResult, type Opinion, type Resolution } from "./cache";
import { describeSpec, type BackendSpec, type JudgeBackend } from "./backends/types";
import { askOpinion, mergeFactsOf, type OpinionFailure } from "./judge-case";
import { crossConfirm } from "./merge";
import { RUBRIC_VERSION, TEXT_RUBRIC_VERSION, VERDICTS, type PromptInput, type Verdict } from "./rubric";
import { layerVerdicts, overallVerdict, SCORING_VERSION, type LayerVerdicts } from "./verdict";
import { DEFAULT_MAX_IMAGES, planImages, renderSummary, visualKeyPart } from "./visual";

export type PolicyId = Resolution["policy"];
export type EffectivePolicy =
  | { policy: "single"; judge: BackendSpec }
  | { policy: "screen-then-confirm"; screen: BackendSpec; confirm: BackendSpec; escalateOn: readonly Verdict[] }
  | { policy: "both"; backends: readonly [BackendSpec, BackendSpec] };

const POLICIES: readonly PolicyId[] = ["single", "screen-then-confirm", "both"];
const BACKENDS: readonly BackendId[] = ["codex", "claude"];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseSpec(value: unknown, where: string): BackendSpec {
  if (!isRecord(value) || typeof value.backend !== "string" || !(BACKENDS as readonly string[]).includes(value.backend) || typeof value.model !== "string" || !value.model) throw new Error(`JUDGE_POLICY ${where} is not a { backend: codex|claude, model } pair: ${JSON.stringify(value)}`);
  return { backend: value.backend as BackendId, model: value.model };
}

/** The policy run.mjs resolved (policy-config.mjs), read back from the JUDGE_POLICY environment variable. */
export function parseEffectivePolicy(json: string): EffectivePolicy {
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch (error) { throw new Error(`JUDGE_POLICY is not JSON (${error instanceof Error ? error.message : String(error)}); run the judge through run.mjs`); }
  if (!isRecord(parsed) || typeof parsed.policy !== "string" || !(POLICIES as readonly string[]).includes(parsed.policy)) throw new Error(`JUDGE_POLICY.policy must be one of ${POLICIES.join("|")}: ${json}`);
  switch (parsed.policy as PolicyId) {
    case "single": return { policy: "single", judge: parseSpec(parsed.judge, "judge") };
    case "screen-then-confirm": {
      const escalateOn = parsed.escalateOn;
      if (!Array.isArray(escalateOn) || escalateOn.length === 0 || escalateOn.some((verdict) => !(VERDICTS as readonly string[]).includes(verdict))) throw new Error(`JUDGE_POLICY.escalateOn must be a non-empty list from ${VERDICTS.join("|")}: ${json}`);
      if (parsed.escalateOnMajorIssue !== undefined) throw new Error(`JUDGE_POLICY.escalateOnMajorIssue is gone since rubric v6 (any valid major issue makes the verdict MAJOR); resolve the policy with the current policy-config.mjs: ${json}`);
      return { policy: "screen-then-confirm", screen: parseSpec(parsed.screen, "screen"), confirm: parseSpec(parsed.confirm, "confirm"), escalateOn: escalateOn as Verdict[] };
    }
    case "both": {
      if (!Array.isArray(parsed.backends) || parsed.backends.length !== 2) throw new Error(`JUDGE_POLICY.backends must name two backends: ${json}`);
      return { policy: "both", backends: [parseSpec(parsed.backends[0], "backends[0]"), parseSpec(parsed.backends[1], "backends[1]")] };
    }
  }
}

/** The part of the cache key that names the judge: the policy and every backend/model it uses. */
export function policyKey(effective: EffectivePolicy): string {
  switch (effective.policy) {
    case "single": return `single ${describeSpec(effective.judge)}`;
    case "screen-then-confirm": return `screen-then-confirm ${describeSpec(effective.screen)} > ${describeSpec(effective.confirm)} on ${[...effective.escalateOn].sort().join(",")}`;
    case "both": return `both ${effective.backends.map(describeSpec).join(" + ")}`;
  }
}

/** The backend/model pairs a policy will call, screen first. */
export function policyBackends(effective: EffectivePolicy): BackendSpec[] {
  switch (effective.policy) {
    case "single": return [effective.judge];
    case "screen-then-confirm": return [effective.screen, effective.confirm];
    case "both": return [...effective.backends];
  }
}

export interface JudgeCaseOptions {
  policy: EffectivePolicy;
  /** Builds (or, in tests, fakes) the backend for a spec; called once per opinion. */
  backend: (spec: BackendSpec) => JudgeBackend;
  timeoutMs: number;
  /** Images per call in visual mode (config.json maxImages). */
  maxImages?: number;
  now?: () => Date;
}

/**
 * The case's cache key. Text mode: exactly the key the text judge always wrote (text rubric version,
 * policy), so its results stay cached. Visual mode: the visual rubric version, the policy, and the
 * mode, the capture's key and the tile files attached.
 */
export function caseKey(input: PromptInput, policy: EffectivePolicy, maxImages = DEFAULT_MAX_IMAGES, rubricVersion?: string): string {
  if (!input.visual) return cacheKey(input.source, input.extracted, rubricVersion ?? TEXT_RUBRIC_VERSION, policyKey(policy));
  return cacheKey(input.source, input.extracted, rubricVersion ?? RUBRIC_VERSION, `${policyKey(policy)} ${visualKeyPart(input.visual, planImages(input.visual, maxImages))}`);
}

export interface Resolved { opinions: Opinion[]; final: Opinion; issues: JudgedIssue[]; layers: LayerVerdicts; verdict: Verdict; resolution: Resolution }
type Outcome = { ok: true; resolved: Resolved } | { ok: false; failure: OpinionFailure; error: string; opinions: Opinion[] };

const failed = (failure: OpinionFailure, error: string, opinions: Opinion[] = []): Outcome => ({ ok: false, failure, error, opinions });
/** The layers askOpinion computed; an opinion without them is a programming error, never a PASS. */
function layersOf(opinion: Opinion): LayerVerdicts {
  if (!opinion.layers) throw new Error(`${opinion.backend}/${opinion.model} opinion has no layer verdicts`);
  return opinion.layers;
}
/** The case decided by one opinion: its issues and verdicts. */
const decided = (opinion: Opinion, policy: PolicyId): Outcome => ({ ok: true, resolved: { opinions: [opinion], final: opinion, issues: opinion.issues, layers: layersOf(opinion), verdict: opinion.verdict, resolution: { policy, from: opinion.backend, disputed: false } } });

/** Two opinions cross-confirmed: the merged issue list decides; the confirmer gives the summary and the model named on the case. */
function merged(input: PromptInput, screen: Opinion, confirm: Opinion, policy: PolicyId): Outcome {
  const issues = crossConfirm(screen.issues, confirm.issues, mergeFactsOf(input));
  const layers = layerVerdicts(issues, input.visual !== undefined);
  return { ok: true, resolved: { opinions: [screen, confirm], final: confirm, issues, layers, verdict: overallVerdict(layers), resolution: { policy, from: "merged", disputed: screen.verdict !== confirm.verdict } } };
}

/** The case's issues and verdicts from the opinions gathered: one decides alone; two are cross-confirmed (screen first). Pure: --rescore calls it on stored opinions. */
export function resolveOpinions(input: PromptInput, opinions: readonly Opinion[], policy: PolicyId): Resolved {
  if (opinions.length === 1) return (decided(opinions[0]!, policy) as Extract<Outcome, { ok: true }>).resolved;
  if (opinions.length === 2) return (merged(input, opinions[0]!, opinions[1]!, policy) as Extract<Outcome, { ok: true }>).resolved;
  throw new Error(`a case has one or two opinions, not ${opinions.length}`);
}

async function judgeUnderPolicy(input: PromptInput, { policy, backend, timeoutMs, maxImages = DEFAULT_MAX_IMAGES }: JudgeCaseOptions): Promise<Outcome> {
  const ask = (spec: BackendSpec) => askOpinion(backend(spec), input, timeoutMs, maxImages);
  switch (policy.policy) {
    case "single": {
      const outcome = await ask(policy.judge);
      if (!outcome.ok) return failed(outcome.failure, `${describeSpec(policy.judge)}: ${outcome.failure.error}`);
      return decided(outcome.opinion, "single");
    }
    case "screen-then-confirm": {
      const screen = await ask(policy.screen);
      if (!screen.ok) return failed(screen.failure, `screener ${describeSpec(policy.screen)}: ${screen.failure.error}`);
      if (!policy.escalateOn.includes(screen.opinion.verdict)) return decided(screen.opinion, "screen-then-confirm");
      const confirm = await ask(policy.confirm);
      if (!confirm.ok) return failed(confirm.failure, `confirmer ${describeSpec(policy.confirm)} failed after screener ${describeSpec(policy.screen)} said ${screen.opinion.verdict}: ${confirm.failure.error}`, [screen.opinion]);
      return merged(input, screen.opinion, confirm.opinion, "screen-then-confirm");
    }
    case "both": {
      const [first, second] = await Promise.all(policy.backends.map(ask));
      if (!first.ok) return failed(first.failure, `${describeSpec(policy.backends[0])}: ${first.failure.error}${second.ok ? ` (${describeSpec(policy.backends[1])} said ${second.opinion.verdict})` : `; ${describeSpec(policy.backends[1])}: ${second.failure.error}`}`, second.ok ? [second.opinion] : []);
      if (!second.ok) return failed(second.failure, `${describeSpec(policy.backends[1])}: ${second.failure.error} (${describeSpec(policy.backends[0])} said ${first.opinion.verdict})`, [first.opinion]);
      return merged(input, first.opinion, second.opinion, "both");
    }
  }
}

const sumTokens = (opinions: readonly { tokens?: number }[]): number | undefined => {
  const counted = opinions.map((opinion) => opinion.tokens).filter((tokens): tokens is number => tokens !== undefined);
  return counted.length ? counted.reduce((sum, tokens) => sum + tokens, 0) : undefined;
};

/**
 * Judges one case under the policy. Never throws for a failed call or a bad answer: that is a
 * FailedCase. CaseBase.model/resolvedModel are the deciding (or failing) opinion's; tokens are the
 * sum over every opinion asked, i.e. what the case cost.
 */
export async function judgeCase(input: PromptInput, options: JudgeCaseOptions): Promise<JudgeResult> {
  const started = Date.now();
  const maxImages = options.maxImages ?? DEFAULT_MAX_IMAGES;
  const visual = input.visual ? { mode: "visual" as const, render: renderSummary(input.visual, planImages(input.visual, maxImages)) } : {};
  const base = { key: caseKey(input, options.policy, maxImages), slug: input.slug, rubricVersion: input.visual ? RUBRIC_VERSION : TEXT_RUBRIC_VERSION, truncated: input.truncated.source || input.truncated.extracted, ...visual };
  const stamp = () => ({ wallMs: Date.now() - started, judgedAt: (options.now ?? (() => new Date()))().toISOString() });
  const outcome = await judgeUnderPolicy(input, options);
  if (!outcome.ok) {
    const { failure } = outcome;
    const tokens = sumTokens([...outcome.opinions, failure]);
    const result: FailedCase = { ...base, model: failure.model, ...(failure.resolvedModel ? { resolvedModel: failure.resolvedModel } : {}), ...(tokens !== undefined ? { tokens } : {}), ...stamp(), error: outcome.error, ...(failure.rawAnswer !== undefined ? { rawAnswer: failure.rawAnswer } : {}) };
    return result;
  }
  const { opinions, final, issues, layers, verdict, resolution } = outcome.resolved;
  const tokens = sumTokens(opinions);
  const stamped = stamp();
  const result: JudgedCase = { ...base, model: final.model, ...(final.resolvedModel ? { resolvedModel: final.resolvedModel } : {}), ...(tokens !== undefined ? { tokens } : {}), ...stamped, scoringVersion: SCORING_VERSION, scoredAt: stamped.judgedAt, verdict, layers, issues, summary: final.summary, opinions, resolution };
  return result;
}
