// The policy without any CLI: config + flags resolution, the cache key's sensitivity to the policy
// and its models, and judgeCase under single / screen-then-confirm / both with fake backends.
import { describe, expect, it } from "vitest";
import { BackendRunError, type BackendSpec, type JudgeBackend } from "./backends/types";
import { cacheKey, isJudged, type JudgedIssue } from "./cache";
import { backendsNeeded, describePolicy, resolveConcurrency, resolvePolicy, VERDICTS as CONFIG_VERDICTS } from "./policy-config.mjs";
import { judgeCase, parseEffectivePolicy, policyBackends, policyKey, unionIssues, type EffectivePolicy } from "./policy";
import { RUBRIC_VERSION, VERDICTS } from "./rubric";

const CONFIG = { policy: "screen-then-confirm", screen: { backend: "claude", model: "haiku" }, confirm: { backend: "codex", model: "default" }, escalateOn: ["MINOR", "MAJOR"], escalateOnMajorIssue: true, concurrency: 3 };
const SCREEN: EffectivePolicy = { policy: "screen-then-confirm", screen: { backend: "claude", model: "haiku" }, confirm: { backend: "codex", model: "default" }, escalateOn: ["MINOR", "MAJOR"], escalateOnMajorIssue: true };
const SINGLE: EffectivePolicy = { policy: "single", judge: { backend: "codex", model: "default" } };
const BOTH: EffectivePolicy = { policy: "both", backends: [{ backend: "claude", model: "haiku" }, { backend: "codex", model: "default" }] };

describe("resolvePolicy (config.json + flags)", () => {
  it("keeps the verdict vocabulary in step with rubric.ts", () => {
    expect(CONFIG_VERDICTS).toEqual([...VERDICTS]);
  });

  it("reads the default policy from config.json", () => {
    expect(resolvePolicy(CONFIG)).toEqual(SCREEN);
    expect(resolvePolicy({ ...CONFIG, escalateOn: undefined })).toEqual(SCREEN);
    expect(resolvePolicy({ ...CONFIG, escalateOn: ["MAJOR", "MAJOR"] })).toMatchObject({ escalateOn: ["MAJOR"] });
  });

  it("--policy single takes the confirmer unless --backend/--model say otherwise", () => {
    expect(resolvePolicy(CONFIG, { policy: "single" })).toEqual(SINGLE);
    expect(resolvePolicy(CONFIG, { policy: "single", model: "gpt-5.6" })).toEqual({ policy: "single", judge: { backend: "codex", model: "gpt-5.6" } });
    // Another backend never inherits a model configured for the confirmer's backend.
    expect(resolvePolicy({ ...CONFIG, confirm: { backend: "codex", model: "gpt-5.6" } }, { policy: "single", backend: "claude" })).toEqual({ policy: "single", judge: { backend: "claude", model: "default" } });
    expect(resolvePolicy(CONFIG, { policy: "single", backend: "claude", model: "sonnet" })).toEqual({ policy: "single", judge: { backend: "claude", model: "sonnet" } });
    expect(resolvePolicy({ ...CONFIG, single: { backend: "claude", model: "opus" } }, { policy: "single" })).toEqual({ policy: "single", judge: { backend: "claude", model: "opus" } });
  });

  it("--screen-model / --confirm-model replace the models of screen-then-confirm and both", () => {
    expect(resolvePolicy(CONFIG, { screenModel: "sonnet", confirmModel: "gpt-5.6" })).toEqual({ ...SCREEN, screen: { backend: "claude", model: "sonnet" }, confirm: { backend: "codex", model: "gpt-5.6" } });
    expect(resolvePolicy(CONFIG, { policy: "both" })).toEqual(BOTH);
    expect(resolvePolicy(CONFIG, { policy: "both", confirmModel: "o3" })).toEqual({ policy: "both", backends: [{ backend: "claude", model: "haiku" }, { backend: "codex", model: "o3" }] });
  });

  it.each([
    ["an unknown policy", CONFIG, { policy: "triple" }, /Unknown policy "triple"/],
    ["no policy anywhere", { ...CONFIG, policy: undefined }, {}, /Unknown policy undefined/],
    ["--backend outside single", CONFIG, { backend: "claude" }, /--backend applies to single/],
    ["--model outside single", CONFIG, { model: "x" }, /--model applies to single/],
    ["--screen-model with single", CONFIG, { policy: "single", screenModel: "x" }, /--screen-model applies to screen-then-confirm and both/],
    ["--confirm-model with single", CONFIG, { policy: "single", confirmModel: "x" }, /--confirm-model applies/],
    ["an unknown backend flag", CONFIG, { policy: "single", backend: "gemini" }, /--backend takes codex\|claude/],
    ["an unknown backend in config", { ...CONFIG, screen: { backend: "gemini" } }, {}, /screen.backend must be one of codex\|claude/],
    ["a missing confirm entry", { ...CONFIG, confirm: undefined }, {}, /confirm must be/],
    ["an empty model", { ...CONFIG, screen: { backend: "claude", model: " " } }, {}, /screen.model must be a non-empty string/],
    ["a bad escalateOn", { ...CONFIG, escalateOn: ["FAIL"] }, {}, /escalateOn must be a non-empty list/],
    ["an empty escalateOn", { ...CONFIG, escalateOn: [] }, {}, /escalateOn must be a non-empty list/],
    ["a non-object config", "nope", {}, /must be a JSON object/],
  ])("rejects %s with what to fix", (_label, config, flags, message) => {
    expect(() => resolvePolicy(config as never, flags as never)).toThrow(message);
  });

  it("describes the effective policy in one line and lists the backends it needs, screen first", () => {
    expect(describePolicy(SCREEN)).toBe("policy screen-then-confirm · screen claude/haiku · confirm codex/default (on MINOR, MAJOR)");
    expect(describePolicy(SINGLE)).toBe("policy single · codex/default");
    expect(describePolicy(BOTH)).toBe("policy both · claude/haiku + codex/default");
    expect(backendsNeeded(SCREEN)).toEqual([SCREEN.screen, SCREEN.confirm]);
    expect(backendsNeeded(SINGLE)).toEqual([SINGLE.judge]);
    expect(policyBackends(BOTH)).toEqual([...BOTH.backends]);
  });

  it("resolves concurrency from the flag, then config.json, then 3", () => {
    expect(resolveConcurrency(CONFIG, undefined)).toBe(3);
    expect(resolveConcurrency({ ...CONFIG, concurrency: 5 }, undefined)).toBe(5);
    expect(resolveConcurrency(CONFIG, "2")).toBe(2);
    expect(resolveConcurrency({}, undefined)).toBe(3);
    expect(() => resolveConcurrency(CONFIG, "0")).toThrow(/positive integer/);
  });
});

