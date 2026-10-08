// Review material (eval/out/<slug>/{source.txt,extracted.md,summary.json}) and the browsable preview
// corpus the renderer reads (apps/desktop/src/renderer/public/dev/corpus/{<id>.json,index.json}).
// A full export (no slugs) rewrites both trees; a partial export rewrites the selected slugs and merges
// their entries into the existing index, so `render <slug>` stays cheap.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "../../packages/normalize/node_modules/linkedom";
import { ROOT, normalizeSnapshot, snapshots, type Snapshot } from "./corpus";
import { summarize } from "./summarize";

export const OUT = join(ROOT, "out");
export const PREVIEW = join(ROOT, "..", "apps", "desktop", "src", "renderer", "public", "dev", "corpus");
const WORDS_PER_MINUTE = 240;

export interface IndexEntry { id: string; slug: string; [key: string]: unknown }
export interface ExportResult { exported: { slug: string; id: string }[]; failed: { slug: string; problems: string[] }[] }

/** The preview corpus id of a page: a short hash of its final URL. */
export function previewId(finalUrl: string): string {
  return createHash("sha256").update(finalUrl).digest("hex").slice(0, 16);
}

function visibleText(html: string) {
  const { document } = parseHTML(html);
  document.querySelectorAll("script, style, noscript, svg, template").forEach((node) => node.remove());
  const text = (document.body?.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return text.slice(0, 300_000);
}

type Exported = { ok: true; slug: string; id: string; entry: IndexEntry } | { ok: false; slug: string; problems: string[] };

function exportOne(snapshot: Snapshot): Exported {
  const outcome = normalizeSnapshot(snapshot);
  const summary = summarize(outcome);
  const dir = join(OUT, snapshot.slug);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "source.txt"), visibleText(new TextDecoder().decode(snapshot.bytes)));
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ slug: snapshot.slug, url: snapshot.finalUrl, framework: snapshot.framework, tags: snapshot.tags, ...summary }, null, 2));
  if (!outcome.ok) {
    const problems = outcome.problems.map((p) => p.code);
    writeFileSync(join(dir, "extracted.md"), `(extraction failed: ${problems.join(", ")})\n`);
    rmSync(join(PREVIEW, `${previewId(snapshot.finalUrl)}.json`), { force: true });
    return { ok: false, slug: snapshot.slug, problems };
  }
  const reps = outcome.article.materialization.representations;
  const by = (schema: string) => reps.find((r) => r.schema === schema)?.content;
  const markdown = by("agent.gfm.v1") ?? "";
  writeFileSync(join(dir, "extracted.md"), markdown);
  const id = previewId(snapshot.finalUrl);
  const plain = by("selection.text.v1");
  const words = (plain ?? markdown).trim().split(/\s+/).filter(Boolean).length;
  const v2 = by("reader.document.v2");
  const record = {
    id, url: snapshot.url, finalUrl: snapshot.finalUrl, title: outcome.article.title,
    ...(outcome.article.byline ? { byline: outcome.article.byline } : {}),
    ...(outcome.article.publishedAt ? { publishedAt: outcome.article.publishedAt } : {}),
    fetchedAt: snapshot.fetchedAt, readingMinutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)), origin: "web", mediaType: "text/html",
    ...(v2 ? { reader: { schema: "reader.document.v2", payload: v2 } } : {}),
    markdown, ...(plain ? { plain } : {}),
    quality: outcome.article.materialization.quality, problems: outcome.problems,
  };
  writeFileSync(join(PREVIEW, `${id}.json`), JSON.stringify(record));
  const { reader: _reader, markdown: _md, plain: _plain, problems: _problems, ...listed } = record;
  return { ok: true, slug: snapshot.slug, id, entry: { ...listed, slug: snapshot.slug } };
}

function readIndex(): IndexEntry[] {
  const path = join(PREVIEW, "index.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as IndexEntry[];
}

/** Exports every snapshot (no slugs) or only the named ones; unknown or unsnapshotted slugs throw. */
export function exportCorpus(options: { slugs?: readonly string[] } = {}): ExportResult {
  const all = snapshots();
  const selected = options.slugs?.length ? new Set(options.slugs) : undefined;
  if (selected) {
    const missing = [...selected].filter((slug) => !all.some((s) => s.slug === slug));
    if (missing.length) throw new Error(`No snapshot for ${missing.join(", ")} (not in eval/corpus.json or not fetched; run \`pnpm --filter @read/eval fetch\`).`);
  } else {
    rmSync(OUT, { recursive: true, force: true });
    rmSync(PREVIEW, { recursive: true, force: true });
  }
  mkdirSync(PREVIEW, { recursive: true });
  const chosen = selected ? all.filter((s) => selected.has(s.slug)) : all;
  const results = chosen.map(exportOne);
  const fresh = new Map(results.flatMap((r) => (r.ok ? [[r.slug, r.entry] as const] : [])));
  const kept = selected ? readIndex().filter((entry) => !selected.has(entry.slug)) : [];
  const order = new Map(all.map((s, index) => [s.slug, index]));
  const index = [...kept, ...fresh.values()].sort((a, b) => (order.get(a.slug) ?? Infinity) - (order.get(b.slug) ?? Infinity));
  writeFileSync(join(PREVIEW, "index.json"), JSON.stringify(index));
  return {
    exported: results.flatMap((r) => (r.ok ? [{ slug: r.slug, id: r.id }] : [])),
    failed: results.flatMap((r) => (r.ok ? [] : [{ slug: r.slug, problems: r.problems }])),
  };
}
