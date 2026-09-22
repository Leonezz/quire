// One judge call: build the prompt, run `codex exec` with the answer schema in a scratch directory,
// parse the last message strictly, verify the evidence quotes. The runner is a parameter so tests
// can judge without Codex.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey, type JudgeResult } from "./cache";
import { AnswerFormatError, ANSWER_SCHEMA, RUBRIC_VERSION, buildPrompt, evidenceOccurs, parseAnswer, type PromptInput } from "./rubric";

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

export interface JudgeCaseOptions { runner: CodexRunner; bin: string; model: string | undefined; timeoutMs: number; now?: () => Date }

const MAX_STDERR = 4_000;
const tail = (text: string) => text.trim().slice(-MAX_STDERR);

/** Judges one case. Never throws for a bad answer: that is a FailedCase with the reason and the raw text. */
export async function judgeCase(input: PromptInput, options: JudgeCaseOptions): Promise<JudgeResult> {
  const model = options.model ?? "default";
  const base = { key: cacheKey(input.source, input.extracted, RUBRIC_VERSION, model), slug: input.slug, model, rubricVersion: RUBRIC_VERSION, truncated: input.truncated.source || input.truncated.extracted };
  const started = Date.now();
  const finish = <T extends object>(fields: T) => ({ ...base, ...fields, wallMs: Date.now() - started, judgedAt: (options.now ?? (() => new Date()))().toISOString() });
  let run: CodexRun;
  try { run = await options.runner({ prompt: buildPrompt(input), schema: ANSWER_SCHEMA, model: options.model, bin: options.bin, timeoutMs: options.timeoutMs }); }
  catch (error) { return finish({ error: `codex could not start: ${error instanceof Error ? error.message : String(error)}` }); }
  const resolvedModel = parseResolvedModel(run.stderr);
  const tokens = parseTokens(run.stderr);
  const meta = { ...(resolvedModel ? { resolvedModel } : {}), ...(tokens !== undefined ? { tokens } : {}) };
  if (run.timedOut) return finish({ ...meta, error: `codex exec exceeded ${options.timeoutMs} ms and was killed` });
  if (run.status !== 0) return finish({ ...meta, error: `codex exec exited with ${String(run.status)}: ${tail(run.stderr) || tail(run.stdout) || "no output"}` });
  if (run.lastMessage === undefined || !run.lastMessage.trim()) return finish({ ...meta, error: `codex exec wrote no last message: ${tail(run.stderr) || "no output"}` });
  try {
    const answer = parseAnswer(run.lastMessage);
    return finish({ ...meta, verdict: answer.verdict, issues: answer.issues.map((issue) => ({ ...issue, verified: evidenceOccurs(issue.evidence, input.source, input.extracted) })), summary: answer.summary });
  } catch (error) {
    if (error instanceof AnswerFormatError) return finish({ ...meta, error: error.message, rawAnswer: run.lastMessage.slice(0, MAX_STDERR) });
    throw error;
  }
}
