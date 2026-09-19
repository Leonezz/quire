import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, MaterialRecord } from "../../shared/contracts";
import { AgentService, QUIT_MESSAGE, type AgentClient, type AgentServiceDeps, type AgentSettings } from "./agent";
import { buildPrompt } from "./agent-prompt";
import { SessionStore } from "./agent-sessions";
import { CodexError, type TurnOptions, type TurnOutcome } from "./codex-client";
import { openDatabase, type Database } from "./db";

let root = "";
let db: Database;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-agent-")); db = openDatabase(":memory:"); });
afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); });

const meta = { kind: "webpage" as const, title: "Momentum, revisited", creators: [{ role: "author" as const, name: "A. Author" }], url: "https://example.test/momentum" };
const material: MaterialRecord = {
  id: "abcdefabcdefabcd", url: "https://example.test/momentum", finalUrl: "https://example.test/momentum", title: "Momentum, revisited", byline: "A. Author",
  fetchedAt: "2026-09-10T00:00:00.000Z", readingMinutes: 3, origin: "web", mediaType: "text/html", markdown: "x".repeat(30_000), tags: [], kind: "webpage", extracted: meta, meta,
  quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "strong", safety: "safe", warnings: [] }, problems: [],
  views: [{ id: "web", label: "Web page", url: "https://example.test/momentum", mediaType: "text/html", status: "ready" }], primaryView: "web", readyViews: ["web"],
};
const artifact: MaterialRecord = { ...material, id: "0123456789abcdef", url: "quire://artifact/0123456789abcdef", finalUrl: "quire://artifact/0123456789abcdef", title: "Momentum (rebuilt)", origin: "agent", mediaType: "text/markdown", lineage: [material.id], markdown: "# Momentum" };
const summaries = Array.from({ length: 45 }, (_, i) => ({ ...material, id: `${i.toString(16).padStart(16, "0")}`, title: `Title ${i}` }));
const rebuilt: [string, string][] = [];
const store: AgentServiceDeps["store"] = {
  list: async () => summaries,
  get: async (id: string) => (id === material.id ? material : id === artifact.id ? artifact : undefined),
  setRebuiltAs: async (id, artifactId) => { rebuilt.push([id, artifactId]); return { ...material, rebuiltAs: artifactId }; },
};

const clientBase: Omit<AgentClient, "runTurn"> = {
  running: 0,
  version: async () => "0.144.1",
  initialize: async () => {},
  account: async () => ({ account: { type: "chatgpt", email: "reader@example.com", planType: "plus" } }),
  login: async () => ({ authUrl: "https://auth.openai.com/x" }),
  waitForAccount: async () => ({ account: { type: "chatgpt", email: "reader@example.com" } }),
  interrupt: async () => {},
  stop: () => {},
};

