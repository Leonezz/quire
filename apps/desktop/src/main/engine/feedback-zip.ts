import { zipSync, type Zippable } from "fflate";
import { FULL_TILE_PATTERN } from "./feedback-capture";

// The one-step report's zip: the whole bundle in one file the reader drags into the GitHub issue. GitHub
// refuses attachments over 25 MB, so the zip is kept under MAX_ZIP_BYTES by dropping full-article tiles
// from the end (the viewport and selection screenshots, the snapshot and the extraction always stay).

export const MAX_ZIP_BYTES = 24 * 1024 * 1024;

export interface ZipEntry { path: string; bytes: Uint8Array }
export type Zipper = (entries: readonly ZipEntry[]) => Uint8Array;

/** Already-compressed formats are stored as they are; text is deflated. */
const STORED = /\.(png|jpe?g|gz|zip|pdf)$/i;

/** A zip of the entries (paths relative to the bundle, `/`-separated), with a fixed timestamp so the same bundle zips the same. */
export const zipEntries: Zipper = (entries) => {
  const files: Zippable = {};
  for (const entry of entries) files[entry.path] = [entry.bytes, { level: STORED.test(entry.path) ? 0 : 6, mtime: new Date(Date.UTC(2026, 0, 1)) }];
  return zipSync(files);
};

export interface PackedZip {
  zip: Uint8Array;
  /** The entries the zip holds. */
  kept: ZipEntry[];
  /** Full-article tiles left out to fit the budget, last tile first. */
  dropped: string[];
  /** The zip is still over the budget with every tile dropped (a very large PDF or page). */
  overBudget: boolean;
}

/** Zips the entries; while the zip is over maxBytes, drops the last full-article tile and zips again. */
export function packWithinBudget(entries: readonly ZipEntry[], maxBytes = MAX_ZIP_BYTES, zip: Zipper = zipEntries): PackedZip {
  let kept = [...entries];
  const dropped: string[] = [];
  let packed = zip(kept);
  while (packed.byteLength > maxBytes) {
    const last = kept.map((entry) => entry.path).filter((path) => FULL_TILE_PATTERN.test(path)).sort().pop();
    if (last === undefined) return { zip: packed, kept, dropped, overBudget: true };
    kept = kept.filter((entry) => entry.path !== last);
    dropped.push(last);
    packed = zip(kept);
  }
  return { zip: packed, kept, dropped, overBudget: false };
}