describe("parseEffectivePolicy (JUDGE_POLICY)", () => {
  it("round-trips what resolvePolicy produced", () => {
    for (const effective of [SCREEN, SINGLE, BOTH]) expect(parseEffectivePolicy(JSON.stringify(effective))).toEqual(effective);
  });

  it.each([
    ["not JSON", "{", /not JSON/],
    ["an unknown policy", JSON.stringify({ policy: "x" }), /policy must be one of/],
    ["a bad spec", JSON.stringify({ policy: "single", judge: { backend: "gemini", model: "x" } }), /judge is not a/],
    ["a bad escalateOn", JSON.stringify({ ...SCREEN, escalateOn: ["NOPE"] }), /escalateOn must be/],
    ["one backend for both", JSON.stringify({ policy: "both", backends: [SINGLE.judge] }), /must name two backends/],
  ])("rejects %s", (_label, json, message) => {
    expect(() => parseEffectivePolicy(json)).toThrow(message);
  });
});

describe("policyKey", () => {
  it("names the policy and every backend/model, so any change re-judges", () => {
    const key = (effective: EffectivePolicy) => cacheKey("src", "md", RUBRIC_VERSION, policyKey(effective));
    expect(policyKey(SCREEN)).toBe("screen-then-confirm claude/haiku > codex/default on MAJOR,MINOR,major-issue");
    expect(policyKey({ ...SCREEN, escalateOnMajorIssue: false })).toBe("screen-then-confirm claude/haiku > codex/default on MAJOR,MINOR");
    expect(policyKey(SINGLE)).toBe("single codex/default");
    expect(policyKey(BOTH)).toBe("both claude/haiku + codex/default");
    const base = key(SCREEN);
    expect(key({ ...SCREEN })).toBe(base);
    expect(key({ ...SCREEN, escalateOn: ["MAJOR", "MINOR"] })).toBe(base);
    expect(key({ ...SCREEN, escalateOn: ["MAJOR"] })).not.toBe(base);
    expect(key({ ...SCREEN, escalateOnMajorIssue: false })).not.toBe(base);
    expect(key({ ...SCREEN, screen: { backend: "claude", model: "sonnet" } })).not.toBe(base);
    expect(key({ ...SCREEN, confirm: { backend: "codex", model: "gpt-5.6" } })).not.toBe(base);
    expect(key({ ...SCREEN, screen: { backend: "codex", model: "haiku" } })).not.toBe(base);
    expect(key(BOTH)).not.toBe(base);
    expect(key(SINGLE)).not.toBe(base);
    expect(key({ policy: "single", judge: { backend: "claude", model: "default" } })).not.toBe(key(SINGLE));
    // The single-Codex key differs from the pre-hybrid key ("default"), so old results are re-judged once.
    expect(key(SINGLE)).not.toBe(cacheKey("src", "md", RUBRIC_VERSION, "default"));
  });
});

