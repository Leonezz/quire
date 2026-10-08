// The Claude Code backend: `claude -p` with no tools, plan permission mode, one turn, the answer
// schema on the command line, the prompt on stdin, nothing persisted. The runner is a parameter so
// tests can judge without the CLI.
//
// The JSON envelope (`--output-format json`) is one object: { type: "result", is_error, result,
// structured_output?, total_cost_usd, usage: { input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens }, modelUsage: { "<model id>": {...} } }. Newer versions put the
// schema-conforming answer in structured_output; older ones only print it as the `result` text.
// `is_error` is the failure signal: a failed call still says subtype "success" (seen on 2.1.x).
//
// Images only go in through stream-json (`--input-format stream-json --output-format stream-json
// --verbose`): stdin is one JSON line, a user message whose content is the base64 image blocks then
// the prompt text; stdout is JSON lines (system init, assistant turns, ...) ending with the same
// result envelope as `{"type":"result",...}`. Without images the plain `--output-format json` path is kept.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightClaude } from "./preflight.mjs";
import { BackendRunError, outputTail, type BackendRunMeta, type JudgeBackend } from "./types";

export interface ClaudeCall { prompt: string; schema: unknown; model: string | undefined; bin: string; timeoutMs: number; images?: string[] }
export interface ClaudeRun { stdout: string; stderr: string; status: number | null; timedOut: boolean }
export type ClaudeRunner = (call: ClaudeCall) => Promise<ClaudeRun>;

/** The arguments that make `claude` answer once, with no tools, and print the JSON envelope (or, with `stream`, take and print stream-json). */
export function claudeArgs(model: string | undefined, schema: unknown, stream = false): string[] {
  return [
    "-p",
    ...(model ? ["--model", model] : []),
    ...(stream ? ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] : ["--output-format", "json"]),
    "--json-schema", JSON.stringify(schema),
    "--no-session-persistence",
    "--tools", "",
    "--permission-mode", "plan",
    "--max-turns", "3",
    "--strict-mcp-config",
    "--disable-slash-commands",
  ];
}

const MEDIA_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** The media type of an image file by its extension; anything else is an error, never a guess. */
export function imageMediaType(path: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  const type = MEDIA_TYPES[extension];
  if (!type) throw new Error(`cannot attach ${path}: only ${Object.keys(MEDIA_TYPES).join(", ")} images are supported`);
  return type;
}

export interface EncodedImage { mediaType: string; data: string }

/** The one stdin line stream-json input takes: a user message with the images first, then the prompt. */
export function claudeStreamMessage(prompt: string, images: readonly EncodedImage[]): string {
  const content = [
    ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
    { type: "text", text: prompt },
  ];
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

const encodeImages = (paths: readonly string[]): Promise<EncodedImage[]> => Promise.all(paths.map(async (path) => ({ mediaType: imageMediaType(path), data: (await readFile(path)).toString("base64") })));

/** The real thing: `claude -p` in a fresh temp directory so no project settings, CLAUDE.md or MCP servers load. */
export const runClaudePrint: ClaudeRunner = async ({ prompt, schema, model, bin, timeoutMs, images = [] }) => {
  const stream = images.length > 0;
  const stdin = stream ? claudeStreamMessage(prompt, await encodeImages(images)) : prompt;
  const dir = await mkdtemp(join(tmpdir(), "quire-judge-claude-"));
  try {
    // CLAUDECODE marks a nested session; a judge run started from inside Claude Code must not inherit it.
    const { CLAUDECODE: _nested, ...env } = process.env;
    return await new Promise<ClaudeRun>((resolve, reject) => {
      const child = spawn(bin, claudeArgs(model, schema, stream), { cwd: dir, stdio: ["pipe", "pipe", "pipe"], env: { ...env, NO_COLOR: "1" } });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (status) => { clearTimeout(timer); resolve({ stdout, stderr, status, timedOut }); });
      child.stdin.on("error", () => { /* the process exited before reading the prompt; `close` reports it */ });
      child.stdin.end(stdin);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export interface ClaudeEnvelope extends BackendRunMeta {
  raw: string;
  /** Where the answer came from: the structured_output field or the result text. */
  answerFrom: "structured_output" | "result";
}

export class ClaudeEnvelopeError extends BackendRunError {
  constructor(message: string, meta: BackendRunMeta = {}) { super(message, meta); this.name = "ClaudeEnvelopeError"; }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const asNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** The result envelope in stdout: the whole output, or the last line that is one (the CLI may print warnings first). */
function findEnvelope(stdout: string): Record<string, unknown> | undefined {
  const candidates = [stdout.trim(), ...stdout.trim().split("\n").reverse().map((line) => line.trim())];
  for (const text of candidates) {
    if (!text.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && ("is_error" in parsed || parsed.type === "result")) return parsed;
    } catch { /* not this one */ }
  }
  return undefined;
}

/** total_cost_usd, the usage token counts summed, and the model ids modelUsage names. */
export function claudeEnvelopeMeta(envelope: Record<string, unknown>): BackendRunMeta {
  const costUsd = asNumber(envelope.total_cost_usd);
  const usage = isRecord(envelope.usage) ? envelope.usage : undefined;
  const counts = usage ? ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].map((field) => asNumber(usage[field])).filter((count): count is number => count !== undefined) : [];
  const models = isRecord(envelope.modelUsage) ? Object.keys(envelope.modelUsage) : [];
  return {
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(counts.length ? { tokens: counts.reduce((sum, count) => sum + count, 0) } : {}),
    ...(models.length ? { resolvedModel: models.join("+") } : {}),
  };
}

const FENCE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
/** The result text without a ```json fence, when the model wrapped its answer in one. */
export const unfence = (text: string): string => FENCE.exec(text.trim())?.[1] ?? text.trim();

/** The `{"type":"result"}` line of stream-json output: the last one, as later lines win. */
function findStreamResult(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.trim().split("\n").reverse()) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && parsed.type === "result") return parsed;
    } catch { /* not a JSON line */ }
  }
  return undefined;
}

