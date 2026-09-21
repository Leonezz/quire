// Downloads the PDF eval corpus once: eval/pdf/corpus/<slug>.pdf (local only, never committed).
// Re-running fetches only what is missing (--force refetches; slugs limit the set). Failures are reported, not fatal.
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const force = args.includes("--force");
const only = new Set(args.filter((arg) => !arg.startsWith("--")));
const sources = JSON.parse(await readFile(join(root, "sources.json"), "utf8"));
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const CONCURRENCY = 4;
const TIMEOUT_MS = 60_000;

async function exists(path) { try { await access(path); return true; } catch { return false; } }

async function download(entry) {
  const path = join(root, "corpus", `${entry.slug}.pdf`);
  if (!force && (await exists(path))) return { slug: entry.slug, status: "kept" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(entry.url, { redirect: "follow", signal: controller.signal, headers: { "user-agent": UA, accept: "application/pdf,*/*;q=0.5" } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const isPdf = bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
    if (!response.ok || !isPdf) return { slug: entry.slug, status: `failed ${response.status} ${response.headers.get("content-type") ?? ""} ${bytes.length}B` };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return { slug: entry.slug, status: `ok ${(bytes.length / 1024).toFixed(0)}KB` };
  } catch (error) {
    return { slug: entry.slug, status: `error ${error.name === "AbortError" ? "timeout" : error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

const queue = sources.filter((entry) => only.size === 0 || only.has(entry.slug));
const results = [];
let cursor = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < queue.length) {
    const entry = queue[cursor++];
    const result = await download(entry);
    results.push(result);
    process.stdout.write(`${result.slug.padEnd(28)} ${result.status}\n`);
  }
}));
const failed = results.filter((result) => !result.status.startsWith("ok") && result.status !== "kept");
process.stdout.write(`\n${results.length - failed.length} PDFs, ${failed.length} failed\n`);
