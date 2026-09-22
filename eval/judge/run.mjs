// Runs the extraction quality judge (harness.test.ts through the eval package's vitest) after checking
// that Codex is installed and logged in; the options go to the harness as environment variables.
//   node run.mjs [slug ...] [--force] [--model M] [--max N] [--update-baseline] [--concurrency N]
// Set CODEX_BIN to use a codex binary that is not on PATH.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const VALUED = ["--model", "--max", "--concurrency"];
const KNOWN = new Set([...VALUED, "--force", "--update-baseline"]);
const flag = (name) => args.includes(name);
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const unknown = args.filter((arg) => arg.startsWith("--") && !KNOWN.has(arg));
if (unknown.length) { console.error(`Unknown option ${unknown.join(", ")}. Usage: judge [slug ...] [--force] [--model M] [--max N] [--update-baseline] [--concurrency N]`); process.exit(2); }
for (const name of VALUED) { if (flag(name) && (option(name) === undefined || option(name).startsWith("--"))) { console.error(`${name} needs a value.`); process.exit(2); } }
const slugs = args.filter((arg, index) => !arg.startsWith("--") && !VALUED.includes(args[index - 1] ?? ""));

const bin = process.env.CODEX_BIN ?? "codex";
const version = spawnSync(bin, ["--version"], { encoding: "utf8" });
if (version.error || version.status !== 0) {
  console.error(`Cannot run \`${bin} --version\` (${version.error?.message ?? `exit ${version.status}`}). Install codex-cli (brew install codex) or set CODEX_BIN to the binary.`);
  process.exit(1);
}
const login = spawnSync(bin, ["login", "status"], { encoding: "utf8" });
if (login.status !== 0) {
  console.error(`Codex is not logged in (${(login.stdout + login.stderr).trim() || `exit ${login.status}`}). Run \`${bin} login\` first.`);
  process.exit(1);
}
process.stdout.write(`${version.stdout.trim()} · ${(login.stdout + login.stderr).trim()}${slugs.length ? ` · cases: ${slugs.join(", ")}` : " · all snapshots"}${option("--model") ? ` · model ${option("--model")}` : ""}\n`);

const env = {
  ...process.env,
  JUDGE_CODEX_BIN: bin,
  JUDGE_ONLY: slugs.join(","),
  JUDGE_FORCE: flag("--force") ? "1" : "",
  JUDGE_UPDATE_BASELINE: flag("--update-baseline") ? "1" : "",
  ...(option("--model") ? { JUDGE_MODEL: option("--model") } : {}),
  ...(option("--max") ? { JUDGE_MAX: option("--max") } : {}),
  ...(option("--concurrency") ? { JUDGE_CONCURRENCY: option("--concurrency") } : {}),
};
const vitest = join(root, "..", "node_modules", ".bin", "vitest");
const result = spawnSync(vitest, ["run", "--config", join(root, "vitest.config.ts"), "--reporter=dot"], { cwd: root, env, stdio: "inherit" });
process.exit(result.status ?? 1);
