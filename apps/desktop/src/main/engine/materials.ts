import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { createMarkdownRepresentations, normalizeArticleCapture, type ContentMaterialization } from "@read/normalize";
import type { CorpusImportResult, MaterialMeta, MaterialRecord, MaterialSummary, OpenFileInput, OpenUrlResult } from "../../shared/contracts";
import { bibtexOf } from "../../shared/bibtex";
import { captureTextOf } from "./capture-text";
import { FetchError, assertPublicHttpUrl, fetchPage, type Fetcher } from "./fetch";
import { degradedQuality, looksLikePdf, mediaTypeForName, titleFromHtml } from "./material-content";
import { effectiveOf, searchFieldsOf, summaryOf, type StoredRecord } from "./material-record";
import { extractMetadata } from "./metadata";
import { PdfError, inspectPdf } from "./pdf";
import type { MetaStore } from "./meta";
import { readingMinutes } from "./reading-time";

export type { StoredRecord } from "./material-record";
export { imageUrlsOf } from "./material-content";

const BUDGET = { maxBytes: 8 * 1024 * 1024, maxDepth: 100, maxNodes: 100_000, maxOutputBytes: 8 * 1024 * 1024 };
const MINUTES_PER_PDF_PAGE = 2.5;

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function idFor(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export interface MaterialStoreOptions {
  /** The reader's overrides; without it every material reads as extracted, with no tags. */
  meta?: Pick<MetaStore, "get" | "all" | "remove">;
  /** Read at every fetch: keep the raw page next to the record so the agent can rebuild it. */
  keepCapture?: () => boolean;
}

function pick(materialization: ContentMaterialization) {
  const by = (schema: string) => materialization.representations.find((r) => r.schema === schema)?.content;
  const v2 = by("reader.document.v2");
  const v1 = by("reader.document.v1");
  const reader = v2 ? { schema: "reader.document.v2" as const, payload: v2 } : v1 ? { schema: "reader.document.v1" as const, payload: v1 } : undefined;
  return { reader, markdown: by("agent.gfm.v1"), plain: by("selection.text.v1") };
}

/** Reader representations, markdown and quality for Markdown content; shared by files, feeds and agent artifacts. */
function markdownParts(content: string, baseUri: string): Pick<StoredRecord, "reader" | "markdown" | "readingMinutes" | "quality" | "problems"> {
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

/** The reader prints the title itself, so a leading "# Title" line that repeats it would show twice. */
export function withoutTitleHeading(markdown: string, title: string): string {
  const match = /^\s*#\s+(.+?)\s*\n/.exec(markdown);
  if (!match) return markdown;
  const same = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  return same(match[1] ?? "") === same(title) ? markdown.slice(match[0].length).replace(/^\s*\n/, "") : markdown;
}

export interface FeedMaterialInput {
  url: string;
  title: string;
  byline?: string;
  publishedAt?: string;
  lang?: string;
  /** What the item declared (the feed's title, its kind); merged under the fallback fields. */
  meta?: MaterialMeta;
  content: { reader?: StoredRecord["reader"]; markdown?: string; plain?: string };
}

const ID = /^[a-f0-9]{16}$/;

function isHtml(mediaType: string): boolean {
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

type Fallback = Parameters<typeof extractMetadata>[0]["fallback"];

/** The extracted layer of a record from the extractor's own fields, the page (when HTML) and the item it came from. */
function extractedFor(record: Pick<StoredRecord, "finalUrl" | "mediaType" | "origin" | "fetchedAt" | "itemMeta">, fallback: Fallback, html?: Uint8Array): MaterialMeta {
  return extractMetadata({
    ...(html && isHtml(record.mediaType) ? { html } : {}),
    url: record.finalUrl, mediaType: record.mediaType, origin: record.origin, fetchedAt: record.fetchedAt, fallback,
    ...(record.itemMeta ? { item: record.itemMeta } : {}),
  });
}

function fallbackOf(record: Pick<StoredRecord, "title" | "byline" | "publishedAt" | "lang">): Fallback {
  return { title: record.title, ...(record.byline ? { byline: record.byline } : {}), ...(record.publishedAt ? { publishedAt: record.publishedAt } : {}), ...(record.lang ? { lang: record.lang } : {}) };
}

/** A record with its extracted layer computed from its own fields (and the page bytes when it is HTML). */
function withExtracted(record: StoredRecord, html?: Uint8Array): StoredRecord {
  return { ...record, extracted: extractedFor(record, fallbackOf(record), html) };
}

/** Materials on disk: one JSON per material, an index for lists. Sources, items and events live in SQLite (db.ts). */
export class MaterialStore {
  private readonly meta: MaterialStoreOptions["meta"];
  private readonly keepCapture: () => boolean;

  constructor(private readonly root: string, private readonly fetch: Fetcher = fetchPage, options: MaterialStoreOptions = {}) {
    this.meta = options.meta;
    this.keepCapture = options.keepCapture ?? (() => true);
  }

  private get dir() { return join(this.root, "materials"); }

  /** Fetches and materializes a public page. `origin` marks material that arrived through a subscription. */
  async openUrl(raw: string, origin: "web" | "feed" = "web", item?: MaterialMeta): Promise<OpenUrlResult> {
    try {
      const url = assertPublicHttpUrl(raw);
      const page = await this.fetch(url);
      const record = await this.materializeAny(page.bytes, page.mediaType, page.finalUrl, raw, origin, idFor(page.finalUrl), item);
      await this.save(record);
      return { ok: true, material: this.decorate(record) };
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
      return { ok: true, material: this.decorate(record) };
    } catch (error) {
      if (error instanceof FetchError || error instanceof PdfError) return { ok: false, code: error.code, message: error.message };
      return { ok: false, code: "NORMALIZE_FAILED", message: error instanceof Error ? error.message : "Could not read this file." };
    }
  }

  /** PDFs keep their bytes on disk next to the record; pages keep their capture when the setting says so; everything else is materialized synchronously. */
  private async materializeAny(bytes: Uint8Array, mediaType: string, finalUrl: string, requestedUrl: string, origin: StoredRecord["origin"] = "web", id = idFor(finalUrl), item?: MaterialMeta): Promise<StoredRecord> {
    if (mediaType !== "application/pdf" && !(mediaType === "application/octet-stream" && looksLikePdf(bytes))) {
      const record = withExtracted({ ...this.materialize(bytes, mediaType, finalUrl, requestedUrl, origin, id), ...(item ? { itemMeta: item } : {}) }, bytes);
      if (!isHtml(mediaType)) return record;
      if (!this.keepCapture()) { await rm(this.htmlPath(id), { force: true }); return record; }
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.htmlPath(id), bytes);
      return { ...record, capture: { byteLength: bytes.byteLength, mediaType } };
    }
    const inspection = await inspectPdf(bytes);
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pdfPath(id), bytes);
    const fileName = decodeURIComponent(new URL(finalUrl).pathname.split("/").pop() ?? "").replace(/\.pdf$/i, "");
    return withExtracted({
      id, url: requestedUrl, finalUrl, mediaType: "application/pdf", fetchedAt: new Date().toISOString(), origin,
      title: inspection.title ?? fileName ?? new URL(finalUrl).hostname,
      ...(inspection.author ? { byline: inspection.author } : {}),
      ...(inspection.sampleText ? { plain: inspection.sampleText } : {}),
      ...(item ? { itemMeta: item } : {}),
      readingMinutes: Math.max(1, Math.round(inspection.pages * MINUTES_PER_PDF_PAGE)),
      pdf: { pages: inspection.pages, byteLength: bytes.byteLength, textLayer: inspection.textLayer },
      quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: origin === "file" ? "derived" : "strong", safety: "safe", warnings: [] },
      problems: [],
    });
  }

  private materialize(bytes: Uint8Array, mediaType: string, finalUrl: string, requestedUrl: string, origin: StoredRecord["origin"] = "web", id = idFor(finalUrl)): StoredRecord {
    const fetchedAt = new Date().toISOString();
    const base = { id, url: requestedUrl, finalUrl, mediaType, fetchedAt, origin };
    if (isHtml(mediaType)) {
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
    const present = await Promise.all(lineage.map((id) => this.read(id)));
    const unknown = lineage.filter((_, index) => present[index] === undefined);
    if (unknown.length > 0) throw new Error(`Unknown material ids in lineage: ${unknown.join(", ")}. Cite only materials that are in the library.`);
    const fetchedAt = new Date().toISOString();
    const id = createHash("sha256").update(`${title}\n${fetchedAt}`).digest("hex").slice(0, 16);
    const url = `quire://artifact/${id}`;
    const record = withExtracted({ id, url, finalUrl: url, mediaType: "text/markdown", fetchedAt, origin: "agent", lineage, title, ...markdownParts(withoutTitleHeading(input.markdown, title), url) });
    await this.save(record);
    return this.decorate(record);
  }

  /** Re-runs extraction on the stored capture (or the record's own fields) and replaces the extracted layer; overrides stay. */
  async refreshMetadata(id: string): Promise<MaterialRecord> {
    const record = await this.read(id);
    if (!record) throw new Error(`Material ${id} is not in the library.`);
    const html = isHtml(record.mediaType) ? await this.readOptional(this.htmlPath(id)) : undefined;
    const next = withExtracted(record, html);
    await this.save(next);
    return this.decorate(next);
  }

  /** BibTeX entries for the given materials, in the given order, separated by blank lines; unknown ids are skipped. */
  async exportBibtex(ids: readonly string[]): Promise<string> {
    const records = await Promise.all(ids.map((id) => this.get(id)));
    const found = records.filter((record): record is MaterialRecord => record !== undefined);
    if (found.length === 0) throw new Error(`None of these materials is in the library: ${ids.join(", ")}.`);
    return found.map((record) => bibtexOf(record.meta, record.id)).join("\n\n");
  }

  /** Whether a record exists, without reading it whole. */
  async has(id: string): Promise<boolean> {
    if (!ID.test(id)) return false;
    try { await stat(join(this.dir, `${id}.json`)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }

  /** The agent rebuilt this material into a cleaner artifact; the Library offers the artifact in its place. */
  async setRebuiltAs(id: string, artifactId: string): Promise<MaterialRecord> {
    const record = await this.read(id);
    if (!record) throw new Error(`Material ${id} is not in the library.`);
    const artifact = await this.read(artifactId);
    if (!artifact || artifact.origin !== "agent") throw new Error(`Artifact ${artifactId} is not in the library.`);
    const next = { ...record, rebuiltAs: artifactId };
    await this.save(next);
    return this.decorate(next);
  }

  private async save(record: StoredRecord) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${record.id}.json`), JSON.stringify(record), "utf8");
  }

  private decorate(record: StoredRecord): MaterialRecord {
    return effectiveOf(record, this.meta?.get(record.id));
  }

  /**
   * A material built from the copy a feed carried, used when the page itself could not be
   * fetched. The FEED_CONTENT_FALLBACK problem marks it so the reader can say so.
   */
  async saveFromFeed(input: FeedMaterialInput): Promise<MaterialRecord> {
    const plain = input.content.plain ?? input.content.markdown ?? "";
    const record = withExtracted({
      id: idFor(input.url), url: input.url, finalUrl: input.url, title: input.title, fetchedAt: new Date().toISOString(),
      origin: "feed", mediaType: "text/html", readingMinutes: readingMinutes(plain),
      ...(input.byline ? { byline: input.byline } : {}),
      ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
      ...(input.lang ? { lang: input.lang } : {}),
      ...(input.meta ? { itemMeta: input.meta } : {}),
      ...(input.content.reader ? { reader: input.content.reader } : {}),
      ...(input.content.markdown ? { markdown: input.content.markdown } : {}),
      ...(input.content.plain ? { plain: input.content.plain } : {}),
      quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "medium", safety: "safe", warnings: [] },
      problems: [{ code: "FEED_CONTENT_FALLBACK", recoverBy: "reopen", scope: "capture", severity: "warning" }],
    });
    await this.save(record);
    return this.decorate(record);
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
        if (await this.read(idFor(meta.finalUrl))) { result.skipped += 1; continue; }
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
  private htmlPath(id: string) { return join(this.dir, `${id}.html`); }

  private async readOptional(path: string): Promise<Uint8Array | undefined> {
    try { return new Uint8Array(await readFile(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  /** Bytes of a stored PDF. Undefined when the id is unknown or the material is not a PDF. */
  async bytes(id: string): Promise<Uint8Array | undefined> {
    if (!ID.test(id)) return undefined;
    return this.readOptional(this.pdfPath(id));
  }

  /** The captured page as readable text with its block structure; undefined when nothing was captured. */
  async captureText(id: string): Promise<string | undefined> {
    if (!ID.test(id)) return undefined;
    const bytes = await this.readOptional(this.htmlPath(id));
    return bytes ? captureTextOf(new TextDecoder("utf-8", { fatal: false }).decode(bytes)) : undefined;
  }

  /** Removes the records and the bytes next to them, and the overrides; returns how many records existed. */
  async delete(ids: readonly string[]): Promise<number> {
    const invalid = ids.find((id) => !ID.test(id));
    if (invalid !== undefined) throw new Error(`Not a material id: ${invalid}`);
    let deleted = 0;
    for (const id of ids) {
      if (await this.read(id)) deleted += 1;
      await Promise.all([this.pdfPath(id), this.htmlPath(id), join(this.dir, `${id}.json`)].map((path) => rm(path, { force: true })));
      this.meta?.remove(id);
    }
    return deleted;
  }

  private async read(id: string): Promise<StoredRecord | undefined> {
    if (!ID.test(id)) return undefined;
    const bytes = await this.readOptional(join(this.dir, `${id}.json`));
    return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as StoredRecord) : undefined;
  }

  async get(id: string): Promise<MaterialRecord | undefined> {
    const record = await this.read(id);
    return record ? this.decorate(record) : undefined;
  }

  /** Every word of the query must appear in the title, creators, publication, abstract, identifiers, tags or the first 200k characters of the text. */
  async search(query: string): Promise<MaterialSummary[]> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (words.length === 0) return [];
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir)).filter((name) => name.endsWith(".json"));
    const metas = this.meta?.all() ?? new Map<string, MaterialMeta>();
    const hits: MaterialSummary[] = [];
    for (const name of files) {
      const stored = JSON.parse(await readFile(join(this.dir, name), "utf8")) as StoredRecord;
      const record = effectiveOf(stored, metas.get(stored.id));
      const haystack = `${searchFieldsOf(record)}\n${(record.plain ?? record.markdown ?? "").slice(0, 200_000)}`.toLowerCase();
      if (words.every((word) => haystack.includes(word))) hits.push(summaryOf(record));
    }
    return hits.sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  }

  async list(): Promise<MaterialSummary[]> {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir)).filter((name) => name.endsWith(".json"));
    const records = await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(this.dir, name), "utf8")) as StoredRecord));
    const metas = this.meta?.all() ?? new Map<string, MaterialMeta>();
    return records
      .map((record) => summaryOf(effectiveOf(record, metas.get(record.id))))
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  }
}
