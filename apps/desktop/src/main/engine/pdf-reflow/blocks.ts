import { endsSentence, isProse, rectRight, wordCountOf, type FigureRegion, type Line, type Sequence } from "./types";

// Lines → blocks. Consecutive lines of a sequence join into a paragraph until the leading
// widens, the font changes, a first line is indented or a marker starts a list item; a
// paragraph that stops mid-sentence continues into the next sequence (column, page).
// Headings are the short blocks set larger, bolder or numbered against the body size.

/** Lines further apart than this many font sizes, baseline to baseline, are separate paragraphs. */
const PARAGRAPH_LEADING = 1.6;
/** Font sizes within this share of each other are the same size. */
const SIZE_TOLERANCE = 0.06;
/** A first-line indent is at least this many ems. */
const INDENT_EMS = 1;
/** A line that ends this many ems short of the sequence's right edge is a paragraph's last line. */
const SHORT_LINE_EMS = 2;
const HEADING_SIZE_RATIO = 1.15;
const NUMBERED_HEADING_SIZE_RATIO = 1.05;
const HEADING_MAX_WORDS = 12;
const HEADING_MAX_LINES = 2;
/** Text within this share of the body size is body text (an abstract set a point smaller still counts). */
const BODY_SIZE_TOLERANCE = 0.12;
const MATH_SHARE = 0.3;
const MATH_MAX_CHARS = 60;

const LIST_MARKER = /^(?:[•●○◦▪■–—\-*·]|\(?(?:\d{1,2}|[a-z]|[ivx]{1,4})[.)])\s+/;
const ORDERED_MARKER = /^\(?(?:\d{1,2}|[a-z]|[ivx]{1,4})[.)]\s+/;
const NUMBERED_HEADING = /^(?:(\d+(?:\.\d+)*)\.?|([IVXLC]+)\.?|([A-Z])(?:\.\d+)*\.?)\s+[A-Z\d“"(]/;
const MATH_GLYPHS = /[=+\-×÷·∑∏∫√∞≤≥≠≈∂∇∈∀∃αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ^_{}|]/g;

export interface Piece { line: Line; text: string }

export interface Block {
  kind: "paragraph" | "heading" | "listItem" | "figure";
  page: number;
  pieces: Piece[];
  text: string;
  fontSize: number;
  bold: boolean;
  /** The first line was indented relative to its column. */
  indented: boolean;
  endsSentence: boolean;
  /** The last line reached the column's right edge, so the paragraph may continue elsewhere. */
  fullLast: boolean;
  /** The first line sits centred in its column (a title, an author line, a centred heading). */
  centred: boolean;
  math: boolean;
  depth?: 1 | 2 | 3;
  ordered?: boolean;
  region?: FigureRegion;
}

/** The body size: the most common line size, weighted by how much text is set in it. */
export function bodyFontSize(lines: readonly Line[]): number {
  const weights = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.fontSize * 2) / 2;
    weights.set(key, (weights.get(key) ?? 0) + line.text.length);
  }
  return [...weights.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 10;
}

function sameSize(a: number, b: number): boolean { return Math.abs(a - b) <= SIZE_TOLERANCE * Math.max(a, b); }

function modeLeft(lines: readonly Line[]): number {
  const counts = new Map<number, number>();
  for (const line of lines) { const key = Math.round(line.rect.x); counts.set(key, (counts.get(key) ?? 0) + 1); }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
}

function startsParagraph(previous: Line, next: Line, left: number, right: number, bodySize: number): boolean {
  const size = Math.max(previous.fontSize, next.fontSize);
  if (next.baseline - previous.baseline > PARAGRAPH_LEADING * size) return true;
  if (!sameSize(previous.fontSize, next.fontSize) || previous.bold !== next.bold) return true;
  if (LIST_MARKER.test(next.text)) return true;
  // A heading's second line hangs indented and follows a colon; only the leading and the font split heading-set lines.
  if (previous.bold || previous.fontSize >= NUMBERED_HEADING_SIZE_RATIO * bodySize) return false;
  const ended = endsSentence(previous.text);
  if (ended && next.rect.x - left >= INDENT_EMS * next.fontSize && next.rect.x - previous.rect.x >= INDENT_EMS * next.fontSize) return true;
  return ended && rectRight(previous.rect) < right - SHORT_LINE_EMS * previous.fontSize;
}

/** "infor-" + "mation" → "information"; a hyphen before a capital or digit stays ("GPT-" + "5"). */
export function joinHyphenated(previous: string, next: string): { previous: string; separator: string } {
  if (!/[-‐]$/.test(previous)) return { previous, separator: " " };
  return /^[a-z\p{Ll}]/u.test(next) ? { previous: previous.slice(0, -1), separator: "" } : { previous, separator: "" };
}

function isMath(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  return compact.length > 0 && compact.length <= MATH_MAX_CHARS && (compact.match(MATH_GLYPHS) ?? []).length / compact.length >= MATH_SHARE;
}

function blockOf(lines: readonly Line[], left: number, right: number): Block {
  const first = lines[0]!;
  const marker = LIST_MARKER.exec(first.text);
  const pieces = lines.reduce<Piece[]>((acc, line, index) => {
    const raw = index === 0 && marker ? line.text.slice(marker[0].length) : line.text;
    const previous = acc[acc.length - 1];
    if (!previous) return [{ line, text: raw }];
    const joined = joinHyphenated(previous.text, raw);
    return [...acc.slice(0, -1), { ...previous, text: joined.previous }, { line, text: joined.separator + raw }];
  }, []);
  const text = pieces.map((piece) => piece.text).join("");
  const last = lines[lines.length - 1]!;
  return {
    kind: marker ? "listItem" : "paragraph", page: first.page, pieces, text,
    fontSize: bodyFontSize(lines), bold: lines.every((line) => line.bold),
    indented: first.rect.x - left >= INDENT_EMS * first.fontSize,
    centred: Math.abs(first.rect.x + first.rect.w / 2 - (left + right) / 2) <= INDENT_EMS * first.fontSize,
    endsSentence: endsSentence(text), fullLast: rectRight(last.rect) >= right - SHORT_LINE_EMS * last.fontSize,
    math: lines.length === 1 && isMath(text),
    ...(marker ? { ordered: ORDERED_MARKER.test(first.text) } : {}),
  };
}

