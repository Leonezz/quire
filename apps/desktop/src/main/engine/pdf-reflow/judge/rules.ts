import type { BlockJudge, JudgeOutcome, JudgePage } from "./types";

/** The baseline: answers every uncertain block with the rules' own kind, so nothing changes. */
export class RulesJudge implements BlockJudge {
  readonly provider = "rules" as const;

  judge(pages: readonly JudgePage[]): Promise<JudgeOutcome> {
    const verdicts = pages.flatMap((page) => page.blocks.filter((block) => !block.certain).map((block) => ({ id: block.id, kind: block.kind, confidence: 1 })));
    return Promise.resolve({ verdicts });
  }
}