/** A client that answers with a script instead of a process: the turn starts (unless told not to), the script streams, the text ends it. */
function fakeClient(script: (options: TurnOptions) => Promise<{ text: string }>, overrides: Partial<AgentClient> = {}, { started = true } = {}) {
  const turns: TurnOptions[] = [];
  const client: AgentClient = {
    ...clientBase,
    runTurn: async (options) => {
      turns.push(options);
      const threadId = options.threadId ?? "t1";
      if (started) options.onStarted?.({ threadId, turnId: "u1" });
      const { text } = await script(options);
      return { threadId, turnId: "u1", text };
    },
    ...overrides,
  };
  return { client, turns };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

interface HeldTurn { options: TurnOptions; threadId: string; start: () => void; complete: (text: string) => void; fail: (error: Error) => void }

/** A client that holds every turn open until the test drives it, so several can be in flight at once. */
function heldClient() {
  const turns: HeldTurn[] = [];
  const interrupted: string[] = [];
  const stopped: string[] = [];
  const client: AgentClient = {
    ...clientBase,
    interrupt: async (threadId) => { interrupted.push(threadId); },
    stop: () => { stopped.push("stop"); },
    runTurn: (options) => new Promise<TurnOutcome>((resolve, reject) => {
      const threadId = options.threadId ?? `t${turns.length + 1}`;
      const turnId = `u${turns.length + 1}`;
      turns.push({ options, threadId, start: () => options.onStarted?.({ threadId, turnId }), complete: (text) => resolve({ threadId, turnId, text }), fail: reject });
    }),
  };
  /** Resolves once `count` turns have reached the client (ask validates and writes before it calls runTurn). */
  const waitFor = async (count: number) => { for (let i = 0; i < 200 && turns.length < count; i += 1) await tick(); if (turns.length < count) throw new Error(`only ${turns.length} of ${count} turns reached the client`); };
  return { client, turns, interrupted, stopped, waitFor };
}

/** Waits until no run is left and its bookkeeping (stored turn, events, rebuild) has had a tick to land. */
async function settled(agent: AgentService) {
  for (let i = 0; i < 50 && agent.listRuns().length > 0; i += 1) await tick();
  await tick(); await tick();
}

function service(client: AgentClient, opened: string[] = [], settings?: AgentSettings) {
  const events: AgentEvent[] = [];
  const changes: string[] = [];
  const errors: string[] = [];
  const sessions = new SessionStore(db);
  const agent = new AgentService({
    client, tools: [{ name: "library_recent", description: "d", inputSchema: {} }], store, sessions, userData: root,
    toolHandler: { forTurn: () => async () => ({ success: true, text: "{}", summary: "library_recent → 1 material" }) },
    onEvent: (e) => events.push(e), onSessionsChanged: () => changes.push("sessions"), onLibraryChanged: () => changes.push("library"),
    onError: (context, error) => errors.push(`${context}: ${error instanceof Error ? error.message : String(error)}`),
    ...(settings ? { settings: () => settings } : {}), openExternal: async (url) => { opened.push(url); },
  });
  return { agent, events, sessions, changes, errors };
}

const library = { context: { kind: "library" as const }, task: "ask" as const };

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
    expect(await signedIn.agent.status()).toEqual({ available: true, version: "0.144.1", account: "reader@example.com", running: 0 });
    const signedOut = service(fakeClient(async () => ({ text: "" }), { account: async () => ({}) }).client);
    expect(await signedOut.agent.status()).toEqual({ available: true, version: "0.144.1", running: 0, reason: "Sign in to ChatGPT to use the agent." });
    const missing = service(fakeClient(async () => ({ text: "" }), { version: async () => { throw new CodexError("AGENT_UNAVAILABLE", "Codex CLI was not found. Install it."); } }).client);
    expect(await missing.agent.status()).toEqual({ available: false, running: 0, reason: "Codex CLI was not found. Install it." });
    const dead = service(fakeClient(async () => ({ text: "" }), { initialize: async () => { throw new CodexError("APP_SERVER_EXITED", "exited (1)"); } }).client);
    expect(await dead.agent.status()).toMatchObject({ available: false, version: "0.144.1", reason: /did not start: exited/ });
  });

  it("runs a turn in <userData>/agent with the tools, returns once it started, and streams started, delta, tool, completed with the session", async () => {
    const { client, turns } = fakeClient(async (options) => {
      options.onDelta?.("Two ");
      options.onTool?.({ tool: "library_recent", status: "running" });
      const reply = await options.onToolCall({ tool: "library_recent", arguments: {}, callId: "c" });
      options.onTool?.({ tool: "library_recent", status: "done", ...(reply.summary ? { summary: reply.summary } : {}) });
      options.onDelta?.("things.");
      return { text: "Two things." };
    });
    const { agent, events, sessions, changes, errors } = service(client, [], { agentModel: "gpt-5-codex", agentReasoningEffort: "medium" });
    const result = await agent.ask({ context: { kind: "material", materialId: material.id }, task: "explain", text: "briefly", threadId: "t1" });
    if (!result.ok) throw new Error(result.message);
    expect(result).toEqual({ ok: true, turnId: "u1", sessionId: result.sessionId });
    expect(turns[0]).toMatchObject({ cwd: join(root, "agent"), threadId: "t1", model: "gpt-5-codex", effort: "medium", dynamicTools: [{ name: "library_recent" }] });
    expect(sessions.get(result.sessionId)?.turnCount).toBe(1);
    await settled(agent);
    const session = sessions.get(result.sessionId)!;
    expect(session).toMatchObject({ title: "briefly", context: { kind: "material", materialId: material.id }, threadId: "t1", turnCount: 2 });
    expect(session.turns.map(({ id: _id, at: _at, ...turn }) => turn)).toEqual([
      { role: "user", text: "briefly", task: "explain" },
      { role: "agent", text: "Two things.", task: "explain", status: "completed", tools: [{ name: "library_recent", status: "done", summary: "library_recent → 1 material" }], sources: [material.id] },
    ]);
    expect(changes).toEqual(["sessions", "sessions"]);
    expect(errors).toEqual([]);
    expect(turns[0]!.prompt).toContain("Momentum, revisited");
    expect((await stat(join(root, "agent"))).isDirectory()).toBe(true);
    const sessionId = result.sessionId;
    expect(events).toEqual([
      { type: "started", sessionId, threadId: "t1", turnId: "u1" },
      { type: "delta", sessionId, turnId: "u1", delta: "Two " },
      { type: "tool", sessionId, turnId: "u1", name: "library_recent", status: "running" },
      { type: "tool", sessionId, turnId: "u1", name: "library_recent", status: "done", summary: "library_recent → 1 material" },
      { type: "delta", sessionId, turnId: "u1", delta: "things." },
      { type: "completed", sessionId, turnId: "u1", text: "Two things.", sources: [material.id] },
    ]);
    expect(agent.listRuns()).toEqual([]);
  });

  it("continues a stored session: appends to it, resumes its thread, and refuses a session that is gone", async () => {
    const { client, turns } = fakeClient(async () => ({ text: "More." }));
    const { agent, sessions } = service(client);
    const first = await agent.ask({ ...library, task: "related", text: "" });
    if (!first.ok) throw new Error(first.message);
    await settled(agent);
    expect(sessions.get(first.sessionId)?.title).toBe("Related · Library");
    expect(turns[0]).not.toHaveProperty("threadId");
    expect(turns[0]).not.toHaveProperty("model");
    const second = await agent.ask({ ...library, text: "and then?", sessionId: first.sessionId });
    expect(second).toEqual({ ok: true, sessionId: first.sessionId, turnId: "u1" });
    await settled(agent);
    expect(turns[1]).toMatchObject({ threadId: "t1" });
    expect(sessions.get(first.sessionId)?.turns.map((t) => t.text)).toEqual(["", "More.", "and then?", "More."]);
    expect(sessions.list()).toHaveLength(1);
    const explicit = await agent.ask({ ...library, text: "elsewhere", sessionId: first.sessionId, threadId: "t-other" });
    expect(explicit.ok).toBe(true);
    await settled(agent);
    expect(turns[2]).toMatchObject({ threadId: "t-other" });
    expect(await agent.ask({ ...library, text: "x", sessionId: "gone" })).toEqual({ ok: false, code: "TURN_FAILED", message: "Session gone no longer exists; start a new one." });
    expect(sessions.list()).toHaveLength(1);
  });

  it("runs two sessions at once, snapshots each mid-run, and folds each into its session when it ends", async () => {
    const { client, turns, waitFor } = heldClient();
    const { agent, events, sessions } = service(client);
    const askA = agent.ask({ context: { kind: "material", materialId: material.id }, task: "summary", text: "" });
    await waitFor(1);
    const askB = agent.ask({ ...library, text: "What is new?" });
    await waitFor(2);
    expect(agent.listRuns()).toEqual([]);
    expect((await agent.status()).running).toBe(2);
    turns[1]!.start();
    const b = await askB;
    if (!b.ok) throw new Error(b.message);
    expect(b).toEqual({ ok: true, sessionId: b.sessionId, turnId: "u2" });
    turns[0]!.start();
    const a = await askA;
    if (!a.ok) throw new Error(a.message);
    expect(a.sessionId).not.toBe(b.sessionId);

    turns[0]!.options.onDelta?.("Summary ");
    turns[1]!.options.onTool?.({ tool: "library_recent", status: "running" });
    turns[1]!.options.onDelta?.("New: ");
    turns[0]!.options.onDelta?.("so far");
    turns[1]!.options.onTool?.({ tool: "library_recent", status: "done", summary: "library_recent → 1 material" });
    const runs = agent.listRuns();
    expect(runs.map(({ startedAt, prompt, ...run }) => ({ ...run, hasPrompt: prompt.length > 0, hasStart: startedAt.length > 0 }))).toEqual([
      { sessionId: a.sessionId, turnId: "u1", threadId: "t1", task: "summary", answer: "Summary so far", tools: [], hasPrompt: true, hasStart: true },
      { sessionId: b.sessionId, turnId: "u2", threadId: "t2", task: "ask", answer: "New: ", tools: [{ name: "library_recent", status: "done", summary: "library_recent → 1 material" }], hasPrompt: true, hasStart: true },
    ]);
    // Snapshots are copies: the registry is not reachable through them.
    runs[0]!.tools.push({ name: "x", status: "running" });
    expect(agent.listRuns()[0]!.tools).toEqual([]);
    expect(events.map((e) => `${e.type}:${e.sessionId === a.sessionId ? "a" : "b"}`)).toEqual(["started:b", "started:a", "delta:a", "tool:b", "delta:b", "delta:a", "tool:b"]);

    turns[1]!.complete("New: one thing.");
    await settled(agent);
    expect(agent.listRuns().map((run) => run.sessionId)).toEqual([a.sessionId]);
    expect(sessions.get(b.sessionId)?.turns.map(({ id: _id, at: _at, ...turn }) => turn)).toEqual([
      { role: "user", text: "What is new?", task: "ask" },
      { role: "agent", text: "New: one thing.", task: "ask", status: "completed", tools: [{ name: "library_recent", status: "done", summary: "library_recent → 1 material" }], sources: [] },
    ]);
    expect(sessions.get(b.sessionId)?.threadId).toBe("t2");
    expect(events.at(-1)).toEqual({ type: "completed", sessionId: b.sessionId, turnId: "u2", text: "New: one thing.", sources: [] });
    expect(sessions.get(a.sessionId)?.turnCount).toBe(1);
    turns[0]!.complete("Summary so far.");
    await settled(agent);
    expect(agent.listRuns()).toEqual([]);
    expect(sessions.get(a.sessionId)?.turns[1]).toMatchObject({ role: "agent", text: "Summary so far.", status: "completed", sources: [material.id] });
    expect((await agent.status()).running).toBe(0);
  });

  it("refuses a second ask for a session with a run, and interrupts by session", async () => {
    const { client, turns, interrupted, waitFor } = heldClient();
    const { agent, sessions, events } = service(client);
    const asked = agent.ask({ ...library, text: "first" });
    await waitFor(1);
    // Stop pressed before the thread is known: sent as soon as it is.
    const sessionId = sessions.list()[0]!.id;
    await agent.interrupt(sessionId);
    expect(interrupted).toEqual([]);
    expect(await agent.ask({ ...library, text: "second", sessionId })).toEqual({ ok: false, code: "TURN_RUNNING", message: "The agent is still answering in this conversation; wait for it or stop it." });
    expect(sessions.get(sessionId)?.turnCount).toBe(1);
    turns[0]!.start();
    const first = await asked;
    expect(first).toEqual({ ok: true, sessionId, turnId: "u1" });
    expect(interrupted).toEqual(["t1"]);
    expect(await agent.ask({ ...library, text: "third", sessionId })).toMatchObject({ ok: false, code: "TURN_RUNNING" });
    await agent.interrupt(sessionId);
    await agent.interrupt("no-such-session");
    expect(interrupted).toEqual(["t1", "t1"]);
    turns[0]!.fail(new CodexError("TURN_INTERRUPTED", "The agent was interrupted."));
    await settled(agent);
    expect(sessions.get(sessionId)?.turns[1]).toMatchObject({ role: "agent", text: "The agent was interrupted.", status: "interrupted", tools: [] });
    expect(events.at(-1)).toEqual({ type: "failed", sessionId, turnId: "u1", code: "TURN_INTERRUPTED", message: "The agent was interrupted." });
    await agent.interrupt(sessionId);
    expect(interrupted).toHaveLength(2);
    const fourth = agent.ask({ ...library, text: "fourth", sessionId });
    await waitFor(2);
    turns[1]!.start();
    expect(await fourth).toEqual({ ok: true, sessionId, turnId: "u2" });
  });

  it("marks the material as rebuilt when a rebuild turn wrote an artifact whose lineage names it", async () => {
    rebuilt.length = 0;
    const { client, turns } = fakeClient(async (options) => {
      options.onTool?.({ tool: "artifact_write", status: "done", summary: `artifact_write "Momentum (rebuilt)" → ${artifact.id}` });
      return { text: artifact.id };
    });
    const { agent, changes, sessions } = service(client);
    const result = await agent.ask({ context: { kind: "material", materialId: material.id }, task: "rebuild", text: "" });
    if (!result.ok) throw new Error(result.message);
    await settled(agent);
    expect(turns[0]!.prompt).toContain("Read the captured page text with material_source");
    expect(turns[0]!.prompt).toContain(`using lineage [${material.id}]`);
    expect(turns[0]!.prompt).not.toContain("<material>");
    expect(rebuilt).toEqual([[material.id, artifact.id]]);
    expect(changes).toEqual(["sessions", "sessions", "library"]);
    expect(sessions.get(result.sessionId)?.title).toBe("Rebuild · Momentum, revisited");

    // A reply naming an id whose lineage does not include the material, or no artifact at all, marks nothing.
    rebuilt.length = 0;
    const other = service(fakeClient(async () => ({ text: `Saved as ${summaries[3]!.id}.` })).client);
    await other.agent.ask({ context: { kind: "material", materialId: material.id }, task: "rebuild", text: "" });
    await settled(other.agent);
    const none = service(fakeClient(async () => ({ text: "I could not rebuild it." })).client);
    await none.agent.ask({ context: { kind: "material", materialId: material.id }, task: "rebuild", text: "" });
    await settled(none.agent);
    expect(rebuilt).toEqual([]);
    expect(other.changes.concat(none.changes)).not.toContain("library");
  });

  it("returns the failure when a turn cannot start, without a failed event, and records it on the session", async () => {
    const codes = ["AUTH_REQUIRED", "TURN_RUNNING", "TURN_TIMEOUT", "APP_SERVER_EXITED", "AGENT_UNAVAILABLE"] as const;
    for (const code of codes) {
      const { client } = fakeClient(async () => { throw new CodexError(code, `because ${code}`); }, {}, { started: false });
      const { agent, events, sessions } = service(client);
      const result = await agent.ask({ ...library, text: "hi" });
      expect(result).toEqual({ ok: false, code: code === "APP_SERVER_EXITED" ? "TURN_FAILED" : code, message: `because ${code}` });
      expect(events).toEqual([]);
      expect(agent.listRuns()).toEqual([]);
      const [session] = sessions.list();
      expect(session?.turnCount).toBe(2);
      expect(sessions.get(session!.id)?.turns[1]).toMatchObject({ role: "agent", text: `because ${code}`, status: "failed", tools: [] });
      expect(sessions.get(session!.id)?.threadId).toBeUndefined();
    }
    const plain = service(fakeClient(async () => { throw new Error("boom"); }, {}, { started: false }).client);
    expect(await plain.agent.ask({ ...library, text: "hi" })).toEqual({ ok: false, code: "TURN_FAILED", message: "boom" });
    const unknown = service(fakeClient(async () => ({ text: "" })).client);
    expect(await unknown.agent.ask({ context: { kind: "material", materialId: "0000000000000001" }, task: "summary", text: "" })).toEqual({ ok: false, code: "TURN_FAILED", message: "Material 0000000000000001 is not in the library." });
  });

  it("emits failed with the code once a started turn fails, and stores the failed or interrupted turn with its tools", async () => {
    for (const code of ["TURN_INTERRUPTED", "TURN_TIMEOUT", "TURN_FAILED"] as const) {
      const { client, turns, waitFor } = heldClient();
      const { agent, events, sessions, errors } = service(client);
      const asked = agent.ask({ ...library, text: "hi" });
      await waitFor(1);
      turns[0]!.start();
      const result = await asked;
      if (!result.ok) throw new Error(result.message);
      turns[0]!.options.onDelta?.("Half an ");
      turns[0]!.options.onTool?.({ tool: "library_recent", status: "running" });
      turns[0]!.options.onTool?.({ tool: "library_recent", status: "failed", summary: "library_recent failed: no" });
      turns[0]!.fail(new CodexError(code, `because ${code}`));
      await settled(agent);
      expect(events.at(-1)).toEqual({ type: "failed", sessionId: result.sessionId, turnId: "u1", code, message: `because ${code}` });
      expect(sessions.get(result.sessionId)?.turns[1]).toMatchObject({ role: "agent", text: `because ${code}`, status: code === "TURN_INTERRUPTED" ? "interrupted" : "failed", tools: [{ name: "library_recent", status: "failed", summary: "library_recent failed: no" }] });
      expect(sessions.get(result.sessionId)?.threadId).toBeUndefined();
      expect(errors).toEqual([]);
    }
  });

  it("reports, never swallows, a turn whose session vanished before it ended", async () => {
    const { client, turns, waitFor } = heldClient();
    const { agent, sessions, errors, events } = service(client);
    const asked = agent.ask({ ...library, text: "hi" });
    await waitFor(1);
    turns[0]!.start();
    const result = await asked;
    if (!result.ok) throw new Error(result.message);
    sessions.delete(result.sessionId);
    turns[0]!.complete("Too late.");
    await settled(agent);
    expect(agent.listRuns()).toEqual([]);
    expect(errors).toEqual([`recording the turn of session ${result.sessionId}: SESSION_NOT_FOUND`]);
    expect(events.map((e) => e.type)).toEqual(["started"]);
  });

  it("shutdown records every open run as interrupted by the quit, then stops the client", async () => {
    const { client, turns, stopped, waitFor } = heldClient();
    const { agent, sessions, events, changes, errors } = service(client);
    const askA = agent.ask({ ...library, text: "a" });
    await waitFor(1);
    const askB = agent.ask({ context: { kind: "material", materialId: material.id }, task: "summary", text: "" });
    await waitFor(2);
    turns[0]!.start();
    turns[1]!.start();
    const [a, b] = await Promise.all([askA, askB]);
    if (!a.ok || !b.ok) throw new Error("did not start");
    turns[0]!.options.onDelta?.("partial");
    turns[0]!.options.onTool?.({ tool: "library_recent", status: "done", summary: "library_recent → 1 material" });
    turns[1]!.options.onTool?.({ tool: "library_recent", status: "running" });
    const eventsBefore = events.length;
    agent.shutdown();
    expect(stopped).toEqual(["stop"]);
    expect(agent.listRuns()).toEqual([]);
    expect((await agent.status()).running).toBe(0);
    expect(sessions.get(a.sessionId)?.turns[1]).toMatchObject({ role: "agent", text: QUIT_MESSAGE, task: "ask", status: "interrupted", tools: [{ name: "library_recent", status: "done", summary: "library_recent → 1 material" }] });
    expect(sessions.get(b.sessionId)?.turns[1]).toMatchObject({ role: "agent", text: QUIT_MESSAGE, task: "summary", status: "interrupted", tools: [] });
    // The client settling afterwards (the stop fails its turns) records nothing twice.
    turns[0]!.fail(new CodexError("APP_SERVER_EXITED", "codex app-server was stopped."));
    turns[1]!.complete("late");
    await settled(agent);
    expect(sessions.get(a.sessionId)?.turnCount).toBe(2);
    expect(sessions.get(b.sessionId)?.turnCount).toBe(2);
    // Nothing is broadcast on quit: the windows are going, the sessions are read afresh at the next start.
    expect(events).toHaveLength(eventsBefore);
    expect(changes.filter((c) => c === "sessions")).toHaveLength(2);
    expect(errors).toEqual([]);
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
