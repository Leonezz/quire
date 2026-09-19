import type { NormalizationProblem } from "@read/normalize";
import type { StoredRecord } from "./material-record";

// Byte-level helpers of MaterialStore that need nothing from the store: what a file is, what a
// page is called, and which pictures a reader document references.

const MAX_PREFETCH_IMAGES = 80;

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
