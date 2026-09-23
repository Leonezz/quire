// Unit tests for the judge's pure parts: cache key, answer parsing, baseline comparison, report, the
// Codex backend with an injected runner, and that the kind vocabulary is the app's. The policy flow
// is in policy.test.ts, the Claude backend in backends/claude.test.ts. No CLI is spawned here.
import { describe, expect, it } from "vitest";
import { RENDERING_PROBLEM_KINDS } from "../../apps/desktop/src/shared/contracts";
import { compareToBaseline, describeDelta, updateBaseline, type Baseline } from "./baseline";
import { cacheKey, isJudged, type JudgedCase, type JudgeResult, type Opinion } from "./cache";
import { codexBackend, parseResolvedModel, parseTokens, type CodexCall, type CodexRun, type CodexRunner } from "./backends/codex";
import { BackendRunError } from "./backends/types";
import { askOpinion } from "./judge-case";
import { extractedMarkdown, truncateInput } from "./inputs";
import { renderReport } from "./report";
import { ANSWER_SCHEMA, AnswerFormatError, EVIDENCE_MAX_CHARS, PROBLEM_KINDS, RUBRIC_VERSION, buildPrompt, evidenceOccurs, parseAnswer } from "./rubric";

const judged = (slug: string, verdict: JudgedCase["verdict"], kinds: string[] = [], extra: Partial<JudgedCase> = {}): JudgedCase => ({
  key: `k-${slug}`, slug, model: "default", rubricVersion: RUBRIC_VERSION, truncated: false, verdict,
  issues: kinds.map((kind) => ({ kind: kind as JudgedCase["issues"][number]["kind"], severity: "minor", evidence: "q", note: "n", verified: true })),
  summary: `${slug} summary`, wallMs: 10, judgedAt: "2026-09-23T00:00:00.000Z", ...extra,
});
const failed = (slug: string): JudgeResult => ({ key: `k-${slug}`, slug, model: "default", rubricVersion: RUBRIC_VERSION, truncated: false, error: "codex exec exited with 1: boom", wallMs: 5, judgedAt: "2026-09-23T00:00:00.000Z" });
const goodAnswer = { verdict: "MINOR", issues: [{ kind: "metadata", severity: "minor", evidence: "By Ada", note: "byline missing" }], summary: "Reads well apart from the byline." };

describe("kind vocabulary", () => {
  it("is the app's RenderingProblemKind list, verbatim, in the prompt and the schema", () => {
    expect(PROBLEM_KINDS).toEqual(RENDERING_PROBLEM_KINDS);
    expect(ANSWER_SCHEMA.properties.issues.items.properties.kind.enum).toEqual([...RENDERING_PROBLEM_KINDS]);
    const prompt = buildPrompt({ slug: "s", url: "https://x.test/", source: "", extracted: "", truncated: { source: false, extracted: false } });
    for (const kind of RENDERING_PROBLEM_KINDS) expect(prompt).toContain(`- ${kind}:`);
  });
});

describe("cacheKey", () => {
  it("changes with any input, the rubric version or the model, and is stable otherwise", () => {
    const base = cacheKey("src", "md", "v1", "m");
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey("src", "md", "v1", "m")).toBe(base);
    expect(cacheKey("src2", "md", "v1", "m")).not.toBe(base);
    expect(cacheKey("src", "md2", "v1", "m")).not.toBe(base);
    expect(cacheKey("src", "md", "v2", "m")).not.toBe(base);
    expect(cacheKey("src", "md", "v1", "m2")).not.toBe(base);
    // The fields are delimited: moving characters across the boundary is a different key.
    expect(cacheKey("ab", "c", "v", "m")).not.toBe(cacheKey("a", "bc", "v", "m"));
  });
});

