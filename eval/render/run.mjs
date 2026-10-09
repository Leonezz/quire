// Render capture for the visual judge: exports the preview corpus, builds and serves the renderer, and
// captures each case (reader tiles + original-page tiles + RenderMetrics) into eval/render/out/<slug>/.
//   node render/run.mjs [slug ...] [--force] [--max-tiles N] [--max-reference-tiles N] [--width PX] [--no-build] [--concurrency N]
// Node strips the types of the .ts modules itself (Node >= 22.18). Exits non-zero when any case failed;
// the other cases still complete.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { parseRenderArgs } from "./args.ts";
import { captureCase, TILE_HEIGHT } from "./capture.mjs";
import { createImageFetcher, imageUrlsOf } from "./image-proxy.ts";
import { imageNodesOf } from "./images.ts";
import { cachedManifest, captureCodeId, captureKey, rendererBuildId, summaryLine } from "./manifest.ts";
import { startStaticServer } from "./server.ts";

const here = dirname(fileURLToPath(import.meta.url));
const EVAL = join(here, "..");
const REPO = join(EVAL, "..");
const DESKTOP = join(REPO, "apps", "desktop");
const RENDERER_OUT = join(DESKTOP, "out", "renderer");
const PREVIEW = join(DESKTOP, "src", "renderer", "public", "dev", "corpus");
const CORPUS = join(EVAL, "corpus");
const OUT = join(here, "out");

const fail = (message, code = 1) => { console.error(message); process.exit(code); };

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) fail(`${command} ${args.join(" ")} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed (exit ${result.status}):\n${(result.stdout ?? "").slice(-4000)}\n${(result.stderr ?? "").slice(-4000)}`);
  return result;
}

/** The slugs to capture: the named ones (each must have a snapshot) or every snapshotted corpus entry. */
function selectSlugs(named) {
  const entries = JSON.parse(readFileSync(join(EVAL, "corpus.json"), "utf8"));
  const snapshotted = entries.map((e) => e.slug).filter((slug) => existsSync(join(CORPUS, slug, "page.html.gz")));
  if (!named.length) return snapshotted;
  const missing = named.filter((slug) => !snapshotted.includes(slug));
  if (missing.length) fail(`No snapshot for ${missing.join(", ")} (not in eval/corpus.json or not fetched; run \`pnpm --filter @read/eval fetch\`).`, 2);
  return named;
}

function exportCorpus(slugs, all) {
  const dir = mkdtempSync(join(tmpdir(), "render-export-"));
  const resultPath = join(dir, "result.json");
  try {
    run(join(EVAL, "node_modules", ".bin", "vitest"), ["run", "src/export.test.ts"], { cwd: EVAL, env: { ...process.env, EXPORT: "1", EXPORT_SLUGS: all ? "" : slugs.join(","), EXPORT_RESULT: resultPath } });
    if (!existsSync(resultPath)) fail("The export ran but wrote no result (is EXPORT honoured by src/export.test.ts?).");
    return JSON.parse(readFileSync(resultPath, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function pool(items, concurrency, work) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
  }));
}

let flags;
try { flags = parseRenderArgs(process.argv.slice(2)); } catch (error) { fail(error instanceof Error ? error.message : String(error), 2); }
const started = Date.now();
const slugs = selectSlugs(flags.slugs);

console.log(`export: ${flags.slugs.length ? slugs.join(", ") : `all ${slugs.length} snapshots`}`);
const exported = exportCorpus(slugs, !flags.slugs.length);
const extractionFailed = new Map(exported.failed.map((f) => [f.slug, f.problems]));

if (flags.build) {
  console.log("build: electron-vite build (renderer → apps/desktop/out/renderer)");
  run("pnpm", ["--filter", "@read/desktop", "exec", "electron-vite", "build"], { cwd: REPO });
}
let buildId;
try { buildId = rendererBuildId(RENDERER_OUT); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }

const index = new Map(JSON.parse(readFileSync(join(PREVIEW, "index.json"), "utf8")).map((entry) => [entry.slug, entry]));
const viewport = { width: flags.width, height: TILE_HEIGHT, deviceScaleFactor: 1 };
const codeId = captureCodeId(here);
const failures = [];
const jobs = [];
let cached = 0;
for (const slug of slugs) {
  const entry = index.get(slug);
  if (!entry) {
    const problems = extractionFailed.get(slug);
    failures.push({ slug, reason: problems ? `extraction failed (${problems.join(", ") || "no problem code"}); nothing to render` : "not in the preview corpus index after export" });
    rmSync(join(OUT, slug, "manifest.json"), { force: true });
    continue;
  }
  const recordPath = join(PREVIEW, `${entry.id}.json`);
  const record = readFileSync(recordPath);
  const snapshotGz = readFileSync(join(CORPUS, slug, "page.html.gz"));
  const meta = JSON.parse(readFileSync(join(CORPUS, slug, "meta.json"), "utf8"));
  const key = captureKey({ record, snapshot: snapshotGz, buildId, codeId, viewport, maxTiles: flags.maxTiles, maxReferenceTiles: flags.maxReferenceTiles });
  const hit = flags.force ? undefined : cachedManifest(join(OUT, slug, "manifest.json"), key);
  if (hit) { cached += 1; console.log(summaryLine(hit, "cached")); continue; }
  const charset = /charset=([^;\s]+)/i.exec(meta.contentType ?? "")?.[1];
  const parsed = JSON.parse(record.toString("utf8"));
  const imageUrls = parsed.reader?.payload ? imageUrlsOf(parsed.reader.payload) : [];
  const imageNodes = parsed.reader?.payload ? imageNodesOf(parsed.reader.payload) : [];
  jobs.push({ slug, id: entry.id, title: String(parsed.title ?? ""), finalUrl: meta.finalUrl, imageUrls, imageNodes, snapshotGz, charset, key });
}

let fresh = 0;
if (jobs.length) {
  const server = await startStaticServer([{ prefix: "/", dir: RENDERER_OUT }, { prefix: "/dev/corpus", dir: PREVIEW }]);
  const browser = await chromium.launch();
  const fetchImage = createImageFetcher(join(OUT, ".images"));
  try {
    await pool(jobs, flags.concurrency, async (job) => {
      try {
        const manifest = await captureCase({ ...job, browser, origin: server.origin, outDir: join(OUT, job.slug), width: flags.width, maxTiles: flags.maxTiles, maxReferenceTiles: flags.maxReferenceTiles, fetchImage });
        fresh += 1;
        console.log(summaryLine(manifest, "fresh"));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push({ slug: job.slug, reason });
        console.error(`${job.slug.padEnd(24)}  FAILED  ${reason}`);
      }
    });
  } finally {
    await browser.close();
    await server.close();
  }
}

for (const { slug, reason } of failures.filter((f) => !jobs.some((j) => j.slug === f.slug))) console.error(`${slug.padEnd(24)}  FAILED  ${reason}`);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${slugs.length} cases · ${fresh} fresh · ${cached} cached · ${failures.length} failed · ${seconds} s · out: ${OUT}`);
if (failures.length) {
  console.error(`Failed: ${failures.map((f) => f.slug).join(", ")}`);
  process.exit(1);
}
