// The visual mode's inputs: the render capture of a case (eval/render/out/<slug>/, written by
// `pnpm --filter @read/eval render`, shaped by eval/render/types.ts) loaded into what the prompt and
// the backends need, and the plan of which tiles go into one call. Loading touches the disk; the
// planning and the key are pure.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Embed, ReferenceImage, RenderedCode, RenderedImage, RenderedTable, RenderManifest, RenderMetrics } from "../render/types";
import { truncateInput } from "./inputs";

export const JUDGE_MODES = ["visual", "text"] as const;
export type JudgeMode = (typeof JUDGE_MODES)[number];
/** Images in one call unless config.json maxImages says otherwise. */
export const DEFAULT_MAX_IMAGES = 10;
/** Of the image budget, this share goes to rendered tiles first; reference tiles take the rest. */
const RENDERED_SHARE = 0.7;
/** Characters of the reader's visible text in the prompt (it mostly repeats EXTRACTED; it is there for quoting). */
export const RENDERED_TEXT_CAP = 20_000;

/** One case's capture, as the judge sees it. Tile paths are absolute, top to bottom. */
export interface VisualInput {
  /** RenderManifest.key: changes whenever the reader payload, the snapshot, the renderer or the viewport changes. */
  manifestKey: string;
  renderedTiles: string[];
  referenceTiles: string[];
  metrics: RenderMetrics;
  warnings: string[];
  /** The capture stopped before the end of the page (--max-tiles). */
  truncated: { rendered: boolean; reference: boolean };
  failedReferenceRequests: number;
  renderedText: string;
  renderedTextTruncated: boolean;
  /** The capture viewport: one tile is this wide and (at most) this tall, in CSS px. */
  viewport: { width: number; height: number };
  /** The image inventories: what the reader shows (r1…) and the sizeable images of the original (o1…) with their reader match. */
  images: { rendered: RenderedImage[]; reference: ReferenceImage[] };
  /** JavaScript or plugin content in the snapshot, in document order (e1… by position). */
  embeds: Embed[];
  /** The reader's tables (t1…) and code blocks (c1…), in document order. */
  tables: RenderedTable[];
  code: RenderedCode[];
}

export interface SideCount { sent: number; total: number }
/** Which tiles one call carries: the first `sent` of each side, rendered first. */
export interface ImagePlan {
  /** Absolute paths in the order they are attached. */
  images: string[];
  rendered: SideCount;
  reference: SideCount;
  maxImages: number;
}

export class MissingCaptureError extends Error {
  constructor(slug: string, detail = "") {
    super(`no render capture for ${slug}: run pnpm --filter @read/eval render ${slug}${detail ? ` (${detail})` : ""}`);
    this.name = "MissingCaptureError";
  }
}

