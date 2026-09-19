import { createMarkdownRepresentations, type ContentMaterialization, type NormalizationProblem } from "@read/normalize";
import type { StoredRecord } from "./material-record";
import type { PdfInspection } from "./pdf";
import { readingMinutes } from "./reading-time";

// Helpers of MaterialStore that need nothing from the store: what a file is, what a page is
// called, which pictures a reader document references, and the content fields of Markdown and PDFs.

const MAX_PREFETCH_IMAGES = 80;
const MINUTES_PER_PDF_PAGE = 2.5;

export const NORMALIZE_BUDGET = { maxBytes: 8 * 1024 * 1024, maxDepth: 100, maxNodes: 100_000, maxOutputBytes: 8 * 1024 * 1024 };

/** The content fields every rendering carries; the record's own for the primary view, a view file's otherwise. */
export type ContentFields = Pick<StoredRecord, "mediaType" | "pdf" | "reader" | "markdown" | "plain" | "readingMinutes" | "quality" | "problems">;

type ReaderRepresentation = NonNullable<StoredRecord["reader"]>;

function readerOf(by: (schema: string) => string | undefined): ReaderRepresentation | undefined {
  const v2 = by("reader.document.v2");
  if (v2) return { schema: "reader.document.v2", payload: v2 };
  const v1 = by("reader.document.v1");
  return v1 ? { schema: "reader.document.v1", payload: v1 } : undefined;
}

/** The reader document (v2 preferred), Markdown and plain text an article materialization produced. */
export function pickRepresentations(materialization: ContentMaterialization): Pick<StoredRecord, "reader" | "markdown" | "plain"> {
  const by = (schema: string) => materialization.representations.find((r) => r.schema === schema)?.content;
  const reader = readerOf(by);
  const markdown = by("agent.gfm.v1");
  const plain = by("selection.text.v1");
  return { ...(reader ? { reader } : {}), ...(markdown ? { markdown } : {}), ...(plain ? { plain } : {}) };
}

/** Reader representations, markdown and quality for Markdown content; shared by files, feeds and agent artifacts. */
export function markdownParts(content: string, baseUri: string): Pick<StoredRecord, "reader" | "markdown" | "readingMinutes" | "quality" | "problems"> {
  const { representations } = createMarkdownRepresentations({ baseUri, content, maxDepth: NORMALIZE_BUDGET.maxDepth, maxNodes: NORMALIZE_BUDGET.maxNodes, maxOutputBytes: NORMALIZE_BUDGET.maxOutputBytes, outputBudgetErrorCode: "MARKDOWN_TOO_LARGE" });
  const reader = readerOf((schema) => representations.find((r) => r.schema === schema)?.content);
  return {
    ...(reader ? { reader } : {}),
    markdown: content, readingMinutes: readingMinutes(content),
    quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "derived", safety: "safe", warnings: [] },
    problems: [],
  };
}

/** The content fields of an inspected PDF: page count, text sample, a reading time by pages. */
export function pdfContent(inspection: PdfInspection, byteLength: number, origin: StoredRecord["origin"]): ContentFields {
  return {
    mediaType: "application/pdf",
    ...(inspection.sampleText ? { plain: inspection.sampleText } : {}),
    readingMinutes: Math.max(1, Math.round(inspection.pages * MINUTES_PER_PDF_PAGE)),
    pdf: { pages: inspection.pages, byteLength, textLayer: inspection.textLayer },
    quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: origin === "file" ? "derived" : "strong", safety: "safe", warnings: [] },
    problems: [],
  };
}

/** The reader prints the title itself, so a leading "# Title" line that repeats it would show twice. */
export function withoutTitleHeading(markdown: string, title: string): string {
  const match = /^\s*#\s+(.+?)\s*\n/.exec(markdown);
  if (!match) return markdown;
  const same = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  return same(match[1] ?? "") === same(title) ? markdown.slice(match[0].length).replace(/^\s*\n/, "") : markdown;
}

/** Image sources referenced by the reader document, in reading order, for caching at save time. */
export function imageUrlsOf(record: Pick<StoredRecord, "reader">): string[] {
  if (!record.reader) return [];
  let root: unknown;
  try { root = JSON.parse(record.reader.payload); } catch { return []; }
  const urls: string[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown) => {
    if (urls.length >= MAX_PREFETCH_IMAGES || !node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const value = node as Record<string, unknown>;
    if (value.type === "image" && typeof value.url === "string" && /^https?:/.test(value.url) && !seen.has(value.url)) { seen.add(value.url); urls.push(value.url); }
    for (const key of ["children", "caption", "credit", "media", "bodies", "head", "foot"]) visit(value[key]);
  };
  visit(root);
  return urls;
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

export function isHtml(mediaType: string): boolean {
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

/** A declared PDF, or an untyped download whose bytes say so. */
export function isPdf(bytes: Uint8Array, mediaType: string): boolean {
  return mediaType === "application/pdf" || (mediaType === "application/octet-stream" && looksLikePdf(bytes));
}

export function titleFromHtml(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 64 * 1024));
  const match = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(head);
  return match?.[1]?.replace(/\s+/g, " ").trim() || undefined;
}

export function mediaTypeForName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "txt") return "text/plain";
  if (ext === "html" || ext === "htm" || ext === "xhtml") return "text/html";
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
}

export function degradedQuality(problems: NormalizationProblem[]) {
  return { completeness: "none" as const, conformance: "recoverable" as const, identityConfidence: "derived" as const, safety: "degraded_plaintext" as const, warnings: problems };
}
