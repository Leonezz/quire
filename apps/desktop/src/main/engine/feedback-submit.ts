import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReadApiFeedback, RenderingFeedback, RenderingFeedbackPackage } from "../../shared/contracts";
import {
  DEFAULT_RENDER_WIDTH, MAX_COMPOSITE_BYTES, MAX_FULL_TILES, SCREENSHOTS_DIR, SHOT, TILE_HEIGHT,
  compositeCaption, decodeCapture, findTextOf, fullTileName, injectBase, renderWidthOf, roundRect, selectionCaptureRect,
  type CompositeCaption, type Rect,
} from "./feedback-capture";
import type { FeedbackStore, SubmitDraft } from "./feedback";
import { issueUrlFor, type IssueRepo } from "./feedback-issue";
import { MAX_ZIP_BYTES, packWithinBudget, type ZipEntry } from "./feedback-zip";

// The one-step report (ReadApiFeedback.feedbackSubmit): the bundle, then the screenshots, the zip, and the
// hand-off (clipboard, issue page, Finder). The screenshots are taken through a Capturer, so this runs without
// Electron in tests; main/feedback-capturer.ts is the real one. A screenshot that fails is a warning on the
// package and the report goes on; a bundle or zip that cannot be written fails the call.

export type FeedbackProgress = Parameters<Parameters<ReadApiFeedback["onFeedbackProgress"]>[0]>[0];

export interface ReaderTiles { tiles: Uint8Array[]; truncated: boolean; warnings: string[] }
export interface OriginalShots { top: Uint8Array; atSelection?: Uint8Array; warnings: string[] }

export interface Capturer {
  /** A PNG of the reader's window: the given rectangle in window CSS pixels, the whole window without one. */
  captureViewport(rect: Rect | undefined): Promise<Uint8Array>;
  /** JPEG tiles of the article as the render harness (`?render=<id>`) lays it out at `width`. */
  renderReaderTiles(input: { materialId: string; width: number; tileHeight: number; maxTiles: number }): Promise<ReaderTiles>;
  /** PNGs of the saved page (JavaScript off): its top `height` pixels and, when `findText` is given, the view around that text. */
  renderOriginal(input: { html: string; width: number; height: number; findText?: string }): Promise<OriginalShots>;
  /** A PNG of the reader screenshot beside the original one (or alone), under the caption, at most `maxBytes`. */
  compose(input: { left: Uint8Array; right?: Uint8Array; caption: CompositeCaption; maxBytes: number }): Promise<Uint8Array>;
}

