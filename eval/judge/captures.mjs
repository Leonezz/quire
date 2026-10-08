// Which selected cases have a render capture (eval/render/out/<slug>/manifest.json), checked by run.mjs
// before any backend is called. Plain JS so it runs before vitest boots; visual.ts loads the captures.
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {string} renderOut eval/render/out
 * @param {string} slug
 */
export const captureExists = (renderOut, slug) => existsSync(join(renderOut, slug, "manifest.json"));

/** @param {readonly string[]} slugs */
export const renderCommand = (slugs) => `pnpm --filter @read/eval render${slugs.length ? ` ${slugs.join(" ")}` : ""}`;

/**
 * Splits the selected slugs by whether a capture exists. `error` is set when none has one: the run
 * would spend nothing useful, so run.mjs exits with the command that makes them. `warning` names the
 * ones missing when only some are: those cases fail in the harness, loudly, one by one.
 * @param {readonly string[]} slugs the cases the run selected
 * @param {(slug: string) => boolean} has
 * @param {boolean} explicit whether the slugs were named on the command line (else: every snapshot)
 * @returns {{ present: string[]; missing: string[]; error?: string; warning?: string }}
 */
export function checkCaptures(slugs, has, explicit) {
  const present = slugs.filter((slug) => has(slug));
  const missing = slugs.filter((slug) => !has(slug));
  if (slugs.length && present.length === 0) {
    return { present, missing, error: `no render capture for ${explicit ? missing.join(", ") : `any of the ${slugs.length} snapshots`}: run ${renderCommand(explicit ? missing : [])} (or pass --mode text)` };
  }
  return { present, missing, ...(missing.length ? { warning: `no render capture for ${missing.join(", ")}: those cases will fail; run ${renderCommand(missing)}` } : {}) };
}
