import { ORDERED_MARKER, blocksOfSequence, joinHyphenated, numberedDepth, type Block } from "../blocks";
import { captionKind, padded } from "../figures";
import { isProse, rectBottom, rectRight, unionRect, wordCountOf, type Line, type PageSize } from "../types";
import type { JudgeKind, JudgeVerdict } from "./types";
import { isRunIn, judgeKindOf } from "./uncertainty";

// Verdicts → blocks. A verdict counts only when the judge is confident and disagrees with the
// rules; then the block changes kind (furniture is dropped, a table is cropped, a caption joins
// its figure), and a block that continues the one before it is merged into it. Footnotes move
// to the end of their page's flow; a run of references opens its own section.

/** A kind verdict is applied at or above this confidence. */
export const KIND_THRESHOLD = 0.75;
/** A continuation is applied at or above this probability. */
export const CONTINUES_THRESHOLD = 0.8;
const REFERENCES_HEADING = /^(references|bibliography|works cited|literature cited)\b/i;
/** A heading verdict never splits prose of this many words over several lines. */
const HEADING_MAX_PROSE_WORDS = 25;
/** A furniture verdict is refused for a block longer than this in the middle of the page (a table of contents is not furniture). */
const FURNITURE_MAX_WORDS = 12;
const EDGE_BAND = 0.12;
/** Table rows the judge marked one by one are one table when the gap between them is at most this many line heights. */
const TABLE_ROW_GAP = 1.5;
const TABLE_OVERLAP_SHARE = 0.5;
/** A bullet the rules did not strip (no space after it, as some PDFs set "•the"), or an ordered marker. */
const JUDGED_LIST_MARKER = /^(?:[•●○◦▪■–—\-*·]\s*|\(?(?:\d{1,2}|[a-z]|[ivx]{1,4})[.)]\s+)/;

export interface ApplyContext {
  bodySize: number;
  sizes: ReadonlyMap<number, PageSize>;
}

export interface ApplyResult {
  blocks: Block[];
  /** Verdicts that changed a block (a kind, a merge). */
  changed: number;
  /** Lines dropped as furniture on the judge's word. */
  furnitureLines: number;
}

const ID = /^b(\d+)$/;

function indexOfId(id: string, count: number): number {
  const match = ID.exec(id);
  const index = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`A verdict names block ${id}, which the pipeline never sent to the judge.`);
  return index;
}

function withoutRoles(block: Block): Block {
  const { depth: _depth, ordered: _ordered, role: _role, ...rest } = block;
  return rest;
}

/** Lines a figure block swallowed, back as text blocks in reading order. */
function restoredFrom(block: Block): Block[] {
  const lines = [...(block.region?.consumed ?? [])].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  if (lines.length === 0) return [];
  const extent = unionRect(lines.map((line) => line.rect));
  return blocksOfSequence({ page: block.page, items: lines.map((line) => ({ kind: "line" as const, line })), left: extent.x, right: extent.x + extent.w }, block.fontSize || 10);
}

/** Tables the judge made from text rows; they merge with their neighbours in mergeTables. */
const judgedTables = new WeakSet<Block>();

function tableOf(block: Block, context: ApplyContext, lines: readonly Line[] = block.pieces.map((piece) => piece.line)): Block {
  const size = context.sizes.get(block.page) ?? { width: 1, height: 1 };
  const rect = padded(unionRect(lines.map((line) => line.rect)), size);
  const table: Block = { ...withoutRoles(block), kind: "figure", pieces: [], text: "", math: false, region: { page: block.page, kind: "table", rect, caption: [], consumed: [...lines] } };
  judgedTables.add(table);
  return table;
}

function topOf(block: Block, context: ApplyContext): number {
  const rect = block.region?.rect ?? block.pieces[0]?.line.rect;
  const size = context.sizes.get(block.page);
  return rect && size ? rect.y / size.height : 0.5;
}

/** A run-in phrase is body text unless the whole block is bold; multi-line prose is never a heading. */
function refusesHeading(block: Block): boolean {
  if (isRunIn(block) && !block.bold) return true;
  return block.pieces.length > 1 && wordCountOf(block.text) >= HEADING_MAX_PROSE_WORDS && isProse(block.text);
}