describe("parseAnswer", () => {
  it("accepts a well-formed answer and clips over-long evidence", () => {
    const answer = parseAnswer(JSON.stringify({ ...goodAnswer, issues: [{ ...goodAnswer.issues[0], evidence: "x".repeat(EVIDENCE_MAX_CHARS + 50) }] }));
    expect(answer.verdict).toBe("MINOR");
    expect(answer.issues[0]?.evidence).toHaveLength(EVIDENCE_MAX_CHARS);
    expect(parseAnswer(JSON.stringify({ verdict: "PASS", issues: [], summary: "Clean." })).issues).toEqual([]);
  });

  it.each([
    ["not JSON", "verdict: PASS"],
    ["an array", "[]"],
    ["an unknown verdict", JSON.stringify({ ...goodAnswer, verdict: "FAIL" })],
    ["an unknown kind", JSON.stringify({ ...goodAnswer, issues: [{ ...goodAnswer.issues[0], kind: "typo" }] })],
    ["an unknown severity", JSON.stringify({ ...goodAnswer, issues: [{ ...goodAnswer.issues[0], severity: "critical" }] })],
    ["a missing note", JSON.stringify({ ...goodAnswer, issues: [{ kind: "other", severity: "minor", evidence: "e" }] })],
    ["an empty summary", JSON.stringify({ ...goodAnswer, summary: " " })],
    ["extra keys", JSON.stringify({ ...goodAnswer, scores: {} })],
    ["issues not an array", JSON.stringify({ ...goodAnswer, issues: {} })],
  ])("rejects %s", (_label, text) => {
    expect(() => parseAnswer(text)).toThrow(AnswerFormatError);
  });
});

describe("evidenceOccurs", () => {
  it("finds quotes in either input ignoring whitespace differences, and rejects paraphrases", () => {
    expect(evidenceOccurs("cache  keys", "The cache\nkeys are", "")).toBe(true);
    expect(evidenceOccurs("# Title", "", "# Title\n\nBody")).toBe(true);
    expect(evidenceOccurs("cache identifiers", "The cache keys are", "")).toBe(false);
    expect(evidenceOccurs("   ", "anything", "anything")).toBe(false);
  });
});

describe("inputs", () => {
  it("cuts long inputs at the cap and marks them", () => {
    expect(truncateInput("short", 10)).toEqual({ text: "short", truncated: false });
    const cut = truncateInput("x".repeat(20), 10);
    expect(cut.truncated).toBe(true);
    expect(cut.text.startsWith("x".repeat(10))).toBe(true);
    expect(cut.text).toContain("cut after 10 characters");
  });

  it("writes a marker instead of markdown when extraction failed", () => {
    expect(extractedMarkdown({ ok: false, problems: [{ code: "empty-body" }], fallbackText: "" } as never)).toBe("(extraction failed: empty-body)\n");
  });

  it("puts the extractor's title, byline and date ahead of its markdown", () => {
    const outcome = { ok: true, article: { title: "T", byline: "Ada", publishedAt: "2026-09-23T00:00:00.000Z", materialization: { representations: [{ schema: "agent.gfm.v1", content: "# T\n\nBody" }] } } } as never;
    expect(extractedMarkdown(outcome)).toBe("<!-- extractor metadata -->\ntitle: T\nbyline: Ada\npublishedAt: 2026-09-23T00:00:00.000Z\n<!-- end extractor metadata -->\n\n# T\n\nBody");
    const bare = { ok: true, article: { title: "T", materialization: { representations: [] } } } as never;
    expect(extractedMarkdown(bare)).toContain("byline: (none)\npublishedAt: (none)");
  });

  it("tells the judge which input was cut", () => {
    const both = buildPrompt({ slug: "s", url: "u", source: "S", extracted: "E", truncated: { source: true, extracted: true } });
    expect(both).toContain("SOURCE and EXTRACTED were cut");
    const one = buildPrompt({ slug: "s", url: "u", source: "S", extracted: "E", truncated: { source: false, extracted: true } });
    expect(one).toContain("EXTRACTED was cut");
    expect(buildPrompt({ slug: "s", url: "u", source: "S", extracted: "E", truncated: { source: false, extracted: false } })).not.toContain("TRUNCATION");
  });
});

