import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CodexClient, CodexError, resolveCodexBinary, type CodexProcess, type Spawn, type ToolCall } from "./codex-client";

type Json = Record<string, unknown>;

/** A scripted app-server: every request the client writes is handed to `script`, which answers by writing lines back. */
class FakeProcess extends EventEmitter implements CodexProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: Json[] = [];
  killed = false;
  private open = true;
  readonly stdin = {
    writable: true,
    write: (chunk: string) => { for (const line of chunk.split("\n").filter(Boolean)) { const message = JSON.parse(line) as Json; this.written.push(message); this.script(message, this); } return true; },
    end: () => { this.open = false; },
  };
  constructor(readonly args: readonly string[], private readonly script: (message: Json, fake: FakeProcess) => void) { super(); }
  send(message: Json) { if (this.open) this.stdout.write(`${JSON.stringify(message)}\n`); }
  kill() { this.killed = true; this.exit(null, "SIGTERM"); return true; }
  exit(code: number | null, signal: NodeJS.Signals | null = null) { this.open = false; this.stdin.writable = false; this.emit("exit", code, signal); }
  requests(method: string) { return this.written.filter((message) => message.method === method); }
}

const ok = (id: unknown, result: unknown) => ({ id, result });
const idOf = (message: Json) => message.id;

/** Answers the handshake and the thread / turn lifecycle; `onTurn` scripts what happens after turn/start. */
function basicScript(onTurn: (fake: FakeProcess, turnRequest: Json) => void, overrides: Partial<Record<string, (fake: FakeProcess, message: Json) => void>> = {}) {
  return (message: Json, fake: FakeProcess) => {
    const method = String(message.method);
    const override = overrides[method];
    if (override) { override(fake, message); return; }
    if (method === "initialize") fake.send(ok(idOf(message), { userAgent: "codex" }));
    else if (method === "account/read") fake.send(ok(idOf(message), { account: { type: "chatgpt", email: "reader@example.com", planType: "plus" }, requiresOpenaiAuth: false }));
    else if (method === "thread/start") fake.send(ok(idOf(message), { thread: { id: "thread-1" } }));
    else if (method === "turn/start") onTurn(fake, message);
    else if (method === "turn/interrupt") fake.send(ok(idOf(message), {}));
  };
}

function harness(script: (message: Json, fake: FakeProcess) => void, options: { turnTimeoutMs?: number } = {}) {
  const processes: FakeProcess[] = [];
  const diagnostics: string[] = [];
  const spawn: Spawn = (_command, args) => {
    const fake = new FakeProcess(args, args[0] === "--version" ? (message) => { throw new Error(`unexpected ${String(message.method)}`); } : script);
    processes.push(fake);
    if (args[0] === "--version") setTimeout(() => { fake.stdout.write("codex-cli 0.144.1\n"); fake.exit(0); }, 0);
    return fake;
  };
  const client = new CodexClient({ spawn, env: { CODEX_PATH: "/fake/codex", HOME: "/home/reader" }, exists: () => true, onDiagnostic: (m) => diagnostics.push(m), sleep: () => Promise.resolve(), ...options });
  return { client, processes, diagnostics, server: () => processes.find((p) => p.args[0] === "app-server")! };
}

const noTools = { cwd: "/tmp/agent", prompt: "hello", dynamicTools: [], onToolCall: async (call: ToolCall) => ({ success: true, text: `unexpected ${call.tool}` }) };

function completeTurn(fake: FakeProcess, turnId: string, text: string) {
  for (const delta of text.split(" ")) fake.send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId, itemId: "m1", delta: `${delta} ` } });
  fake.send({ method: "item/completed", params: { threadId: "thread-1", turnId, item: { type: "agentMessage", id: "m1", text } } });
  fake.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed", items: [] } } });
}