export interface SubmitDeps {
  store: Pick<FeedbackStore, "createSubmission" | "save">;
  capturer: Capturer;
  repo: IssueRepo;
  progress: (progress: FeedbackProgress) => void;
  openExternal: (url: string) => Promise<void>;
  showItemInFolder: (path: string) => void;
  /** Puts the PNG at `path` on the clipboard; rejects when it cannot. */
  copyImageToClipboard: (path: string) => Promise<void>;
  maxZipBytes?: number;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const MB = 1024 * 1024;

/** "24 MB", "1.5 MB", "11 KB". */
export function sizeText(bytes: number): string {
  return bytes >= MB ? `${(bytes / MB).toFixed(1).replace(/\.0$/, "")} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** The zip's file name: `quire-report-<slug>-<id>.zip`. */
export function zipNameOf(slug: string, id: string): string {
  return `quire-report-${slug}-${id}.zip`;
}

/** Every file under the bundle directory except zips, `/`-separated and sorted. */
async function bundleEntries(dir: string, prefix = ""): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  for (const entry of (await readdir(join(dir, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) entries.push(...(await bundleEntries(dir, path)));
    else if (entry.isFile() && !entry.name.endsWith(".zip")) entries.push({ path, bytes: new Uint8Array(await readFile(join(dir, path))) });
  }
  return entries;
}

/** One report, from the draft to the filed-by-hand issue. Resolves with the saved record and its package. */
export async function submitFeedback(deps: SubmitDeps, draft: SubmitDraft): Promise<RenderingFeedback> {
  const submission = await deps.store.createSubmission(draft);
  const { record, material, original } = submission;
  const dir = record.bundleDir;
  const warnings = [...submission.warnings];
  const screenshots: string[] = [];
  const shots: Partial<Record<keyof typeof SHOT, Uint8Array>> = {};
  const progress = (step: FeedbackProgress["step"], text: string) => deps.progress({ id: record.id, step, message: text });
  /** Runs one capture step; its failure becomes a warning. */
  async function attempt<T>(label: string, run: () => Promise<T>): Promise<T | undefined> {
    try { return await run(); } catch (error) { warnings.push(`${label}: ${message(error)}`); return undefined; }
  }
  async function keep(name: keyof typeof SHOT, bytes: Uint8Array | undefined) {
    if (!bytes) return;
    await writeFile(join(dir, SHOT[name]), bytes);
    shots[name] = bytes;
    if (name !== "composite") screenshots.push(SHOT[name]);
  }
  await mkdir(join(dir, SCREENSHOTS_DIR), { recursive: true });

  // What the reader sees, first. The report panel stays transparent while the step is "capturing" and comes back
  // at the first other step, so both captures of the reader's window happen inside "capturing".
  progress("capturing", "Capturing the reader…");
  const viewport = draft.viewport ? roundRect(draft.viewport) : undefined;
  await keep("viewport", await attempt("Reader screenshot", () => deps.capturer.captureViewport(viewport)));
  if (draft.selection) {
    const rect = selectionCaptureRect(draft.selection.rect, draft.viewport);
    await keep("selection", await attempt("Selection screenshot", () => deps.capturer.captureViewport(rect)));
  }

  // The whole article, as the render harness lays it out (the primary view only; a PDF is in the bundle as itself).
  const primary = material.primaryView ?? record.view;
  if (record.view !== "pdf" && record.view !== primary) {
    warnings.push(`Full-article screenshots: the render harness shows the ${primary} view only, so none were taken of the ${record.view} view.`);
  } else if (record.view !== "pdf") {
    progress("capturing", "Capturing the whole article…");
    const full = await attempt("Full-article screenshots", () => deps.capturer.renderReaderTiles({ materialId: record.materialId, width: renderWidthOf(draft.viewport), tileHeight: TILE_HEIGHT, maxTiles: MAX_FULL_TILES }));
    if (full) {
      for (const [index, tile] of full.tiles.entries()) {
        await writeFile(join(dir, fullTileName(index)), tile);
        screenshots.push(fullTileName(index));
      }
      warnings.push(...full.warnings.map((warning) => `Full-article screenshots: ${warning}`));
      if (full.truncated) warnings.push(`Full-article screenshots: the article is longer than ${MAX_FULL_TILES} tiles; the rest is not shown.`);
    }
  }

  // The original page with JavaScript off, at the top and at the selected text.
  if (original?.kind === "page") {
    progress("rendering-original", "Rendering the original page…");
    const decoded = decodeCapture(original.bytes, material.capture?.mediaType);
    if (decoded.warning) warnings.push(`Original page: ${decoded.warning}`);
    const findText = draft.selection ? findTextOf(draft.selection.quote) : undefined;
    const html = injectBase(decoded.html, material.finalUrl);
    const shotsOfOriginal = await attempt("Original page", () => deps.capturer.renderOriginal({ html, width: DEFAULT_RENDER_WIDTH, height: TILE_HEIGHT, ...(findText ? { findText } : {}) }));
    if (shotsOfOriginal) {
      await keep("originalTop", shotsOfOriginal.top);
      await keep("originalAtSelection", shotsOfOriginal.atSelection);
      warnings.push(...shotsOfOriginal.warnings.map((warning) => `Original page: ${warning}`));
    }
  }

  // Reader | original, side by side: the picture that goes on the clipboard.
  const left = shots.selection ?? shots.viewport;
  const right = shots.originalAtSelection ?? shots.originalTop;
  if (left) {
    await keep("composite", await attempt("Side-by-side screenshot", () => deps.capturer.compose({ left, ...(right ? { right } : {}), caption: compositeCaption(record), maxBytes: MAX_COMPOSITE_BYTES })));
  } else {
    warnings.push("Side-by-side screenshot: there is no reader screenshot to put in it.");
  }

  progress("packaging", "Packaging the report…");
  const zipPath = join(dir, zipNameOf(submission.slug, record.id));
  const maxZipBytes = deps.maxZipBytes ?? MAX_ZIP_BYTES;
  const packed = packWithinBudget(await bundleEntries(dir), maxZipBytes);
  for (const path of packed.dropped) await rm(join(dir, path), { force: true });
  if (packed.dropped.length > 0) warnings.push(`Packaging: left out the last ${packed.dropped.length} full-article screenshot${packed.dropped.length === 1 ? "" : "s"} to keep the zip under ${sizeText(maxZipBytes)}.`);
  if (packed.overBudget) warnings.push(`Packaging: the zip is ${sizeText(packed.zip.byteLength)}, over the ${sizeText(maxZipBytes)} that fits GitHub's attachment limit, even without full-article screenshots; attach the screenshots alone, or report again without the original.`);
  await writeFile(zipPath, packed.zip);

  progress("opening", "Opening the issue…");
  const composite = shots.composite ? SHOT.composite : undefined;
  let copiedToClipboard = false;
  if (composite) {
    try { await deps.copyImageToClipboard(join(dir, composite)); copiedToClipboard = true; }
    catch (error) { warnings.push(`Clipboard: ${message(error)}`); }
  }
  const pack: RenderingFeedbackPackage = {
    zipPath, zipBytes: packed.zip.byteLength,
    screenshots: screenshots.filter((path) => !packed.dropped.includes(path)),
    ...(composite ? { composite } : {}),
    issueOpened: false, revealed: false, copiedToClipboard, warnings,
  };
  let issueOpened = false;
  try { await deps.openExternal(issueUrlFor({ ...record, package: pack }, deps.repo)); issueOpened = true; }
  catch (error) { warnings.push(`Issue page: ${message(error)}`); }
  let revealed = false;
  try { deps.showItemInFolder(zipPath); revealed = true; }
  catch (error) { warnings.push(`Finder: ${message(error)}`); }
  return deps.store.save({ ...record, package: { ...pack, issueOpened, revealed, warnings: [...warnings] } });
}