describe("baseline", () => {
  const baseline: Baseline = { a: { verdict: "PASS", kinds: [] }, b: { verdict: "MINOR", kinds: ["layout"] }, c: { verdict: "MAJOR", kinds: ["missing_content"] }, d: { verdict: "PASS", kinds: [] } };

  it("classifies worse, better, unchanged, new and errored", () => {
    const delta = compareToBaseline(baseline, [judged("a", "MINOR", ["layout"]), judged("b", "MAJOR"), judged("c", "PASS"), judged("d", "PASS"), judged("e", "MAJOR"), failed("f")]);
    expect(delta.worse).toEqual([{ slug: "a", from: "PASS", to: "MINOR" }, { slug: "b", from: "MINOR", to: "MAJOR" }]);
    expect(delta.better).toEqual([{ slug: "c", from: "MAJOR", to: "PASS" }]);
    expect(delta.unchanged).toEqual(["d"]);
    expect(delta.added).toEqual(["e"]);
    expect(delta.errored).toEqual(["f"]);
    const text = describeDelta(delta).join("\n");
    expect(text).toContain("WORSE than baseline (2): a PASS→MINOR, b MINOR→MAJOR");
    expect(text).toContain("--update-baseline");
  });

  it("does not mutate its input and treats an empty baseline as all new", () => {
    const frozen = Object.freeze({ a: Object.freeze({ verdict: "PASS" as const, kinds: [] }) });
    expect(compareToBaseline(frozen, [judged("a", "PASS")]).unchanged).toEqual(["a"]);
    expect(compareToBaseline({}, [judged("z", "PASS")]).added).toEqual(["z"]);
  });

  it("updateBaseline rewrites judged slugs, keeps failed and absent ones, sorts, and dedupes kinds", () => {
    const next = updateBaseline(baseline, [judged("c", "PASS"), judged("z", "MINOR", ["tables", "layout", "tables"]), failed("b")]);
    expect(Object.keys(next)).toEqual(["a", "b", "c", "d", "z"]);
    expect(next.b).toEqual(baseline.b);
    expect(next.c).toEqual({ verdict: "PASS", kinds: [] });
    expect(next.z).toEqual({ verdict: "MINOR", kinds: ["layout", "tables"] });
    expect(baseline.c.verdict).toBe("MAJOR");
  });
});

