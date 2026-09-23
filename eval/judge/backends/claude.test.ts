// The Claude Code backend without the CLI: the argument list, the JSON envelope in both shapes
// (structured_output and result text), is_error, malformed output, and the login check's parser.
import { describe, expect, it } from "vitest";
import { ANSWER_SCHEMA } from "../rubric";
import { claudeArgs, claudeBackend, ClaudeEnvelopeError, parseClaudeEnvelope, unfence, type ClaudeCall, type ClaudeRun, type ClaudeRunner } from "./claude";
import { parseAuthStatus } from "./preflight.mjs";
import { BackendRunError } from "./types";

const answer = { verdict: "PASS", issues: [], summary: "Clean." };
const usage = { input_tokens: 1000, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 50, server_tool_use: { web_search_requests: 0 } };
const modelUsage = { "claude-haiku-4-5-20251001": { inputTokens: 1000, outputTokens: 50, costUSD: 0.0012 } };
/** The envelope newer CLIs print: the schema-conforming answer in structured_output, the same text in result. */
const structured = { type: "result", subtype: "success", is_error: false, duration_ms: 1200, num_turns: 1, result: JSON.stringify(answer), structured_output: answer, session_id: "s", total_cost_usd: 0.0012, usage, modelUsage, permission_denials: [] };
/** The envelope older CLIs print: only the result text carries the answer. */
const textOnly = { type: "result", subtype: "success", is_error: false, duration_ms: 1200, num_turns: 1, result: `\`\`\`json\n${JSON.stringify(answer, null, 2)}\n\`\`\``, session_id: "s", total_cost_usd: 0.0012, usage, modelUsage };
/** What 2.1.x prints when not logged in: is_error true although subtype says success, exit 1. */
const loggedOut = { duration_api_ms: 0, session_id: "s", total_cost_usd: 0, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, modelUsage: {}, is_error: true, num_turns: 1, subtype: "success", result: "Failed to authenticate: OAuth session expired and could not be refreshed", type: "result" };

describe("claudeArgs", () => {
  it("prints once with no tools, plan mode, one turn, the schema inline, and nothing persisted", () => {
    const args = claudeArgs("haiku", ANSWER_SCHEMA);
    expect(args.slice(0, 3)).toEqual(["-p", "--model", "haiku"]);
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args[args.indexOf("--json-schema") + 1]).toBe(JSON.stringify(ANSWER_SCHEMA));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("3"); // structured output is a tool-call turn; 1 cut long pages off
    expect(args).toContain("--strict-mcp-config");
  });

  it("passes any alias or full id through and leaves --model out for the default", () => {
    expect(claudeArgs("claude-haiku-4-5", {})).toContain("claude-haiku-4-5");
    expect(claudeArgs(undefined, {})).not.toContain("--model");
  });
});

describe("parseClaudeEnvelope", () => {
  it("takes the answer from structured_output when present, with cost, tokens and the model", () => {
    expect(parseClaudeEnvelope(`${JSON.stringify(structured)}\n`)).toEqual({ raw: JSON.stringify(answer), answerFrom: "structured_output", costUsd: 0.0012, tokens: 1550, resolvedModel: "claude-haiku-4-5-20251001" });
  });

  it("falls back to the result text, unfenced, when structured_output is absent", () => {
    const envelope = parseClaudeEnvelope(JSON.stringify(textOnly));
    expect(envelope.answerFrom).toBe("result");
    expect(JSON.parse(envelope.raw)).toEqual(answer);
    expect(envelope).toMatchObject({ costUsd: 0.0012, tokens: 1550 });
    expect(parseClaudeEnvelope(JSON.stringify({ ...textOnly, structured_output: null })).answerFrom).toBe("result");
  });

  it("finds the envelope after warning lines and reads several models as one label", () => {
    const stdout = `warning: something\n${JSON.stringify({ ...structured, modelUsage: { "claude-haiku-4-5": {}, "claude-sonnet-4-5": {} } })}\n`;
    expect(parseClaudeEnvelope(stdout).resolvedModel).toBe("claude-haiku-4-5+claude-sonnet-4-5");
  });

  it("leaves meta out that the envelope does not carry", () => {
    expect(parseClaudeEnvelope(JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(answer) }))).toEqual({ raw: JSON.stringify(answer), answerFrom: "result" });
  });

  it("reports is_error with the result text, keeping the meta (the logged-out envelope says subtype success)", () => {
    const failure = (() => { try { parseClaudeEnvelope(JSON.stringify(loggedOut)); return undefined; } catch (error) { return error; } })();
    expect(failure).toBeInstanceOf(ClaudeEnvelopeError);
    expect((failure as Error).message).toBe("claude -p reported an error: Failed to authenticate: OAuth session expired and could not be refreshed");
    expect((failure as ClaudeEnvelopeError).meta).toEqual({ costUsd: 0, tokens: 0 });
    expect(() => parseClaudeEnvelope(JSON.stringify({ type: "result", is_error: true, subtype: "error_max_turns", errors: ["too many turns"] }))).toThrow("claude -p reported an error: too many turns");
    expect(() => parseClaudeEnvelope(JSON.stringify({ type: "result", is_error: true, subtype: "error_during_execution" }))).toThrow("claude -p reported an error: error_during_execution");
  });

  it.each([
    ["no output", ""],
    ["prose", "Sorry, something went wrong"],
    ["a broken object", '{"type":"result","is_error":false,"result":'],
    ["an array", "[]"],
    ["an object that is not the envelope", JSON.stringify({ verdict: "PASS" })],
  ])("rejects %s as no envelope", (_label, stdout) => {
    expect(() => parseClaudeEnvelope(stdout)).toThrow(/printed no JSON result envelope/);
  });

  it("rejects an envelope with neither structured_output nor result text", () => {
    expect(() => parseClaudeEnvelope(JSON.stringify({ type: "result", is_error: false, result: "" }))).toThrow(/neither structured_output nor a result text/);
  });

  it("unfence strips a json fence and leaves bare text alone", () => {
    expect(unfence("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
    expect(unfence("```\n{}\n```\n")).toBe("{}");
    expect(unfence(' {"a":1} ')).toBe('{"a":1}');
  });
});

