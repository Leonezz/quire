import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, MaterialRecord } from "../../shared/contracts";
import { AgentService, type AgentClient } from "./agent";
import { buildPrompt } from "./agent-prompt";
import { CodexError, type TurnOptions } from "./codex-client";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-agent-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const material: MaterialRecord = {
  id: "abcdefabcdefabcd", url: "https://example.test/momentum", finalUrl: "https://example.test/momentum", title: "Momentum, revisited", byline: "A. Author",
  fetchedAt: "2026-09-10T00:00:00.000Z", readingMinutes: 3, origin: "web", mediaType: "text/html", markdown: "x".repeat(30_000),
  quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "strong", safety: "safe", warnings: [] }, problems: [],
};
const summaries = Array.from({ length: 45 }, (_, i) => ({ ...material, id: `${i.toString(16).padStart(16, "0")}`, title: `Title ${i}` }));
const store = { list: async () => summaries, get: async (id: string) => (id === material.id ? material : undefined) };

/** A client that answers with a script instead of a process. */
function fakeClient(script: (options: TurnOptions) => Promise<{ text: string }>, overrides: Partial<AgentClient> = {}) {
  const turns: TurnOptions[] = [];
  const client: AgentClient = {
    busy: false,
    version: async () => "0.144.1",
    initialize: async () => {},
    account: async () => ({ account: { type: "chatgpt", email: "reader@example.com", planType: "plus" } }),
    login: async () => ({ authUrl: "https://auth.openai.com/x" }),
    waitForAccount: async () => ({ account: { type: "chatgpt", email: "reader@example.com" } }),
    interrupt: async () => {},
    runTurn: async (options) => { turns.push(options); const { text } = await script(options); return { threadId: "t1", turnId: "u1", text }; },
    ...overrides,
  };
  return { client, turns };
}

function service(client: AgentClient, opened: string[] = []) {
  const events: AgentEvent[] = [];
  const agent = new AgentService({ client, tools: [{ name: "library_recent", description: "d", inputSchema: {} }], toolHandler: async () => ({ success: true, text: "{}", summary: "library_recent → 1 material" }), store, userData: root, onEvent: (e) => events.push(e), openExternal: async (url) => { opened.push(url); } });
  return { agent, events };
}

