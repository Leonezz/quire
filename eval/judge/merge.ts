// Cross-confirmation (docs/design/eval-rubric.md §6): how two opinions on one case become one issue
// list. Only valid issues take part. An issue both report (intersecting refs, whatever the kind and
// layer; or, when neither cites refs, same layer and kind) counts once, at the more severe of the two. A major issue only one reports
// counts as major only when a measured fact supports it, otherwise as minor; a minor one counts as
// it is. Invalid issues of both follow, for the record. Pure.
import type { Embed, ReferenceImage, RenderedCode, RenderedImage, RenderedTable, RenderMetrics } from "../render/types";
import type { JudgedIssue } from "./cache";
import { embedId, fixedSeverity, hasEmptyCells, inArticle, type Severity } from "./verdict";

/** Where a merged issue's standing comes from. */
export const ISSUE_ORIGINS = ["both", "one-sided-fact", "one-sided-downgraded", "one-sided"] as const;
export type IssueOrigin = (typeof ISSUE_ORIGINS)[number];

/** The capture facts a one-sided major issue can lean on; absent in text mode, where nothing supports one. */
export interface MergeFacts {
  rendered: readonly RenderedImage[];
  reference: readonly ReferenceImage[];
  embeds: readonly Embed[];
  tables: readonly RenderedTable[];
  code: readonly RenderedCode[];
  /** EXTRACTED as the prompt carries it: an original image or embed supports an issue only when it is in the article. */
  extracted: string;
  metrics: Pick<RenderMetrics, "images" | "emptyCellTables" | "rawMarkup" | "mathErrors" | "unmarkedLists" | "collapsedCode">;
}

const SEVERITY_RANK: Record<Severity, number> = { minor: 0, major: 1 };
const moreSevere = (a: Severity, b: Severity): Severity => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a);
const sameIssue = (issue: JudgedIssue) => `${issue.layer}\u0000${issue.kind}\u0000${issue.evidence}`;

/**
 * The same issue (§6): refs in common, the kind and layer aside (the models may file one defect under
 * different kinds or layers); when neither cites refs, the same layer and kind. One citing refs and
 * the other none is not a match.
 */
export function issuesMatch(a: JudgedIssue, b: JudgedIssue): boolean {
  const left = a.refs ?? [];
  const right = b.refs ?? [];
  if (left.length && right.length) return left.some((ref) => right.includes(ref));
  if (left.length || right.length) return false;
  return a.layer === b.layer && a.kind === b.kind;
}

/**
 * Whether a measured fact backs an issue on its own: it cites an unmatched original image in the
 * article, a broken reader image, an embed in the article the reader does not show, a table with empty cells or a code block shown as
 * one line; or it is a rendering image issue while some reader image is broken, a table issue while
 * some table has empty cells, a code/math or layout issue while raw markup, math errors, unmarked
 * lists or collapsed code were measured.
 */
export function factSupported(issue: JudgedIssue, facts: MergeFacts | undefined): boolean {
  if (!facts) return false;
  const refs = issue.refs ?? [];
  const citesFact = refs.some((ref) =>
    facts.reference.some((image) => image.id === ref && image.matchedBy === null && inArticle(image.context, facts.extracted) === true)
    || facts.rendered.some((image) => image.id === ref && image.broken)
    || facts.embeds.some((embed, index) => embedId(index) === ref && !embed.representedInReader && inArticle(embed.context, facts.extracted) === true)
    || facts.tables.some((table) => table.id === ref && hasEmptyCells(table))
    || facts.code.some((block) => block.id === ref && block.collapsed));
  if (citesFact) return true;
  const { metrics } = facts;
  if (issue.layer === "rendering" && issue.kind === "images" && metrics.images.broken > 0) return true;
  if (issue.kind === "tables" && metrics.emptyCellTables.count > 0) return true;
  return (issue.kind === "code_or_math" || issue.kind === "layout") && (metrics.rawMarkup.count > 0 || metrics.mathErrors > 0 || metrics.unmarkedLists > 0 || metrics.collapsedCode > 0);
}

