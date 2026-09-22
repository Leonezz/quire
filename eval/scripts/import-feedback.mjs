// Turns an app feedback bundle (report.json + meta.json + page.html.gz, written by "Report rendering
// problem") into a corpus case: eval/corpus/<slug>/{meta.json,page.html.gz} and an entry in corpus.json.
//   node import-feedback.mjs <bundleDir|bundle.zip> [--slug s]
// Refuses when the bundle has no capture or the slug is already taken (pick another with --slug).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GENERIC_HOST_LABELS = new Set(["www", "blog", "blogs", "docs", "news", "posts", "web", "m", "en", "zh"]);
const SLUG_MAX = 60;

const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * A corpus slug from a URL, in the corpus's own style (`<site>-<page>`): the site's distinctive host
 * label plus the last path segment (`simonwillison.net/2024/Dec/31/llms-in-2024/` → `simonwillison-llms-in-2024`).
 * @param {string} url
 */
export function deriveSlug(url) {
  const parsed = new URL(url);
  const labels = parsed.hostname.split(".").filter(Boolean);
  const site = labels.length > 2 && GENERIC_HOST_LABELS.has(labels[0]) ? labels[1] : labels[0] === "www" && labels.length > 1 ? labels[1] : labels[0];
  // Strip a file extension, but not the fraction of a numeric id like arxiv's 2609.24983.
  const segments = parsed.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment)).map((segment) => (/^\d+\.\d+(v\d+)?$/i.test(segment) ? segment : segment.replace(/\.[a-z0-9]{1,5}$/i, "")));
  const meaningful = segments.filter((segment) => slugify(segment));
  // The last named segment is the page. Date parts (2024, 07, 21) are dropped; an identifier-like tail
  // (arxiv's 2609.24983, a version like v2) is kept, and a format segment such as "html" is dropped.
  const datePart = (segment) => /^\d{1,4}$/.test(segment) || /^[a-z]{3}$/i.test(segment) && Number.isNaN(Number(segment)) && ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].includes(segment.toLowerCase());
  const identifier = (segment) => /^\d+\.\d+(v\d+)?$/i.test(segment) || /^\d{5,}$/.test(segment) || /^v\d+$/i.test(segment);
  const format = (segment) => ["html", "pdf", "abs"].includes(segment.toLowerCase());
  const kept = meaningful.filter((segment) => !datePart(segment) && !format(segment));
  const named = [...kept].reverse().find((segment) => !identifier(segment));
  const ids = kept.filter(identifier);
  const page = [named, ...ids].filter(Boolean).join("-") || "home";
  const slug = `${slugify(site)}-${slugify(page)}`.slice(0, SLUG_MAX).replace(/-+$/, "");
  if (!slugify(site)) throw new Error(`cannot derive a slug from ${url}`);
  return slug;
}

/**
 * corpus.json with one more entry; returns the JSON text to write (immutable: the input text is not
 * changed). Throws when the slug is already present. Keeps the file's trailing-newline convention.
 * @param {string} corpusText
 * @param {{ slug: string; url: string; framework: string; tags: readonly string[] }} entry
 */
export function appendCorpusEntry(corpusText, entry) {
  const entries = JSON.parse(corpusText);
  if (!Array.isArray(entries)) throw new Error("corpus.json is not an array");
  if (entries.some((existing) => existing.slug === entry.slug)) throw new Error(`slug ${entry.slug} already exists in corpus.json; pass --slug <other> to import under another name`);
  const next = [...entries, { slug: entry.slug, url: entry.url, framework: entry.framework, tags: [...entry.tags] }];
  return JSON.stringify(next, null, 2) + (corpusText.endsWith("\n") ? "\n" : "");
}

/** The bundle's files: the directory itself, or the zip unpacked into a temp directory (cleaned up by the caller). */
function openBundle(path) {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  if (statSync(path).isDirectory()) return { dir: path, cleanup: () => {} };
  if (!/\.zip$/i.test(path)) throw new Error(`${path} is neither a directory nor a .zip`);
  const dir = mkdtempSync(join(tmpdir(), "quire-feedback-"));
  const unzip = spawnSync("unzip", ["-o", "-q", path, "-d", dir], { encoding: "utf8" });
  if (unzip.error || unzip.status !== 0) { rmSync(dir, { recursive: true, force: true }); throw new Error(`unzip failed for ${path}: ${unzip.error?.message ?? unzip.stderr.trim() ?? `exit ${unzip.status}`}`); }
  // A zip made from the bundle directory holds the files under one top-level folder.
  const inner = existsSync(join(dir, "report.json")) ? dir : join(dir, basename(path, ".zip"));
  return { dir: inner, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The import itself, against any eval root (tests use a temp one).
 * @param {{ bundlePath: string; evalRoot: string; slugOverride?: string }} options
 * @returns {{ slug: string; url: string; tags: string[]; framework: string; target: string }}
 */
export function importFeedback({ bundlePath, evalRoot, slugOverride }) {
  const { dir, cleanup } = openBundle(bundlePath);
  try {
    const reportPath = join(dir, "report.json");
    const metaPath = join(dir, "meta.json");
    const capturePath = join(dir, "page.html.gz");
    if (!existsSync(reportPath)) throw new Error(`${dir} has no report.json; is this a feedback bundle?`);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    if (!existsSync(capturePath) || !report.capture?.included) throw new Error(`${dir} has no page.html.gz: the reader did not include the captured page, so there is nothing to evaluate.`);
    if (!existsSync(metaPath)) throw new Error(`${dir} has no meta.json`);
    const url = report.url;
    if (typeof url !== "string" || !url) throw new Error("report.json has no url");
    const bundleMeta = JSON.parse(readFileSync(metaPath, "utf8"));
    const slug = slugOverride ?? deriveSlug(url);
    const corpusDir = join(evalRoot, "corpus");
    const target = join(corpusDir, slug);
    if (existsSync(target)) throw new Error(`eval/corpus/${slug} already exists; pass --slug <other> to import under another name`);
    const corpusPath = join(evalRoot, "corpus.json");
    const tags = [...new Set([...(Array.isArray(report.kinds) ? report.kinds : []), "feedback"])];
    const framework = typeof bundleMeta.framework === "string" && bundleMeta.framework ? bundleMeta.framework : "unknown";
    const corpusText = appendCorpusEntry(readFileSync(corpusPath, "utf8"), { slug, url, framework, tags });
    mkdirSync(target, { recursive: true });
    copyFileSync(capturePath, join(target, "page.html.gz"));
    writeFileSync(join(target, "meta.json"), `${JSON.stringify({ ...bundleMeta, slug, url, framework, tags }, null, 2)}\n`);
    writeFileSync(corpusPath, corpusText);
    return { slug, url, tags, framework, target };
  } finally {
    cleanup();
  }
}

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--slug");
  const slugOverride = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && (!slugOverride || slugOverride.startsWith("--"))) { console.error("--slug needs a value."); process.exit(2); }
  const positional = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--slug");
  if (positional.length !== 1) { console.error("Usage: import-feedback <bundleDir|bundle.zip> [--slug s]"); process.exit(2); }
  const evalRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const imported = importFeedback({ bundlePath: positional[0], evalRoot, slugOverride });
    process.stdout.write([
      `Imported ${imported.url} as ${imported.slug} (${imported.framework}; tags ${imported.tags.join(", ")}) → ${imported.target}`,
      "Next:",
      `  cd eval && GOLDEN=1 npx vitest run -t ${imported.slug}      # write the golden for the new case`,
      `  pnpm --filter @read/eval judge ${imported.slug}             # judge it`,
      "",
    ].join("\n"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
