import type { Block } from "../blocks";
import type { PageLayout } from "../columns";
import type { PageSize } from "../types";
import { applyVerdicts } from "./apply";
import { mergeSplitTitles } from "./split-titles";
import type { BlockJudge, JudgeOutcome, JudgeUsage } from "./types";
import { judgePagesOf } from "./uncertainty";

export { JevJudge, JEV_ENDPOINT, type FetchLike, type JevJudgeOptions } from "./jev";
export { RulesJudge } from "./rules";
export type { BlockJudge, JudgeBlock, JudgeKind, JudgeOutcome, JudgePage, JudgeUsage, JudgeVerdict } from "./types";

export interface RefineContext {
  bodySize: number;
  sizes: ReadonlyMap<number, PageSize>;
  layouts: ReadonlyMap<number, PageLayout>;
}

export interface RefineResult {
  blocks: Block[];
  /** Blocks the rules were unsure about (sent to the judge). */
  asked: number;
  /** Verdicts that changed a block. */
  changed: number;
  /** Lines dropped as furniture on the judge's word. */
  furnitureLines: number;
  /** The judge could not answer (some or all pages); the rules' result stands for those. */
  error?: string;
  usage?: JudgeUsage;
}

/** Asks the judge about the uncertain blocks and applies what it is sure of; a judge that fails leaves the rules' blocks untouched, with the reason. */
export async function refineBlocks(input: readonly Block[], judge: BlockJudge, context: RefineContext): Promise<RefineResult> {
  const blocks = mergeSplitTitles(input, context.bodySize);
  const pages = judgePagesOf(blocks, context);
  const asked = pages.reduce((sum, page) => sum + page.blocks.filter((block) => !block.certain).length, 0);
  let outcome: JudgeOutcome;
  try { outcome = await judge.judge(pages); }
  catch (error) { return { blocks: [...blocks], asked, changed: 0, furnitureLines: 0, error: error instanceof Error ? error.message : String(error) }; }
  const applied = applyVerdicts(blocks, outcome.verdicts, context);
  return { ...applied, asked, ...(outcome.error !== undefined ? { error: outcome.error } : {}), ...(outcome.usage ? { usage: outcome.usage } : {}) };
}