describe("renderReport", () => {
  const opinion = (backend: Opinion["backend"], model: string, verdict: Opinion["verdict"], extra: Partial<Opinion> = {}): Opinion => ({ backend, model, verdict, issues: [], summary: `${backend} says ${verdict}`, wallMs: 1, ...extra });

  it("counts verdicts and errors, ranks kinds, lists one row per case, and keeps evidence out", () => {
    const rows = [
      { result: judged("beta", "MAJOR", ["missing_content", "layout"], { issues: [{ kind: "missing_content", severity: "major", evidence: "SECRET-QUOTE", note: "n", verified: true }, { kind: "layout", severity: "minor", evidence: "q", note: "n", verified: false }] }), origin: "fresh" as const },
      { result: judged("alpha", "PASS"), origin: "cached" as const },
      { result: judged("gamma", "MINOR", ["layout"]), origin: "previous" as const },
      { result: failed("delta"), origin: "fresh" as const },
    ];
    const text = renderReport(rows, { date: "2026-09-23", policy: "policy single · codex/default", rubricVersion: RUBRIC_VERSION, ranSlugs: 3 });
    expect(text).toContain("4 cases: 1 PASS · 1 MINOR · 1 MAJOR · 1 error. This run judged 3 (2 fresh, 1 cached); 1 rows are from earlier runs. Judge: policy single · codex/default; rubric");
    expect(text).toContain("1 evidence quote(s) could not be found verbatim");
    expect(text).toContain("| layout | 2 | 2 | 0 |");
    expect(text).toContain("| missing_content | 1 | 1 | 1 |");
    expect(text.indexOf("| layout |")).toBeLessThan(text.indexOf("| missing_content |"));
    const table = text.slice(text.indexOf("## Cases"));
    expect(table.split("\n").filter((line) => /^\| (alpha|beta|gamma|delta) /.test(line))).toHaveLength(4);
    expect(table).toContain("| beta | MAJOR | missing_content!, layout | beta summary | – | fresh |");
    expect(table).toContain("| delta | error | – | codex exec exited with 1: boom | – | fresh |");
    expect(text.indexOf("| alpha ")).toBeLessThan(text.indexOf("| beta "));
    expect(text).not.toContain("SECRET-QUOTE");
    expect(text).not.toContain("Opinions:");
  });

  it("shows which backend decided each case, marks disputes, and totals opinions, tokens and cost per backend", () => {
    const rows = [
      // screened PASS: one opinion
      { result: judged("alpha", "PASS", [], { opinions: [opinion("claude", "haiku", "PASS", { tokens: 1000, costUsd: 0.01 })], resolution: { policy: "screen-then-confirm", from: "claude", disputed: false } }), origin: "fresh" as const },
      // escalated and confirmed, verdicts differ
      { result: judged("beta", "MAJOR", ["layout"], { opinions: [opinion("claude", "haiku", "MINOR", { tokens: 2000, costUsd: 0.02 }), opinion("codex", "default", "MAJOR", { tokens: 30000 })], resolution: { policy: "screen-then-confirm", from: "codex", disputed: true } }), origin: "fresh" as const },
      // escalated and confirmed, verdicts agree
      { result: judged("gamma", "MINOR", ["tables"], { opinions: [opinion("claude", "haiku", "MINOR", { tokens: 3000, costUsd: 0.03 }), opinion("codex", "default", "MINOR", { tokens: 40000 })], resolution: { policy: "screen-then-confirm", from: "codex", disputed: false } }), origin: "cached" as const },
      // a result from before the hybrid judge
      { result: judged("delta", "PASS"), origin: "previous" as const },
      { result: failed("epsilon"), origin: "fresh" as const },
    ];
    const text = renderReport(rows, { date: "2026-09-23", policy: "policy screen-then-confirm · screen claude/haiku · confirm codex/default (on MINOR, MAJOR)", rubricVersion: RUBRIC_VERSION, ranSlugs: 4 });
    expect(text).toContain("Opinions: claude/haiku 3 opinions, 6,000 tokens, $0.0600 · codex/default 2 opinions, 70,000 tokens. Escalated 2 of 3 screened. Disputed 1. 1 result(s) predate the hybrid judge and carry no opinions.");
    expect(text).toContain("| alpha | PASS | – | alpha summary | claude/haiku | fresh |");
    expect(text).toContain("| beta | MAJOR | layout | beta summary | codex/default (disputed) | fresh |");
    expect(text).toContain("| gamma | MINOR | tables | gamma summary | codex/default | cached |");
    expect(text).toContain("| delta | PASS | – | delta summary | – | previous |");
    expect(text).toContain("| epsilon | error | – | codex exec exited with 1: boom | – | fresh |");
  });
});

describe("codex output parsing", () => {
  it("reads the model header and the token line", () => {
    const stderr = "OpenAI Codex v0.144.1\n--------\nworkdir: /tmp/x\nmodel: gpt-5.6-sol\nprovider: openai\n--------\ncodex\n{}\ntokens used\n20,846\n";
    expect(parseResolvedModel(stderr)).toBe("gpt-5.6-sol");
    expect(parseTokens(stderr)).toBe(20846);
    expect(parseTokens("nothing")).toBeUndefined();
  });
});