/** A one-sided issue: minor as it is; major when a fact supports it, else downgraded to minor (keeping what it was). */
function oneSided(issue: JudgedIssue, facts: MergeFacts | undefined): JudgedIssue {
  if (issue.severity === "minor") return { ...issue, origin: "one-sided" };
  if (factSupported(issue, facts)) return { ...issue, origin: "one-sided-fact" };
  return { ...issue, severity: "minor", originalSeverity: issue.originalSeverity ?? "major", origin: "one-sided-downgraded" };
}

/**
 * The screener issue a confirmer issue pairs with: among the untaken ones it matches, the first of the
 * same kind and layer, else of the same kind, else the first. One issue can match several by refs
 * ("all 16 images fail to load" and "the r16 thumbnail is related-post chrome"); the closest pairs.
 */
function bestPartner(issue: JudgedIssue, screen: readonly JudgedIssue[], taken: ReadonlySet<number>): number {
  const candidates = screen.map((candidate, index) => ({ candidate, index })).filter(({ candidate, index }) => !taken.has(index) && issuesMatch(issue, candidate));
  const pick = candidates.find(({ candidate }) => candidate.kind === issue.kind && candidate.layer === issue.layer)
    ?? candidates.find(({ candidate }) => candidate.kind === issue.kind)
    ?? candidates[0];
  return pick ? pick.index : -1;
}

/** Keeps the first of issues with the same layer, kind and evidence. */
function dedupe(issues: readonly JudgedIssue[]): JudgedIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => { const key = sameIssue(issue); if (seen.has(key)) return false; seen.add(key); return true; });
}

/**
 * The case's issues from two opinions' (already normalized and validated) issues. Greedy one-to-one
 * matching, the confirmer's issues first: each takes the closest screener issue it matches (same kind
 * and layer first). A pair keeps the confirmer's text, evidence, where and layer at the more severe
 * severity — unless the program fixes it (kept-boundary content minor, metadata by subject) — origin "both". Then
 * the confirmer's unmatched issues, then the screener's, each one-sided; duplicates (same layer,
 * kind and evidence) are kept once. Invalid issues of both come last and never count.
 */
export function crossConfirm(screen: readonly JudgedIssue[], confirm: readonly JudgedIssue[], facts: MergeFacts | undefined): JudgedIssue[] {
  const screenValid = screen.filter((issue) => !issue.invalid);
  const confirmValid = confirm.filter((issue) => !issue.invalid);
  const taken = new Set<number>();
  const matched: JudgedIssue[] = [];
  const confirmOnly: JudgedIssue[] = [];
  for (const issue of confirmValid) {
    const partner = bestPartner(issue, screenValid, taken);
    if (partner < 0) { confirmOnly.push(issue); continue; }
    taken.add(partner);
    const other = screenValid[partner]!;
    const severity = fixedSeverity(issue) ?? moreSevere(issue.severity, other.severity);
    const { originalSeverity: _dropped, ...kept } = issue;
    matched.push({ ...kept, severity, origin: "both", ...(issue.originalSeverity && issue.originalSeverity !== severity ? { originalSeverity: issue.originalSeverity } : {}) });
  }
  const screenOnly = screenValid.filter((_, index) => !taken.has(index));
  const merged = dedupe([...matched, ...confirmOnly.map((issue) => oneSided(issue, facts)), ...screenOnly.map((issue) => oneSided(issue, facts))]);
  const invalid = dedupe([...confirm, ...screen].filter((issue) => issue.invalid));
  return [...merged, ...invalid];
}

/** How many of a case's counted issues each origin gave. */
export function originCounts(issues: readonly JudgedIssue[]): Record<IssueOrigin, number> {
  const counted = issues.filter((issue) => !issue.invalid);
  return Object.fromEntries(ISSUE_ORIGINS.map((origin) => [origin, counted.filter((issue) => issue.origin === origin).length])) as Record<IssueOrigin, number>;
}