/** Long text in the middle of the page is content the judge misread, not furniture. */
function refusesFurniture(block: Block, context: ApplyContext): boolean {
  const top = topOf(block, context);
  return wordCountOf(block.text) > FURNITURE_MAX_WORDS && top > EDGE_BAND && top < 1 - EDGE_BAND;
}

function asKind(block: Block, kind: JudgeKind, context: ApplyContext): Block[] {
  const base = withoutRoles(block);
  switch (kind) {
    case "furniture": return refusesFurniture(block, context) ? [block] : [];
    case "heading": return refusesHeading(block) ? [block] : [{ ...base, kind: "heading", math: false, depth: numberedDepth(block.text) ?? block.depth ?? 2 }];
    case "table": return [tableOf(block, context)];
    case "math": return [{ ...base, kind: "paragraph", math: true }];
    case "list_item": return [listItemOf(base)];
    case "footnote": case "reference": case "caption": return [{ ...base, kind: "paragraph", math: false, role: kind }];
    case "body": return [{ ...base, kind: "paragraph", math: false }];
  }
}

/** The judge's list item: the marker the rules left in the text comes off, as the rules do for their own items. */
function listItemOf(block: Block): Block {
  const first = block.pieces[0];
  const marker = first ? JUDGED_LIST_MARKER.exec(first.text) : null;
  const pieces = first && marker ? [{ ...first, text: first.text.slice(marker[0].length) }, ...block.pieces.slice(1)] : block.pieces;
  return { ...block, kind: "listItem", math: false, pieces, text: pieces.map((piece) => piece.text).join(""), ordered: ORDERED_MARKER.test(first?.line.text ?? "") };
}

/** A figure block the rules made from a caption-less grid: the judge can give its lines back to the text. */
function reclassified(block: Block, kind: JudgeKind, context: ApplyContext): Block[] {
  if (block.kind !== "figure") return asKind(block, kind, context);
  if (kind === "table" || kind === "caption") return [block];
  return restoredFrom(block).flatMap((restored) => asKind(restored, kind, context));
}

function merged(previous: Block, next: Block): Block {
  const lastPiece = previous.pieces[previous.pieces.length - 1];
  const firstPiece = next.pieces[0];
  if (!lastPiece || !firstPiece) return previous;
  const joined = joinHyphenated(lastPiece.text, firstPiece.text);
  const pieces = [...previous.pieces.slice(0, -1), { ...lastPiece, text: joined.previous }, { ...firstPiece, text: joined.separator + firstPiece.text }, ...next.pieces.slice(1)];
  return { ...previous, pieces, text: pieces.map((piece) => piece.text).join(""), endsSentence: next.endsSentence, fullLast: next.fullLast };
}

const isText = (block: Block | undefined): block is Block => block !== undefined && block.kind !== "figure";

/** Kind changes and merges, in block order. */
function reclassify(blocks: readonly Block[], verdicts: readonly JudgeVerdict[], context: ApplyContext): ApplyResult {
  const byIndex = new Map(verdicts.map((verdict) => [indexOfId(verdict.id, blocks.length), verdict] as const));
  let changed = 0;
  let furnitureLines = 0;
  const result = blocks.reduce<Block[]>((acc, block, index) => {
    const verdict = byIndex.get(index);
    if (!verdict) return [...acc, block];
    const previous = acc[acc.length - 1];
    if ((verdict.continues ?? 0) >= CONTINUES_THRESHOLD && isText(previous) && isText(block)) {
      changed += 1;
      return [...acc.slice(0, -1), merged(previous, block)];
    }
    if (verdict.confidence < KIND_THRESHOLD || verdict.kind === judgeKindOf(block)) return [...acc, block];
    const next = reclassified(block, verdict.kind, context);
    if (next.length === 1 && next[0] === block) return [...acc, block];
    changed += 1;
    if (verdict.kind === "furniture") furnitureLines += block.pieces.length;
    return [...acc, ...next];
  }, []);
  return { blocks: result, changed, furnitureLines };
}

function linesOf(table: Block): Line[] { return table.region?.consumed ?? []; }

/** Two judged tables on one page, in one column (their extents overlap), separated by at most a row gap. */
function adjacentTables(previous: Block, next: Block): boolean {
  const above = linesOf(previous); const below = linesOf(next);
  if (above.length === 0 || below.length === 0 || previous.page !== next.page) return false;
  const a = unionRect(above.map((line) => line.rect)); const b = unionRect(below.map((line) => line.rect));
  const overlap = Math.min(rectRight(a), rectRight(b)) - Math.max(a.x, b.x);
  if (overlap < TABLE_OVERLAP_SHARE * Math.min(a.w, b.w)) return false;
  const lineHeight = Math.max(...[...above, ...below].map((line) => line.fontSize));
  return b.y - rectBottom(a) <= TABLE_ROW_GAP * lineHeight;
}