describe("unionIssues", () => {
  const issue = (kind: JudgedIssue["kind"], evidence: string, note = "n"): JudgedIssue => ({ kind, severity: "minor", evidence, note, verified: true });
  it("keeps the first list's order and adds the second's issues not already there by kind + evidence", () => {
    expect(unionIssues([issue("layout", "a"), issue("tables", "b")], [issue("layout", "a", "other note"), issue("layout", "c"), issue("tables", "b")])).toEqual([issue("layout", "a"), issue("tables", "b"), issue("layout", "c")]);
    expect(unionIssues([], [])).toEqual([]);
  });
});

describe("judgeCase under a policy", () => {
  const input = { slug: "s", url: "https://x.test/p", source: "# Title\n\nBy Ada\n\nBody text.", extracted: "# Title\n\nBody text.", truncated: { source: false, extracted: false } };
  type Answer = { verdict: string; issues: { kind: string; severity: string; evidence: string; note: string }[]; summary: string };
  const answer = (verdict: string, issues: Answer["issues"] = []): Answer => ({ verdict, issues, summary: `${verdict} says` });
  const issue = (kind: string, evidence: string) => ({ kind, severity: "minor", evidence, note: "n" });
  type Script = Record<string, (() => Promise<Answer | string>) | undefined>;

  /** Fake backends keyed "backend/model": each call returns the scripted answer (or throws) and is counted. */
  function fakes(script: Script) {
    const calls: string[] = [];
    const backend = (spec: BackendSpec): JudgeBackend => ({
      id: spec.backend,
      model: spec.model,
      preflight: async () => {},
      run: async () => {
        const label = `${spec.backend}/${spec.model}`;
        calls.push(label);
        const scripted = script[label];
        if (!scripted) throw new Error(`no script for ${label}`);
        const result = await scripted();
        return { raw: typeof result === "string" ? result : JSON.stringify(result), tokens: 100, ...(spec.backend === "claude" ? { costUsd: 0.01 } : {}), resolvedModel: `${spec.model}-resolved` };
      },
    });
    return { calls, backend };
  }
  const options = (policy: EffectivePolicy, script: Script) => { const { calls, backend } = fakes(script); return { calls, options: { policy, backend, timeoutMs: 1000, now: () => new Date("2026-09-23T12:00:00Z") } }; };

  it("single: one call, that opinion is the verdict, key covers the policy", async () => {
    const { calls, options: opts } = options(SINGLE, { "codex/default": async () => answer("MINOR", [issue("metadata", "By Ada")]) });
    const result = await judgeCase(input, opts);
    expect(calls).toEqual(["codex/default"]);
    if (!isJudged(result)) throw new Error(result.error);
    expect(result).toMatchObject({ slug: "s", model: "default", resolvedModel: "default-resolved", tokens: 100, verdict: "MINOR", summary: "MINOR says", judgedAt: "2026-09-23T12:00:00.000Z", resolution: { policy: "single", from: "codex", disputed: false } });
    expect(result.key).toBe(cacheKey(input.source, input.extracted, RUBRIC_VERSION, policyKey(SINGLE)));
    expect(result.opinions).toHaveLength(1);
    expect(result.opinions?.[0]).toMatchObject({ backend: "codex", model: "default", verdict: "MINOR", tokens: 100 });
    expect(result.issues[0]).toMatchObject({ kind: "metadata", verified: true });
  });

  it("single: a failed call is a FailedCase naming the backend", async () => {
    const { options: opts } = options(SINGLE, { "codex/default": async () => { throw new BackendRunError("codex exec exited with 1: boom", { tokens: 5 }); } });
    const result = await judgeCase(input, opts);
    expect(isJudged(result)).toBe(false);
    if (isJudged(result)) throw new Error("expected a failure");
    expect(result).toMatchObject({ error: "codex/default: codex exec exited with 1: boom", model: "default", tokens: 5 });
  });

  it("screen-then-confirm: a screener PASS is final and the confirmer is never called", async () => {
    const { calls, options: opts } = options(SCREEN, { "claude/haiku": async () => answer("PASS"), "codex/default": async () => { throw new Error("must not be called"); } });
    const result = await judgeCase(input, opts);
    expect(calls).toEqual(["claude/haiku"]);
    if (!isJudged(result)) throw new Error(result.error);
    expect(result).toMatchObject({ verdict: "PASS", model: "haiku", tokens: 100, resolution: { policy: "screen-then-confirm", from: "claude", disputed: false } });
    expect(result.opinions?.map((opinion) => opinion.backend)).toEqual(["claude"]);
    expect(result.opinions?.[0]?.costUsd).toBe(0.01);
  });

  it("screen-then-confirm: a screener MINOR is confirmed; the confirmer's opinion is final and a differing verdict is disputed", async () => {
    const { calls, options: opts } = options(SCREEN, { "claude/haiku": async () => answer("MINOR", [issue("layout", "Body text.")]), "codex/default": async () => answer("MAJOR", [issue("missing_content", "By Ada")]) });
    const result = await judgeCase(input, opts);
    expect(calls).toEqual(["claude/haiku", "codex/default"]);
    if (!isJudged(result)) throw new Error(result.error);
    expect(result).toMatchObject({ verdict: "MAJOR", summary: "MAJOR says", model: "default", resolvedModel: "default-resolved", tokens: 200, resolution: { policy: "screen-then-confirm", from: "codex", disputed: true } });
    expect(result.issues.map((item) => item.kind)).toEqual(["missing_content"]);
    expect(result.opinions?.map((opinion) => `${opinion.backend}:${opinion.verdict}`)).toEqual(["claude:MINOR", "codex:MAJOR"]);
  });

  it("screen-then-confirm: agreeing verdicts are not disputed, and escalateOn decides what escalates", async () => {
    const agree = options(SCREEN, { "claude/haiku": async () => answer("MAJOR"), "codex/default": async () => answer("MAJOR") });
    const result = await judgeCase(input, agree.options);
    if (!isJudged(result)) throw new Error(result.error);
    expect(result.resolution).toEqual({ policy: "screen-then-confirm", from: "codex", disputed: false });
    const majorOnly = options({ ...SCREEN, escalateOn: ["MAJOR"] }, { "claude/haiku": async () => answer("MINOR"), "codex/default": async () => { throw new Error("must not be called"); } });
    const minor = await judgeCase(input, majorOnly.options);
    expect(majorOnly.calls).toEqual(["claude/haiku"]);
    if (!isJudged(minor)) throw new Error(minor.error);
    expect(minor.resolution?.from).toBe("claude");
  });

  it("screen-then-confirm: a PASS that lists a major issue escalates too (unless escalateOnMajorIssue is off)", async () => {
    const majorIssue = { kind: "missing_content", severity: "major", evidence: "Body text.", note: "the ending is gone" };
    const strict = options(SCREEN, { "claude/haiku": async () => answer("PASS", [majorIssue]), "codex/default": async () => answer("MAJOR", [majorIssue]) });
    const result = await judgeCase(input, strict.options);
    expect(strict.calls).toEqual(["claude/haiku", "codex/default"]);
    if (!isJudged(result)) throw new Error(result.error);
    expect(result.verdict).toBe("MAJOR");
    expect(result.resolution).toEqual({ policy: "screen-then-confirm", from: "codex", disputed: true });
    const lenient = options({ ...SCREEN, escalateOnMajorIssue: false }, { "claude/haiku": async () => answer("PASS", [majorIssue]), "codex/default": async () => { throw new Error("must not be called"); } });
    const kept = await judgeCase(input, lenient.options);
    expect(lenient.calls).toEqual(["claude/haiku"]);
    if (!isJudged(kept)) throw new Error(kept.error);
    expect(kept.verdict).toBe("PASS");
  });

  it("screen-then-confirm: a failed screener fails the case before any confirmation", async () => {
    const { calls, options: opts } = options(SCREEN, { "claude/haiku": async () => { throw new BackendRunError("claude -p reported an error: Failed to authenticate"); }, "codex/default": async () => answer("PASS") });
    const result = await judgeCase(input, opts);
    expect(calls).toEqual(["claude/haiku"]);
    expect(isJudged(result)).toBe(false);
    if (!isJudged(result)) expect(result.error).toBe("screener claude/haiku: claude -p reported an error: Failed to authenticate");
  });

  it("screen-then-confirm: a failed confirmer fails the case, keeping the screener's verdict in the error and its tokens in the total", async () => {
    const { options: opts } = options(SCREEN, { "claude/haiku": async () => answer("MINOR"), "codex/default": async () => '{"verdict":"PASS"}' });
    const result = await judgeCase(input, opts);
    expect(isJudged(result)).toBe(false);
    if (isJudged(result)) throw new Error("expected a failure");
    expect(result.error).toMatch(/^confirmer codex\/default failed after screener claude\/haiku said MINOR: judge answer rejected/);
    expect(result).toMatchObject({ model: "default", tokens: 200, rawAnswer: '{"verdict":"PASS"}' });
  });

  it("both: both are always called; the more severe verdict wins, issues are the union, disagreement is disputed", async () => {
    const { calls, options: opts } = options(BOTH, { "claude/haiku": async () => answer("MINOR", [issue("layout", "Body text."), issue("metadata", "By Ada")]), "codex/default": async () => answer("MAJOR", [issue("missing_content", "By Ada"), issue("layout", "Body text.")]) });
    const result = await judgeCase(input, opts);
    expect(calls.sort()).toEqual(["claude/haiku", "codex/default"]);
    if (!isJudged(result)) throw new Error(result.error);
    expect(result).toMatchObject({ verdict: "MAJOR", summary: "MAJOR says", model: "default", tokens: 200, resolution: { policy: "both", from: "codex", disputed: true } });
    expect(result.issues.map((item) => `${item.kind}:${item.evidence}`)).toEqual(["missing_content:By Ada", "layout:Body text.", "metadata:By Ada"]);
    expect(result.opinions).toHaveLength(2);
  });

  it("both: on a tie the first backend decides and nothing is disputed", async () => {
    const { options: opts } = options(BOTH, { "claude/haiku": async () => answer("PASS"), "codex/default": async () => answer("PASS") });
    const result = await judgeCase(input, opts);
    if (!isJudged(result)) throw new Error(result.error);
    expect(result.resolution).toEqual({ policy: "both", from: "claude", disputed: false });
    expect(result.model).toBe("haiku");
  });

  it("both: either failing fails the case and says what the other said", async () => {
    const second = options(BOTH, { "claude/haiku": async () => answer("PASS"), "codex/default": async () => { throw new BackendRunError("codex exec exceeded 1000 ms and was killed"); } });
    const one = await judgeCase(input, second.options);
    if (isJudged(one)) throw new Error("expected a failure");
    expect(one.error).toBe("codex/default: codex exec exceeded 1000 ms and was killed (claude/haiku said PASS)");
    const first = options(BOTH, { "claude/haiku": async () => "not json", "codex/default": async () => answer("MINOR") });
    const other = await judgeCase(input, first.options);
    if (isJudged(other)) throw new Error("expected a failure");
    expect(other.error).toMatch(/^claude\/haiku: judge answer rejected: not JSON .* \(codex\/default said MINOR\)$/);
    const neither = options(BOTH, { "claude/haiku": async () => "not json", "codex/default": async () => { throw new BackendRunError("boom"); } });
    const none = await judgeCase(input, neither.options);
    if (isJudged(none)) throw new Error("expected a failure");
    expect(none.error).toMatch(/^claude\/haiku: judge answer rejected: .*; codex\/default: boom$/);
  });
});