export const captureDir = (renderOut: string, slug: string) => join(renderOut, slug);
export const manifestPath = (renderOut: string, slug: string) => join(captureDir(renderOut, slug), "manifest.json");
export const hasCapture = (renderOut: string, slug: string) => existsSync(manifestPath(renderOut, slug));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** The manifest, checked far enough that the judge never reads a half-written capture as a real one. */
function readManifest(renderOut: string, slug: string): RenderManifest {
  const path = manifestPath(renderOut, slug);
  if (!existsSync(path)) throw new MissingCaptureError(slug);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new MissingCaptureError(slug, `${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const bad = (what: string) => new MissingCaptureError(slug, `${path}: ${what}`);
  if (!isRecord(parsed)) throw bad("not an object");
  if (parsed.slug !== slug) throw bad(`slug is ${JSON.stringify(parsed.slug)}`);
  if (typeof parsed.key !== "string" || !parsed.key) throw bad("no key");
  const { rendered, reference } = parsed;
  if (!isRecord(rendered) || !isStringList(rendered.tiles) || typeof rendered.textPath !== "string" || !isRecord(rendered.metrics)) throw bad("rendered.tiles/textPath/metrics missing");
  if (!isRecord(reference) || !isStringList(reference.tiles)) throw bad("reference.tiles missing");
  // Rubric v6 checks image and embed claims against these inventories; a capture without them is stale, not empty.
  if (!Array.isArray(rendered.images) || !Array.isArray(reference.images) || !Array.isArray(parsed.embeds)) throw bad("no image/embed inventories (rendered.images, reference.images, embeds): the capture predates them, re-capture it");
  if (!Array.isArray(rendered.tables) || !Array.isArray(rendered.code) || typeof rendered.metrics.collapsedCode !== "number") throw bad("no table/code inventories (rendered.tables, rendered.code, metrics.collapsedCode): the capture predates them, re-capture it");
  if (!isStringList(parsed.warnings)) throw bad("warnings is not a list");
  const { viewport } = parsed;
  if (!isRecord(viewport) || typeof viewport.width !== "number" || typeof viewport.height !== "number") throw bad("viewport missing");
  return parsed as unknown as RenderManifest;
}

/** Reads eval/render/out/<slug>/; throws MissingCaptureError (with the command to run) when the capture is absent or incomplete. */
export function loadCapture(renderOut: string, slug: string): VisualInput {
  const manifest = readManifest(renderOut, slug);
  const dir = captureDir(renderOut, slug);
  const resolveTiles = (tiles: readonly string[]) => tiles.map((tile) => {
    const path = join(dir, tile);
    if (!existsSync(path)) throw new MissingCaptureError(slug, `tile ${tile} is missing`);
    return path;
  });
  const textPath = join(dir, manifest.rendered.textPath);
  if (!existsSync(textPath)) throw new MissingCaptureError(slug, `${manifest.rendered.textPath} is missing`);
  const text = truncateInput(readFileSync(textPath, "utf8"), RENDERED_TEXT_CAP);
  return {
    manifestKey: manifest.key,
    renderedTiles: resolveTiles(manifest.rendered.tiles),
    referenceTiles: resolveTiles(manifest.reference.tiles),
    metrics: manifest.rendered.metrics,
    warnings: manifest.warnings,
    truncated: { rendered: manifest.rendered.truncated === true, reference: manifest.reference.truncated === true },
    failedReferenceRequests: typeof manifest.reference.failedRequests === "number" ? manifest.reference.failedRequests : 0,
    renderedText: text.text,
    renderedTextTruncated: text.truncated,
    viewport: { width: manifest.viewport.width, height: manifest.viewport.height },
    images: { rendered: manifest.rendered.images, reference: manifest.reference.images },
    embeds: manifest.embeds,
    tables: manifest.rendered.tables,
    code: manifest.rendered.code,
  };
}

/**
 * The tiles one call carries: rendered tiles first, up to 70% of the budget (7 of 10) — more when the
 * reference has fewer tiles than its share — then reference tiles in what is left. Always the top of
 * each page, so tile n in the prompt is tile n of the capture.
 */
export function planImages(visual: Pick<VisualInput, "renderedTiles" | "referenceTiles">, maxImages = DEFAULT_MAX_IMAGES): ImagePlan {
  if (!Number.isInteger(maxImages) || maxImages < 1) throw new Error(`maxImages must be a positive integer, got ${String(maxImages)}`);
  const share = Math.ceil(maxImages * RENDERED_SHARE);
  const renderedSent = Math.min(visual.renderedTiles.length, Math.max(share, maxImages - visual.referenceTiles.length));
  const referenceSent = Math.min(visual.referenceTiles.length, maxImages - renderedSent);
  return {
    images: [...visual.renderedTiles.slice(0, renderedSent), ...visual.referenceTiles.slice(0, referenceSent)],
    rendered: { sent: renderedSent, total: visual.renderedTiles.length },
    reference: { sent: referenceSent, total: visual.referenceTiles.length },
    maxImages,
  };
}

/** The visual part of a cache key: the mode, the capture's own key and the tiles sent (by file name). */
export function visualKeyPart(visual: VisualInput, plan: ImagePlan): string {
  return `visual ${visual.manifestKey} ${plan.images.map((path) => basename(path)).join(",")}`;
}

/** What a judged case keeps of its capture, for the reports: file names (relative to the capture directory), counts and facts. */
export interface RenderSummary {
  manifestKey: string;
  tiles: { rendered: string[]; reference: string[] };
  sent: { rendered: number; reference: number };
  truncated: { rendered: boolean; reference: boolean };
  metrics: RenderMetrics;
  warnings: string[];
  failedReferenceRequests: number;
  /** The inventories the issues were checked against; absent on results judged before rubric v6. */
  images?: { rendered: RenderedImage[]; reference: ReferenceImage[] };
  embeds?: Embed[];
  /** The table and code inventories; absent on results judged before rubric 2026-10-10.9. */
  tables?: RenderedTable[];
  code?: RenderedCode[];
}

export function renderSummary(visual: VisualInput, plan: ImagePlan): RenderSummary {
  return {
    manifestKey: visual.manifestKey,
    tiles: { rendered: visual.renderedTiles.map((path) => basename(path)), reference: visual.referenceTiles.map((path) => basename(path)) },
    sent: { rendered: plan.rendered.sent, reference: plan.reference.sent },
    truncated: visual.truncated,
    metrics: visual.metrics,
    warnings: visual.warnings,
    failedReferenceRequests: visual.failedReferenceRequests,
    images: visual.images,
    embeds: visual.embeds,
    tables: visual.tables,
    code: visual.code,
  };
}
