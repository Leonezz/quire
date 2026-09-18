import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { createMarkdownRepresentations, normalizeArticleCapture, type ContentMaterialization, type NormalizationProblem } from "@read/normalize";
import type { CorpusImportResult, MaterialRecord, MaterialSummary, OpenFileInput, OpenUrlResult } from "../../shared/contracts";
import { FetchError, assertPublicHttpUrl, fetchPage, type Fetcher } from "./fetch";
import { PdfError, inspectPdf } from "./pdf";
import { readingMinutes } from "./reading-time";

const BUDGET = { maxBytes: 8 * 1024 * 1024, maxDepth: 100, maxNodes: 100_000, maxOutputBytes: 8 * 1024 * 1024 };
const MINUTES_PER_PDF_PAGE = 2.5;

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function idFor(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function pick(materialization: ContentMaterialization) {
  const by = (schema: string) => materialization.representations.find((r) => r.schema === schema)?.content;
  const v2 = by("reader.document.v2");
  const v1 = by("reader.document.v1");
  const reader = v2 ? { schema: "reader.document.v2" as const, payload: v2 } : v1 ? { schema: "reader.document.v1" as const, payload: v1 } : undefined;
  return { reader, markdown: by("agent.gfm.v1"), plain: by("selection.text.v1") };
}

/** Reader representations, markdown and quality for Markdown content; shared by files, feeds and agent artifacts. */
function markdownParts(content: string, baseUri: string): Pick<MaterialRecord, "reader" | "markdown" | "readingMinutes" | "quality" | "problems"> {
  const { representations } = createMarkdownRepresentations({ baseUri, content, maxDepth: BUDGET.maxDepth, maxNodes: BUDGET.maxNodes, maxOutputBytes: BUDGET.maxOutputBytes, outputBudgetErrorCode: "MARKDOWN_TOO_LARGE" });
  const by = (schema: string) => representations.find((r) => r.schema === schema)?.content;
  const v2 = by("reader.document.v2"); const v1 = by("reader.document.v1");
  return {
    ...(v2 ? { reader: { schema: "reader.document.v2" as const, payload: v2 } } : v1 ? { reader: { schema: "reader.document.v1" as const, payload: v1 } } : {}),
    markdown: content, readingMinutes: readingMinutes(content),
    quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "derived", safety: "safe", warnings: [] },
    problems: [],
  };
}

export interface FeedMaterialInput {
  url: string;
  title: string;
  byline?: string;
  publishedAt?: string;
  lang?: string;
  content: { reader?: MaterialRecord["reader"]; markdown?: string; plain?: string };
}

/** Materials on disk: one JSON per material, an index for lists. Sources, items and events live in SQLite (db.ts). */
export class MaterialStore {
  constructor(private readonly root: string, private readonly fetch: Fetcher = fetchPage) {}

  private get dir() { return join(this.root, "materials"); }

  /** Fetches and materializes a public page. `origin` marks material that arrived through a subscription. */
  async openUrl(raw: string, origin: "web" | "feed" = "web"): Promise<OpenUrlResult> {
    try {
      const url = assertPublicHttpUrl(raw);
      const page = await this.fetch(url);
      const record = await this.materializeAny(page.bytes, page.mediaType, page.finalUrl, raw, origin);
      await this.save(record);
      return { ok: true, material: record };
    } catch (error) {
      if (error instanceof FetchError || error instanceof PdfError) return { ok: false, code: error.code, message: error.message };
      return { ok: false, code: "NORMALIZE_FAILED", message: error instanceof Error ? error.message : "Could not read this page." };
    }
  }

  /** A dropped or opened file. The bytes already crossed the bridge; only the type is decided here. */
  async openFile(input: OpenFileInput): Promise<OpenUrlResult> {
    try {
      const name = input.name.replace(/[\\/]/g, "_").slice(0, 200) || "file";
      const mediaType = input.mediaType || mediaTypeForName(name);
      // The article extractor only resolves http(s) bases; a synthetic origin keeps relative links well-formed.
      const locator = `https://file.local/${encodeURIComponent(name)}`;
      const record = await this.materializeAny(input.bytes, mediaType, locator, `file:///${encodeURIComponent(name)}`, "file", sha256(input.bytes).slice(7, 23));
      await this.save(record);
      return { ok: true, material: record };
    } catch (error) {
      if (error instanceof FetchError || error instanceof PdfError) return { ok: false, code: error.code, message: error.message };
      return { ok: false, code: "NORMALIZE_FAILED", message: error instanceof Error ? error.message : "Could not read this file." };
    }
  }

