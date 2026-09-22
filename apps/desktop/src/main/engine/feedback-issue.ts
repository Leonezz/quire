import type { RenderingFeedback, RenderingProblemKind } from "../../shared/contracts";

// The prefilled "new issue" link for a rendering report. It carries what the reader typed and the
// versions the report was made with; never the capture or the extracted text (the reader attaches
// the bundle by hand). The fields are the ids of .github/ISSUE_TEMPLATE/rendering.yml: `url`,
// `note`, `versions`. Its `kinds` checkboxes cannot be prefilled through the URL, so the kinds go
// at the top of the note, in the template's own words.

export const ISSUE_TEMPLATE = "rendering.yml";
/** Browsers and GitHub start dropping very long URLs; the note is truncated to stay inside this. */
export const MAX_ISSUE_URL_LENGTH = 6_000;
const MAX_TITLE_TEXT = 60;
const ELLIPSIS = "…";

/** The template's checkbox labels, by kind. */
export const PROBLEM_KIND_LABELS: Record<RenderingProblemKind, string> = {
  missing_content: "Body text, sections or the ending are missing",
  extra_content: "Navigation, related posts, comments, share or subscribe blocks kept as body",
  wrong_order: "Paragraphs or sections out of order",
  code_or_math: "Code blocks or formulas broken",
  tables: "Tables mangled or dropped",
  images: "Figures missing, duplicated or wrong",
  metadata: "Wrong or missing title, author or date",
  layout: "Headings, lists, quotes or footnotes wrong",
  other: "Other",
};

export interface IssueRepo { owner: string; repo: string }

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "") || parsed.protocol.replace(/:$/, "");
  } catch { return "unknown site"; }
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1).trimEnd()}${ELLIPSIS}` : single;
}

export function issueTitleFor(feedback: Pick<RenderingFeedback, "url" | "title">): string {
  return `Rendering: ${hostOf(feedback.url)} — ${truncate(feedback.title, MAX_TITLE_TEXT)}`;
}

/** The text-view report on one line, for the versions block. */
export function reportLineOf(report: NonNullable<RenderingFeedback["report"]>): string {
  const parts = [
    `${report.pages} pages`, `${report.columns} columns`, `${report.furnitureLines} furniture lines`, `${report.headings} headings`,
    `${report.paragraphs} paragraphs`, `${report.figures} figures`,
    ...(report.degradedPages.length > 0 ? [`degraded pages ${report.degradedPages.join(", ")}`] : []),
    ...(report.judged ? [`judged by ${report.judged.provider}: ${report.judged.changed}/${report.judged.asked} changed${report.judged.error ? ` (${report.judged.error})` : ""}`] : []),
  ];
  return parts.join(", ");
}

export function versionsTextFor(feedback: RenderingFeedback): string {
  const codes = feedback.problems.map((problem) => problem.code);
  const capture = feedback.capture.included
    ? `included in the bundle${feedback.capture.byteLength !== undefined ? ` (${feedback.capture.byteLength} bytes, ${feedback.capture.mediaType ?? "unknown type"})` : ""}`
    : "not included";
  return [
    `Quire ${feedback.app.version} (${feedback.app.platform})`,
    `normalize ${feedback.app.normalize}`,
    `view: ${feedback.view}`,
    `quality: completeness=${feedback.quality.completeness}, conformance=${feedback.quality.conformance}, safety=${feedback.quality.safety}`,
    `problems: ${codes.length > 0 ? codes.join(", ") : "none"}`,
    ...(feedback.report ? [`text view: ${reportLineOf(feedback.report)}`] : []),
    `capture: ${capture}`,
  ].join("\n");
}

function noteTextFor(feedback: Pick<RenderingFeedback, "kinds" | "note">, note: string): string {
  const kinds = feedback.kinds.map((kind) => `- ${PROBLEM_KIND_LABELS[kind]}`).join("\n");
  return note.trim().length > 0 ? `${kinds}\n\n${note}` : kinds;
}

function buildUrl(feedback: RenderingFeedback, repo: IssueRepo, note: string): string {
  const params = new URLSearchParams({
    template: ISSUE_TEMPLATE,
    title: issueTitleFor(feedback),
    url: feedback.url,
    note: noteTextFor(feedback, note),
    versions: versionsTextFor(feedback),
  });
  return `https://github.com/${repo.owner}/${repo.repo}/issues/new?${params.toString()}`;
}

/**
 * The link that opens a prefilled issue. The note is the only part that can grow without bound,
 * so it is cut (with an ellipsis) until the whole URL fits MAX_ISSUE_URL_LENGTH.
 */
export function issueUrlFor(feedback: RenderingFeedback, repo: IssueRepo): string {
  let note = feedback.note;
  let url = buildUrl(feedback, repo, note);
  while (url.length > MAX_ISSUE_URL_LENGTH && note.length > 0) {
    // Encoded characters take up to nine bytes each, so shrink by the observed ratio and a margin.
    const keep = Math.floor(note.length * (MAX_ISSUE_URL_LENGTH / url.length) * 0.9);
    note = keep > 0 ? `${feedback.note.slice(0, keep).trimEnd()}${ELLIPSIS}` : "";
    url = buildUrl(feedback, repo, note);
  }
  return url;
}
