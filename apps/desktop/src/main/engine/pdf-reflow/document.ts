import type { ReaderDocumentV2 } from "@read/normalize/contract";
import type { TextViewAnchor } from "../../../shared/contracts";
import type { Block, Piece } from "./blocks";
import { canonicalRect, type PageSize } from "./types";

// Blocks → the three representations the reader takes: a reader.document.v2 tree with
// sections nested by heading depth, Markdown for the agent, and `plain` where every block is
// one line and every source line is an anchor [start, end) back to its page rect.

type ReaderV2FlowNode = ReaderDocumentV2["children"][number];
type ReaderV2PhrasingNode = Extract<ReaderV2FlowNode, { type: "paragraph" }>["children"][number];
type ReaderV2Image = Extract<ReaderV2PhrasingNode, { type: "image" }>;
type ReaderV2ListItem = Extract<ReaderV2FlowNode, { type: "list" }>["children"][number];

export interface FigureAsset { url: string; width: number; height: number }

/** A block ready for the document: figures carry their crop, or nothing when none could be rendered. */
export interface DocumentBlock extends Block {
  number?: number;
  asset?: FigureAsset;
}

export interface Assembled { document: ReaderDocumentV2; markdown: string; plain: string; anchors: TextViewAnchor[] }

const text = (value: string): ReaderV2PhrasingNode => ({ type: "text", value });

function figureLabel(block: DocumentBlock): string {
  return `${block.region?.kind === "table" ? "Table" : "Figure"} ${block.number ?? 0}`;
}

/** The line a block contributes to `plain`, and which pieces map onto it. */
function plainLineOf(block: DocumentBlock): { line: string; pieces: Piece[] | undefined } {
  if (block.kind !== "figure") return { line: block.text, pieces: block.pieces };
  if (block.asset) return block.text ? { line: block.text, pieces: block.pieces } : { line: `[${figureLabel(block)}]`, pieces: undefined };
  return { line: block.text ? `[${figureLabel(block)}: ${block.text}]` : `[${figureLabel(block)}]`, pieces: undefined };
}

function anchorsOf(block: DocumentBlock, start: number, line: string, pieces: Piece[] | undefined, sizes: ReadonlyMap<number, PageSize>): TextViewAnchor[] {
  const sizeOf = (page: number) => sizes.get(page) ?? { width: 1, height: 1 };
  if (!pieces) {
    const rect = block.region?.rect ?? block.pieces[0]?.line.rect;
    return rect ? [{ page: block.page, rect: canonicalRect(rect, sizeOf(block.page)), start, end: start + line.length }] : [];
  }
  let offset = start;
  return pieces.flatMap((piece) => {
    const leading = piece.text.length - piece.text.trimStart().length;
    const from = offset + leading;
    const to = offset + piece.text.length;
    offset = to;
    return to > from ? [{ page: piece.line.page, rect: canonicalRect(piece.line.rect, sizeOf(piece.line.page)), start: from, end: to }] : [];
  });
}

function imageOf(block: DocumentBlock): ReaderV2Image {
  const { url, width, height } = block.asset!;
  return { type: "image", url, alt: block.text || figureLabel(block), title: null, width, height };
}

function flowOf(block: DocumentBlock, line: string): ReaderV2FlowNode {
  if (block.kind === "heading") return { type: "heading", depth: block.depth ?? 2, children: [text(block.text)] };
  if (block.kind === "figure" && block.asset) return { type: "figure", media: [imageOf(block)], caption: block.text ? [text(block.text)] : [], credit: [] };
  return { type: "paragraph", children: [text(line)] };
}

function markdownOf(block: DocumentBlock, line: string): string {
  if (block.kind === "heading") return `${"#".repeat(block.depth ?? 2)} ${block.text}`;
  if (block.kind === "listItem") return `${block.ordered ? "1." : "-"} ${block.text}`;
  if (block.kind === "figure" && block.asset) return `![${(block.text || figureLabel(block)).replace(/[[\]]/g, "")}](${block.asset.url})${block.text ? `\n\n${block.text}` : ""}`;
  return line;
}

/** Consecutive list items become one list; everything else stays a flow node. */
function groupLists(entries: readonly { block: DocumentBlock; node: ReaderV2FlowNode }[]): ReaderV2FlowNode[] {
  return entries.reduce<ReaderV2FlowNode[]>((acc, { block, node }) => {
    if (block.kind !== "listItem") return [...acc, node];
    const item: ReaderV2ListItem = { type: "listItem", spread: false, children: [node] };
    const last = acc[acc.length - 1];
    if (last?.type === "list" && last.ordered === Boolean(block.ordered)) return [...acc.slice(0, -1), { ...last, children: [...last.children, item] }];
    return [...acc, { type: "list", ordered: Boolean(block.ordered), spread: false, start: block.ordered ? 1 : null, children: [item] }];
  }, []);
}

/** Headings open sections that hold everything up to the next heading of the same or a shallower depth. */
function sectioned(entries: readonly { block: DocumentBlock; node: ReaderV2FlowNode }[]): ReaderV2FlowNode[] {
  type Frame = { depth: number; items: { block: DocumentBlock; node: ReaderV2FlowNode }[] };
  const stack: Frame[] = [{ depth: 0, items: [] }];
  const close = () => {
    const frame = stack.pop()!;
    const section: ReaderV2FlowNode = { type: "section", children: groupLists(frame.items) };
    stack[stack.length - 1]!.items.push({ block: frame.items[0]!.block, node: section });
  };
  for (const entry of entries) {
    if (entry.block.kind === "heading") {
      const depth = entry.block.depth ?? 2;
      while (stack.length > 1 && stack[stack.length - 1]!.depth >= depth) close();
      stack.push({ depth, items: [entry] });
      continue;
    }
    stack[stack.length - 1]!.items.push(entry);
  }
  while (stack.length > 1) close();
  return groupLists(stack[0]!.items);
}

const sameTitle = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * `title`: the material's own title. The reader prints it above the document, so a leading heading
 * that repeats it is kept in `plain` (anchors stay valid) but left out of the tree and the Markdown.
 */
export function assembleDocument(blocks: readonly DocumentBlock[], sizes: ReadonlyMap<number, PageSize>, title?: string): Assembled {
  const lines: string[] = [];
  const markdown: string[] = [];
  const anchors: TextViewAnchor[] = [];
  const entries: { block: DocumentBlock; node: ReaderV2FlowNode }[] = [];
  let offset = 0;
  let titleSeen = false;
  for (const block of blocks) {
    const { line, pieces } = plainLineOf(block);
    if (line.length === 0) continue;
    anchors.push(...anchorsOf(block, offset, line, pieces, sizes));
    lines.push(line);
    offset += line.length + 2;
    const repeatsTitle = !titleSeen && title !== undefined && block.kind === "heading" && sameTitle(line, title);
    if (block.kind === "heading") titleSeen = true;
    if (repeatsTitle) continue;
    markdown.push(markdownOf(block, line));
    entries.push({ block, node: flowOf(block, line) });
  }
  return { document: { type: "root", children: sectioned(entries), losses: [] }, markdown: markdown.join("\n\n"), plain: lines.join("\n\n"), anchors };
}
