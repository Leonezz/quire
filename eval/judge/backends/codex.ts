// The Codex backend: `codex exec` with the answer schema in a scratch directory, the prompt on stdin,
// nothing persisted. The runner is a parameter so tests can judge without Codex.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightCodex } from "./preflight.mjs";
import { BackendRunError, outputTail, type BackendRunMeta, type JudgeBackend } from "./types";

export interface CodexCall { prompt: string; schema: unknown; model: string | undefined; bin: string; timeoutMs: number }
export interface CodexRun {
  /** The agent's last message (`-o`), when it wrote one. */
  lastMessage: string | undefined;
  stdout: string;
  stderr: string;
  status: number | null;
  /** Set when the process was killed at timeoutMs. */
  timedOut: boolean;
}
export type CodexRunner = (call: CodexCall) => Promise<CodexRun>;

/** "model: gpt-5.6-sol" from the header Codex prints, when present. */
export const parseResolvedModel = (stderr: string): string | undefined => /^model:\s*(\S+)/m.exec(stderr)?.[1];
/** "tokens used\n20,846" from the tail Codex prints, when present. */
export function parseTokens(stderr: string): number | undefined {
  const match = /^tokens used\s*\n\s*([\d,]+)/m.exec(stderr);
  return match?.[1] ? Number(match[1].replace(/,/g, "")) : undefined;
}

/** The real thing: `codex exec` in a fresh temp directory, the prompt on stdin, nothing persisted. */
export const runCodexExec: CodexRunner = async ({ prompt, schema, model, bin, timeoutMs }) => {
  const dir = await mkdtemp(join(tmpdir(), "quire-judge-"));
  try {
    const schemaPath = join(dir, "schema.json");
    const outPath = join(dir, "answer.json");
    await writeFile(schemaPath, JSON.stringify(schema));
    const args = ["exec", "--skip-git-repo-check", "--ephemeral", "--color", "never", "-s", "read-only", "-C", dir, "--output-schema", schemaPath, "-o", outPath, ...(model ? ["-m", model] : []), "-"];
    const run = await new Promise<Omit<CodexRun, "lastMessage">>((resolve, reject) => {
      const child = spawn(bin, args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (status) => { clearTimeout(timer); resolve({ stdout, stderr, status, timedOut }); });
      child.stdin.on("error", () => { /* the process exited before reading the prompt; `close` reports it */ });
      child.stdin.end(prompt);
    });
    const lastMessage = await readFile(outPath, "utf8").catch(() => undefined);
    return { ...run, lastMessage };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export interface CodexBackendOptions {
  bin: string;
  /** "default" runs whatever the Codex configuration selects; anything else goes to `-m`. */
  model: string;
  runner?: CodexRunner;
}

/** Tokens and model from the header/tail Codex prints on stderr, as far as it printed them. */
export function codexRunMeta(run: Pick<CodexRun, "stderr">): BackendRunMeta {
  const resolvedModel = parseResolvedModel(run.stderr);
  const tokens = parseTokens(run.stderr);
  return { ...(resolvedModel ? { resolvedModel } : {}), ...(tokens !== undefined ? { tokens } : {}) };
}

export function codexBackend({ bin, model, runner = runCodexExec }: CodexBackendOptions): JudgeBackend {
  return {
    id: "codex",
    model,
    preflight: async () => { preflightCodex(bin); },
    run: async ({ prompt, schema, timeoutMs }) => {
      const run = await runner({ prompt, schema, model: model === "default" ? undefined : model, bin, timeoutMs });
      const meta = codexRunMeta(run);
      if (run.timedOut) throw new BackendRunError(`codex exec exceeded ${timeoutMs} ms and was killed`, meta);
      if (run.status !== 0) throw new BackendRunError(`codex exec exited with ${String(run.status)}: ${outputTail(run.stderr) || outputTail(run.stdout) || "no output"}`, meta);
      if (run.lastMessage === undefined || !run.lastMessage.trim()) throw new BackendRunError(`codex exec wrote no last message: ${outputTail(run.stderr) || "no output"}`, meta);
      return { raw: run.lastMessage, ...meta };
    },
  };
}
