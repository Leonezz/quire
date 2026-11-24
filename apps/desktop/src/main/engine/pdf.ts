/** What the engine learns about a PDF before it is stored. Rendering happens in the renderer. */
export interface PdfInspection {
  pages: number;
  title?: string;
  author?: string;
  textLayer: "available" | "absent";
  /** Text of the first pages, for reading-time estimates and the agent's first look. */
  sampleText: string;
}

export class PdfError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

const SAMPLE_PAGES = 3;
const MAX_SAMPLE_CHARS = 20_000;

type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsModule: Promise<PdfjsModule> | undefined;
let configuredWorkerSrc: string | undefined;

export function setPdfWorkerSrc(src: string): void {
  configuredWorkerSrc = src;
}

// Loaded once, on first use. Browser / Worker hosts pass `setPdfWorkerSrc(...)`;
// Node / Vitest uses pdfjs's fake-worker fallback with standard fonts from node_modules.
function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsModule ??= (async () => {
    const mod = await import("pdfjs-dist/legacy/build/pdf.mjs");
    if (configuredWorkerSrc && !mod.GlobalWorkerOptions.workerSrc) {
      mod.GlobalWorkerOptions.workerSrc = configuredWorkerSrc;
    }
    return mod;
  })();
  return pdfjsModule;
}

function standardFontDataUrl(): string | undefined {
  const nodeRequire = (globalThis as { require?: { resolve?: (id: string) => string } }).require;
  if (typeof nodeRequire?.resolve !== "function") return undefined;
  try {
    const pkgPath = nodeRequire.resolve("pdfjs-dist/package.json");
    return pkgPath.replace(/package\.json$/, "standard_fonts/");
  } catch {
    return undefined;
  }
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 0 && text.length <= 500 ? text : undefined;
}

type TextItem = import("pdfjs-dist/types/src/display/api").TextItem;
type TitleCandidate = Pick<TextItem, "str" | "height" | "transform">;

/** Upright text only: rotated runs are stamps and margins (the arXiv watermark), never the title. */
function isUpright(item: TitleCandidate): boolean {
  const [, b, c] = item.transform;
  return Math.abs(b ?? 0) < 0.01 && Math.abs(c ?? 0) < 0.01;
}

/** Papers rarely fill the Info title; the largest type on the first page is the title far more often. */
export function largestTextRun(items: readonly TitleCandidate[]): string | undefined {
  const sized = items.filter((item) => item.str.trim().length > 0 && item.height > 0 && isUpright(item));
  if (sized.length === 0) return undefined;
  const max = Math.max(...sized.map((item) => item.height));
  const threshold = max * 0.92;
  // Take the first contiguous run of items at the largest size; a line break inside the run keeps it going.
  const start = sized.findIndex((item) => item.height >= threshold);
  const run: string[] = [];
  for (const item of sized.slice(start)) {
    if (item.height < threshold) break;
    run.push(item.str.trim());
  }
  const text = run.join(" ").replace(/\s+/g, " ").trim();
  return text.length >= 4 && text.length <= 300 ? text : undefined;
}

export type PdfDocument = import("pdfjs-dist/types/src/display/api").PDFDocumentProxy;

/** pdf.js failures as PdfError codes the store and the renderer already know. */
function toPdfError(error: unknown): PdfError {
  if (error instanceof PdfError) return error;
  const name = (error as { name?: string }).name;
  if (name === "PasswordException") return new PdfError("PDF_ENCRYPTED", "This PDF is password protected.");
  if (name === "InvalidPDFException") return new PdfError("PDF_INVALID", "This file is not a readable PDF.");
  return new PdfError("PDF_UNREADABLE", error instanceof Error ? error.message : "Could not open this PDF.");
}

/** Opens the document in Node (fake worker, standard fonts from disk), runs `use`, and always destroys the loading task. */
export async function withPdfDocument<T>(bytes: Uint8Array, use: (doc: PdfDocument) => Promise<T>): Promise<T> {
  const pdfjs = await loadPdfjs();
  const fontUrl = standardFontDataUrl();
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    disableFontFace: true,
    useSystemFonts: fontUrl === undefined,
    ...(fontUrl ? { standardFontDataUrl: fontUrl } : {}),
  });
  try {
    const doc = await task.promise;
    if (doc.numPages < 1) throw new PdfError("PDF_EMPTY", "This PDF has no pages.");
    return await use(doc);
  } catch (error) {
    throw toPdfError(error);
  } finally {
    await task.destroy();
  }
}

/** Reads page count, Info dict and a text sample. */
export function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  return withPdfDocument(bytes, async (doc) => {
    const pages = doc.numPages;
    const info = (await doc.getMetadata()).info as Record<string, unknown>;
    const parts: string[] = [];
    let headline: string | undefined;
    for (let index = 1; index <= Math.min(SAMPLE_PAGES, pages); index += 1) {
      const page = await doc.getPage(index);
      const content = await page.getTextContent();
      const items = content.items.filter((item): item is TextItem => "str" in item && "height" in item);
      if (index === 1) headline = largestTextRun(items);
      parts.push(items.map((item) => item.str).join(" "));
    }
    const sampleText = parts.join("\n").replace(/[ \t]+/g, " ").trim().slice(0, MAX_SAMPLE_CHARS);
    const title = cleanText(info.Title) ?? headline;
    return {
      pages,
      ...(title ? { title } : {}),
      ...(cleanText(info.Author) ? { author: cleanText(info.Author) } : {}),
      textLayer: sampleText.length > 0 ? "available" : "absent",
      sampleText,
    };
  });
}