describe("buildPrompt", () => {
  it("indexes the library for library questions and appends the reader's words", () => {
    const prompt = buildPrompt({ context: { kind: "library" }, task: "ask", text: "What did I read about momentum?" }, { library: summaries });
    expect(prompt).toMatch(/^You are Quire's reading agent/);
    expect(prompt).toContain("40 of 45");
    expect(prompt).toContain("- 0000000000000000 Title 0 — A. Author");
    expect(prompt).not.toContain("Title 40");
    expect(prompt.endsWith("What did I read about momentum?")).toBe(true);
  });

  it("inlines the material up to a page and points at material_read for the rest", () => {
    const prompt = buildPrompt({ context: { kind: "material", materialId: material.id }, task: "summary", text: "" }, { library: summaries, material });
    expect(prompt).toContain(`Material ${material.id}: Momentum, revisited\nBy A. Author\nURL: https://example.test/momentum`);
    expect(prompt).toContain("<material>\n" + "x".repeat(24_000) + "\n</material>");
    expect(prompt).toContain(`[6000 more characters; read on with material_read id ${material.id} offset 24000]`);
    expect(prompt).toContain("Summarise this material: the thesis");
    expect(prompt).not.toContain("The reader adds");
  });

  it("quotes the selection and adds the reader's note after a canned task", () => {
    const prompt = buildPrompt({ context: { kind: "selection", materialId: material.id, quote: "keeps the direction", locator: "loc" }, task: "verify", text: "focus on the second claim" }, { library: [], material });
    expect(prompt).toContain("The reader has selected this passage: «keeps the direction»");
    expect(prompt).toContain("Check the claims in the passage");
    expect(prompt.endsWith("The reader adds: focus on the second claim")).toBe(true);
    for (const task of ["explain", "related", "synthesis"] as const) expect(buildPrompt({ context: { kind: "library" }, task, text: "" }, { library: [] })).toContain(task === "synthesis" ? "artifact_write" : task === "related" ? "library_search" : "plain terms");
  });
});

describe("AgentService", () => {
  it("reports the version and account, and the sign-in reason when there is none", async () => {
    const signedIn = service(fakeClient(async () => ({ text: "" })).client);
    expect(await signedIn.agent.status()).toEqual({ available: true, version: "0.144.1", account: "reader@example.com", busy: false });
    const signedOut = service(fakeClient(async () => ({ text: "" }), { account: async () => ({}) }).client);
    expect(await signedOut.agent.status()).toEqual({ available: true, version: "0.144.1", busy: false, reason: "Sign in to ChatGPT to use the agent." });
    const missing = service(fakeClient(async () => ({ text: "" }), { version: async () => { throw new CodexError("AGENT_UNAVAILABLE", "Codex CLI was not found. Install it."); } }).client);
    expect(await missing.agent.status()).toEqual({ available: false, busy: false, reason: "Codex CLI was not found. Install it." });
    const dead = service(fakeClient(async () => ({ text: "" }), { initialize: async () => { throw new CodexError("APP_SERVER_EXITED", "exited (1)"); } }).client);
    expect(await dead.agent.status()).toMatchObject({ available: false, version: "0.144.1", reason: /did not start: exited/ });
  });

  it("runs a turn in <userData>/agent with the tools and streams started, delta, tool, completed", async () => {
    const { client, turns } = fakeClient(async (options) => {
      options.onStarted?.({ threadId: "t1", turnId: "u1" });
      options.onDelta?.("Two ");
      options.onTool?.({ tool: "library_recent", status: "running" });
      const reply = await options.onToolCall({ tool: "library_recent", arguments: {}, callId: "c" });
      options.onTool?.({ tool: "library_recent", status: "done", ...(reply.summary ? { summary: reply.summary } : {}) });
      options.onDelta?.("things.");
      return { text: "Two things." };
    });
    const { agent, events } = service(client);
    const result = await agent.ask({ context: { kind: "material", materialId: material.id }, task: "explain", text: "briefly", threadId: "t1" });
    expect(result).toEqual({ ok: true, threadId: "t1", turnId: "u1", text: "Two things." });
    expect(turns[0]).toMatchObject({ cwd: join(root, "agent"), threadId: "t1", dynamicTools: [{ name: "library_recent" }] });
    expect(turns[0]!.prompt).toContain("Momentum, revisited");
    expect((await stat(join(root, "agent"))).isDirectory()).toBe(true);
    expect(events).toEqual([
      { type: "started", threadId: "t1", turnId: "u1" },
      { type: "delta", turnId: "u1", delta: "Two " },
      { type: "tool", turnId: "u1", name: "library_recent", status: "running" },
      { type: "tool", turnId: "u1", name: "library_recent", status: "done", summary: "library_recent → 1 material" },
      { type: "delta", turnId: "u1", delta: "things." },
      { type: "completed", turnId: "u1" },
    ]);
  });

  it("maps client errors to result codes and emits failed once the turn had started", async () => {
    const codes = ["AUTH_REQUIRED", "TURN_RUNNING", "TURN_INTERRUPTED", "TURN_TIMEOUT", "APP_SERVER_EXITED", "AGENT_UNAVAILABLE"] as const;
    for (const code of codes) {
      const { client } = fakeClient(async (options) => { if (code === "TURN_INTERRUPTED") options.onStarted?.({ threadId: "t", turnId: "u" }); throw new CodexError(code, `because ${code}`); });
      const { agent, events } = service(client);
      const result = await agent.ask({ context: { kind: "library" }, task: "ask", text: "hi" });
      expect(result).toEqual({ ok: false, code: code === "APP_SERVER_EXITED" ? "TURN_FAILED" : code, message: `because ${code}` });
      expect(events.filter((e) => e.type === "failed")).toEqual(code === "TURN_INTERRUPTED" ? [{ type: "failed", turnId: "u", message: "because TURN_INTERRUPTED" }] : []);
    }
    const plain = service(fakeClient(async () => { throw new Error("boom"); }).client);
    expect(await plain.agent.ask({ context: { kind: "library" }, task: "ask", text: "hi" })).toEqual({ ok: false, code: "TURN_FAILED", message: "boom" });
    const unknown = service(fakeClient(async () => ({ text: "" })).client);
    expect(await unknown.agent.ask({ context: { kind: "material", materialId: "0000000000000001" }, task: "summary", text: "" })).toEqual({ ok: false, code: "TURN_FAILED", message: "Material 0000000000000001 is not in the library." });
  });

  it("opens the login URL in the browser and reports the status afterwards, or the failure reason", async () => {
    const opened: string[] = [];
    const ok = service(fakeClient(async () => ({ text: "" })).client, opened);
    expect(await ok.agent.login()).toMatchObject({ available: true, account: "reader@example.com" });
    expect(opened).toEqual(["https://auth.openai.com/x"]);
    const insecure = service(fakeClient(async () => ({ text: "" }), { login: async () => ({ authUrl: "http://evil.test/x" }), account: async () => ({}) }).client, opened);
    expect(await insecure.agent.login()).toMatchObject({ available: true, reason: /non-https login URL/ });
    expect(opened).toHaveLength(1);
    const slow = service(fakeClient(async () => ({ text: "" }), { waitForAccount: async () => { throw new CodexError("AUTH_REQUIRED", "The sign-in did not complete within three minutes."); }, account: async () => ({}) }).client, opened);
    expect(await slow.agent.login()).toMatchObject({ reason: /did not complete within three minutes/ });
  });
});
