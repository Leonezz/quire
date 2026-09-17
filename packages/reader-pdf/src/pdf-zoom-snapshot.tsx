// Bridges a zoom commit. react-pdf keys each page canvas on its scale, so the
// commit unmounts the sharp canvas and mounts a hidden one until pdf.js has
// drawn the page again: one white flash per page. Right before the commit
// every rendered page bitmap is copied into a snapshot; the snapshot sits over
// the page shell, stretched to the new page size, until that page reports a
// render at the committed zoom.
import { useLayoutEffect, useRef } from "react";

export const PDF_PAGE_CANVAS_SELECTOR = "canvas.react-pdf__Page__canvas";

export type PdfZoomSnapshot = Readonly<{
  bitmap: HTMLCanvasElement;
  /**
   * The CSS page width the snapshot bridges to. react-pdf keys its canvas on
   * the scale this width produces, so a render at any other width belongs to
   * another commit and leaves the snapshot in place.
   */
  pageWidth: number;
}>;

export type PdfZoomSnapshots = ReadonlyMap<number, PdfZoomSnapshot>;

export const NO_ZOOM_SNAPSHOTS: PdfZoomSnapshots = new Map();

/**
 * Copies a rendered page canvas. The copy keeps the source's device pixels
 * when zooming in and is downsampled when zooming out (`ratio` is
 * next / previous zoom), so it never holds more pixels than the new page shows.
 * Returns undefined when the canvas has no finished bitmap or no 2D context.
 */
export function capturePageBitmap(
  source: HTMLCanvasElement,
  ratio: number,
): HTMLCanvasElement | undefined {
  // react-pdf keeps the canvas hidden while pdf.js is still drawing into it.
  if (!source.width || !source.height || source.style.visibility === "hidden")
    return undefined;
  const width = Math.max(
    1,
    Math.min(source.width, Math.ceil(source.width * Math.min(1, ratio))),
  );
  const height = Math.max(
    1,
    Math.round((width * source.height) / source.width),
  );
  const bitmap = source.ownerDocument.createElement("canvas");
  bitmap.width = width;
  bitmap.height = height;
  const context = bitmap.getContext("2d", { alpha: false });
  // No 2D context (jsdom, or the browser refused one more context): there is
  // nothing to copy the page into, so this page re-renders without a bridge.
  // That is the explicit "no snapshot possible" outcome, not a hidden error.
  if (!context) return undefined;
  context.drawImage(source, 0, 0, width, height);
  return bitmap;
}

/**
 * The snapshots to show for a zoom commit that re-lays the pages out from
 * `currentWidth` to `pageWidth`. A page whose canvas is finished gets a fresh
 * copy; a page still rendering keeps whatever snapshot already bridged it (its
 * pixels are older but the same content); pages without either get none. Only
 * page shells that hold a canvas, i.e. the windowed pages, can contribute,
 * which bounds the count.
 */
export function snapshotsForZoomCommit(
  pageShells: ReadonlyMap<number, HTMLElement>,
  current: PdfZoomSnapshots,
  currentWidth: number,
  pageWidth: number,
): PdfZoomSnapshots {
  const next = new Map<number, PdfZoomSnapshot>();
  for (const [page, shell] of pageShells) {
    const canvas = shell.querySelector<HTMLCanvasElement>(
      PDF_PAGE_CANVAS_SELECTOR,
    );
    const bitmap = canvas
      ? capturePageBitmap(canvas, pageWidth / currentWidth)
      : undefined;
    const kept = bitmap ?? current.get(page)?.bitmap;
    if (kept) next.set(page, { bitmap: kept, pageWidth });
  }
  return next;
}

/** Drops the snapshot for `page` when it bridged exactly this render. */
export function withoutRenderedSnapshot(
  current: PdfZoomSnapshots,
  page: number,
  renderedWidth: number,
): PdfZoomSnapshots {
  const snapshot = current.get(page);
  if (!snapshot || snapshot.pageWidth !== renderedWidth) return current;
  const next = new Map(current);
  next.delete(page);
  return next;
}

/** Keeps only the snapshots whose page still renders a canvas. */
export function snapshotsWithinWindow(
  current: PdfZoomSnapshots,
  isRendered: (page: number) => boolean,
): PdfZoomSnapshots {
  if (Array.from(current.keys()).every(isRendered)) return current;
  return new Map(
    Array.from(current).filter(([page]) => isRendered(page)),
  );
}

/**
 * Zeroing a canvas makes browsers release its graphics memory at once rather
 * than when the detached element is eventually collected.
 */
export function releaseSnapshotBitmap(snapshot: PdfZoomSnapshot) {
  snapshot.bitmap.width = 0;
  snapshot.bitmap.height = 0;
}

/**
 * Hosts a snapshot bitmap over the page shell. The bitmap is adopted in a
 * layout effect, so it is in the DOM before the browser paints the commit
 * that changed the page size: the reader sees the pixels the pinch transform
 * showed, then the sharp render replaces them.
 */
export function PdfZoomSnapshotOverlay({
  snapshot,
}: Readonly<{ snapshot: PdfZoomSnapshot }>) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    hostRef.current?.replaceChildren(snapshot.bitmap);
  }, [snapshot]);
  return (
    <div
      aria-hidden="true"
      className="pdf-canvas-viewer__zoom-snapshot"
      ref={hostRef}
    />
  );
}