export function blocksOfSequence(sequence: Sequence, bodySize: number): Block[] {
  const lines = sequence.items.flatMap((item) => (item.kind === "line" ? [item.line] : []));
  const left = modeLeft(lines);
  const right = Math.max(sequence.right, ...lines.map((line) => rectRight(line.rect)));
  const blocks: Block[] = [];
  let current: Line[] = [];
  const flush = () => { if (current.length > 0) blocks.push(blockOf(current, left, right)); current = []; };
  for (const item of sequence.items) {
    if (item.kind === "figure") {
      flush();
      const caption = item.region.caption.map((line, index) => ({ line, text: (index === 0 ? "" : " ") + line.text }));
      blocks.push({ kind: "figure", page: sequence.page, pieces: caption, text: caption.map((piece) => piece.text).join(""), fontSize: caption[0]?.line.fontSize ?? 0, bold: false, indented: false, centred: false, endsSentence: true, fullLast: false, math: false, region: item.region });
      continue;
    }
    const previous = current[current.length - 1];
    if (previous && startsParagraph(previous, item.line, left, right, bodySize)) flush();
    current = [...current, item.line];
  }
  flush();
  return blocks;
}

/** A lone short line (a title, a label) does not continue anywhere; a paragraph that is cut off does. */
const MIN_CONTINUING_CHARS = 40;

function continues(previous: Block, next: Block): boolean {
  if (previous.kind !== "paragraph" || next.kind !== "paragraph" || previous.endsSentence || !previous.fullLast || next.indented) return false;
  if (previous.pieces.length < 2 && previous.text.length < MIN_CONTINUING_CHARS) return false;
  return !previous.math && !next.math && sameSize(previous.fontSize, next.fontSize);
}

/** Paragraphs that stop mid-sentence at the foot of a column or page continue with the next sequence's first paragraph. */
export function mergeAcross(blocks: readonly Block[]): Block[] {
  return blocks.reduce<Block[]>((acc, block) => {
    const previous = acc[acc.length - 1];
    if (!previous || !continues(previous, block)) return [...acc, block];
    const lastPiece = previous.pieces[previous.pieces.length - 1]!;
    const firstPiece = block.pieces[0]!;
    const joined = joinHyphenated(lastPiece.text, firstPiece.text);
    const pieces = [...previous.pieces.slice(0, -1), { ...lastPiece, text: joined.previous }, { ...firstPiece, text: joined.separator + firstPiece.text }, ...block.pieces.slice(1)];
    const text = pieces.map((piece) => piece.text).join("");
    return [...acc.slice(0, -1), { ...previous, pieces, text, endsSentence: block.endsSentence, fullLast: block.fullLast }];
  }, []);
}

export function numberedDepth(text: string): 1 | 2 | 3 | undefined {
  const match = NUMBERED_HEADING.exec(text);
  if (!match) return undefined;
  const dotted = match[1];
  if (dotted === undefined) return 1;
  return Math.min(3, dotted.split(".").length) as 1 | 2 | 3;
}

function headingLike(block: Block, next: Block | undefined, bodySize: number): boolean {
  if (block.kind !== "paragraph" || block.math || block.pieces.length > HEADING_MAX_LINES || block.text.length > 200) return false;
  const words = wordCountOf(block.text);
  if (block.fontSize >= HEADING_SIZE_RATIO * bodySize) return true;
  const nextIsBody = next !== undefined && (next.kind === "paragraph" || next.kind === "listItem") && Math.abs(next.fontSize - bodySize) <= BODY_SIZE_TOLERANCE * bodySize && isProse(next.text);
  // A bold line that ends in a full stop is a run-in heading's first line, not a heading of its own; one that
  // sits neither at the column's left nor centred (an author in a name grid) is not a heading either.
  if (block.bold && words <= HEADING_MAX_WORDS && nextIsBody && !/\.$/.test(block.text.trim()) && (!block.indented || block.centred)) return true;
  return numberedDepth(block.text) !== undefined && words <= HEADING_MAX_WORDS && block.fontSize >= NUMBERED_HEADING_SIZE_RATIO * bodySize;
}

/**
 * Marks headings and gives them depths: numbering decides when present; otherwise the page's
 * largest type is depth 1 and the rest depth 2. On page 1 the first heading in the largest
 * type is the title, and later unnumbered headings there are depth 2.
 */
export function classifyHeadings(blocks: readonly Block[], largestOnPage: ReadonlyMap<number, number>, bodySize: number): Block[] {
  let titleFound = false;
  return blocks.map((block, index) => {
    if (!headingLike(block, blocks[index + 1], bodySize)) return block;
    const numbered = numberedDepth(block.text);
    const largest = largestOnPage.get(block.page) ?? block.fontSize;
    const isLargest = block.fontSize >= largest - 0.5;
    let depth: 1 | 2 | 3;
    if (block.page === 1 && !titleFound && isLargest) { titleFound = true; depth = 1; }
    else if (numbered !== undefined) depth = numbered;
    else depth = isLargest && block.page !== 1 ? 1 : 2;
    return { ...block, kind: "heading", depth };
  });
}