/** Rows the judge marked one by one become one crop when they sit in one column with only row gaps between them. */
function mergeTables(blocks: readonly Block[], context: ApplyContext): Block[] {
  return blocks.reduce<Block[]>((acc, block) => {
    const previous = acc[acc.length - 1];
    if (!previous || !judgedTables.has(previous) || !judgedTables.has(block) || !adjacentTables(previous, block)) return [...acc, block];
    return [...acc.slice(0, -1), tableOf(previous, context, [...linesOf(previous), ...linesOf(block)])];
  }, []);
}

/** A judge-found caption, or a "Table N" paragraph beside a judged table, names the nearest caption-less figure of its page. */
function isCaptionFor(block: Block, figure: Block): boolean {
  if (block.kind !== "paragraph" || block.page !== figure.page) return false;
  return block.role === "caption" || (judgedTables.has(figure) && captionKind(block.text) === "table");
}

/** A caption paragraph joins the nearest caption-less figure of its page; the others stay paragraphs marked as captions. */
function attachCaptions(blocks: readonly Block[]): Block[] {
  const captions = blocks.flatMap((block, index) => (block.kind === "paragraph" && (block.role === "caption" || captionKind(block.text) === "table") ? [index] : []));
  const taken = new Set<number>();
  const attachedTo = new Map<number, number>();
  for (const at of captions) {
    const candidates = blocks.flatMap((block, index) => (block.kind === "figure" && !block.text && !taken.has(index) && isCaptionFor(blocks[at]!, block) ? [index] : []));
    const nearest = candidates.sort((a, b) => Math.abs(a - at) - Math.abs(b - at))[0];
    if (nearest === undefined) continue;
    taken.add(nearest);
    attachedTo.set(nearest, at);
  }
  const consumed = new Set(attachedTo.values());
  return blocks.flatMap((block, index) => {
    if (consumed.has(index)) return [];
    const captionAt = attachedTo.get(index);
    if (captionAt === undefined) return [block];
    const caption = blocks[captionAt]!;
    const lines: Line[] = caption.pieces.map((piece) => piece.line);
    return [{ ...block, pieces: caption.pieces, text: caption.text, ...(block.region ? { region: { ...block.region, caption: lines } } : {}) }];
  });
}

/** Footnotes go after the last block of their page. */
function footnotesLast(blocks: readonly Block[]): Block[] {
  const result: Block[] = [];
  let pending: Block[] = [];
  let page: number | undefined;
  for (const block of blocks) {
    if (block.page !== page) { result.push(...pending); pending = []; page = block.page; }
    if (block.role === "footnote") pending = [...pending, block];
    else result.push(block);
  }
  return [...result, ...pending];
}

/** A run of references opens with a "References" heading unless the last heading before it already says so. */
function referencesSectioned(blocks: readonly Block[], context: ApplyContext): Block[] {
  let lastHeading: string | undefined;
  let inRun = false;
  return blocks.flatMap((block) => {
    if (block.kind === "heading") { lastHeading = block.text; inRun = false; return [block]; }
    if (block.role !== "reference") { inRun = false; return [block]; }
    if (inRun) return [block];
    inRun = true;
    if (lastHeading !== undefined && REFERENCES_HEADING.test(lastHeading.trim())) return [block];
    lastHeading = "References";
    const heading: Block = { kind: "heading", depth: 1, page: block.page, pieces: [], text: "References", fontSize: context.bodySize, bold: true, indented: false, centred: false, endsSentence: false, fullLast: false, math: false };
    return [heading, block];
  });
}

export function applyVerdicts(blocks: readonly Block[], verdicts: readonly JudgeVerdict[], context: ApplyContext): ApplyResult {
  const { blocks: reclassifiedBlocks, changed, furnitureLines } = reclassify(blocks, verdicts, context);
  if (changed === 0) return { blocks: [...blocks], changed, furnitureLines };
  return { blocks: referencesSectioned(footnotesLast(attachCaptions(mergeTables(reclassifiedBlocks, context))), context), changed, furnitureLines };
}
