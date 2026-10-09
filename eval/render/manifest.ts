// Cache key, renderer build id, manifest assembly and the one-line report per slug.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Embed, ReferenceImage, RenderedCode, RenderedImage, RenderedTable, RenderManifest, RenderMetrics } from "./types";

/** The capture's own code: a change to how pages are measured, tiled or loaded redoes every capture. */
export const CAPTURE_SOURCES = ["capture.mjs", "page-facts.ts", "metrics.ts", "tiles.ts", "reference.ts", "image-proxy.ts", "images.ts", "reference-facts.ts", "embeds.ts"] as const;

/** Hash of the capture's source files in dir (the render directory). */
export function captureCodeId(dir: string, files: readonly string[] = CAPTURE_SOURCES): string {
  const hash = createHash("sha256");
  for (const name of files) hash.update(`${name}\0`).update(readFileSync(join(dir, name))).update("\0");
  return hash.digest("hex").slice(0, 16);
}

/** Every file under dir, relative and sorted. */
function filesUnder(dir: string, root = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path, root) : [relative(root, path)];
  }).sort();
}

/** Hash of the built renderer's index.html and its asset file names (Vite puts content hashes in them). */
export function rendererBuildId(rendererDir: string): string {
  const index = join(rendererDir, "index.html");
  if (!existsSync(index)) throw new Error(`No renderer build at ${index}. Run without --no-build, or \`pnpm --filter @read/desktop exec electron-vite build\`.`);
  const hash = createHash("sha256").update(readFileSync(index));
  for (const name of filesUnder(join(rendererDir, "assets"))) hash.update(`\0${name}`);
  return hash.digest("hex").slice(0, 16);
}

export interface KeyInputs {
  /** The preview corpus record the reader renders (`<id>.json` bytes). */
  record: Uint8Array | string;
  /** The snapshot file the reference renders (`page.html.gz` bytes). */
  snapshot: Uint8Array;
  buildId: string;
  /** captureCodeId of the capture code that made it. */
  codeId: string;
  viewport: RenderManifest["viewport"];
  maxTiles: number;
  maxReferenceTiles: number;
}

export function captureKey(inputs: KeyInputs): string {
  const hash = createHash("sha256");
  hash.update(`capture:${inputs.codeId}\0`);
  hash.update(inputs.record);
  hash.update("\0");
  hash.update(inputs.snapshot);
  const { width, height, deviceScaleFactor } = inputs.viewport;
  hash.update(`\0build:${inputs.buildId}\0viewport:${width}x${height}@${deviceScaleFactor}\0tiles:${inputs.maxTiles}/${inputs.maxReferenceTiles}`);
  return hash.digest("hex");
}

export interface ManifestInputs {
  slug: string;
  id: string;
  url: string;
  key: string;
  capturedAt: Date;
  viewport: RenderManifest["viewport"];
  rendered: { tiles: string[]; height: number; truncated: boolean; metrics: RenderMetrics; images: RenderedImage[]; tables: RenderedTable[]; code: RenderedCode[] };
  reference: { tiles: string[]; height: number; truncated: boolean; failedRequests: number; images: ReferenceImage[] };
  embeds: Embed[];
  warnings: string[];
}

export function buildManifest(inputs: ManifestInputs): RenderManifest {
  return {
    slug: inputs.slug, id: inputs.id, url: inputs.url, key: inputs.key, capturedAt: inputs.capturedAt.toISOString(), viewport: { ...inputs.viewport },
    rendered: { tiles: [...inputs.rendered.tiles], height: inputs.rendered.height, truncated: inputs.rendered.truncated, textPath: "rendered.txt", metrics: inputs.rendered.metrics, images: inputs.rendered.images.map((image) => ({ ...image })),
      tables: inputs.rendered.tables.map((table) => ({ ...table })), code: inputs.rendered.code.map((block) => ({ ...block })) },
    reference: { tiles: [...inputs.reference.tiles], height: inputs.reference.height, truncated: inputs.reference.truncated, failedRequests: inputs.reference.failedRequests, images: inputs.reference.images.map((image) => ({ ...image, candidates: [...image.candidates] })) },
    embeds: inputs.embeds.map((embed) => ({ ...embed })),
    warnings: [...inputs.warnings],
  };
}

/** The manifest at path when it was made with this key, else undefined (missing, unreadable or stale). */
export function cachedManifest(path: string, key: string): RenderManifest | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as RenderManifest;
    return manifest.key === key ? manifest : undefined;
  } catch {
    return undefined; // a corrupt manifest is redone, which is what --force would do
  }
}

const SLUG_WIDTH = 24;

export function summaryLine(manifest: RenderManifest, status: "fresh" | "cached"): string {
  const { rendered, reference } = manifest;
  const m = rendered.metrics;
  const more = (side: { truncated: boolean }) => (side.truncated ? "+" : "");
  return `${manifest.slug.padEnd(SLUG_WIDTH)}  ${status.padEnd(6)}  rendered ${rendered.tiles.length}${more(rendered)} tiles (${rendered.height} px) · reference ${reference.tiles.length}${more(reference)} tiles · broken images ${m.images.broken} · overflow ${m.overflow.count} · raw markup ${m.rawMarkup.count} · math errors ${m.mathErrors} · collapsed code ${m.collapsedCode} · images ${rendered.images.length} shown, ${reference.images.filter((image) => image.matchedBy).length}/${reference.images.length} original matched · embeds ${manifest.embeds.length} (${manifest.embeds.filter((embed) => !embed.representedInReader).length} not in reader)${manifest.warnings.length ? ` · warnings: ${manifest.warnings.join("; ")}` : ""}`;
}