describe("claudeBackend", () => {
  const run = (overrides: Partial<ClaudeRun>): ClaudeRun => ({ stdout: JSON.stringify(structured), stderr: "", status: 0, timedOut: false, ...overrides });
  const backend = (runner: ClaudeRunner, model = "haiku") => claudeBackend({ bin: "claude", model, runner, env: {} });
  const call = { prompt: "P", schema: ANSWER_SCHEMA, timeoutMs: 1000 };

  it("hands the runner the model, bin, prompt and schema and returns the answer with its meta", async () => {
    const calls: ClaudeCall[] = [];
    const claude = backend(async (input) => { calls.push(input); return run({}); });
    expect(claude).toMatchObject({ id: "claude", model: "haiku" });
    expect(await claude.run(call)).toEqual({ raw: JSON.stringify(answer), costUsd: 0.0012, tokens: 1550, resolvedModel: "claude-haiku-4-5-20251001" });
    expect(calls).toEqual([{ prompt: "P", schema: ANSWER_SCHEMA, model: "haiku", bin: "claude", timeoutMs: 1000 }]);
  });

  it("asks for no model when the model is default", async () => {
    let seen: string | undefined = "unset";
    await backend(async (input) => { seen = input.model; return run({}); }, "default").run(call);
    expect(seen).toBeUndefined();
  });

  it("reads the text-only envelope too", async () => {
    const output = await backend(async () => run({ stdout: JSON.stringify(textOnly) })).run(call);
    expect(JSON.parse(output.raw)).toEqual(answer);
  });

  it.each([
    ["a logged-out is_error envelope with exit 1", run({ stdout: JSON.stringify(loggedOut), status: 1 }), /reported an error: Failed to authenticate/],
    ["a non-zero exit with no envelope", run({ stdout: "", stderr: "unknown option --frobnicate", status: 2 }), /exited with 2: unknown option --frobnicate/],
    ["a timeout", run({ timedOut: true, status: null }), /exceeded 1000 ms/],
    ["output that is not the envelope", run({ stdout: "hello" }), /printed no JSON result envelope/],
  ])("throws BackendRunError for %s", async (_label, outcome, message) => {
    const failure = await backend(async () => outcome).run(call).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BackendRunError);
    expect((failure as Error).message).toMatch(message);
  });

  it("lets a runner that cannot start propagate", async () => {
    await expect(backend(async () => { throw new Error("spawn claude ENOENT"); }).run(call)).rejects.toThrow("spawn claude ENOENT");
  });
});

describe("parseAuthStatus", () => {
  it("reads the JSON object claude auth status prints, even after a wrapper's own lines", () => {
    expect(parseAuthStatus('{\n  "loggedIn": false,\n  "authMethod": "none"\n}\n')).toEqual({ loggedIn: false, authMethod: "none" });
    expect(parseAuthStatus('[cac] using env pro\n{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c"}')).toMatchObject({ loggedIn: true });
    expect(parseAuthStatus("")).toBeUndefined();
    expect(parseAuthStatus("Logged in")).toBeUndefined();
    expect(parseAuthStatus("[1,2]")).toBeUndefined();
  });
});
