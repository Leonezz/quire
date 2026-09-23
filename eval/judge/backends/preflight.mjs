// Is each judge CLI installed and logged in? Plain JS so run.mjs can fail fast before vitest boots,
// and the TypeScript backends can call the same checks from preflight(). Every failure is an Error
// whose message says what to do.
import { spawnSync } from "node:child_process";

const CLAUDE_NOT_LOGGED_IN = "Claude Code is not logged in: run `claude login` (or set ANTHROPIC_API_KEY) — or pass --backend codex";

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {string} name what to do when the binary cannot run
 * @returns {ReturnType<typeof spawnSync<string>>}
 */
function tryRun(bin, args, name) {
  const result = spawnSync(bin, args, { encoding: "utf8" });
  if (result.error) throw new Error(`Cannot run \`${bin} ${args.join(" ")}\` (${result.error.message}). ${name}`);
  return result;
}

/**
 * Codex: `codex --version` runs and `codex login status` succeeds.
 * @param {string} bin
 * @returns {string} one line describing the version and login, for the run header
 */
export function preflightCodex(bin) {
  const version = tryRun(bin, ["--version"], "Install codex-cli (brew install codex) or set CODEX_BIN to the binary — or pass --backend claude.");
  if (version.status !== 0) throw new Error(`\`${bin} --version\` exited with ${String(version.status)}. Install codex-cli (brew install codex) or set CODEX_BIN to the binary — or pass --backend claude.`);
  const login = spawnSync(bin, ["login", "status"], { encoding: "utf8" });
  const said = `${login.stdout ?? ""}${login.stderr ?? ""}`.trim();
  if (login.status !== 0) throw new Error(`Codex is not logged in (${said || `exit ${String(login.status)}`}). Run \`${bin} login\` first — or pass --backend claude.`);
  return `${version.stdout.trim()} · ${said}`;
}

/**
 * Claude Code: ANTHROPIC_API_KEY counts as logged in; otherwise `claude auth status` must report
 * loggedIn true. A wrapper on PATH that reports another version is fine; only the auth matters.
 * @param {string} bin
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} one line describing the version and login, for the run header
 */
export function preflightClaude(bin, env = process.env) {
  const version = tryRun(bin, ["--version"], "Install Claude Code (npm install -g @anthropic-ai/claude-code) or set CLAUDE_BIN to the binary — or pass --backend codex.");
  if (version.status !== 0) throw new Error(`\`${bin} --version\` exited with ${String(version.status)}. Install Claude Code or set CLAUDE_BIN to the binary — or pass --backend codex.`);
  const label = `claude ${version.stdout.trim()}`;
  if (env.ANTHROPIC_API_KEY) return `${label} · ANTHROPIC_API_KEY set`;
  const status = spawnSync(bin, ["auth", "status"], { encoding: "utf8", env: { ...env } });
  const auth = parseAuthStatus(status.stdout ?? "");
  if (!auth) throw new Error(`Cannot tell whether Claude Code is logged in: \`${bin} auth status\` printed no JSON (${`${status.stdout ?? ""}${status.stderr ?? ""}`.trim().slice(-300) || `exit ${String(status.status)}`}). Upgrade Claude Code, set ANTHROPIC_API_KEY — or pass --backend codex.`);
  if (auth.loggedIn !== true) throw new Error(CLAUDE_NOT_LOGGED_IN);
  return `${label} · logged in${typeof auth.authMethod === "string" ? ` via ${auth.authMethod}` : ""}${typeof auth.email === "string" ? ` as ${auth.email}` : ""}`;
}

/**
 * The JSON object `claude auth status` prints, when it printed one.
 * @param {string} stdout
 * @returns {Record<string, unknown> | undefined}
 */
export function parseAuthStatus(stdout) {
  const text = stdout.trim();
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
