// Publishes the judge's results: the interactive report.html, the tracking "Extraction quality report"
// issue (created once, then edited in place with a comment per update) and one "Rendering: <slug>"
// issue per MAJOR case, all through gh.
//   node publish.mjs [--html] [--issue] [--cases [--max-cases N]] [--dry-run] [--repo owner/name]
// Node strips the types of the report modules itself (Node ≥ 22.18); nothing here needs tsx or vitest.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadReportData } from "./report/data.ts";
import { renderHtml } from "./report/html.ts";
import { majorCases, renderCaseIssue, renderReportIssue } from "./report/issue.ts";

export const TRACKING_LABEL = "quality-report";
export const TRACKING_TITLE_PREFIX = "Extraction quality report";
const LABELS = {
  [TRACKING_LABEL]: { color: "0E8A16", description: "Automated extraction quality report from the judge" },
  judge: { color: "0E8A16", description: "Filed by the extraction quality judge" },
};
const DEFAULT_MAX_CASES = 5;

/**
 * @typedef {{ stdout: string; stderr: string; status: number | null; error?: Error }} GhResult
 * @typedef {(args: string[]) => GhResult} GhRunner
 * @typedef {{ html: boolean; issue: boolean; cases: boolean; dryRun: boolean; maxCases: number; repo?: string; runLabel?: string }} Flags
 * @typedef {import("./report/data.ts").ReportData} ReportData
 * @typedef {(line: string) => void} Log
 */

const USAGE = "Usage: judge:publish [--html] [--issue] [--cases [--max-cases N]] [--dry-run] [--repo owner/name] [--run-label text]";