  /** PDFs keep their bytes on disk next to the record; everything else is materialized synchronously. */
  private async materializeAny(bytes: Uint8Array, mediaType: string, finalUrl: string, requestedUrl: string, origin: MaterialRecord["origin"] = "web", id = idFor(finalUrl)): Promise<MaterialRecord> {
    if (mediaType !== "application/pdf" && !(mediaType === "application/octet-stream" && looksLikePdf(bytes))) return this.materialize(bytes, mediaType, finalUrl, requestedUrl, origin, id);
    const inspection = await inspectPdf(bytes);
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pdfPath(id), bytes);
    const fileName = decodeURIComponent(new URL(finalUrl).pathname.split("/").pop() ?? "").replace(/\.pdf$/i, "");
    return {
      id, url: requestedUrl, finalUrl, mediaType: "application/pdf", fetchedAt: new Date().toISOString(), origin,
      title: inspection.title ?? fileName ?? new URL(finalUrl).hostname,
      ...(inspection.author ? { byline: inspection.author } : {}),
      ...(inspection.sampleText ? { plain: inspection.sampleText } : {}),
      readingMinutes: Math.max(1, Math.round(inspection.pages * MINUTES_PER_PDF_PAGE)),
      pdf: { pages: inspection.pages, byteLength: bytes.byteLength, textLayer: inspection.textLayer },
      quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: origin === "file" ? "derived" : "strong", safety: "safe", warnings: [] },
      problems: [],
    };
  }

  private materialize(bytes: Uint8Array, mediaType: string, finalUrl: string, requestedUrl: string, origin: MaterialRecord["origin"] = "web", id = idFor(finalUrl)): MaterialRecord {
    const fetchedAt = new Date().toISOString();
    const base = { id, url: requestedUrl, finalUrl, mediaType, fetchedAt, origin };
    if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
      const outcome = normalizeArticleCapture({ budget: BUDGET, capture: { baseLocator: finalUrl, bytes, contentIdentity: sha256(bytes), mediaType } });
      if (!outcome.ok) {
        const plain = outcome.fallbackText ?? "";
        return { ...base, title: new URL(finalUrl).hostname, plain, readingMinutes: readingMinutes(plain), quality: degradedQuality(outcome.problems), problems: outcome.problems };
      }
      const { article } = outcome;
      const parts = pick(article.materialization);
      return {
        ...base,
        title: article.title.trim() || titleFromHtml(bytes) || new URL(finalUrl).hostname,
        ...(article.byline ? { byline: article.byline } : {}),
        ...(article.publishedAt ? { publishedAt: article.publishedAt } : {}),
        ...(article.lang ? { lang: article.lang } : {}),
        ...(article.dir ? { dir: article.dir } : {}),
        ...(parts.reader ? { reader: parts.reader } : {}),
        ...(parts.markdown ? { markdown: parts.markdown } : {}),
        ...(parts.plain ? { plain: parts.plain } : {}),
        readingMinutes: readingMinutes(parts.plain ?? parts.markdown ?? ""),
        quality: article.materialization.quality,
        problems: outcome.problems,
      };
    }
    if (mediaType === "text/markdown" || mediaType === "text/plain" || mediaType === "text/x-markdown") {
      const content = new TextDecoder("utf-8").decode(bytes);
      const title = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? decodeURIComponent(new URL(finalUrl).pathname.split("/").pop() ?? finalUrl);
      return { ...base, title, ...markdownParts(content, finalUrl) };
    }
    throw new FetchError("UNSUPPORTED_TYPE", `This is ${mediaType}; only pages, PDFs, Markdown and plain text can be read in M0.`);
  }

  /**
   * A material the agent wrote (a synthesis, a summary). `lineage` names the materials it was built
   * from; every id must be in the library so each claim keeps its trail.
   */
  async saveArtifact(input: { title: string; markdown: string; lineage: readonly string[] }): Promise<MaterialRecord> {
    const title = input.title.trim();
    if (!title) throw new Error("An artifact needs a title.");
    if (!input.markdown.trim()) throw new Error("An artifact needs content.");
    const lineage = [...new Set(input.lineage)];
    const present = await Promise.all(lineage.map((id) => this.get(id)));
    const unknown = lineage.filter((_, index) => present[index] === undefined);
    if (unknown.length > 0) throw new Error(`Unknown material ids in lineage: ${unknown.join(", ")}. Cite only materials that are in the library.`);
    const fetchedAt = new Date().toISOString();
    const id = createHash("sha256").update(`${title}\n${fetchedAt}`).digest("hex").slice(0, 16);
    const url = `quire://artifact/${id}`;
    const record: MaterialRecord = { id, url, finalUrl: url, mediaType: "text/markdown", fetchedAt, origin: "agent", lineage, title, ...markdownParts(input.markdown, url) };
    await this.save(record);
    return record;
  }

  private async save(record: MaterialRecord) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${record.id}.json`), JSON.stringify(record), "utf8");
  }

  /**
   * A material built from the copy a feed carried, used when the page itself could not be
   * fetched. The FEED_CONTENT_FALLBACK problem marks it so the reader can say so.
   */
  async saveFromFeed(input: FeedMaterialInput): Promise<MaterialRecord> {
    const plain = input.content.plain ?? input.content.markdown ?? "";
    const record: MaterialRecord = {
      id: idFor(input.url), url: input.url, finalUrl: input.url, title: input.title, fetchedAt: new Date().toISOString(),
      origin: "feed", mediaType: "text/html", readingMinutes: readingMinutes(plain),
      ...(input.byline ? { byline: input.byline } : {}),
      ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
      ...(input.lang ? { lang: input.lang } : {}),
      ...(input.content.reader ? { reader: input.content.reader } : {}),
      ...(input.content.markdown ? { markdown: input.content.markdown } : {}),
      ...(input.content.plain ? { plain: input.content.plain } : {}),
      quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "medium", safety: "safe", warnings: [] },
      problems: [{ code: "FEED_CONTENT_FALLBACK", recoverBy: "reopen", scope: "capture", severity: "warning" }],
    };
    await this.save(record);
    return record;
  }

  /** Materializes every eval snapshot (corpus/<slug>/page.html.gz + meta.json) that is not in the library yet. */
  async importSnapshots(corpusDir: string): Promise<CorpusImportResult> {
    const result: CorpusImportResult = { imported: 0, skipped: 0, failed: [] };
    let slugs: string[];
    try { slugs = (await readdir(corpusDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
    catch (error) { throw new Error(`Corpus directory not readable: ${corpusDir} (${(error as Error).message})`); }
    for (const slug of slugs.sort()) {
      try {
        const meta = JSON.parse(await readFile(join(corpusDir, slug, "meta.json"), "utf8")) as { url: string; finalUrl: string; fetchedAt: string };
        if (await this.get(idFor(meta.finalUrl))) { result.skipped += 1; continue; }
        const bytes = new Uint8Array(gunzipSync(await readFile(join(corpusDir, slug, "page.html.gz"))));
        const record = await this.materializeAny(bytes, "text/html", meta.finalUrl, meta.url);
        await this.save({ ...record, fetchedAt: meta.fetchedAt });
        result.imported += 1;
      } catch (error) {
        result.failed.push({ slug, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }

  private pdfPath(id: string) { return join(this.dir, `${id}.pdf`); }

  /** Bytes of a stored PDF. Undefined when the id is unknown or the material is not a PDF. */
  async bytes(id: string): Promise<Uint8Array | undefined> {
    if (!/^[a-f0-9]{16}$/.test(id)) return undefined;
    try { return new Uint8Array(await readFile(this.pdfPath(id))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async get(id: string): Promise<MaterialRecord | undefined> {
    if (!/^[a-f0-9]{16}$/.test(id)) return undefined;
    try { return JSON.parse(await readFile(join(this.dir, `${id}.json`), "utf8")) as MaterialRecord; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async list(): Promise<MaterialSummary[]> {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir)).filter((name) => name.endsWith(".json"));
    const records = await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(this.dir, name), "utf8")) as MaterialRecord));
    return records
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))
      .map(({ id, url, title, byline, publishedAt, fetchedAt, readingMinutes, origin, mediaType, quality, lineage }) => ({ id, url, title, fetchedAt, readingMinutes, origin, mediaType, quality, ...(byline ? { byline } : {}), ...(publishedAt ? { publishedAt } : {}), ...(lineage ? { lineage } : {}) }));
  }
}

const MAX_PREFETCH_IMAGES = 80;

/** Image sources referenced by the reader document, in reading order, for caching at save time. */
export function imageUrlsOf(record: Pick<MaterialRecord, "reader">): string[] {
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

function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

function titleFromHtml(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 64 * 1024));
  const match = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(head);
  return match?.[1]?.replace(/\s+/g, " ").trim() || undefined;
}

function mediaTypeForName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "txt") return "text/plain";
  if (ext === "html" || ext === "htm" || ext === "xhtml") return "text/html";
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
}

function degradedQuality(problems: NormalizationProblem[]) {
  return { completeness: "none" as const, conformance: "recoverable" as const, identityConfidence: "derived" as const, safety: "degraded_plaintext" as const, warnings: problems };
}
