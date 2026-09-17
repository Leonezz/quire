// Snapshots every corpus entry once: eval/corpus/<slug>/page.html.gz + meta.json.
// Re-running only fetches entries without a snapshot (pass --force to refetch, or slugs to limit).
import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const force = args.includes("--force");
const only = new Set(args.filter((a) => !a.startsWith("--")));
const corpus = JSON.parse(await readFile(join(root, "corpus.json"), "utf8"));
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const CONCURRENCY = 5;

async function exists(path) { try { await access(path); return true; } catch { return false; } }

function generatorOf(html) {
  const meta = /<meta[^>]+name=["']generator["'][^>]*content=["']([^"']+)["']/i.exec(html) ?? /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']generator["']/i.exec(html);
  if (meta) return meta[1].trim();
  if (/substackcdn\.com|substack\.com\/api/.test(html)) return "Substack";
  if (/cdn-client\.medium\.com|medium\.com\/_\/graphql/.test(html)) return "Medium";
  if (/ghost-(?:cdn|sdk)|content\/images\/size/.test(html)) return "Ghost (inferred)";
  if (/wp-content\/|wp-includes\//.test(html)) return "WordPress (inferred)";
  if (/__NEXT_DATA__|\/_next\//.test(html)) return "Next.js (inferred)";
  return "";
}

async function snapshot(entry) {
  const dir = join(root, "corpus", entry.slug);
  if (!force && (await exists(join(dir, "page.html.gz")))) return { slug: entry.slug, status: "kept" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(entry.url, { redirect: "follow", signal: controller.signal, headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8" } });
    const html = await response.text();
    const meta = {
      slug: entry.slug, url: entry.url, finalUrl: response.url || entry.url, status: response.status,
      contentType: response.headers.get("content-type") ?? "", bytes: Buffer.byteLength(html), generator: generatorOf(html),
      fetchedAt: new Date().toISOString(), framework: entry.framework, tags: entry.tags,
    };
    if (!response.ok || !/html/.test(meta.contentType) || meta.bytes < 2000) {
      return { slug: entry.slug, status: `failed ${response.status} ${meta.contentType} ${meta.bytes}B` };
    }
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "page.html.gz"), gzipSync(Buffer.from(html)));
    await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
    return { slug: entry.slug, status: `ok ${meta.status} ${(meta.bytes / 1024).toFixed(0)}KB ${meta.generator || "-"}` };
  } catch (error) {
    return { slug: entry.slug, status: `error ${error.name === "AbortError" ? "timeout" : error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

const queue = corpus.filter((entry) => only.size === 0 || only.has(entry.slug));
const results = [];
let cursor = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < queue.length) {
    const entry = queue[cursor++];
    const result = await snapshot(entry);
    results.push(result);
    process.stdout.write(`${result.slug.padEnd(30)} ${result.status}\n`);
  }
}));
const failed = results.filter((r) => !r.status.startsWith("ok") && r.status !== "kept");
process.stdout.write(`\n${results.length - failed.length} snapshots, ${failed.length} failed\n`);
