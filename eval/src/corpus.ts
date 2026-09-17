import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { normalizeArticleCapture, type ArticleNormalizationOutcome } from "@read/normalize";

export const ROOT = join(import.meta.dirname, "..");
export const CORPUS_DIR = join(ROOT, "corpus");

export interface CorpusEntry { slug: string; url: string; framework: string; tags: string[] }
export interface Snapshot extends CorpusEntry { finalUrl: string; generator: string; fetchedAt: string; bytes: Uint8Array }

const BUDGET = { maxBytes: 32 * 1024 * 1024, maxDepth: 100, maxNodes: 200_000, maxOutputBytes: 16 * 1024 * 1024 };

export function corpusEntries(): CorpusEntry[] {
  return JSON.parse(readFileSync(join(ROOT, "corpus.json"), "utf8")) as CorpusEntry[];
}

/** Every entry that has a snapshot on disk; entries without one are skipped, not failed (fetch them first). */
export function snapshots(): Snapshot[] {
  const present = new Set(existsSync(CORPUS_DIR) ? readdirSync(CORPUS_DIR) : []);
  return corpusEntries().filter((entry) => present.has(entry.slug) && existsSync(join(CORPUS_DIR, entry.slug, "page.html.gz"))).map((entry) => {
    const dir = join(CORPUS_DIR, entry.slug);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { finalUrl: string; generator: string; fetchedAt: string };
    return { ...entry, finalUrl: meta.finalUrl, generator: meta.generator, fetchedAt: meta.fetchedAt, bytes: new Uint8Array(gunzipSync(readFileSync(join(dir, "page.html.gz")))) };
  });
}

export function normalizeSnapshot(snapshot: Snapshot): ArticleNormalizationOutcome {
  const contentIdentity = `sha256:${createHash("sha256").update(snapshot.bytes).digest("hex")}` as const;
  return normalizeArticleCapture({ budget: BUDGET, capture: { baseLocator: snapshot.finalUrl, bytes: snapshot.bytes, contentIdentity, mediaType: "text/html" } });
}
