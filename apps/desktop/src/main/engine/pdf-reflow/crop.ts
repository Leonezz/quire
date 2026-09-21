import type { PdfDocument } from "../pdf";
import type { Rect } from "./types";

// Figure crops: the page rendered by pdf.js into a Node canvas, at twice the page's point
// size, with the viewport offset so only the region lands on the canvas. pdf.js brings its
// own canvas factory (backed by @napi-rs/canvas when that optional native package is
// installed); when it is missing the reflow is told so and says so, instead of pretending.

export const CROP_SCALE = 2;

export interface CropResult { png: Uint8Array; width: number; height: number }

export interface FigureRenderer {
  render: (page: number, rect: Rect) => Promise<CropResult>;
}

interface NodeCanvasLike {
  encode?: (format: "png") => Promise<Uint8Array> | Uint8Array;
  toBuffer?: (mime: "image/png") => Uint8Array;
}

interface CanvasFactoryLike {
  create: (width: number, height: number) => { canvas: NodeCanvasLike; context: CanvasRenderingContext2D };
  destroy?: (entry: { canvas: NodeCanvasLike; context: CanvasRenderingContext2D }) => void;
}

function canvasFactoryOf(doc: PdfDocument): CanvasFactoryLike {
  const factory = (doc as { canvasFactory?: unknown }).canvasFactory;
  if (!factory || typeof (factory as CanvasFactoryLike).create !== "function") throw new Error("pdf.js exposes no canvas factory in this process.");
  return factory as CanvasFactoryLike;
}

async function encodePng(canvas: NodeCanvasLike): Promise<Uint8Array> {
  if (typeof canvas.encode === "function") return canvas.encode("png");
  if (typeof canvas.toBuffer === "function") return canvas.toBuffer("image/png");
  throw new Error("The canvas cannot encode PNG (neither encode() nor toBuffer() exists).");
}

/**
 * A renderer for the document, or the reason none is possible. Probing creates a 1×1 canvas,
 * which is where a missing @napi-rs/canvas surfaces (pdf.js requires it lazily).
 */
export function figureRendererOf(doc: PdfDocument): { renderer: FigureRenderer } | { error: string } {
  let factory: CanvasFactoryLike;
  try {
    factory = canvasFactoryOf(doc);
    const probe = factory.create(1, 1);
    factory.destroy?.(probe);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return {
    renderer: {
      async render(pageNumber, rect) {
        const page = await doc.getPage(pageNumber);
        const width = Math.max(1, Math.round(rect.w * CROP_SCALE));
        const height = Math.max(1, Math.round(rect.h * CROP_SCALE));
        const viewport = page.getViewport({ scale: CROP_SCALE, offsetX: -rect.x * CROP_SCALE, offsetY: -rect.y * CROP_SCALE });
        const entry = factory.create(width, height);
        try {
          await page.render({ canvas: null, canvasContext: entry.context, viewport, background: "#ffffff" }).promise;
          return { png: await encodePng(entry.canvas), width, height };
        } finally {
          factory.destroy?.(entry);
        }
      },
    },
  };
}