describe("codexBackend", () => {
  const input = { slug: "s", url: "https://x.test/p", source: "# Title\n\nBy Ada\n\nBody text.", extracted: "# Title\n\nBody text.", truncated: { source: false, extracted: false } };
  const run = (overrides: Partial<CodexRun>): CodexRun => ({ lastMessage: JSON.stringify(goodAnswer), stdout: "", stderr: "model: gpt-test\ntokens used\n1,234\n", status: 0, timedOut: false, ...overrides });
  const backend = (runner: CodexRunner, model = "default") => codexBackend({ bin: "codex", model, runner });

  it("passes the prompt and schema to the runner, omits -m for the default model, and reports the model and tokens", async () => {
    const calls: CodexCall[] = [];
    const output = await backend(async (call) => { calls.push(call); return run({}); }).run({ prompt: "P", schema: ANSWER_SCHEMA, timeoutMs: 1000 });
    expect(calls).toEqual([{ prompt: "P", schema: ANSWER_SCHEMA, model: undefined, bin: "codex", timeoutMs: 1000 }]);
    expect(output).toEqual({ raw: JSON.stringify(goodAnswer), resolvedModel: "gpt-test", tokens: 1234 });
  });

  it("passes a requested model through and reports it on the backend", async () => {
    let seen: string | undefined;
    const codex = backend(async (call) => { seen = call.model; return run({}); }, "gpt-x");
    expect(codex).toMatchObject({ id: "codex", model: "gpt-x" });
    await codex.run({ prompt: "P", schema: ANSWER_SCHEMA, timeoutMs: 1000 });
    expect(seen).toBe("gpt-x");
  });

  it.each([
    ["no last message", run({ lastMessage: undefined }), /wrote no last message/],
    ["a non-zero exit", run({ status: 1, stderr: "not logged in" }), /exited with 1: not logged in/],
    ["a timeout", run({ timedOut: true, status: null }), /exceeded 1000 ms/],
  ])("throws BackendRunError for %s, keeping the meta it read", async (_label, outcome, message) => {
    const failure = await backend(async () => outcome).run({ prompt: "P", schema: ANSWER_SCHEMA, timeoutMs: 1000 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BackendRunError);
    expect((failure as BackendRunError).message).toMatch(message);
    expect((failure as BackendRunError).meta).toEqual(outcome.stderr.includes("tokens used") ? { resolvedModel: "gpt-test", tokens: 1234 } : {});
  });

  it("askOpinion turns a good answer into an Opinion with verified evidence", async () => {
    const outcome = await askOpinion(backend(async () => run({})), input, 1000);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected an opinion");
    const expected: Partial<Opinion> = { backend: "codex", model: "default", resolvedModel: "gpt-test", tokens: 1234, verdict: "MINOR", summary: goodAnswer.summary };
    expect(outcome.opinion).toMatchObject(expected);
    expect(outcome.opinion.issues[0]).toMatchObject({ kind: "metadata", verified: true });
  });

  it.each([
    ["a malformed answer", run({ lastMessage: '{"verdict":"PASS"}' }), /judge answer rejected/],
    ["a non-zero exit", run({ status: 1, stderr: "boom" }), /exited with 1: boom/],
  ])("askOpinion records %s as a failure, never as an opinion", async (_label, outcome, message) => {
    const result = await askOpinion(backend(async () => outcome), input, 1000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.failure.error).toMatch(message);
    expect(result.failure).toMatchObject({ backend: "codex", model: "default" });
    if (outcome.status === 0) expect(result.failure.rawAnswer).toBe('{"verdict":"PASS"}');
  });

  it("askOpinion records a runner that cannot start as a failure", async () => {
    const result = await askOpinion(backend(async () => { throw new Error("spawn codex ENOENT"); }), input, 1000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.error).toBe("codex could not start: spawn codex ENOENT");
  });
});
