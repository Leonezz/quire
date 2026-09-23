// How a case is judged under a policy: which backends are asked, in what order, and how their
// opinions fold into the case's verdict. Pure apart from the backends it is handed.
//
//   single              one opinion; it is the verdict.
//   screen-then-confirm the screener answers first. PASS (or any verdict outside escalateOn) is
//                       final. Otherwise the confirmer answers and its opinion is final; `disputed`
//                       when the two verdicts differ. A failed screener fails the case. A failed
//                       confirmer also fails the case: JudgedCase has no field for a partial
//                       failure, and a screener-only verdict passed off as confirmed would be a
//                       silent downgrade. The error names the screener's verdict so it is not lost.
//   both                both answer (in parallel). The more severe verdict's opinion is final
//                       (MAJOR > MINOR > PASS; the first backend on a tie), its issues joined with
//                       the other's (deduped by kind + evidence); `disputed` when verdicts differ.
//                       Either failing fails the case.
//
// The cache key covers the policy and every backend/model it names, so changing any of them
// re-judges every case.
import { cacheKey, type BackendId, type FailedCase, type JudgedCase, type JudgedIssue, type JudgeResult, type Opinion, type Resolution } from "./cache";
import { describeSpec, type BackendSpec, type JudgeBackend } from "./backends/types";
import { askOpinion, type OpinionFailure } from "./judge-case";
import { RUBRIC_VERSION, VERDICTS, type PromptInput, type Verdict } from "./rubric";

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
  now?: () => Date;
}

const RANK: Record<Verdict, number> = { PASS: 0, MINOR: 1, MAJOR: 2 };
const moreSevere = (a: Opinion, b: Opinion): Opinion => (RANK[b.verdict] > RANK[a.verdict] ? b : a);

/** a's issues, then those of b not already there (same kind and evidence). */
export function unionIssues(a: readonly JudgedIssue[], b: readonly JudgedIssue[]): JudgedIssue[] {
  const seen = new Set(a.map((issue) => `${issue.kind}\u0000${issue.evidence}`));
  return [...a, ...b.filter((issue) => !seen.has(`${issue.kind}\u0000${issue.evidence}`))];
}

interface Resolved { opinions: Opinion[]; final: Opinion; issues: JudgedIssue[]; resolution: Resolution }
type Outcome = { ok: true; resolved: Resolved } | { ok: false; failure: OpinionFailure; error: string; opinions: Opinion[] };

const failed = (failure: OpinionFailure, error: string, opinions: Opinion[] = []): Outcome => ({ ok: false, failure, error, opinions });
const resolved = (opinions: Opinion[], final: Opinion, issues: JudgedIssue[], policy: PolicyId, disputed: boolean): Outcome => ({ ok: true, resolved: { opinions, final, issues, resolution: { policy, from: final.backend, disputed } } });

async function judgeUnderPolicy(input: PromptInput, { policy, backend, timeoutMs }: JudgeCaseOptions): Promise<Outcome> {
  const ask = (spec: BackendSpec) => askOpinion(backend(spec), input, timeoutMs);
  switch (policy.policy) {
    case "single": {
      const outcome = await ask(policy.judge);
      if (!outcome.ok) return failed(outcome.failure, `${describeSpec(policy.judge)}: ${outcome.failure.error}`);
      return resolved([outcome.opinion], outcome.opinion, outcome.opinion.issues, "single", false);
    }
    case "screen-then-confirm": {
      const screen = await ask(policy.screen);
      if (!screen.ok) return failed(screen.failure, `screener ${describeSpec(policy.screen)}: ${screen.failure.error}`);
      if (!policy.escalateOn.includes(screen.opinion.verdict)) return resolved([screen.opinion], screen.opinion, screen.opinion.issues, "screen-then-confirm", false);
      const confirm = await ask(policy.confirm);
      if (!confirm.ok) return failed(confirm.failure, `confirmer ${describeSpec(policy.confirm)} failed after screener ${describeSpec(policy.screen)} said ${screen.opinion.verdict}: ${confirm.failure.error}`, [screen.opinion]);
      return resolved([screen.opinion, confirm.opinion], confirm.opinion, confirm.opinion.issues, "screen-then-confirm", screen.opinion.verdict !== confirm.opinion.verdict);
    }
    case "both": {
      const [first, second] = await Promise.all(policy.backends.map(ask));
      if (!first.ok) return failed(first.failure, `${describeSpec(policy.backends[0])}: ${first.failure.error}${second.ok ? ` (${describeSpec(policy.backends[1])} said ${second.opinion.verdict})` : `; ${describeSpec(policy.backends[1])}: ${second.failure.error}`}`, second.ok ? [second.opinion] : []);
      if (!second.ok) return failed(second.failure, `${describeSpec(policy.backends[1])}: ${second.failure.error} (${describeSpec(policy.backends[0])} said ${first.opinion.verdict})`, [first.opinion]);
      const final = moreSevere(first.opinion, second.opinion);
      const other = final === first.opinion ? second.opinion : first.opinion;
      return resolved([first.opinion, second.opinion], final, unionIssues(final.issues, other.issues), "both", first.opinion.verdict !== second.opinion.verdict);
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
  const base = { key: cacheKey(input.source, input.extracted, RUBRIC_VERSION, policyKey(options.policy)), slug: input.slug, rubricVersion: RUBRIC_VERSION, truncated: input.truncated.source || input.truncated.extracted };
  const stamp = () => ({ wallMs: Date.now() - started, judgedAt: (options.now ?? (() => new Date()))().toISOString() });
  const outcome = await judgeUnderPolicy(input, options);
  if (!outcome.ok) {
    const { failure } = outcome;
    const tokens = sumTokens([...outcome.opinions, failure]);
    const result: FailedCase = { ...base, model: failure.model, ...(failure.resolvedModel ? { resolvedModel: failure.resolvedModel } : {}), ...(tokens !== undefined ? { tokens } : {}), ...stamp(), error: outcome.error, ...(failure.rawAnswer !== undefined ? { rawAnswer: failure.rawAnswer } : {}) };
    return result;
  }
  const { opinions, final, issues, resolution } = outcome.resolved;
  const tokens = sumTokens(opinions);
  const result: JudgedCase = { ...base, model: final.model, ...(final.resolvedModel ? { resolvedModel: final.resolvedModel } : {}), ...(tokens !== undefined ? { tokens } : {}), ...stamp(), verdict: final.verdict, issues, summary: final.summary, opinions, resolution };
  return result;
}
