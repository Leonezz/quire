// The effective judge policy: eval/judge/config.json with the run's flags written over it. Plain JS
// so run.mjs resolves (and rejects) it before vitest boots; the harness parses the same object from
// JUDGE_POLICY. policy.ts declares the TypeScript shape (EffectivePolicy) this produces.
//
//   single              one backend: --backend / --model, else config.confirm (the authoritative judge)
//   screen-then-confirm config.screen judges first; a verdict in escalateOn is confirmed by config.confirm
//   both                config.screen and config.confirm both judge every case
// --screen-model / --confirm-model replace the models of screen-then-confirm and both.

export const POLICIES = ["single", "screen-then-confirm", "both"];
export const BACKENDS = ["codex", "claude"];
/** Kept in step with rubric.ts VERDICTS (policy.test.ts checks). */
export const VERDICTS = ["PASS", "MINOR", "MAJOR"];
const DEFAULT_ESCALATE_ON = ["MINOR", "MAJOR"];

/**
 * @typedef {{ backend: "codex" | "claude"; model: string }} BackendSpec
 * @typedef {{ policy?: unknown; screen?: unknown; confirm?: unknown; single?: unknown; escalateOn?: unknown; escalateOnMajorIssue?: unknown; concurrency?: unknown }} JudgeConfigFile
 * @typedef {{ policy?: string; backend?: string; model?: string; screenModel?: string; confirmModel?: string }} PolicyFlags
 * @typedef {{ policy: "single"; judge: BackendSpec }
 *   | { policy: "screen-then-confirm"; screen: BackendSpec; confirm: BackendSpec; escalateOn: readonly string[]; escalateOnMajorIssue: boolean }
 *   | { policy: "both"; backends: readonly [BackendSpec, BackendSpec] }} EffectivePolicy
 */

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value
 * @param {string} where
 * @param {string | undefined} modelOverride
 * @returns {BackendSpec}
 */
function backendSpec(value, where, modelOverride) {
  if (!isRecord(value)) throw new Error(`config.json ${where} must be { "backend": "codex"|"claude", "model": "..." }`);
  const backend = value.backend;
  if (typeof backend !== "string" || !BACKENDS.includes(backend)) throw new Error(`config.json ${where}.backend must be one of ${BACKENDS.join("|")}, got ${JSON.stringify(backend)}`);
  const model = modelOverride ?? value.model ?? "default";
  if (typeof model !== "string" || !model.trim()) throw new Error(`config.json ${where}.model must be a non-empty string, got ${JSON.stringify(model)}`);
  return { backend: /** @type {"codex" | "claude"} */ (backend), model: model.trim() };
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function escalateOn(value) {
  if (value === undefined) return [...DEFAULT_ESCALATE_ON];
  if (!Array.isArray(value) || value.length === 0 || value.some((verdict) => !VERDICTS.includes(verdict))) throw new Error(`config.json escalateOn must be a non-empty list from ${VERDICTS.join("|")}, got ${JSON.stringify(value)}`);
  return [...new Set(value)];
}

/**
 * @param {string | undefined} flag
 * @param {string} name
 * @param {string} policy
 * @param {string} applies
 */
function rejectFlag(flag, name, policy, applies) {
  if (flag !== undefined) throw new Error(`${name} applies to ${applies}, not to --policy ${policy}.`);
}

/**
 * config.json with the flags written over it; throws with what to fix when either is wrong.
 * @param {JudgeConfigFile} config
 * @param {PolicyFlags} [flags]
 * @returns {EffectivePolicy}
 */
export function resolvePolicy(config, flags = {}) {
  if (!isRecord(config)) throw new Error("config.json must be a JSON object");
  const policy = flags.policy ?? config.policy;
  if (typeof policy !== "string" || !POLICIES.includes(policy)) throw new Error(`Unknown policy ${JSON.stringify(policy)}: --policy takes ${POLICIES.join("|")} (config.json "policy" is the default).`);
  if (policy === "single") {
    rejectFlag(flags.screenModel, "--screen-model", policy, "screen-then-confirm and both");
    rejectFlag(flags.confirmModel, "--confirm-model", policy, "screen-then-confirm and both");
    if (flags.backend !== undefined && !BACKENDS.includes(flags.backend)) throw new Error(`--backend takes ${BACKENDS.join("|")}, got ${JSON.stringify(flags.backend)}`);
    const base = backendSpec(config.single ?? config.confirm, config.single ? "single" : "confirm", undefined);
    const backend = /** @type {"codex" | "claude"} */ (flags.backend ?? base.backend);
    // A model configured for another backend never carries over: --backend without --model runs that backend's default.
    const model = flags.model ?? (backend === base.backend ? base.model : "default");
    if (!model.trim()) throw new Error("--model needs a value.");
    return { policy, judge: { backend, model: model.trim() } };
  }
  rejectFlag(flags.backend, "--backend", policy, "single");
  rejectFlag(flags.model, "--model", policy, "single");
  const screen = backendSpec(config.screen, "screen", flags.screenModel);
  const confirm = backendSpec(config.confirm, "confirm", flags.confirmModel);
  if (policy === "screen-then-confirm") {
    if (config.escalateOnMajorIssue !== undefined && typeof config.escalateOnMajorIssue !== "boolean") throw new Error(`config.json escalateOnMajorIssue must be true or false, got ${JSON.stringify(config.escalateOnMajorIssue)}`);
    return { policy, screen, confirm, escalateOn: escalateOn(config.escalateOn), escalateOnMajorIssue: config.escalateOnMajorIssue ?? true };
  }
  return { policy: "both", backends: [screen, confirm] };
}

/** @param {BackendSpec} spec */
export const describeSpec = (spec) => `${spec.backend}/${spec.model}`;

/**
 * The backend/model pairs a policy will call, screen first.
 * @param {EffectivePolicy} effective
 * @returns {BackendSpec[]}
 */
export function backendsNeeded(effective) {
  switch (effective.policy) {
    case "single": return [effective.judge];
    case "screen-then-confirm": return [effective.screen, effective.confirm];
    case "both": return [...effective.backends];
  }
}

/**
 * One line for the run header and the report: "policy screen-then-confirm · screen claude/haiku · confirm codex/default (on MINOR, MAJOR)".
 * @param {EffectivePolicy} effective
 */
export function describePolicy(effective) {
  switch (effective.policy) {
    case "single": return `policy single · ${describeSpec(effective.judge)}`;
    case "screen-then-confirm": return `policy screen-then-confirm · screen ${describeSpec(effective.screen)} · confirm ${describeSpec(effective.confirm)} (on ${effective.escalateOn.join(", ")})`;
    case "both": return `policy both · ${effective.backends.map(describeSpec).join(" + ")}`;
  }
}

/**
 * The concurrency a run asked for: the flag, else config.json, else 3.
 * @param {JudgeConfigFile} config
 * @param {string | undefined} flag
 */
export function resolveConcurrency(config, flag) {
  const value = flag ?? (isRecord(config) ? config.concurrency : undefined);
  if (value === undefined) return 3;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) throw new Error(`concurrency must be a positive integer, got ${JSON.stringify(value)}`);
  return count;
}
