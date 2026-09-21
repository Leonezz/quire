import { isJudgeKind, type JudgeBlock, type JudgeKind, type JudgePage, type JudgeVerdict } from "./types";

// One Jev request per page (or per chunk of a long page): the state lists the uncertain blocks
// with the block before and after each as context; one `choice` question per uncertain block asks
// its kind, one `noul` question whether it continues the block before it.

/** Rough token estimate for budgeting: four characters per token. */
export const CHARS_PER_TOKEN = 4;
export const DEFAULT_MAX_STATE_TOKENS = 24_000;

export const JEV_MODEL = "jev-latest";

const CRITERIA: Record<JudgeKind, string> = {
  body: "running body text of the document: a paragraph or part of one (also an abstract's text)",
  heading: "a section, subsection or document title, or an author/affiliation line: a short label that opens what follows",
  caption: "the caption of a figure or table (often starting with Figure/Table/Algorithm and a number)",
  furniture: "page furniture: running head, footer, page number, venue or journal line, copyright or license notice, submission date, watermark",
  table: "rows or cells of a table, or a table's contents spelled out cell by cell",
  footnote: "a footnote at the foot of the page (smaller type, often opened by a number, asterisk or dagger), including author-note footnotes",
  reference: "a bibliography entry in the reference list (authors, title, venue, year)",
  math: "a displayed equation or formula, or an equation number",
  list_item: "an item of a bulleted or numbered list",
};

export interface JevQuestion {
  type: "choice" | "noul";
  instructions: string;
  criteria?: Record<string, string>;
}

export interface JevRequest {
  page: number;
  /** Ids of the blocks the questions are about. */
  asked: string[];
  body: { model: string; state: string; questions: Record<string, JevQuestion> };
  /** Estimated input tokens of the request. */
  estimatedTokens: number;
}

export interface JevUsage { input_tokens: number; output_tokens: number }

function describe(block: JudgeBlock, asked: boolean): string {
  const weight = block.bold ? "bold" : block.runIn ? "run-in (bold lead, then regular text)" : "regular";
  const facts = [`col ${block.column + 1}/${block.columns}`, `y ${Math.round(block.y * 100)}%`, `size ${block.sizeRatio}×`, weight, `${block.lines} line${block.lines === 1 ? "" : "s"}`, `${block.words} word${block.words === 1 ? "" : "s"}`, `rules: ${block.kind}`];
  return `[${block.id}${asked ? " ?" : ""}] ${facts.join(" · ")}\n  ${block.head}`;
}

function stateOf(page: JudgePage, asked: readonly JudgeBlock[], previousPageLast: JudgeBlock | undefined): string {
  const askedIds = new Set(asked.map((block) => block.id));
  const neighbours = new Set<string>();
  for (const block of asked) {
    const at = page.blocks.indexOf(block);
    for (const neighbour of [page.blocks[at - 1], page.blocks[at + 1]]) if (neighbour) neighbours.add(neighbour.id);
  }
  const listed = page.blocks.filter((block) => askedIds.has(block.id) || neighbours.has(block.id));
  const first = asked[0];
  const carry = previousPageLast && first && page.blocks[0] === first ? [describe(previousPageLast, false)] : [];
  const columns = page.blocks[0]?.columns ?? 1;
  const header = [
    `Page ${page.page} of a PDF (${columns}-column page). Blocks in reading order; a block is one or more consecutive text lines.`,
    "Each block: [id] column/columns · top as % of page height · font size relative to the body text · weight (\"run-in\" = a bold lead phrase inside a regular paragraph, which is body text, not a heading) · lines · words · the rule-based classifier's guess (may be wrong).",
    'Blocks marked "?" are the ones asked about; the others are context. The block before the first one listed may be on the previous page.',
    "",
  ];
  return [...header, ...carry, ...listed.map((block) => describe(block, askedIds.has(block.id)))].join("\n");
}