/** @param {string[]} argv @returns {Flags} */
export function parseArgs(argv) {
  const valued = ["--max-cases", "--repo", "--run-label"];
  const known = new Set([...valued, "--html", "--issue", "--cases", "--dry-run"]);
  const unknown = argv.filter((arg) => arg.startsWith("--") && !known.has(arg));
  if (unknown.length) throw new Error(`Unknown option ${unknown.join(", ")}. ${USAGE}`);
  const positional = argv.filter((arg, index) => !arg.startsWith("--") && !valued.includes(argv[index - 1] ?? ""));
  if (positional.length) throw new Error(`Unexpected argument ${positional.join(", ")}. ${USAGE}`);
  /** @param {string} name */
  const option = (name) => {
    const at = argv.indexOf(name);
    if (at < 0) return undefined;
    const value = argv[at + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value.`);
    return value;
  };
  const maxCasesText = option("--max-cases");
  const maxCases = maxCasesText === undefined ? DEFAULT_MAX_CASES : Number(maxCasesText);
  if (!Number.isInteger(maxCases) || maxCases < 0) throw new Error(`--max-cases must be a non-negative integer, got ${maxCasesText}`);
  const flags = { html: argv.includes("--html"), issue: argv.includes("--issue"), cases: argv.includes("--cases"), dryRun: argv.includes("--dry-run"), maxCases };
  if (!flags.html && !flags.issue && !flags.cases) throw new Error(`Nothing to do: pass --html, --issue and/or --cases. ${USAGE}`);
  const repo = option("--repo");
  const runLabel = option("--run-label");
  return { ...flags, ...(repo ? { repo } : {}), ...(runLabel ? { runLabel } : {}) };
}

/** "owner/name" from a GitHub remote URL (https or ssh). @param {string} remote */
export function repoFromRemote(remote) {
  const match = remote.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (!match) throw new Error(`cannot read owner/name from remote ${remote.trim() || "(empty)"}; pass --repo owner/name`);
  return `${match[1]}/${match[2]}`;
}

/** The gh CLI as a runner; tests inject a fake. @returns {GhRunner} */
export function ghRunner(bin = "gh") {
  return (args) => {
    const result = spawnSync(bin, args, { encoding: "utf8" });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status, ...(result.error ? { error: result.error } : {}) };
  };
}

/** Runs gh and returns stdout; any failure throws with the command and stderr, so nothing is half-published quietly. @param {GhRunner} run @param {string[]} args */
export function gh(run, args) {
  const result = run(args);
  if (result.error || result.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")} failed (${result.error ? result.error.message : `exit ${result.status}`}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`);
  return result.stdout;
}

/** @param {GhRunner} run @param {string[]} args */
function ghJson(run, args) {
  const text = gh(run, args);
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`gh ${args.slice(0, 2).join(" ")} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

/** @param {GhRunner} run @param {string} repo @param {keyof typeof LABELS} name @param {Log} log */
export function ensureLabel(run, repo, name, log) {
  /** @type {{ name: string }[]} */
  const labels = ghJson(run, ["label", "list", "--repo", repo, "--json", "name", "--search", name, "--limit", "100"]);
  if (labels.some((label) => label.name === name)) return;
  gh(run, ["label", "create", name, "--repo", repo, "--color", LABELS[name].color, "--description", LABELS[name].description]);
  log(`Created label ${name}.`);
}

/** The open tracking issue's number, if one exists. @param {GhRunner} run @param {string} repo */
export function findTrackingIssue(run, repo) {
  /** @type {{ number: number; title: string }[]} */
  const issues = ghJson(run, ["issue", "list", "--repo", repo, "--state", "open", "--label", TRACKING_LABEL, "--json", "number,title", "--limit", "50"]);
  return issues.find((issue) => issue.title.startsWith(TRACKING_TITLE_PREFIX))?.number;
}

/** Whether an open issue already names the slug in its title. @param {GhRunner} run @param {string} repo @param {string} slug */
export function hasOpenCaseIssue(run, repo, slug) {
  /** @type {{ title: string }[]} */
  const issues = ghJson(run, ["issue", "list", "--repo", repo, "--state", "open", "--search", `${slug} in:title`, "--json", "title", "--limit", "50"]);
  return issues.some((issue) => issue.title.includes(slug));
}

/** One line for the update comment: verdict counts and the movement against the baseline. @param {ReportData} data */
export function deltaSummary(data) {
  const { totals } = data;
  const movement = [
    data.regressions.length ? `${data.regressions.length} regressed (${data.regressions.map((c) => c.slug).join(", ")})` : "",
    data.improvements.length ? `${data.improvements.length} improved (${data.improvements.map((c) => c.slug).join(", ")})` : "",
  ].filter(Boolean).join(", ") || "no verdict changes";
  return `${totals.PASS} PASS / ${totals.MINOR} MINOR / ${totals.MAJOR} MAJOR${totals.errors ? ` / ${totals.errors} errors` : ""}; ${movement} vs baseline.`;
}

/** Runs fn with the body in a temp file (gh reads --body-file), then removes it. @template T @param {string} body @param {(path: string) => T} fn */
function withBodyFile(body, fn) {
  const dir = mkdtempSync(join(tmpdir(), "judge-publish-"));
  try { const path = join(dir, "body.md"); writeFileSync(path, body); return fn(path); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

/** @param {{ data: ReportData; repo: string; runLabel?: string; run: GhRunner; dryRun: boolean; log: Log }} options @returns {{ action: "created" | "updated" | "dry-run"; number?: number; url?: string }} */
export function publishTrackingIssue({ data, repo, runLabel, run, dryRun, log }) {
  const issue = renderReportIssue(data, { repo, ...(runLabel ? { runLabel } : {}) });
  if (dryRun) {
    log(`[dry-run] tracking issue (${issue.body.length} chars, label ${TRACKING_LABEL})`);
    log(`Title: ${issue.title}`);
    log("");
    log(issue.body);
    return { action: "dry-run" };
  }
  ensureLabel(run, repo, TRACKING_LABEL, log);
  const existing = findTrackingIssue(run, repo);
  if (existing !== undefined) {
    withBodyFile(issue.body, (path) => gh(run, ["issue", "edit", String(existing), "--repo", repo, "--title", issue.title, "--body-file", path]));
    gh(run, ["issue", "comment", String(existing), "--repo", repo, "--body", `Updated ${data.generatedAt.slice(0, 10)}: ${deltaSummary(data)}`]);
    log(`Updated issue #${existing}: ${issue.title}`);
    return { action: "updated", number: existing };
  }
  const url = withBodyFile(issue.body, (path) => gh(run, ["issue", "create", "--repo", repo, "--title", issue.title, "--body-file", path, "--label", TRACKING_LABEL])).trim();
  log(`Created ${url}: ${issue.title}`);
  return { action: "created", url };
}

