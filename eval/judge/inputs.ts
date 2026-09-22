// The two inputs a case is judged on, cut to a size that fits one prompt. Pure: the harness
// supplies the page text and the normalization outcome; nothing here touches the disk or Codex.
import type { ArticleNormalizationOutcome } from "@read/normalize";

/** Characters of SOURCE and of EXTRACTED that go into the prompt; longer inputs are cut and flagged. */
export const INPUT_CAP = 60_000;

export interface TruncatedText { text: string; truncated: boolean }

export function truncateInput(text: string, cap = INPUT_CAP): TruncatedText {
  if (text.length <= cap) return { text, truncated: false };
  return { text: `${text.slice(0, cap)}\n\n[... cut after ${cap} characters ...]`, truncated: true };
}

/**
 * What the judge sees as EXTRACTED: the metadata fields the extractor recorded (the markdown carries
 * only the title, so byline and date would otherwise be invisible to the judge), then its markdown
 * (agent.gfm.v1); or a one-line marker when extraction failed, as export.test.ts writes it.
 */
export function extractedMarkdown(outcome: ArticleNormalizationOutcome): string {
  if (!outcome.ok) return `(extraction failed: ${outcome.problems.map((problem) => problem.code).join(", ")})\n`;
  const { article } = outcome;
  const markdown = article.materialization.representations.find((representation) => representation.schema === "agent.gfm.v1")?.content ?? "";
  const header = ["<!-- extractor metadata -->", `title: ${article.title}`, `byline: ${article.byline ?? "(none)"}`, `publishedAt: ${article.publishedAt ?? "(none)"}`, "<!-- end extractor metadata -->"];
  return `${header.join("\n")}\n\n${markdown}`;
}
