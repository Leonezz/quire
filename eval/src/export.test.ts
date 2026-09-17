// EXPORT=1 writes review material: eval/out/<slug>/{source.txt,extracted.md,summary.json}
// and a browsable copy of the corpus for the renderer preview (public/dev/corpus).
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { parseHTML } from "../../packages/normalize/node_modules/linkedom";
import { ROOT, normalizeSnapshot, snapshots } from "./corpus";
import { summarize } from "./summarize";

const OUT = join(ROOT, "out");
const PREVIEW = join(ROOT, "..", "apps", "desktop", "src", "renderer", "public", "dev", "corpus");
const WORDS_PER_MINUTE = 240;

function visibleText(html: string) {
  const { document } = parseHTML(html);
  document.querySelectorAll("script, style, noscript, svg, template").forEach((node) => node.remove());
  const text = (document.body?.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return text.slice(0, 300_000);
}

it.skipIf(!process.env.EXPORT)("exports review material and the preview corpus", () => {
  rmSync(OUT, { recursive: true, force: true });
  rmSync(PREVIEW, { recursive: true, force: true });
  mkdirSync(PREVIEW, { recursive: true });
  const index: unknown[] = [];
  for (const snapshot of snapshots()) {
    const outcome = normalizeSnapshot(snapshot);
    const summary = summarize(outcome);
    const dir = join(OUT, snapshot.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "source.txt"), visibleText(new TextDecoder().decode(snapshot.bytes)));
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ slug: snapshot.slug, url: snapshot.finalUrl, framework: snapshot.framework, tags: snapshot.tags, ...summary }, null, 2));
    if (!outcome.ok) { writeFileSync(join(dir, "extracted.md"), `(extraction failed: ${outcome.problems.map((p) => p.code).join(", ")})\n`); continue; }
    const reps = outcome.article.materialization.representations;
    const by = (schema: string) => reps.find((r) => r.schema === schema)?.content;
    const markdown = by("agent.gfm.v1") ?? "";
    writeFileSync(join(dir, "extracted.md"), markdown);
    const id = createHash("sha256").update(snapshot.finalUrl).digest("hex").slice(0, 16);
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
    index.push({ ...listed, slug: snapshot.slug });
  }
  writeFileSync(join(PREVIEW, "index.json"), JSON.stringify(index));
});
