// EXPORT=1 writes review material: eval/out/<slug>/{source.txt,extracted.md,summary.json}
// and a browsable copy of the corpus for the renderer preview (public/dev/corpus).
// EXPORT_SLUGS=a,b limits it to those slugs (merged into the existing index); EXPORT_RESULT=<path>
// writes the ExportResult as JSON (the render capture reads it). The logic lives in ./export.
import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { exportCorpus } from "./export";

it.skipIf(!process.env.EXPORT)("exports review material and the preview corpus", () => {
  const slugs = (process.env.EXPORT_SLUGS ?? "").split(",").map((slug) => slug.trim()).filter(Boolean);
  const result = exportCorpus({ slugs });
  if (process.env.EXPORT_RESULT) writeFileSync(process.env.EXPORT_RESULT, JSON.stringify(result));
});
