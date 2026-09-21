import { numberedDepth, type Block } from "../blocks";
import type { PageLayout } from "../columns";
import { isProse, wordCountOf, type Line, type PageSize } from "../types";
import { MAX_HEAD_CHARS, type JudgeBlock, type JudgeKind, type JudgePage } from "./types";

// Which blocks the rules are sure about. Certain: multi-line body-sized prose, numbered
// headings, captioned figures. Everything else (short or bold lines, front matter, blocks at the
// page's edges or beside figures, "(1)"-style starts, caption-less grids) goes to the judge.

/** A body-sized paragraph of at least this many words over at least two lines, mostly lowercase words, reads as prose beyond doubt. */
const CERTAIN_PROSE_WORDS = 25;
/** Beside a figure, prose needs this many words before it is surely not a label or a stray caption line. */
const FIGURE_NEIGHBOUR_WORDS = 60;
const BODY_SIZE_TOLERANCE = 0.12;
/** Blocks whose top lies in the page's top or bottom band are furniture or footnote candidates. */
const EDGE_BAND = 0.12;
/** The first page's front matter (title, authors, affiliations, abstract label) lies above this share of the page. */
const FRONT_MATTER_SHARE = 0.35;
const EQUATION_NUMBER = /^\(\d{1,3}\)/;
/** A block of at least this many lines at the page's edge is running text, not a running head or a footnote. */
const EDGE_CERTAIN_LINES = 3;
/** Under a references heading, multi-line entries of at least this many words are references beyond doubt. */
const REFERENCE_MIN_WORDS = 10;
const REFERENCES_HEADING = /^(references|bibliography|works cited|literature cited)\b/i;

export interface UncertaintyContext {
  bodySize: number;
  sizes: ReadonlyMap<number, PageSize>;
  layouts: ReadonlyMap<number, PageLayout>;
}

export function judgeKindOf(block: Block): JudgeKind {
  if (block.kind === "heading") return "heading";
  if (block.kind === "listItem") return "list_item";
  if (block.kind === "figure") return block.region?.caption.length ? "caption" : "table";
  if (block.role === "footnote" || block.role === "reference" || block.role === "caption") return block.role;
  return block.math ? "math" : "body";
}

function firstLine(block: Block): Line | undefined {
  return block.pieces[0]?.line ?? block.region?.caption[0] ?? block.region?.consumed[0];
}

function columnOf(block: Block, layout: PageLayout | undefined): number {
  const line = firstLine(block);
  if (!layout || !line || layout.extents.length < 2) return 0;
  const centre = line.rect.x + line.rect.w / 2;
  const index = layout.extents.findIndex(([left, right]) => centre >= left && centre <= right);
  return index < 0 ? 0 : index;
}

function topOf(block: Block, size: PageSize | undefined): number {
  const line = firstLine(block);
  const rect = block.region?.rect ?? line?.rect;
  if (!rect || !size) return 0;
  return rect.y / size.height;
}

function isBodySized(block: Block, bodySize: number): boolean {
  return Math.abs(block.fontSize - bodySize) <= BODY_SIZE_TOLERANCE * bodySize;
}

/** A bold first line (or a bold lead span closed by a period/colon) followed by regular text: a run-in heading inside a paragraph. */
export function isRunIn(block: Block): boolean {
  const first = block.pieces[0]?.line;
  if (!first || block.bold || block.kind === "figure") return false;
  if (first.boldLead) return true;
  return first.bold && block.pieces.length > 1 && block.pieces.slice(1).some((piece) => !piece.line.bold);
}

function startsLikeEquation(block: Block): boolean {
  return EQUATION_NUMBER.test(block.pieces[0]?.line.text ?? "");
}

/**
 * Whether the rules' kind for a block is beyond doubt. `neighbours` are the blocks before and after
 * it in reading order; a block beside a figure is uncertain (a label, a stray caption line).
 */
export function isCertain(block: Block, context: UncertaintyContext, neighbours: readonly (Block | undefined)[], inReferences = false): boolean {
  if (block.kind === "figure") return (block.region?.caption.length ?? 0) > 0;
  if (block.kind === "heading") return numberedDepth(block.text) !== undefined;
  if (startsLikeEquation(block) || block.pieces.length < 2 || !isBodySized(block, context.bodySize)) return false;
  const top = topOf(block, context.sizes.get(block.page));
  if (block.page === 1 && top < FRONT_MATTER_SHARE) return false;
  const words = wordCountOf(block.text);
  if (inReferences && block.kind === "paragraph" && words >= REFERENCE_MIN_WORDS) return true;
  if (words < CERTAIN_PROSE_WORDS || !isProse(block.text)) return false;
  // A short bold block may be a heading; a long one is a paragraph the font flagged bold. Prose is certain unless it is
  // short enough to be a label beside a figure, or thin enough to be furniture at an edge.
  if (block.bold && block.pieces.length < EDGE_CERTAIN_LINES) return false;
  if (neighbours.some((neighbour) => neighbour?.kind === "figure") && words < FIGURE_NEIGHBOUR_WORDS) return false;
  return (top >= EDGE_BAND && top <= 1 - EDGE_BAND) || block.pieces.length >= EDGE_CERTAIN_LINES;
}

function headOf(block: Block): string {
  const text = block.kind === "figure" && !block.text ? (block.region?.consumed ?? []).map((line) => line.text).join(" | ") : block.text;
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= MAX_HEAD_CHARS ? compact : `${compact.slice(0, MAX_HEAD_CHARS - 1)}…`;
}

export function judgeBlockOf(block: Block, index: number, context: UncertaintyContext, neighbours: readonly (Block | undefined)[], inReferences = false): JudgeBlock {
  const layout = context.layouts.get(block.page);
  const lines = block.kind === "figure" && !block.text ? (block.region?.consumed.length ?? 0) : block.pieces.length;
  return {
    id: `b${index}`, page: block.page,
    column: columnOf(block, layout), columns: layout?.columns ?? 1,
    y: Number(topOf(block, context.sizes.get(block.page)).toFixed(3)),
    sizeRatio: Number((block.fontSize / context.bodySize).toFixed(2)),
    bold: block.bold, runIn: isRunIn(block), lines, words: wordCountOf(block.text || headOf(block)),
    head: headOf(block), kind: judgeKindOf(block), certain: isCertain(block, context, neighbours, inReferences),
  };
}

/**
 * Whether each block sits under a references heading, until the next top-level heading. The heading
 * itself may have escaped the rules (a lone "References" line is not followed by prose), so any
 * one-line block that says so opens the section.
 */
function referenceSectionsOf(blocks: readonly Block[]): boolean[] {
  let inside = false;
  return blocks.map((block) => {
    if (block.pieces.length === 1 && REFERENCES_HEADING.test(block.text.trim()) && wordCountOf(block.text) <= 2) inside = true;
    else if (block.kind === "heading" && (block.depth ?? 2) === 1) inside = false;
    return inside;
  });
}

/** The blocks grouped by page, in reading order, each with its features and certainty; ids index into `blocks`. */
export function judgePagesOf(blocks: readonly Block[], context: UncertaintyContext): JudgePage[] {
  const inReferences = referenceSectionsOf(blocks);
  const judged = blocks.map((block, index) => judgeBlockOf(block, index, context, [blocks[index - 1], blocks[index + 1]], inReferences[index]));
  const pages = new Map<number, JudgeBlock[]>();
  for (const block of judged) pages.set(block.page, [...(pages.get(block.page) ?? []), block]);
  return [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([page, entries]) => ({ page, blocks: entries }));
}
