import type { Block } from "../blocks";

// OCR text layers split a display title into one word per line ("STRAIN" / "OF" / "FORCES"). Before
// judging, consecutive one-word bold or large lines on the first page that sit within one line height
// of each other are one block again, so the judge sees a title and not three.

const LARGE_RATIO = 1.15;

/** A one-word bold or large line on page 1, or the run such lines already formed. */
function isTitleRun(block: Block, bodySize: number): boolean {
  if (block.kind !== "paragraph" || block.page !== 1 || block.pieces.length === 0) return false;
  if (!block.pieces.every((piece) => /^\s?\S+$/.test(piece.text))) return false;
  return block.bold || block.fontSize >= LARGE_RATIO * bodySize;
}

/** The next line starts at most one line height below the previous one. */
function withinLine(previous: Block, next: Block): boolean {
  const a = previous.pieces[previous.pieces.length - 1]!.line; const b = next.pieces[0]!.line;
  return b.baseline > a.baseline && b.baseline - a.baseline <= 2 * Math.max(a.fontSize, b.fontSize);
}

function joined(previous: Block, next: Block): Block {
  const piece = next.pieces[0]!;
  const pieces = [...previous.pieces, { ...piece, text: ` ${piece.text}` }];
  return { ...previous, pieces, text: pieces.map((entry) => entry.text).join(""), endsSentence: next.endsSentence, fullLast: next.fullLast };
}

/** Merges runs of one-word title lines on page 1; every other block passes through unchanged. */
export function mergeSplitTitles(blocks: readonly Block[], bodySize: number): Block[] {
  return blocks.reduce<Block[]>((acc, block) => {
    const previous = acc[acc.length - 1];
    if (previous && block.pieces.length === 1 && isTitleRun(block, bodySize) && isTitleRun(previous, bodySize) && withinLine(previous, block)) return [...acc.slice(0, -1), joined(previous, block)];
    return [...acc, block];
  }, []);
}
