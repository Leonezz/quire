// Unit tests for the judge's pure parts: cache key, answer parsing, baseline comparison, report,
// the case flow with an injected runner, and that the kind vocabulary is the app's. No Codex here.
import { describe, expect, it } from "vitest";
import { RENDERING_PROBLEM_KINDS } from "../../apps/desktop/src/shared/contracts";
import { compareToBaseline, describeDelta, updateBaseline, type Baseline } from "./baseline";
import { cacheKey, isJudged, type JudgedCase, type JudgeResult } from "./cache";
import { judgeCase, parseResolvedModel, parseTokens, type CodexRun, type CodexRunner } from "./codex";
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
  it("counts verdicts and errors, ranks kinds, lists one row per case, and keeps evidence out", () => {
    const rows = [
      { result: judged("beta", "MAJOR", ["missing_content", "layout"], { issues: [{ kind: "missing_content", severity: "major", evidence: "SECRET-QUOTE", note: "n", verified: true }, { kind: "layout", severity: "minor", evidence: "q", note: "n", verified: false }] }), origin: "fresh" as const },
      { result: judged("alpha", "PASS"), origin: "cached" as const },
      { result: judged("gamma", "MINOR", ["layout"]), origin: "previous" as const },
      { result: failed("delta"), origin: "fresh" as const },
    ];
    const text = renderReport(rows, { date: "2026-09-23", model: "default", rubricVersion: RUBRIC_VERSION, ranSlugs: 3 });
    expect(text).toContain("4 cases: 1 PASS · 1 MINOR · 1 MAJOR · 1 error. This run judged 3 (2 fresh, 1 cached); 1 rows are from earlier runs.");
    expect(text).toContain("1 evidence quote(s) could not be found verbatim");
    expect(text).toContain("| layout | 2 | 2 | 0 |");
    expect(text).toContain("| missing_content | 1 | 1 | 1 |");
    expect(text.indexOf("| layout |")).toBeLessThan(text.indexOf("| missing_content |"));
    const table = text.slice(text.indexOf("## Cases"));
    expect(table.split("\n").filter((line) => /^\| (alpha|beta|gamma|delta) /.test(line))).toHaveLength(4);
    expect(table).toContain("| beta | MAJOR | missing_content!, layout | beta summary | fresh |");
    expect(table).toContain("| delta | error | – | codex exec exited with 1: boom | fresh |");
    expect(text.indexOf("| alpha ")).toBeLessThan(text.indexOf("| beta "));
    expect(text).not.toContain("SECRET-QUOTE");
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

describe("judgeCase", () => {
  const input = { slug: "s", url: "https://x.test/p", source: "# Title\n\nBy Ada\n\nBody text.", extracted: "# Title\n\nBody text.", truncated: { source: false, extracted: false } };
  const run = (overrides: Partial<CodexRun>): CodexRun => ({ lastMessage: JSON.stringify(goodAnswer), stdout: "", stderr: "model: gpt-test\ntokens used\n1,234\n", status: 0, timedOut: false, ...overrides });
  const options = (runner: CodexRunner) => ({ runner, bin: "codex", model: undefined, timeoutMs: 1000, now: () => new Date("2026-09-23T12:00:00Z") });

  it("passes the prompt and schema to the runner and records a verdict with verified evidence", async () => {
    const calls: unknown[] = [];
    const result = await judgeCase(input, options(async (call) => { calls.push(call); return run({}); }));
    expect(calls).toHaveLength(1);
    expect((calls[0] as { schema: unknown }).schema).toBe(ANSWER_SCHEMA);
    expect((calls[0] as { prompt: string }).prompt).toContain("===== SOURCE =====\n# Title");
    expect(isJudged(result)).toBe(true);
    if (!isJudged(result)) throw new Error("expected a verdict");
    expect(result).toMatchObject({ slug: "s", model: "default", resolvedModel: "gpt-test", tokens: 1234, rubricVersion: RUBRIC_VERSION, truncated: false, verdict: "MINOR", judgedAt: "2026-09-23T12:00:00.000Z" });
    expect(result.key).toBe(cacheKey(input.source, input.extracted, RUBRIC_VERSION, "default"));
    expect(result.issues[0]).toMatchObject({ kind: "metadata", verified: true });
  });

  it("uses the requested model in the key and the call", async () => {
    let seen: string | undefined;
    const result = await judgeCase(input, { ...options(async (call) => { seen = call.model; return run({}); }), model: "gpt-x" });
    expect(seen).toBe("gpt-x");
    expect(result.model).toBe("gpt-x");
    expect(result.key).toBe(cacheKey(input.source, input.extracted, RUBRIC_VERSION, "gpt-x"));
  });

  it.each([
    ["a malformed answer", run({ lastMessage: '{"verdict":"PASS"}' }), /judge answer rejected/],
    ["no last message", run({ lastMessage: undefined }), /wrote no last message/],
    ["a non-zero exit", run({ status: 1, stderr: "not logged in" }), /exited with 1: not logged in/],
    ["a timeout", run({ timedOut: true, status: null }), /exceeded 1000 ms/],
  ])("records %s as an error, never as a verdict", async (_label, outcome, message) => {
    const result = await judgeCase(input, options(async () => outcome));
    expect(isJudged(result)).toBe(false);
    if (isJudged(result)) throw new Error("expected an error");
    expect(result.error).toMatch(message);
  });

  it("records a runner that cannot start as an error", async () => {
    const result = await judgeCase(input, options(async () => { throw new Error("spawn codex ENOENT"); }));
    expect(isJudged(result)).toBe(false);
    if (!isJudged(result)) expect(result.error).toContain("codex could not start: spawn codex ENOENT");
  });
});