describe("resolveCodexBinary", () => {
  it("prefers CODEX_PATH, then the install locations, then PATH, and explains what to install", () => {
    expect(resolveCodexBinary({ CODEX_PATH: "/x/codex" }, (p) => p === "/x/codex")).toBe("/x/codex");
    expect(() => resolveCodexBinary({ CODEX_PATH: "/x/codex" }, () => false)).toThrow(/CODEX_PATH points to \/x\/codex/);
    expect(resolveCodexBinary({}, (p) => p === "/usr/local/bin/codex")).toBe("/usr/local/bin/codex");
    expect(resolveCodexBinary({ PATH: "/a:/b" }, (p) => p === "/b/codex")).toBe("/b/codex");
    let error: unknown;
    try { resolveCodexBinary({ PATH: "/a" }, () => false); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(CodexError);
    expect((error as CodexError).code).toBe("AGENT_UNAVAILABLE");
    expect((error as CodexError).message).toMatch(/npm i -g @openai\/codex/);
  });
});

describe("CodexClient", () => {
  it("parses the version once", async () => {
    const { client, processes } = harness(basicScript(() => {}));
    expect(await client.version()).toBe("0.144.1");
    expect(await client.version()).toBe("0.144.1");
    expect(processes.filter((p) => p.args[0] === "--version")).toHaveLength(1);
  });

  it("initializes with experimentalApi, sets CODEX_HOME and reads the account", async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const h = harness(basicScript(() => {}));
    const spawn = h.client as unknown as { spawn: Spawn };
    const inner = spawn.spawn;
    spawn.spawn = (command, args, options) => { seen.push(options.env); return inner(command, args, options); };
    const info = await h.client.account();
    expect(info.account).toMatchObject({ type: "chatgpt", email: "reader@example.com" });
    const init = h.server().requests("initialize")[0]!;
    expect(init.params).toMatchObject({ clientInfo: { name: "quire" }, capabilities: { experimentalApi: true } });
    expect(h.server().written[1]).toMatchObject({ method: "initialized" });
    expect(seen[0]?.CODEX_HOME).toBe("/home/reader/.codex");
  });

  it("runs a turn: thread/start with the tools, streamed deltas, a tool call, the final text", async () => {
    const deltas: string[] = [];
    const calls: ToolCall[] = [];
    const progress: string[] = [];
    const h = harness(basicScript((fake, turnRequest) => {
      fake.send(ok(idOf(turnRequest), { turn: { id: "turn-1", status: "inProgress", items: [] } }));
      fake.send({ id: 900, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", callId: "c1", tool: "library_recent", arguments: { limit: 2 } } });
    }));
    const outcomePromise = h.client.runTurn({
      cwd: "/tmp/agent", prompt: "What is new?", dynamicTools: [{ name: "library_recent", description: "newest", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
      onDelta: (d) => deltas.push(d), onTool: (p) => progress.push(`${p.tool}:${p.status}:${p.summary ?? ""}`),
      onToolCall: async (call) => { calls.push(call); return { success: true, text: "[]", summary: "library_recent → 0 materials" }; },
    });
    await new Promise((r) => setTimeout(r, 5));
    const server = h.server();
    const threadStart = server.requests("thread/start")[0]!;
    expect(threadStart.params).toMatchObject({ approvalPolicy: "never", approvalsReviewer: "user", cwd: "/tmp/agent", sandboxPolicy: { type: "readOnly" }, serviceName: "quire", dynamicTools: [{ type: "function", name: "library_recent" }] });
    expect(server.requests("turn/start")[0]!.params).toMatchObject({ threadId: "thread-1", input: [{ type: "text", text: "What is new?" }] });
    const toolReply = server.written.find((m) => m.id === 900)!;
    expect(toolReply.result).toEqual({ contentItems: [{ type: "inputText", text: "[]" }], success: true });
    expect(calls).toEqual([{ tool: "library_recent", arguments: { limit: 2 }, callId: "c1" }]);
    completeTurn(server, "turn-1", "Two new pieces.");
    const outcome = await outcomePromise;
    expect(outcome).toEqual({ threadId: "thread-1", turnId: "turn-1", text: "Two new pieces." });
    expect(deltas.join("")).toBe("Two new pieces. ");
    expect(progress).toEqual(["library_recent:running:", "library_recent:done:library_recent → 0 materials"]);
    expect(h.client.busy).toBe(false);
  });

  it("buffers a tool call and deltas that arrive before the turn/start ACK", async () => {
    const deltas: string[] = [];
    const h = harness(basicScript((fake, turnRequest) => {
      fake.send({ id: 901, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-2", callId: "c1", tool: "inbox_list", arguments: {} } });
      fake.send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-2", itemId: "m", delta: "early " } });
      setTimeout(() => fake.send(ok(idOf(turnRequest), { turn: { id: "turn-2", status: "inProgress", items: [] } })), 2);
    }));
    const outcome = h.client.runTurn({ ...noTools, onDelta: (d) => deltas.push(d), onToolCall: async () => ({ success: true, text: "{}" }) });
    await new Promise((r) => setTimeout(r, 10));
    const server = h.server();
    expect(server.written.find((m) => m.id === 901)?.result).toMatchObject({ success: true });
    expect(deltas).toEqual(["early "]);
    completeTurn(server, "turn-2", "done");
    expect((await outcome).text).toBe("done");
  });

  it("declines approval requests and reports a failing tool without ending the turn", async () => {
    const h = harness(basicScript((fake, turnRequest) => {
      fake.send(ok(idOf(turnRequest), { turn: { id: "turn-3", status: "inProgress", items: [] } }));
      fake.send({ id: 77, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-3", command: "rm -rf" } });
      fake.send({ id: 78, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-3", callId: "c2", tool: "material_read", arguments: { id: "nope" } } });
    }));
    const outcome = h.client.runTurn({ ...noTools, onToolCall: async () => { throw new Error("Material nope is not in the library."); } });
    await new Promise((r) => setTimeout(r, 5));
    const server = h.server();
    expect(server.written.find((m) => m.id === 77)?.result).toEqual({ decision: "decline" });
    expect(server.written.find((m) => m.id === 78)?.result).toEqual({ contentItems: [{ type: "inputText", text: "Material nope is not in the library." }], success: false });
    expect(h.diagnostics).toContain("declined item/commandExecution/requestApproval");
    completeTurn(server, "turn-3", "ok");
    expect((await outcome).text).toBe("ok");
  });

  it("refuses a second turn while one runs, and interrupts settle as TURN_INTERRUPTED", async () => {
    const h = harness(basicScript((fake, turnRequest) => fake.send(ok(idOf(turnRequest), { turn: { id: "turn-4", status: "inProgress", items: [] } }))));
    const first = h.client.runTurn(noTools);
    await new Promise((r) => setTimeout(r, 5));
    await expect(h.client.runTurn(noTools)).rejects.toMatchObject({ code: "TURN_RUNNING" });
    await h.client.interrupt();
    const server = h.server();
    expect(server.requests("turn/interrupt")[0]!.params).toEqual({ threadId: "thread-1", turnId: "turn-4" });
    server.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-4", status: "interrupted", items: [] } } });
    await expect(first).rejects.toMatchObject({ code: "TURN_INTERRUPTED" });
    expect(h.client.busy).toBe(false);
  });

  it("fails the turn when the server exits mid-turn and starts a fresh process afterwards", async () => {
    const h = harness(basicScript((fake, turnRequest) => fake.send(ok(idOf(turnRequest), { turn: { id: "turn-5", status: "inProgress", items: [] } }))));
    const turn = h.client.runTurn(noTools);
    await new Promise((r) => setTimeout(r, 5));
    h.server().exit(1);
    await expect(turn).rejects.toMatchObject({ code: "APP_SERVER_EXITED", message: /exited \(1\)/ });
    await h.client.account();
    expect(h.processes.filter((p) => p.args[0] === "app-server")).toHaveLength(2);
  });

  it("maps a failed turn, a missing account and a turn timeout", async () => {
    const failing = harness(basicScript((fake, turnRequest) => {
      fake.send(ok(idOf(turnRequest), { turn: { id: "turn-6", status: "inProgress", items: [] } }));
      fake.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-6", status: "failed", items: [], error: { message: "model overloaded" } } } });
    }));
    await expect(failing.client.runTurn(noTools)).rejects.toMatchObject({ code: "TURN_FAILED", message: "model overloaded" });

    const signedOut = harness(basicScript(() => {}, { "account/read": (fake, m) => fake.send(ok(idOf(m), { account: null, requiresOpenaiAuth: true })) }));
    await expect(signedOut.client.runTurn(noTools)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });

    const slow = harness(basicScript((fake, turnRequest) => fake.send(ok(idOf(turnRequest), { turn: { id: "turn-7", status: "inProgress", items: [] } }))), { turnTimeoutMs: 15 });
    await expect(slow.client.runTurn(noTools)).rejects.toMatchObject({ code: "TURN_TIMEOUT" });
    await new Promise((r) => setTimeout(r, 2));
    expect(slow.server().requests("turn/interrupt")).toHaveLength(1);
  });

  it("continues an existing thread by resuming it and returns the login URL", async () => {
    const h = harness(basicScript((fake, turnRequest) => { fake.send(ok(idOf(turnRequest), { turn: { id: "turn-8", status: "inProgress", items: [] } })); completeTurn(fake, "turn-8", "again"); }, {
      "thread/resume": (fake, m) => fake.send(ok(idOf(m), { thread: { id: "thread-1" } })),
      "account/login/start": (fake, m) => fake.send(ok(idOf(m), { type: "chatgpt", authUrl: "https://auth.openai.com/x", loginId: "l1" })),
    }));
    expect((await h.client.runTurn({ ...noTools, threadId: "thread-1" })).text).toBe("again");
    expect(h.server().requests("thread/start")).toHaveLength(0);
    expect(h.server().requests("thread/resume")[0]!.params).toMatchObject({ threadId: "thread-1" });
    expect(await h.client.login()).toEqual({ authUrl: "https://auth.openai.com/x" });
    expect(await h.client.waitForAccount(1, 100)).toMatchObject({ account: { type: "chatgpt" } });
  });

  it("passes the model to thread/start and thread/resume, and model and effort to turn/start, only when set", async () => {
    const h = harness(basicScript((fake, turnRequest) => { fake.send(ok(idOf(turnRequest), { turn: { id: "turn-9", status: "inProgress", items: [] } })); completeTurn(fake, "turn-9", "ok"); }, {
      "thread/resume": (fake, m) => fake.send(ok(idOf(m), { thread: { id: "thread-1" } })),
    }));
    await h.client.runTurn({ ...noTools, model: "gpt-5-codex", effort: "high" });
    const server = h.server();
    expect(server.requests("thread/start")[0]!.params).toMatchObject({ model: "gpt-5-codex" });
    expect(server.requests("thread/start")[0]!.params).not.toHaveProperty("effort");
    expect(server.requests("turn/start")[0]!.params).toMatchObject({ model: "gpt-5-codex", effort: "high" });
    await h.client.runTurn({ ...noTools, threadId: "thread-1", model: "gpt-5-codex" });
    expect(server.requests("thread/resume")[0]!.params).toMatchObject({ threadId: "thread-1", model: "gpt-5-codex" });
    expect(server.requests("turn/start")[1]!.params).not.toHaveProperty("effort");
    await h.client.runTurn(noTools);
    expect(server.requests("thread/start")[1]!.params).not.toHaveProperty("model");
    expect(server.requests("turn/start")[2]!.params).not.toHaveProperty("model");
  });

  it("honours the configured path from Settings over CODEX_PATH, and re-reads it after stop()", async () => {
    expect(resolveCodexBinary({ CODEX_PATH: "/x/codex" }, (p) => p === "/settings/codex", "/settings/codex")).toBe("/settings/codex");
    expect(() => resolveCodexBinary({}, () => false, "/gone/codex")).toThrow(/Codex path in Settings \(\/gone\/codex\) does not exist/);
    let configured = "";
    const commands: string[] = [];
    const spawn: Spawn = (command, args) => { commands.push(command); const fake = new FakeProcess(args, () => {}); setTimeout(() => { fake.stdout.write("codex-cli 0.144.1\n"); fake.exit(0); }, 0); return fake; };
    const client = new CodexClient({ spawn, env: { CODEX_PATH: "/env/codex" }, exists: () => true, configuredPath: () => configured });
    expect(client.binary()).toBe("/env/codex");
    await client.version();
    configured = "/settings/codex";
    expect(client.binary()).toBe("/settings/codex");
    await client.version();
    expect(commands).toEqual(["/env/codex"]);
    client.stop();
    await client.version();
    expect(commands).toEqual(["/env/codex", "/settings/codex"]);
  });

  it("stop() ends the process and reports the binary as missing when nothing is installed", async () => {
    const h = harness(basicScript(() => {}));
    await h.client.initialize();
    h.client.stop();
    expect(h.server().killed).toBe(true);
    const missing = new CodexClient({ spawn: () => { throw new Error("must not spawn"); }, env: { PATH: "/nowhere" }, exists: () => false });
    await expect(missing.version()).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
    expect(() => missing.start()).toThrow(/Codex CLI was not found/);
  });
});
