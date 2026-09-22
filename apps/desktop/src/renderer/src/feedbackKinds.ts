import { RENDERING_PROBLEM_KINDS, type RenderingProblemKind } from "../../shared/contracts";

/** The nine problem kinds in the reader's words: what they see, not what the extractor did. */
export const PROBLEM_KIND_LABELS: Record<RenderingProblemKind, string> = {
  missing_content: "Text or sections are missing",
  extra_content: "Navigation, related posts, comments or share blocks kept",
  wrong_order: "Paragraphs out of order",
  code_or_math: "Code or formulas broken",
  tables: "Tables mangled",
  images: "Figures missing or wrong",
  metadata: "Wrong title, author or date",
  layout: "Headings, lists, quotes or footnotes wrong",
  other: "Something else",
};

export const PROBLEM_KIND_OPTIONS: readonly { id: RenderingProblemKind; label: string }[] = RENDERING_PROBLEM_KINDS.map((id) => ({ id, label: PROBLEM_KIND_LABELS[id] }));

export const isProblemKind = (value: string): value is RenderingProblemKind => (RENDERING_PROBLEM_KINDS as readonly string[]).includes(value);
