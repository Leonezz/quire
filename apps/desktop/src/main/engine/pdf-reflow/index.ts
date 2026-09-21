import type { NormalizationProblem } from "@read/normalize/contract";
import type { MaterialViewContent, TextViewReport } from "../../../shared/contracts";
import { TEXT_VIEW_MEDIA_TYPE } from "../material-views";
import { PdfError, withPdfDocument } from "../pdf";
import { readingMinutes } from "../reading-time";
import { blocksOfSequence, bodyFontSize, classifyHeadings, mergeAcross, type Block } from "./blocks";
import { dominantColumns, layoutPage } from "./columns";
import { figureRendererOf } from "./crop";
import { assembleDocument, type DocumentBlock } from "./document";
import { extractPages } from "./extract";
import { figureRegionsOf } from "./figures";
import { removeFurniture, withoutMarkers } from "./furniture";
import { sequencesOf } from "./sequences";
import type { PageSize } from "./types";

// The text view of a PDF (SDT-lite): the PDF's own text layer reflowed into one column of
// paragraphs, headings and lists, with figures and tables cropped from the page as pictures.
// Built in the main process, never fetched; every line keeps its page rect (see document.ts).

export interface FigureSink {
  /** Stores the crop and returns the URL the reader resolves it by (quire-figure://<materialId>/<n>.png). */
  write: (materialId: string, index: number, png: Uint8Array) => Promise<string>;
}

export interface BuildTextViewDeps { figures: FigureSink; /** The material title; a leading heading repeating it is not emitted twice. */ title?: string }

const problem = (code: string): NormalizationProblem => ({ code, recoverBy: "none", scope: "representation", severity: "warning" });

async function withCrops(blocks: readonly Block[], materialId: string, renderer: ReturnType<typeof figureRendererOf>, sink: FigureSink): Promise<{ blocks: DocumentBlock[]; figures: number }> {
  const result: DocumentBlock[] = [];
  let figures = 0;
  for (const block of blocks) {
    if (block.kind !== "figure" || !block.region) { result.push(block); continue; }
    figures += 1;
    if ("error" in renderer) { result.push({ ...block, number: figures }); continue; }
    const crop = await renderer.renderer.render(block.page, block.region.rect);
    const url = await sink.write(materialId, figures, crop.png);
    result.push({ ...block, number: figures, asset: { url, width: crop.width, height: crop.height } });
  }
  return { blocks: result, figures };
}

/** Builds the text view from the PDF's bytes; throws a PdfError when the PDF cannot be read or has no usable text at all. */
export function buildTextView(bytes: Uint8Array, materialId: string, deps: BuildTextViewDeps): Promise<MaterialViewContent> {
  return withPdfDocument(bytes, async (doc) => {
    const extracted = await extractPages(doc);
    const degradedPages = extracted.filter((page) => page.degraded).map((page) => page.page);
    if (degradedPages.length === extracted.length) throw new PdfError("TEXT_VIEW_NO_TEXT", "This PDF has no usable text layer; nothing can be reflowed.");
    const furniture = removeFurniture(extracted);
    const bodySize = bodyFontSize(furniture.pages.flatMap((page) => page.lines));
    const pages = withoutMarkers(furniture.pages, bodySize);
    const layouts = pages.map(layoutPage);
    const sequences = pages.flatMap((page, index) => sequencesOf(layouts[index]!, figureRegionsOf(page, layouts[index]!, bodySize)));
    const largestOnPage = new Map(pages.map((page) => [page.page, Math.max(0, ...page.lines.map((line) => line.fontSize))]));
    const blocks = classifyHeadings(mergeAcross(sequences.flatMap((sequence) => blocksOfSequence(sequence, bodySize))), largestOnPage, bodySize);
    const renderer = figureRendererOf(doc);
    const cropped = await withCrops(blocks, materialId, renderer, deps.figures);
    const sizes = new Map<number, PageSize>(pages.map((page) => [page.page, { width: page.width, height: page.height }]));
    const assembled = assembleDocument(cropped.blocks, sizes, deps.title);
    const problems = [
      ...(degradedPages.length > 0 ? [problem("TEXT_VIEW_PAGE_DEGRADED")] : []),
      ...("error" in renderer && cropped.figures > 0 ? [problem("TEXT_VIEW_NO_FIGURES")] : []),
    ];
    const report: TextViewReport = {
      pages: extracted.length, columns: dominantColumns(layouts), furnitureLines: furniture.removed,
      headings: blocks.filter((block) => block.kind === "heading").length,
      paragraphs: blocks.filter((block) => block.kind === "paragraph" || block.kind === "listItem").length,
      figures: cropped.figures, degradedPages,
    };
    return {
      view: "text", mediaType: TEXT_VIEW_MEDIA_TYPE,
      reader: { schema: "reader.document.v2", payload: JSON.stringify(assembled.document) },
      markdown: assembled.markdown, plain: assembled.plain,
      readingMinutes: readingMinutes(assembled.plain),
      quality: { completeness: degradedPages.length > 0 ? "ambiguous" : "declared_full", conformance: "conformant", identityConfidence: "derived", safety: "safe", warnings: problems },
      problems, anchors: assembled.anchors, report,
    };
  });
}