/** Reads the envelope; throws ClaudeEnvelopeError (with the meta it could read) when the call failed or printed no answer. */
export function parseClaudeEnvelope(stdout: string): ClaudeEnvelope {
  const envelope = findEnvelope(stdout);
  if (!envelope) throw new ClaudeEnvelopeError(`claude -p printed no JSON result envelope: ${outputTail(stdout) || "no output"}`);
  return readEnvelope(envelope);
}

/** Reads the result line of stream-json output (the same envelope, one line among many); throws ClaudeEnvelopeError like parseClaudeEnvelope. */
export function parseClaudeStream(stdout: string): ClaudeEnvelope {
  const envelope = findStreamResult(stdout);
  if (!envelope) throw new ClaudeEnvelopeError(`claude -p (stream-json) printed no {"type":"result"} line: ${outputTail(stdout) || "no output"}`);
  return readEnvelope(envelope);
}

function readEnvelope(envelope: Record<string, unknown>): ClaudeEnvelope {
  const meta = claudeEnvelopeMeta(envelope);
  if (envelope.is_error === true) {
    const errors = Array.isArray(envelope.errors) ? envelope.errors.filter((item): item is string => typeof item === "string") : [];
    const said = typeof envelope.result === "string" && envelope.result.trim() ? envelope.result.trim() : errors.join("; ") || (typeof envelope.subtype === "string" ? envelope.subtype : "no message");
    throw new ClaudeEnvelopeError(`claude -p reported an error: ${outputTail(said)}`, meta);
  }
  if (envelope.structured_output !== undefined && envelope.structured_output !== null) {
    return { ...meta, raw: JSON.stringify(envelope.structured_output), answerFrom: "structured_output" };
  }
  if (typeof envelope.result !== "string" || !envelope.result.trim()) throw new ClaudeEnvelopeError("claude -p returned neither structured_output nor a result text", meta);
  return { ...meta, raw: unfence(envelope.result), answerFrom: "result" };
}

export interface ClaudeBackendOptions {
  bin: string;
  /** An alias ("haiku", "sonnet", "opus") or a full id ("claude-haiku-4-5"); "default" leaves --model out. */
  model: string;
  runner?: ClaudeRunner;
  env?: Record<string, string | undefined>;
}

export function claudeBackend({ bin, model, runner = runClaudePrint, env = process.env }: ClaudeBackendOptions): JudgeBackend {
  return {
    id: "claude",
    model,
    preflight: async () => { preflightClaude(bin, env); },
    run: async ({ prompt, schema, timeoutMs, images }) => {
      const stream = (images?.length ?? 0) > 0;
      const run = await runner({ prompt, schema, model: model === "default" ? undefined : model, bin, timeoutMs, ...(stream ? { images } : {}) });
      if (run.timedOut) throw new BackendRunError(`claude -p exceeded ${timeoutMs} ms and was killed`);
      const envelope = stream ? findStreamResult(run.stdout) : findEnvelope(run.stdout);
      // A non-zero exit with an envelope is an is_error result: the parser reports its message.
      if (run.status !== 0 && !envelope) throw new BackendRunError(`claude -p exited with ${String(run.status)}: ${outputTail(run.stderr) || outputTail(run.stdout) || "no output"}`);
      const { raw, answerFrom: _answerFrom, ...meta } = stream ? parseClaudeStream(run.stdout) : parseClaudeEnvelope(run.stdout);
      return { raw, ...meta };
    },
  };
}
