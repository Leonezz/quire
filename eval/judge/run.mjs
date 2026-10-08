// Runs the extraction quality judge (harness.test.ts through the eval package's vitest) after resolving
// the policy (config.json + flags) and checking that every CLI the policy needs is installed and logged
// in; the options go to the harness as environment variables.
//   node run.mjs [slug ...] [--policy single|screen-then-confirm|both] [--backend codex|claude] [--model M]
//                [--screen-model M] [--confirm-model M] [--force] [--max N] [--update-baseline] [--concurrency N]
//                [--mode visual|text]
// --backend/--model apply to --policy single; --screen-model/--confirm-model to the other two.
// --mode visual (config.json "mode", the default) needs the render capture of each case
// (pnpm --filter @read/eval render <slug>); when none of the selected cases has one, nothing runs.
// Set CODEX_BIN / CLAUDE_BIN to use a binary that is not on PATH.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { preflightClaude, preflightCodex } from "./backends/preflight.mjs";
import { captureExists, checkCaptures } from "./captures.mjs";
import { backendsNeeded, describePolicy, resolveConcurrency, resolveMaxImages, resolveMode, resolvePolicy } from "./policy-config.mjs";

const USAGE = "Usage: judge [slug ...] [--policy single|screen-then-confirm|both] [--backend codex|claude] [--model M] [--screen-model M] [--confirm-model M] [--force] [--max N] [--update-baseline] [--concurrency N] [--mode visual|text]";
const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const VALUED = ["--policy", "--backend", "--model", "--screen-model", "--confirm-model", "--max", "--concurrency", "--mode"];
const KNOWN = new Set([...VALUED, "--force", "--update-baseline"]);
const flag = (name) => args.includes(name);
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const unknown = args.filter((arg) => arg.startsWith("--") && !KNOWN.has(arg));
if (unknown.length) { console.error(`Unknown option ${unknown.join(", ")}. ${USAGE}`); process.exit(2); }
for (const name of VALUED) { if (flag(name) && (option(name) === undefined || option(name).startsWith("--"))) { console.error(`${name} needs a value.`); process.exit(2); } }
const slugs = args.filter((arg, index) => !arg.startsWith("--") && !VALUED.includes(args[index - 1] ?? ""));

const configPath = join(root, "config.json");
let config;
try { config = JSON.parse(readFileSync(configPath, "utf8")); }
catch (error) { console.error(`Cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`); process.exit(2); }

let effective;
let concurrency;
let mode;
let maxImages;
try {
  effective = resolvePolicy(config, { policy: option("--policy"), backend: option("--backend"), model: option("--model"), screenModel: option("--screen-model"), confirmModel: option("--confirm-model") });
  concurrency = resolveConcurrency(config, option("--concurrency"));
  mode = resolveMode(config, option("--mode"));
  maxImages = resolveMaxImages(config);
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  process.exit(2);
}

// Visual mode: the captures must exist before anything is spent. The selection is the named slugs,
// else every corpus entry with a snapshot (what the harness judges).
let captureLine = "";
if (mode === "visual") {
  const renderOut = join(root, "..", "render", "out");
  const corpusDir = join(root, "..", "corpus");
  const everySnapshot = () => JSON.parse(readFileSync(join(root, "..", "corpus.json"), "utf8")).map((entry) => entry.slug).filter((slug) => existsSync(join(corpusDir, slug, "page.html.gz")));
  const selected = slugs.length ? slugs : everySnapshot();
  const max = Number(option("--max") ?? 0);
  const captures = checkCaptures(max > 0 && !slugs.length ? selected.slice(0, max) : selected, (slug) => captureExists(renderOut, slug), slugs.length > 0);
  if (captures.error) { console.error(captures.error); process.exit(1); }
  if (captures.warning) console.error(captures.warning);
  captureLine = ` · visual (${captures.present.length} captured, ≤ ${maxImages} images per call)`;
}

const bins = { codex: process.env.CODEX_BIN ?? "codex", claude: process.env.CLAUDE_BIN ?? "claude" };
const PREFLIGHT = { codex: preflightCodex, claude: preflightClaude };
const checked = [];
for (const id of new Set(backendsNeeded(effective).map((spec) => spec.backend))) {
  try { checked.push(PREFLIGHT[id](bins[id])); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
process.stdout.write(`${describePolicy(effective)}\n${checked.join(" · ")}${slugs.length ? ` · cases: ${slugs.join(", ")}` : " · all snapshots"} · concurrency ${concurrency} · mode ${mode}${captureLine}\n`);

const env = {
  ...process.env,
  JUDGE_POLICY: JSON.stringify(effective),
  JUDGE_CODEX_BIN: bins.codex,
  JUDGE_CLAUDE_BIN: bins.claude,
  JUDGE_ONLY: slugs.join(","),
  JUDGE_FORCE: flag("--force") ? "1" : "",
  JUDGE_UPDATE_BASELINE: flag("--update-baseline") ? "1" : "",
  JUDGE_CONCURRENCY: String(concurrency),
  JUDGE_MODE: mode,
  JUDGE_MAX_IMAGES: String(maxImages),
  ...(option("--max") ? { JUDGE_MAX: option("--max") } : {}),
};
const vitest = join(root, "..", "node_modules", ".bin", "vitest");
const result = spawnSync(vitest, ["run", "--config", join(root, "vitest.config.ts"), "--reporter=dot"], { cwd: root, env, stdio: "inherit" });
process.exit(result.status ?? 1);