/** @param {{ data: ReportData; repo: string; run: GhRunner; dryRun: boolean; maxCases: number; log: Log }} options @returns {{ filed: string[]; skipped: string[]; left: string[] }} */
export function publishCaseIssues({ data, repo, run, dryRun, maxCases, log }) {
  const candidates = majorCases(data);
  // "rendering" is the issue template's own label and is expected to exist; gh issue create fails loudly if not.
  if (!dryRun) ensureLabel(run, repo, "judge", log);
  const outcome = candidates.reduce((acc, row) => {
    if (acc.filed.length >= maxCases) return { ...acc, left: [...acc.left, row.slug] };
    if (!dryRun && hasOpenCaseIssue(run, repo, row.slug)) { log(`Skipped ${row.slug}: an open issue already names it.`); return { ...acc, skipped: [...acc.skipped, row.slug] }; }
    const issue = renderCaseIssue(row, { repo });
    if (dryRun) {
      log(`[dry-run] case issue for ${row.slug} (labels ${issue.labels.join(", ")})`);
      log(`Title: ${issue.title}`);
      log("");
      log(issue.body);
    } else {
      const url = withBodyFile(issue.body, (path) => gh(run, ["issue", "create", "--repo", repo, "--title", issue.title, "--body-file", path, ...issue.labels.flatMap((label) => ["--label", label])])).trim();
      log(`Filed ${url}: ${issue.title}`);
    }
    return { ...acc, filed: [...acc.filed, row.slug] };
  }, { filed: /** @type {string[]} */ ([]), skipped: /** @type {string[]} */ ([]), left: /** @type {string[]} */ ([]) });
  log(`${dryRun ? "Would file" : "Filed"} ${outcome.filed.length} of ${candidates.length} MAJOR case${candidates.length === 1 ? "" : "s"}${outcome.skipped.length ? `, skipped ${outcome.skipped.length} already open` : ""}${outcome.left.length ? `, ${outcome.left.length} left (raise --max-cases)` : ""}.`);
  return outcome;
}

/** @param {{ flags: Flags; data: ReportData; repo: string; run: GhRunner; log: Log; htmlPath: string; writeFile?: (path: string, text: string) => void }} options */
export function publish({ flags, data, repo, run, log, htmlPath, writeFile = writeFileSync }) {
  if (flags.html) {
    writeFile(htmlPath, renderHtml(data));
    log(`Wrote ${htmlPath} (${data.totals.cases} cases, ${data.totals.errors} errors).`);
  }
  const tracking = flags.issue ? publishTrackingIssue({ data, repo, run, dryRun: flags.dryRun, log, ...(flags.runLabel ? { runLabel: flags.runLabel } : {}) }) : undefined;
  const cases = flags.cases ? publishCaseIssues({ data, repo, run, dryRun: flags.dryRun, maxCases: flags.maxCases, log }) : undefined;
  return { tracking, cases };
}

function main() {
  const root = dirname(fileURLToPath(import.meta.url));
  /** @type {Log} */
  const log = (line) => process.stdout.write(`${line}\n`);
  try {
    const flags = parseArgs(process.argv.slice(2));
    const repo = flags.repo ?? repoFromRemote((() => {
      const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" });
      if (remote.error || remote.status !== 0) throw new Error(`git remote get-url origin failed (${remote.error?.message ?? remote.stderr.trim()}); pass --repo owner/name`);
      return remote.stdout;
    })());
    const data = loadReportData({ outDir: join(root, "out"), baselinePath: join(root, "baseline.json"), corpusPath: join(root, "..", "corpus.json") });
    publish({ flags, data, repo, run: ghRunner(), log, htmlPath: join(root, "report.html") });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
