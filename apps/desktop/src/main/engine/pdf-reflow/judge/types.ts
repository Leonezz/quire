// The block judge: a second opinion on the blocks the rules are unsure about. The rules stay the
// baseline; a judge only answers "what kind of block is this" (and "does it continue the previous
// one") for the uncertain blocks, and its verdicts are applied only when confident (apply.ts).

export type JudgeKind = "body" | "heading" | "caption" | "furniture" | "table" | "footnote" | "reference" | "math" | "list_item";

export const JUDGE_KINDS: readonly JudgeKind[] = ["body", "heading", "caption", "furniture", "table", "footnote", "reference", "math", "list_item"];

/** One block as the judge sees it: layout features, a text head, and what the rules decided. */
export interface JudgeBlock {
  /** Stable within one build: "b<index>" into the block list the pipeline judged. */
  id: string;
  page: number;
  /** 0-based column the block sits in, and how many columns the page has. */
  column: number;
  columns: number;
  /** Top of the block as a fraction of the page height. */
  y: number;
  /** The block's font size over the body size. */
  sizeRatio: number;
  bold: boolean;
  /** The block opens with a bold run-in phrase and continues in regular weight: body text with an inline label, not a heading. */
  runIn: boolean;
  lines: number;
  words: number;
  /** The block's first characters (at most 160). */
  head: string;
  /** The rules' kind. */
  kind: JudgeKind;
  /** True when the rules are confident and the judge is not asked. */
  certain: boolean;
}

export interface JudgePage {
  page: number;
  /** Every block of the page in reading order (certain ones are context for the judge). */
  blocks: JudgeBlock[];
}

export interface JudgeVerdict {
  id: string;
  kind: JudgeKind;
  /** 0..1; a verdict is applied only above the threshold in apply.ts. */
  confidence: number;
  /** 0..1: how surely the block continues the previous block's sentence. */
  continues?: number;
}

export interface JudgeUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface JudgeOutcome {
  verdicts: JudgeVerdict[];
  /** Set when some (or all) pages could not be judged; those pages keep the rules' result. */
  error?: string;
  usage?: JudgeUsage;
}

export interface BlockJudge {
  readonly provider: "rules" | "jev";
  judge(pages: readonly JudgePage[]): Promise<JudgeOutcome>;
}

export const MAX_HEAD_CHARS = 160;

export function isJudgeKind(value: unknown): value is JudgeKind {
  return typeof value === "string" && (JUDGE_KINDS as readonly string[]).includes(value);
}
