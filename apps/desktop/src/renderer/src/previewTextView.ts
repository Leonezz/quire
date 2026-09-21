import type { MaterialViewContent, TextViewAnchor, TextViewReport } from "../../shared/contracts";

// The text view of the preview's sample PDF: a small hand-written reflow whose every line carries an
// anchor into pages 1–2, so the note mirroring between the PDF and Text views can be exercised in a
// browser. The engine builds the real thing from the PDF's own text layer.

export const PREVIEW_TEXT_VIEW_MEDIA_TYPE = "text/plain";
/** Set this localStorage key to "1" to see the degraded-pages banner in the preview. */
export const PREVIEW_TEXT_DEGRADED_KEY = "read:preview-text-degraded";

type Line = { text: string; page: number; y: number };
type Block =
  | { kind: "heading"; depth: 1 | 2; lines: Line[] }
  | { kind: "paragraph"; lines: Line[] }
  | { kind: "figure"; n: number; alt: string; caption: Line[] };

/** A single text column: where the lines sit on the canonical page, top-left origin, 0..1. */
const COLUMN = { x: 0.12, width: 0.76, lineHeight: 0.018, lineStep: 0.024 };
const FIGURE_SIZE = { width: 320, height: 200 };

/** Lines laid out one under the other from `top` on `page`. */
function lines(page: number, top: number, texts: readonly string[]): Line[] {
  return texts.map((text, index) => ({ text, page, y: top + index * COLUMN.lineStep }));
}

const FIGURES: readonly { n: number; alt: string }[] = [{ n: 1, alt: "The encoder and decoder stacks, each a column of attention and feed-forward blocks" }];

const BLOCKS: readonly Block[] = [
  { kind: "heading", depth: 1, lines: lines(1, 0.10, ["Attention Is All You Need"]) },
  { kind: "paragraph", lines: lines(1, 0.16, [
    "The dominant sequence transduction models are based on complex recurrent or convolutional",
    "networks that include an encoder and a decoder. We propose a simpler architecture based",
    "solely on attention mechanisms, dispensing with recurrence and convolutions entirely.",
  ]) },
  { kind: "heading", depth: 2, lines: lines(1, 0.26, ["1 Introduction"]) },
  { kind: "paragraph", lines: lines(1, 0.30, [
    "Recurrent neural networks have long been the state of the art in sequence modeling and",
    "transduction problems such as language modeling and machine translation. Numerous efforts",
    "have since pushed the boundaries of recurrent language models and encoder-decoder",
    "architectures, but their sequential nature precludes parallelization within an example.",
  ]) },
  { kind: "paragraph", lines: [
    ...lines(1, 0.41, [
      "Attention mechanisms let a model draw on dependencies without regard to their distance in",
      "the input or output sequences. In all but a few cases, however, such attention is used",
    ]),
    ...lines(2, 0.10, ["in conjunction with a recurrent network rather than in its place."]),
  ] },
  { kind: "paragraph", lines: lines(2, 0.14, [
    "In this work we propose the Transformer, an architecture that relies entirely on attention",
    "to draw global dependencies between input and output. It allows for significantly more",
    "parallelization and reaches a new state of the art after twelve hours on eight GPUs.",
  ]) },
  { kind: "figure", n: 1, alt: FIGURES[0]!.alt, caption: lines(2, 0.62, [
    "Figure 1: The Transformer model architecture, with the encoder on the left and the",
    "decoder on the right.",
  ]) },
];

const blockLines = (block: Block): Line[] => (block.kind === "figure" ? block.caption : block.lines);
const anchorOf = (line: Line, start: number): TextViewAnchor => ({ page: line.page, rect: [COLUMN.x, line.y, COLUMN.width, COLUMN.lineHeight], start, end: start + line.text.length });

/** The blocks as a Reader Document v2, with `plain` (blocks joined by blank lines, lines by spaces) and one anchor per line. */
function reflow(materialId: string): { payload: string; plain: string; anchors: TextViewAnchor[] } {
  const anchors: TextViewAnchor[] = [];
  const parts: string[] = [];
  let offset = 0;
  const children = BLOCKS.map((block) => {
    const texts: string[] = [];
    for (const line of blockLines(block)) {
      if (texts.length) offset += 1;
      anchors.push(anchorOf(line, offset));
      texts.push(line.text);
      offset += line.text.length;
    }
    const text = texts.join(" ");
    parts.push(text);
    offset += 2;
    if (block.kind === "heading") return { type: "heading", depth: block.depth, children: [{ type: "text", value: text }] };
    if (block.kind === "paragraph") return { type: "paragraph", children: [{ type: "text", value: text }] };
    return { type: "figure", media: [{ type: "image", url: `quire-figure://${materialId}/${block.n}.png`, alt: block.alt, title: null, ...FIGURE_SIZE }], caption: [{ type: "text", value: text }], credit: [] };
  });
  return { payload: JSON.stringify({ type: "root", children, losses: [] }), plain: parts.join("\n\n"), anchors };
}

function report(): TextViewReport {
  const degraded = localStorage.getItem(PREVIEW_TEXT_DEGRADED_KEY) === "1";
  return {
    pages: 2, columns: 1, furnitureLines: 4,
    headings: BLOCKS.filter((block) => block.kind === "heading").length,
    paragraphs: BLOCKS.filter((block) => block.kind === "paragraph").length,
    figures: BLOCKS.filter((block) => block.kind === "figure").length,
    degradedPages: degraded ? [3, 4] : [],
  };
}

/** The preview's text view for `materialId`: the reflow above, as the engine would store it. */
export function previewTextViewContent(materialId: string, quality: MaterialViewContent["quality"]): MaterialViewContent {
  const { payload, plain, anchors } = reflow(materialId);
  return { view: "text", mediaType: PREVIEW_TEXT_VIEW_MEDIA_TYPE, reader: { schema: "reader.document.v2", payload }, plain, readingMinutes: 2, quality, problems: [], anchors, report: report() };
}

/**
 * The figure crop `quire-figure://<materialId>/<n>.png` as a PNG data URL: a bordered card with the
 * figure's caption, drawn on a canvas. Undefined for any other URL or material.
 */
export function previewFigurePng(url: string, materialId: string): string | undefined {
  const match = /^quire-figure:\/\/([^/]+)\/(\d+)\.png$/.exec(url);
  if (!match || match[1] !== materialId) return undefined;
  const figure = FIGURES.find((entry) => entry.n === Number(match[2]));
  if (!figure) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = FIGURE_SIZE.width; canvas.height = FIGURE_SIZE.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The preview cannot draw the figure: the canvas 2D context is unavailable.");
  context.fillStyle = "#f7f4ee";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#8b8578";
  context.lineWidth = 2;
  context.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
  // Two stacks of blocks: the encoder and the decoder.
  context.fillStyle = "#d9d2c3";
  for (const [x, y] of [[60, 40], [60, 90], [200, 40], [200, 90]] as const) context.fillRect(x, y, 60, 32);
  context.fillStyle = "#3a3733";
  context.font = "12px system-ui, sans-serif";
  context.textAlign = "center";
  context.fillText("Encoder", 90, 140);
  context.fillText("Decoder", 230, 140);
  context.font = "11px system-ui, sans-serif";
  context.fillText(`Figure ${figure.n} · preview crop`, canvas.width / 2, canvas.height - 14);
  return canvas.toDataURL("image/png");
}
