// Re-scoring (docs/design/eval-rubric.md §7): verdicts, validity and the merge are the program's, so a
// change to the program's rules needs no model call. A stored result's opinions keep each issue as the
// program normalized it, with the model's own layer and severity in originalLayer/originalSeverity;
// from those the issue as reported is rebuilt and scored again against the case's current inputs and
// capture facts, then the opinions are resolved again (one decides, two are cross-confirmed). The
// result keeps its key, judgedAt and model fields, so a later run under the same prompt still finds it
// cached. Pure.
import type { JudgedCase, JudgedIssue, Opinion } from "./cache";
import { scoreIssues, scoringContextOf } from "./judge-case";
import { caseKey, resolveOpinions, type EffectivePolicy, type PolicyId } from "./policy";
import { planImages, renderSummary } from "./visual";
import type { JudgeIssue, PromptInput } from "./rubric";
import { SCORING_VERSION } from "./verdict";

/** The issue as the model reported it: the program's normalization undone, its checks and merge origin dropped. */
export function rawIssueOf(issue: JudgedIssue): JudgeIssue {
  return {
    layer: issue.originalLayer ?? issue.layer,
    kind: issue.kind,
    severity: issue.originalSeverity ?? issue.severity,
    evidence: issue.evidence,
    note: issue.note,
    ...(issue.where !== undefined ? { where: issue.where } : {}),
    ...(issue.refs !== undefined ? { refs: issue.refs } : {}),
    ...(issue.subject !== undefined ? { subject: issue.subject } : {}),
  };
}

/** Why a stored result cannot be rescored, or undefined when it can: it needs one or two opinions scored by the v6 program (with layers) and a resolution. */
export function rescoreBlocker(result: JudgedCase): string | undefined {
  const opinions = result.opinions ?? [];
  if (opinions.length === 0) return "it has no stored opinions (judged before the hybrid judge); re-judge it";
  if (opinions.length > 2) return `it has ${opinions.length} opinions; a case has one or two`;
  if (opinions.some((opinion) => !opinion.layers)) return "its opinions were scored before rubric v6 (no layer verdicts); re-judge it";
  if (!result.resolution) return "it has no resolution; re-judge it";
  return undefined;
}

/**
 * Why a stored result's opinions do not fit the case as it is now, or undefined when they do: its key
 * is rebuilt from the current texts, policy and tiles with the prompt version and capture key it was
 * judged with. A re-capture (new capture key, same tiles) is fine: rescoring uses the current facts by
 * design; new texts, a new policy, or other tiles sent are not.
 */
export function inputsChanged(result: JudgedCase, input: PromptInput, policy: EffectivePolicy, maxImages: number): string | undefined {
  const judgedOn = input.visual && result.render ? { ...input, visual: { ...input.visual, manifestKey: result.render.manifestKey } } : input;
  if (input.visual && !result.render) return "it was judged without a render capture; re-judge it in visual mode";
  if (caseKey(judgedOn, policy, maxImages, result.rubricVersion) !== result.key) return "its texts, policy or the tiles sent changed since it was judged; re-judge it";
  return undefined;
}

/**
 * The result scored again from its stored opinions against `input` (the case's current texts and
 * capture facts); throws when rescoreBlocker says it cannot be. With `policy` the key and render
 * summary move to the current capture, so a later run under the same prompt finds it cached.
 */
export function rescoreCase(result: JudgedCase, input: PromptInput, maxImages: number, now: () => Date = () => new Date(), policy?: EffectivePolicy): JudgedCase {
  const blocker = rescoreBlocker(result);
  if (blocker) throw new Error(`cannot rescore ${result.slug}: ${blocker}`);
  const capture = policy && input.visual ? { key: caseKey(input, policy, maxImages, result.rubricVersion), render: renderSummary(input.visual, planImages(input.visual, maxImages)) } : {};
  const context = scoringContextOf(input, maxImages);
  const opinions: Opinion[] = (result.opinions ?? []).map((opinion) => ({ ...opinion, ...scoreIssues(opinion.issues.map(rawIssueOf), context) }));
  const resolvedUnder: PolicyId = result.resolution!.policy;
  const { issues, layers, verdict, resolution, final } = resolveOpinions(input, opinions, resolvedUnder);
  return { ...result, ...capture, verdict, layers, issues, summary: final.summary, opinions, resolution, scoringVersion: SCORING_VERSION, scoredAt: now().toISOString() };
}
