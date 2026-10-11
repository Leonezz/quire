#!/usr/bin/env node
// Lists the threads Quire left in the user's own Codex home (~/.codex, or $CODEX_HOME) before it got
// a CODEX_HOME of its own, and archives or deletes them so they leave the Codex app's thread list.
// They are told apart by originator "quire" (Quire's clientInfo name); the app-server records them as
// "vscode" threads, which is why the Codex app shows them.
//
//   node scripts/clean-codex-threads.mjs            # dry run: list them
//   node scripts/clean-codex-threads.mjs --archive  # archive them (reversible in the Codex app)
//   node scripts/clean-codex-threads.mjs --delete   # delete them for good
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const ORIGINATOR = "quire";
const SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "unknown"];
const REQUEST_TIMEOUT_MS = 60_000;

const flags = new Set(process.argv.slice(2));
const unknown = [...flags].filter((flag) => flag !== "--archive" && flag !== "--delete");
if (unknown.length > 0 || (flags.has("--archive") && flags.has("--delete"))) {
  console.error("usage: clean-codex-threads.mjs [--archive | --delete]");
  process.exit(2);
}
const action = flags.has("--delete") ? "delete" : flags.has("--archive") ? "archive" : undefined;
const binary = process.env.CODEX_PATH || "codex";

const server = spawn(binary, ["app-server"], { env: { ...process.env, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let nextId = 1;
let stderr = "";
server.stderr.on("data", (chunk) => { stderr += chunk; });
server.on("error", (error) => fail(`could not run ${binary} app-server: ${error.message} (set CODEX_PATH to the codex binary)`));
server.on("exit", (code, signal) => {
  for (const { reject } of pending.values()) reject(new Error(`codex app-server exited (${code ?? signal}). ${stderr.trim().slice(-400)}`));
  pending.clear();
});
createInterface({ input: server.stdout }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const waiter = typeof message.id === "number" ? pending.get(message.id) : undefined;
  if (!waiter || !("result" in message || "error" in message)) return;
  pending.delete(message.id);
  clearTimeout(waiter.timeout);
  if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message ?? JSON.stringify(message.error)}`));
  else waiter.resolve(message.result);
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} got no answer within ${REQUEST_TIMEOUT_MS / 1000}s`)); }, REQUEST_TIMEOUT_MS);
    pending.set(id, { method, resolve, reject, timeout });
    server.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

function fail(message) {
  console.error(`clean-codex-threads: ${message}`);
  server.kill();
  process.exit(1);
}

/** Every unarchived thread of the local Codex home whose originator is Quire, across all pages. */
async function quireThreads() {
  const found = [];
  let cursor;
  do {
    const page = await request("thread/list", { sourceKinds: SOURCE_KINDS, archived: false, limit: 100, ...(cursor ? { cursor } : {}) });
    found.push(...(page.data ?? []).filter((thread) => thread.originator === ORIGINATOR));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return found;
}

const label = (thread) => `${thread.id}  ${new Date((thread.createdAt ?? 0) * 1000).toISOString().slice(0, 16)}  ${(thread.preview ?? "").replace(/\s+/g, " ").slice(0, 60)}`;

try {
  await request("initialize", { clientInfo: { name: "quire-cleanup", title: "Quire cleanup", version: "0.0.1" }, capabilities: { experimentalApi: true } });
  server.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  const threads = await quireThreads();
  for (const thread of threads) console.log(label(thread));
  console.log(`${threads.length} Quire thread(s) in ${process.env.CODEX_HOME || "~/.codex"}.`);
  if (!action) {
    if (threads.length > 0) console.log("Dry run. Pass --archive to archive them or --delete to delete them.");
  } else {
    const failures = [];
    for (const thread of threads) {
      try { await request(`thread/${action}`, { threadId: thread.id }); }
      catch (error) { failures.push(`${thread.id}: ${error.message}`); }
    }
    console.log(`${action === "delete" ? "Deleted" : "Archived"} ${threads.length - failures.length} of ${threads.length}.`);
    if (failures.length > 0) fail(`${failures.length} failed:\n${failures.join("\n")}`);
  }
  server.kill();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