function questionsOf(page: JudgePage, asked: readonly JudgeBlock[], previousPageLast: JudgeBlock | undefined): Record<string, JevQuestion> {
  return Object.fromEntries(asked.flatMap((block): [string, JevQuestion][] => {
    const at = page.blocks.indexOf(block);
    const previous = page.blocks[at - 1] ?? (at === 0 ? previousPageLast : undefined);
    const kind: [string, JevQuestion] = [`${block.id}_kind`, { type: "choice", instructions: `What kind of block is [${block.id}] on this page?`, criteria: CRITERIA }];
    if (!previous || previous.kind === "table" || previous.kind === "caption" || previous.kind === "furniture") return [kind];
    const continues: [string, JevQuestion] = [`${block.id}_continues`, { type: "noul", instructions: `Block [${block.id}] continues a sentence that block [${previous.id}] (the block just before it) left unfinished: they are one paragraph split by a column or page break.` }];
    return [kind, continues];
  }));
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function requestOf(page: JudgePage, asked: readonly JudgeBlock[], previousPageLast: JudgeBlock | undefined): JevRequest {
  const state = stateOf(page, asked, previousPageLast);
  const questions = questionsOf(page, asked, previousPageLast);
  return { page: page.page, asked: asked.map((block) => block.id), body: { model: JEV_MODEL, state, questions }, estimatedTokens: estimateTokens(state) + estimateTokens(JSON.stringify(questions)) };
}

/**
 * The requests for one page: none when nothing is uncertain, one normally, several when the state
 * would exceed the token budget (the asked blocks are split in halves until each chunk fits).
 */
export function requestsOfPage(page: JudgePage, previousPageLast: JudgeBlock | undefined, maxStateTokens = DEFAULT_MAX_STATE_TOKENS): JevRequest[] {
  const asked = page.blocks.filter((block) => !block.certain);
  if (asked.length === 0) return [];
  const build = (chunk: readonly JudgeBlock[]): JevRequest[] => {
    const request = requestOf(page, chunk, previousPageLast);
    if (chunk.length === 1 || estimateTokens(request.body.state) <= maxStateTokens) return [request];
    const half = Math.ceil(chunk.length / 2);
    return [...build(chunk.slice(0, half)), ...build(chunk.slice(half))];
  };
  return build(asked);
}

export class JevResponseError extends Error {
  constructor(message: string) { super(message); this.name = "JevResponseError"; }
}

function numberOf(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new JevResponseError(`Jev's answer ${name} is not a number between 0 and 1.`);
  return value;
}

/** The verdicts a response carries for the asked blocks; a missing or malformed answer is an error, never a silent skip. */
export function verdictsOfResponse(response: unknown, asked: readonly string[]): { verdicts: JudgeVerdict[]; usage: JevUsage } {
  if (typeof response !== "object" || response === null) throw new JevResponseError("Jev's response is not a JSON object.");
  const { answers, usage } = response as { answers?: unknown; usage?: unknown };
  if (typeof answers !== "object" || answers === null) throw new JevResponseError("Jev's response has no answers.");
  const byName = answers as Record<string, { type?: unknown; choice?: unknown; confidence?: unknown; noul?: unknown } | undefined>;
  const verdicts = asked.map((id): JudgeVerdict => {
    const kind = byName[`${id}_kind`];
    if (!kind || kind.type !== "choice" || !isJudgeKind(kind.choice)) throw new JevResponseError(`Jev's answer for ${id}_kind is missing or names an unknown kind.`);
    const continues = byName[`${id}_continues`];
    if (continues !== undefined && continues.type !== "noul") throw new JevResponseError(`Jev's answer for ${id}_continues is not a noul answer.`);
    return { id, kind: kind.choice, confidence: numberOf(kind.confidence, `${id}_kind.confidence`), ...(continues ? { continues: numberOf(continues.noul, `${id}_continues.noul`) } : {}) };
  });
  const tokens = (usage ?? {}) as Partial<JevUsage>;
  return { verdicts, usage: { input_tokens: typeof tokens.input_tokens === "number" ? tokens.input_tokens : 0, output_tokens: typeof tokens.output_tokens === "number" ? tokens.output_tokens : 0 } };
}
