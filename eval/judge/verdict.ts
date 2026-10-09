// The program's half of the standard (docs/design/eval-rubric.md §5): which of the judge's issues are
// valid, and the verdicts they add up to. The model only lists issues with evidence; an issue counts
// only when its quote is verbatim, it does not contradict the capture's measured facts, and the tiles
// and ids it names exist. Metadata issues get their layer and severity from their subject, not from
// the model (title major, author and date minor). Each layer is MAJOR with any valid major issue,
// else MINOR with any valid minor one, else PASS; the case is its worst layer. Pure.
import type { Embed, ReferenceImage, RenderedCode, RenderedImage, RenderedTable } from "../render/types";
import type { RenderingProblemKind } from "../../apps/desktop/src/shared/contracts";

export const VERDICTS = ["PASS", "MINOR", "MAJOR"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const SEVERITIES = ["minor", "major"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const VERDICT_RANK: Record<Verdict, number> = { PASS: 0, MINOR: 1, MAJOR: 2 };
export const worseOf = (a: Verdict, b: Verdict): Verdict => (VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a);

/** content and metadata are the extractor's, rendering is the reader's (§3). */
export const LAYERS = ["content", "metadata", "rendering"] as const;
export type Layer = (typeof LAYERS)[number];
/** One verdict per layer; rendering is null when the case was judged without a render capture (text mode). */
export interface LayerVerdicts { content: Verdict; metadata: Verdict; rendering: Verdict | null }

export const TILE_IMAGES = ["rendered", "reference"] as const;
export type TileImage = (typeof TILE_IMAGES)[number];
/** Where a visual issue shows: tile n (1-based, top to bottom) of the rendered reader or of the reference page. */
export interface TileRef { image: TileImage; tile: number }
/** The tiles attached to a visual call. */
export interface SentTiles { rendered: number; reference: number }

/** What a metadata issue is about; it decides the issue's severity (§5). */
export const SUBJECTS = ["title", "author", "date"] as const;
export type Subject = (typeof SUBJECTS)[number];

/** An issue as the judge reported it. `where`, `refs` and `subject` exist in visual mode only. */
export interface JudgeIssue {
  layer: Layer;
  kind: RenderingProblemKind;
  severity: Severity;
  evidence: string;
  note: string;
  where?: TileRef | null;
  /** Ids of the reader images (r…), original images (o…) and embeds (e…) the issue is about. */
  refs?: string[];
  /** title | author | date for a metadata issue, null otherwise. */
  subject?: Subject | null;
  /** The severity the model gave, when the program changed it (metadata normalization, or a one-sided major downgraded in cross-confirmation). */
  originalSeverity?: Severity;
  /** The layer the model gave, when the program changed it (the metadata rule, or the layer the facts decide). */
  originalLayer?: Layer;
}

export const INVALID_REASONS = ["evidence-not-verbatim", "outside-boundary", "metadata-without-subject", "tile-not-sent", "unknown-ref", "contradicts-image-facts", "contradicts-embed-facts", "contradicts-table-facts"] as const;
export type InvalidReason = (typeof INVALID_REASONS)[number];
export interface Invalidity { reason: InvalidReason; detail: string }

/** An unmatched original image at least this many CSS px on one side is a figure the reader can be missing. */
export const LARGE_IMAGE_PX = 200;

/** The measured inventories an issue is checked against (visual mode). */
export interface FactInventory {
  rendered: readonly RenderedImage[];
  reference: readonly ReferenceImage[];
  embeds: readonly Embed[];
  /** The reader's tables (t1…) and code blocks (c1…). */
  tables: readonly RenderedTable[];
  code: readonly RenderedCode[];
  /** EXTRACTED as the prompt carries it: where a collapsed code block is looked up to decide its layer. */
  extracted: string;
  sent: SentTiles;
}
/** What the layer rule (layerByFacts) reads. */
export type LayerFacts = Pick<FactInventory, "rendered" | "reference" | "embeds" | "tables" | "code" | "extracted">;

/** A table counts as having empty cells (a fact) when a quarter or more of at least 4 body cells hold nothing, as RenderMetrics.emptyCellTables counts them. */
export const hasEmptyCells = (table: RenderedTable) => table.cells >= 4 && table.emptyCells / table.cells >= 0.25;

/**
 * Whether EXTRACTED still has a code block with its line breaks, found by the block's visible head
 * (whitespace ignored, since a collapsed block shows its lines run together). Inside a fenced block,
 * the block's code must contain a line break; outside one, the span the head matched must. Not found
 * at all, or found on one line, means the extractor lost the breaks. Markdown escapes are ignored, and
 * a block the extractor turned into a paragraph with hard breaks still has its line breaks.
 */
export function extractedKeepsLineBreaks(head: string, extracted: string): boolean {
  const needle = unescapeMarkdown(head).replace(/\s+/g, "");
  if (!needle) return false;
  const positions: number[] = [];
  let stripped = "";
  for (let index = 0; index < extracted.length; index += 1) {
    if (/\s/.test(extracted[index]!)) continue;
    // A markdown escape or hard-break backslash is not part of the code.
    if (extracted[index] === "\\" && /[!-/:-@[-`{-~\s]/.test(extracted[index + 1] ?? "")) continue;
    stripped += extracted[index];
    positions.push(index);
  }
  const at = stripped.indexOf(needle);
  if (at < 0) return false;
  const start = positions[at]!;
  const end = positions[at + needle.length - 1]! + 1;
  const fence = enclosingFence(extracted, start);
  if (fence) return fence.trim().includes("\n");
  return extracted.slice(start, end).includes("\n");
}

/** The code of the fenced block (``` or ~~~) that contains `index`, or undefined when it lies outside every fence. */
function enclosingFence(text: string, index: number): string | undefined {
  const fence = /^[ \t]*(```|~~~)[^\n]*$/gm;
  let open: number | undefined;
  for (let match = fence.exec(text); match; match = fence.exec(text)) {
    const lineEnd = match.index + match[0].length;
    if (open === undefined) { open = lineEnd; continue; }
    if (index >= open && index < match.index) return text.slice(open, match.index);
    open = undefined;
  }
  return undefined;
}

/** e1, e2, … : the embed inventory's ids are its 1-based positions. */
export const embedId = (index: number) => `e${index + 1}`;

/** Curly quotes and apostrophes as their straight forms, so a quote typed with either still matches. */
const straightQuotes = (text: string) => text.replace(/[\u2018\u2019\u201A\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u2033]/g, "\"");
const squash = (text: string) => straightQuotes(text).replace(/\s+/g, " ").trim();
/** A quote's trailing ellipsis ("…" or "...") marks where the judge stopped copying; it is not part of the text. */
const withoutTrailingEllipsis = (text: string) => text.replace(/\s*(\u2026|\.\.\.)\s*$/, "");

/** Markdown's backslash escapes (`\.`, `\*`, `\<`) and hard-break backslashes removed: the text a reader sees. */
export const unescapeMarkdown = (text: string) => text.replace(/\\(?=[!-/:-@[-`{-~]|\s)/g, "");

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'" };
/** The visible text of markdown or HTML: escapes removed, links and images reduced to their text, tags dropped, common entities decoded, whitespace squashed. */
export function plainText(text: string): string {
  const unescaped = unescapeMarkdown(text)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_, name: string) => ENTITIES[name] ?? "");
  return squash(unescaped);
}

/**
 * Whether an evidence quote really occurs in any of the texts; false means the judge paraphrased.
 * Whitespace never matters; when the raw quote is not found, markup does not either (a quote of a
 * table row without its link syntax, escapes or tags still counts), but the visible words must be
 * there, in order.
 */
export function evidenceOccurs(evidence: string, ...texts: string[]): boolean {
  evidence = withoutTrailingEllipsis(evidence);
  const needle = squash(evidence);
  if (!needle) return false;
  if (texts.some((text) => squash(text).includes(needle))) return true;
  const plainNeedle = plainText(evidence);
  return plainNeedle.length > 0 && texts.some((text) => plainText(text).includes(plainNeedle));
}

function tileProblem(where: TileRef | null | undefined, sent: SentTiles): string | undefined {
  if (!where) return undefined;
  const count = sent[where.image];
  return where.tile > count ? `${where.image} tile ${where.tile} was not attached (${count} ${where.image} tile${count === 1 ? "" : "s"} sent)` : undefined;
}

function unknownRefs(refs: readonly string[], facts: FactInventory): string[] {
  const known = new Set([...facts.rendered.map((image) => image.id), ...facts.reference.map((image) => image.id), ...facts.embeds.map((_, index) => embedId(index)), ...facts.tables.map((table) => table.id), ...facts.code.map((block) => block.id)]);
  return refs.filter((ref) => !known.has(ref));
}

/**
 * A major tables issue citing only tables that have no empty cells. Kept simple on purpose: it reads
 * any major tables issue as an empty-cells claim, so a major issue about a table's structure must
 * not cite a table without empty cells either (cite the table and say so in the note: still invalid).
 */
function tableContradiction(refs: readonly string[], facts: FactInventory): string | undefined {
  const cited = facts.tables.filter((table) => refs.includes(table.id));
  if (cited.length === 0 || cited.some((table) => table.emptyCells > 0)) return undefined;
  return `${cited.map((table) => table.id).join(", ")} ${cited.length === 1 ? "has" : "have"} no empty cells`;
}

/**
 * A major image issue claims an image is missing or broken. It holds when one of its cited images
 * backs it: a broken reader image, an original image no reader image matches, or one matched by a
 * broken reader image. Citing no image holds only when the facts leave room for the claim: an
 * unmatched original image of LARGE_IMAGE_PX or more on a side, or a broken reader image.
 */
function imageContradiction(refs: readonly string[], facts: FactInventory): string | undefined {
  const rendered = new Map(facts.rendered.map((image) => [image.id, image]));
  const reference = new Map(facts.reference.map((image) => [image.id, image]));
  const cited = refs.filter((ref) => rendered.has(ref) || reference.has(ref));
  if (cited.length === 0) {
    const unmatchedLarge = facts.reference.some((image) => image.matchedBy === null && Math.max(image.width, image.height) >= LARGE_IMAGE_PX);
    const broken = facts.rendered.some((image) => image.broken);
    return unmatchedLarge || broken ? undefined : `cites no image, and every original image of ${LARGE_IMAGE_PX} px or more is in the reader and none is broken`;
  }
  const backs = (ref: string): boolean => {
    const shown = rendered.get(ref);
    if (shown) return shown.broken;
    const original = reference.get(ref)!;
    if (original.matchedBy === null) return true;
    return rendered.get(original.matchedBy)?.broken === true;
  };
  if (cited.some(backs)) return undefined;
  const why = (ref: string) => {
    const original = reference.get(ref);
    return original ? `${ref} is in the reader as ${original.matchedBy}, not broken` : `${ref} is in the reader, not broken`;
  };
  return cited.map(why).join("; ");
}

function embedContradiction(refs: readonly string[], facts: FactInventory): string | undefined {
  const cited = facts.embeds.map((embed, index) => ({ id: embedId(index), embed })).filter(({ id }) => refs.includes(id));
  if (cited.length === 0 || cited.some(({ embed }) => !embed.representedInReader)) return undefined;
  return `${cited.map(({ id }) => id).join(", ")} ${cited.length === 1 ? "is" : "are"} shown in the reader`;
}

const SUBJECT_SEVERITY: Record<Subject, Severity> = { title: "major", author: "minor", date: "minor" };

/**
 * §5's metadata rule, applied before validation and verdicts: an issue of kind metadata or with a
 * subject is in the metadata layer; a title issue is major, an author or date issue minor, whatever
 * the model said (`originalSeverity` keeps what it said when that differs). Text mode has no subject:
 * its metadata issues keep their severity. Any other issue gets its layer from the facts where they
 * decide it (layerByFacts).
 */
export function normalizeIssue(issue: JudgeIssue, facts?: LayerFacts): JudgeIssue {
  const subject = issue.subject ?? null;
  if (issue.kind !== "metadata" && subject === null) return layerByFacts(issue, facts);
  const severity = subject ? SUBJECT_SEVERITY[subject] : issue.severity;
  return { ...issue, layer: "metadata", severity, ...(severity !== issue.severity ? { originalSeverity: issue.severity } : {}), ...(issue.layer !== "metadata" ? { originalLayer: issue.layer } : {}) };
}

/** The layer one cited id decides by the facts, if any (§3). */
function layerOfRef(ref: string, facts: LayerFacts): Layer | undefined {
  if (facts.reference.some((image) => image.id === ref && image.matchedBy === null)) return "content";
  if (facts.embeds.some((embed, index) => embedId(index) === ref && !embed.representedInReader)) return "content";
  if (facts.tables.some((table) => table.id === ref && hasEmptyCells(table))) return "content";
  const block = facts.code.find((candidate) => candidate.id === ref && candidate.collapsed);
  if (block) return extractedKeepsLineBreaks(block.head, facts.extracted) ? "rendering" : "content";
  if (facts.rendered.some((image) => image.id === ref && image.broken)) return "rendering";
  return undefined;
}

/**
 * §3's dividing line where the facts decide it: an issue citing an original image no reader image
 * matches, an embed the reader does not show, or a table with empty cells is the extractor's
 * (content); one citing a broken reader image is the reader's (rendering); one citing a code block
 * shown as one line is the reader's when EXTRACTED still has that code with line breaks, else the
 * extractor's. Content wins when the cited ids disagree. `originalLayer` keeps what the model said
 * when that differs.
 */
export function layerByFacts(issue: JudgeIssue, facts: LayerFacts | undefined): JudgeIssue {
  const refs = issue.refs ?? [];
  if (!facts || refs.length === 0) return issue;
  const decided = refs.map((ref) => layerOfRef(ref, facts));
  const layer: Layer | undefined = decided.includes("content") ? "content" : decided.includes("rendering") ? "rendering" : undefined;
  if (!layer || layer === issue.layer) return issue;
  return { ...issue, layer, originalLayer: issue.originalLayer ?? issue.layer };
}

/** Copyright, licence and trademark notices: outside the article boundary (§2), so their absence is never an issue. */
const BOUNDARY_FOOTER = /(©|\(c\)\s*\d{4}|copyright\b|all rights reserved|licen[cs]ed under|creative commons|\bCC BY\b|apache license|\bMIT licen[cs]e|trademarks? of|registered trademark|版权所有|保留所有权利|许可协议)/i;

/** A missing-content claim whose evidence is a copyright or licence notice: the standard says dropping it is never an issue. */
export function isBoundaryExternalDrop(issue: Pick<JudgeIssue, "kind" | "evidence">): boolean {
  return issue.kind === "missing_content" && BOUNDARY_FOOTER.test(issue.evidence);
}

/**
 * Why an issue does not count, or undefined when it does: (a) its evidence is not verbatim in the
 * texts; a metadata issue names no subject (visual mode); (c) its tile was not attached or it cites an id no inventory has; (b) it contradicts the
 * measured facts (an image claim the image inventories refute, an embed claim citing embeds the
 * reader shows). Text mode (no facts) checks the evidence only.
 */
export function validateIssue(issue: JudgeIssue, texts: readonly string[], facts?: FactInventory): Invalidity | undefined {
  if (!evidenceOccurs(issue.evidence, ...texts)) return { reason: "evidence-not-verbatim", detail: "the evidence quote is not in SOURCE, EXTRACTED or RENDERED TEXT" };
  if (isBoundaryExternalDrop(issue)) return { reason: "outside-boundary", detail: "the quoted text is a copyright or licence notice; dropping it is never an issue (docs/design/eval-rubric.md §2)" };
  if (issue.kind === "metadata" && issue.subject === null) return { reason: "metadata-without-subject", detail: "a metadata issue must say whether it is about the title, the author or the date" };
  if (!facts) return undefined;
  const tile = tileProblem(issue.where, facts.sent);
  if (tile) return { reason: "tile-not-sent", detail: tile };
  const refs = issue.refs ?? [];
  const unknown = unknownRefs(refs, facts);
  if (unknown.length) return { reason: "unknown-ref", detail: `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} in no inventory` };
  if (issue.kind === "images" && issue.severity === "major") {
    const image = imageContradiction(refs, facts);
    if (image) return { reason: "contradicts-image-facts", detail: image };
  }
  const embed = embedContradiction(refs, facts);
  if (embed) return { reason: "contradicts-embed-facts", detail: embed };
  if (issue.kind === "tables" && issue.severity === "major") {
    const table = tableContradiction(refs, facts);
    if (table) return { reason: "contradicts-table-facts", detail: table };
  }
  return undefined;
}

/** Per layer: MAJOR with any valid major issue, else MINOR with any valid minor one, else PASS; rendering is null without a capture. */
export function layerVerdicts(issues: readonly (JudgeIssue & { invalid?: Invalidity })[], judgedRendering: boolean): LayerVerdicts {
  const valid = issues.filter((issue) => !issue.invalid);
  const of = (layer: Layer): Verdict => {
    const own = valid.filter((issue) => issue.layer === layer);
    return own.some((issue) => issue.severity === "major") ? "MAJOR" : own.length ? "MINOR" : "PASS";
  };
  return { content: of("content"), metadata: of("metadata"), rendering: judgedRendering ? of("rendering") : null };
}

/** The case's verdict: its worst layer. */
export function overallVerdict(layers: LayerVerdicts): Verdict {
  return [layers.content, layers.metadata, ...(layers.rendering ? [layers.rendering] : [])].reduce<Verdict>(worseOf, "PASS");
}
