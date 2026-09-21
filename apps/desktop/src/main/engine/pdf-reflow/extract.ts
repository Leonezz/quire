import type { PdfDocument } from "../pdf";
import { linesOfRuns } from "./lines";
import type { PageLines, Rect, Run } from "./types";

// Text items of a page → runs with their boxes in viewport space (points, top-left origin).
// pdf.js gives each item its text matrix; the glyph box is the advance along the matrix's
// x axis by the font's ascent/descent along its y axis, mapped through the viewport.

type TextItem = import("pdfjs-dist/types/src/display/api").TextItem;
type TextStyleLike = { ascent?: number; descent?: number };

export interface ViewportLike {
  width: number;
  height: number;
  convertToViewportPoint: (x: number, y: number) => number[];
}

export interface PageTextInput {
  page: number;
  items: readonly Pick<TextItem, "str" | "transform" | "width" | "height" | "fontName">[];
  styles: Record<string, TextStyleLike>;
  viewport: ViewportLike;
  /** The real font name behind pdf.js's loaded name (g_d0_f1 → NimbusRomNo9L-Medi); undefined when not exposed. */
  fontNameOf: (loadedName: string) => string | undefined;
}

const DEFAULT_ASCENT = 0.8;
const DEFAULT_DESCENT = -0.2;
const BOLD_FONT = /bold|black|heavy|semibold|demibold|demi\b|extrab|ultrab|medi(?!um)|cmbx|cmb\d|-b\b|-bd\b/i;
const ITALIC_FONT = /italic|oblique|ital\b|cmti|cmmi|-it\b|-i\b/i;

const REPLACEMENT_RATIO = 0.3;
const MIN_CHARS_FOR_SPACING_CHECK = 200;
const MAX_AVERAGE_WORD_LENGTH = 15;

function boxOf(item: PageTextInput["items"][number], style: TextStyleLike | undefined, viewport: ViewportLike): { rect: Rect; baseline: number; fontSize: number; rotated: boolean } {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = item.transform as number[];
  const size = Math.hypot(c, d) || item.height || Math.hypot(a, b);
  const advance = Math.hypot(a, b) || size;
  const ux = a / advance; const uy = b / advance; // unit advance direction in user space
  const vx = c / (size || 1); const vy = d / (size || 1); // unit "up" direction in user space
  const ascent = (style?.ascent ?? DEFAULT_ASCENT) * size;
  const descent = (style?.descent ?? DEFAULT_DESCENT) * size;
  const corners = [[0, descent], [item.width, descent], [0, ascent], [item.width, ascent]].map(([t, y]) =>
    viewport.convertToViewportPoint(e + ux * t! + vx * y!, f + uy * t! + vy * y!),
  );
  const xs = corners.map((point) => point[0] ?? 0);
  const ys = corners.map((point) => point[1] ?? 0);
  const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  const origin = viewport.convertToViewportPoint(e, f);
  const step = viewport.convertToViewportPoint(e + ux, f + uy);
  const rotated = Math.abs((step[1] ?? 0) - (origin[1] ?? 0)) > 0.05;
  return { rect, baseline: rotated ? rect.y + rect.h : (origin[1] ?? 0), fontSize: size, rotated };
}

/** Runs of one page; whitespace-only items are kept so the line joiner knows a space was drawn. */
export function runsOfPage(input: PageTextInput): Run[] {
  return input.items.flatMap((item) => {
    if (item.str.length === 0) return [];
    const box = boxOf(item, input.styles[item.fontName], input.viewport);
    if (!(box.fontSize > 0) || !Number.isFinite(box.rect.x) || !Number.isFinite(box.rect.y)) return [];
    const font = input.fontNameOf(item.fontName) ?? "";
    return [{ text: item.str, ...box, bold: BOLD_FONT.test(font), italic: ITALIC_FONT.test(font) }];
  });
}

/**
 * Whether a page's text layer is unusable: nothing readable, mostly replacement characters,
 * or long unspaced glyph soup (a text layer without word breaks reads as garbage).
 */
export function isDegradedText(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length === 0) return true;
  const replacements = (compact.match(/�/g) ?? []).length;
  if (replacements / compact.length > REPLACEMENT_RATIO) return true;
  if (compact.length < MIN_CHARS_FOR_SPACING_CHECK) return false;
  const words = text.trim().split(/\s+/).filter(Boolean);
  return compact.length / Math.max(1, words.length) > MAX_AVERAGE_WORD_LENGTH;
}

/** Every page of the document as lines; fonts are resolved through the operator list so bold/italic hints exist. */
export async function extractPages(doc: PdfDocument): Promise<PageLines[]> {
  const pages: PageLines[] = [];
  for (let index = 1; index <= doc.numPages; index += 1) {
    const page = await doc.getPage(index);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    await page.getOperatorList();
    const fontNameOf = (loadedName: string): string | undefined => {
      if (!page.commonObjs.has(loadedName)) return undefined;
      const font = page.commonObjs.get(loadedName) as { name?: unknown } | null;
      return typeof font?.name === "string" ? font.name : undefined;
    };
    const items = content.items.filter((item): item is TextItem => "str" in item && "transform" in item);
    const runs = runsOfPage({ page: index, items, styles: content.styles, viewport, fontNameOf });
    const lines = linesOfRuns(index, runs);
    const degraded = isDegradedText(lines.map((line) => line.text).join("\n"));
    pages.push({ page: index, width: viewport.width, height: viewport.height, lines: degraded ? [] : lines, degraded });
  }
  return pages;
}
