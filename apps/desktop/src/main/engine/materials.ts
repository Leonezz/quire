import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { normalizeArticleCapture } from "@read/normalize";
import type { CorpusImportResult, MaterialMeta, MaterialRecord, MaterialSummary, MaterialView, MaterialViewContent, MaterialViewId, OpenFileInput, OpenUrlResult } from "../../shared/contracts";
import { bibtexOf } from "../../shared/bibtex";
import { captureTextOf } from "./capture-text";
import { FetchError, assertPublicHttpUrl, fetchPage, type Fetcher } from "./fetch";
import { NORMALIZE_BUDGET, degradedQuality, isHtml, isPdf, markdownParts, mediaTypeForName, pdfContent, pickRepresentations, titleFromHtml, withoutTitleHeading } from "./material-content";
import { effectiveOf, searchFieldsOf, summaryOf, withExtracted, type StoredRecord } from "./material-record";
import { failedView, mediaTypeFitsView, primaryContentOf, primaryPdfPath, primaryViewOf, readViewContent, readyView, swapPrimaryFiles, upsertView, viewFilePaths, viewPdfPath, viewsOf, withContent, withPrimaryView, writeViewContent } from "./material-views";
import { PdfError, inspectPdf } from "./pdf";
import { buildTextView } from "./pdf-reflow";
import type { BlockJudge } from "./pdf-reflow/judge";
import { FigureStore } from "./figures";
import type { MetaStore } from "./meta";
import { readingMinutes } from "./reading-time";

export type { StoredRecord } from "./material-record";
export { imageUrlsOf, withoutTitleHeading } from "./material-content";

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
  /** Read at every text-view build: who refines the reflow's block kinds (the rules when absent). May throw to refuse the build with a reason. */
  judge?: () => BlockJudge;
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
/** Records only: <id>.json, never a view's <id>.<view>.json beside it. */
const RECORD_FILE = /^[a-f0-9]{16}\.json$/;

function failureOf(error: unknown, fallback: string): { ok: false; code: string; message: string } {
  if (error instanceof FetchError || error instanceof PdfError) return { ok: false, code: error.code, message: error.message };
  return { ok: false, code: "NORMALIZE_FAILED", message: error instanceof Error ? error.message : fallback };
}

/** Materials on disk: one JSON per material, an index for lists. Sources, items and events live in SQLite (db.ts). */
export class MaterialStore {
  private readonly meta: MaterialStoreOptions["meta"];
  private readonly keepCapture: () => boolean;
  private readonly judge: (() => BlockJudge) | undefined;
  private readonly figures: FigureStore;

  constructor(private readonly root: string, private readonly fetch: Fetcher = fetchPage, options: MaterialStoreOptions = {}) {
    this.meta = options.meta;
    this.keepCapture = options.keepCapture ?? (() => true);
    this.judge = options.judge;
    this.figures = new FigureStore(root);
  }

  private get dir() { return join(this.root, "materials"); }

  /** Fetches and materializes a public page. `origin` marks material that arrived through a subscription. */
  async openUrl(raw: string, origin: "web" | "feed" = "web", item?: MaterialMeta): Promise<OpenUrlResult> {
    try {
      const url = assertPublicHttpUrl(raw);
      const page = await this.fetch(url);
      const record = await this.materializeAny(page.bytes, page.mediaType, page.finalUrl, raw, origin, idFor(page.finalUrl), item);
      return { ok: true, material: this.decorate(await this.save(record)) };
    } catch (error) {
      return failureOf(error, "Could not read this page.");
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
      return { ok: true, material: this.decorate(await this.save(record)) };
    } catch (error) {
      return failureOf(error, "Could not read this file.");
    }
  }

  /** PDFs keep their bytes on disk next to the record; pages keep their capture when the setting says so; everything else is materialized synchronously. */
  private async materializeAny(bytes: Uint8Array, mediaType: string, finalUrl: string, requestedUrl: string, origin: StoredRecord["origin"] = "web", id = idFor(finalUrl), item?: MaterialMeta): Promise<StoredRecord> {
    if (!isPdf(bytes, mediaType)) {
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
      id, url: requestedUrl, finalUrl, fetchedAt: new Date().toISOString(), origin,
      title: inspection.title ?? fileName ?? new URL(finalUrl).hostname,
      ...(inspection.author ? { byline: inspection.author } : {}),
      ...(item ? { itemMeta: item } : {}),
      ...pdfContent(inspection, bytes.byteLength, origin),
    });
  }

  private materialize(bytes: Uint8Array, mediaType: string, finalUrl: string, requestedUrl: string, origin: StoredRecord["origin"] = "web", id = idFor(finalUrl)): StoredRecord {
    const fetchedAt = new Date().toISOString();
    const base = { id, url: requestedUrl, finalUrl, mediaType, fetchedAt, origin };
    if (isHtml(mediaType)) {
      const outcome = normalizeArticleCapture({ budget: NORMALIZE_BUDGET, capture: { baseLocator: finalUrl, bytes, contentIdentity: sha256(bytes), mediaType } });
      if (!outcome.ok) {
        const plain = outcome.fallbackText ?? "";
        return { ...base, title: new URL(finalUrl).hostname, plain, readingMinutes: readingMinutes(plain), quality: degradedQuality(outcome.problems), problems: outcome.problems };
      }
      const { article } = outcome;
      const parts = pickRepresentations(article.materialization);
      return {
        ...base,
        title: article.title.trim() || titleFromHtml(bytes) || new URL(finalUrl).hostname,
        ...(article.byline ? { byline: article.byline } : {}),
        ...(article.publishedAt ? { publishedAt: article.publishedAt } : {}),
        ...(article.lang ? { lang: article.lang } : {}),
        ...(article.dir ? { dir: article.dir } : {}),
        ...parts,
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
    return this.decorate(await this.save(record));
  }

  /** Re-runs extraction on the stored capture (or the record's own fields) and replaces the extracted layer; overrides stay. */
  async refreshMetadata(id: string): Promise<MaterialRecord> {
    const record = await this.require(id);
    const html = isHtml(record.mediaType) ? await this.readOptional(this.htmlPath(id)) : undefined;
    return this.decorate(await this.save(withExtracted(record, html)));
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
    const record = await this.require(id);
    const artifact = await this.read(artifactId);
    if (!artifact || artifact.origin !== "agent") throw new Error(`Artifact ${artifactId} is not in the library.`);
    return this.decorate(await this.save({ ...record, rebuiltAs: artifactId }));
  }

  // --- Views: the record is the primary rendering; the others are stored beside it (material-views.ts). ---

  /** Lists another rendering on the record (available for a later fetch, or failed with its reason); the primary view cannot be replaced. */
  async registerView(id: string, view: MaterialView): Promise<MaterialRecord> {
    const record = await this.require(id);
    if (view.id === primaryViewOf(record) || view.status === "ready") throw new Error(`View ${view.id} of ${id} cannot be registered: it is the primary view or claims to be stored.`);
    return this.decorate(await this.save({ ...record, views: upsertView(viewsOf(record), view) }));
  }

  /** Fetches a listed view and stores it beside the record; the view is marked ready, or failed with the message (never silently). */
  async fetchView(id: string, viewId: MaterialViewId): Promise<OpenUrlResult> {
    const record = await this.read(id);
    if (!record) return { ok: false, code: "MATERIAL_NOT_FOUND", message: `Material ${id} is not in the library.` };
    const view = viewsOf(record).find((entry) => entry.id === viewId);
    if (!view) return { ok: false, code: "VIEW_UNKNOWN", message: `This material has no ${viewId} view.` };
    if (view.status === "ready") return { ok: false, code: "VIEW_ALREADY_STORED", message: `The ${view.label} view is stored already.` };
    try {
      const { content, byteLength } = viewId === "text" ? await this.buildText(record) : await this.fetchRemoteView(record, view);
      const next = { ...record, views: upsertView(viewsOf(record), readyView(view, content, byteLength)) };
      return { ok: true, material: this.decorate(await this.save(next)) };
    } catch (error) {
      const failure = failureOf(error, `Could not read the ${view.label} view.`);
      await this.save({ ...record, views: upsertView(viewsOf(record), failedView(view, failure.message)) });
      return failure;
    }
  }

  private async fetchRemoteView(record: StoredRecord, view: MaterialView): Promise<{ content: MaterialViewContent; byteLength: number }> {
    const page = await this.fetch(assertPublicHttpUrl(view.url));
    const content = await this.materializeView(page.bytes, page.mediaType, page.finalUrl, record.id, view.id, record.origin);
    return { content, byteLength: page.bytes.byteLength };
  }

  /** The text view is never fetched: it is reflowed from the stored PDF (the primary one or the pdf view's) and stored beside the record. */
  private async buildText(record: StoredRecord): Promise<{ content: MaterialViewContent; byteLength: number }> {
    const pdf = viewsOf(record).find((entry) => entry.id === "pdf");
    if (!pdf || pdf.status !== "ready") throw new PdfError("PDF_NOT_STORED", "The PDF is not stored yet; fetch the PDF view before building the text view.");
    const bytes = await this.bytes(record.id, "pdf");
    if (!bytes) throw new PdfError("PDF_NOT_STORED", "The PDF view is listed as stored but its file is missing.");
    const judge = this.judge?.();
    await this.figures.remove(record.id);
    const content = await buildTextView(bytes, record.id, { figures: this.figures, title: record.title, ...(judge ? { judge } : {}) });
    await mkdir(this.dir, { recursive: true });
    await writeViewContent(this.dir, record.id, content);
    return { content, byteLength: Buffer.byteLength(JSON.stringify(content)) };
  }

  /** A view's content in the shape the readers take: a PDF's inspection with its bytes stored, or a page through the article pipeline. */
  private async materializeView(bytes: Uint8Array, mediaType: string, finalUrl: string, id: string, view: MaterialViewId, origin: StoredRecord["origin"]): Promise<MaterialViewContent> {
    const pdf = isPdf(bytes, mediaType);
    if (!mediaTypeFitsView(view, pdf ? "application/pdf" : mediaType)) throw new FetchError("VIEW_TYPE_MISMATCH", `The ${view} view answered ${mediaType}.`);
    await mkdir(this.dir, { recursive: true });
    if (pdf) {
      const content = { view, ...pdfContent(await inspectPdf(bytes), bytes.byteLength, origin) };
      await writeViewContent(this.dir, id, content, bytes);
      return content;
    }
    const content = { ...primaryContentOf(this.materialize(bytes, mediaType, finalUrl, finalUrl, origin, id)), view };
    await writeViewContent(this.dir, id, content);
    return content;
  }

  /** Content of a stored view; the primary view's is assembled from the record. Undefined when nothing is stored. */
  async getView(id: string, view: MaterialViewId): Promise<MaterialViewContent | undefined> {
    const record = await this.read(id);
    if (!record) return undefined;
    if (view !== primaryViewOf(record)) return readViewContent(this.dir, id, view);
    // The text view keeps its file even as primary: its anchors and report have no place on the record.
    return (view === "text" ? await readViewContent(this.dir, id, view) : undefined) ?? primaryContentOf(record);
  }

  /** Makes a stored view the one the reader opens first: the record takes its content, the old primary becomes a stored view. */
  async setPrimaryView(id: string, view: MaterialViewId): Promise<MaterialRecord> {
    const record = withPrimaryView(await this.require(id));
    if (view === primaryViewOf(record)) return this.decorate(record);
    const entry = viewsOf(record).find((candidate) => candidate.id === view);
    if (!entry || entry.status !== "ready") throw new Error(`The ${view} view of ${id} is not stored; fetch it first.`);
    const incoming = await readViewContent(this.dir, id, view);
    if (!incoming) throw new Error(`The ${view} view of ${id} is listed as stored but its file is missing.`);
    const outgoing = (primaryViewOf(record) === "text" ? await readViewContent(this.dir, id, "text") : undefined) ?? primaryContentOf(record);
    await swapPrimaryFiles(this.dir, id, outgoing, incoming);
    return this.decorate(await this.save(withContent(record, incoming)));
  }

  /** Writes the record with its views made explicit, and returns what was written. */
  private async save(record: StoredRecord): Promise<StoredRecord> {
    const stored = withPrimaryView(record);
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${stored.id}.json`), JSON.stringify(stored), "utf8");
    return stored;
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
    return this.decorate(await this.save(record));
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

  private pdfPath(id: string) { return primaryPdfPath(this.dir, id); }
  private htmlPath(id: string) { return join(this.dir, `${id}.html`); }

  private async readOptional(path: string): Promise<Uint8Array | undefined> {
    try { return new Uint8Array(await readFile(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  /** Bytes of a stored PDF: the primary one, or a view's. Undefined when the id is unknown or nothing is stored for it. */
  async bytes(id: string, view?: MaterialViewId): Promise<Uint8Array | undefined> {
    if (!ID.test(id)) return undefined;
    if (view === undefined) return this.readOptional(this.pdfPath(id));
    const record = await this.read(id);
    if (!record) return undefined;
    return this.readOptional(view === primaryViewOf(record) ? this.pdfPath(id) : viewPdfPath(this.dir, id, view));
  }

  /** The captured page as readable text with its block structure; undefined when nothing was captured. */
  async captureText(id: string): Promise<string | undefined> {
    if (!ID.test(id)) return undefined;
    const bytes = await this.readOptional(this.htmlPath(id));
    return bytes ? captureTextOf(new TextDecoder("utf-8", { fatal: false }).decode(bytes)) : undefined;
  }

  /** Removes the records, the bytes, view files and figure crops next to them, and the overrides; returns how many records existed. */
  async delete(ids: readonly string[]): Promise<number> {
    const invalid = ids.find((id) => !ID.test(id));
    if (invalid !== undefined) throw new Error(`Not a material id: ${invalid}`);
    let deleted = 0;
    for (const id of ids) {
      if (await this.read(id)) deleted += 1;
      const paths = [this.pdfPath(id), this.htmlPath(id), join(this.dir, `${id}.json`), ...viewFilePaths(this.dir, id)];
      await Promise.all([...paths.map((path) => rm(path, { force: true })), this.figures.remove(id)]);
      this.meta?.remove(id);
    }
    return deleted;
  }

  private async read(id: string): Promise<StoredRecord | undefined> {
    if (!ID.test(id)) return undefined;
    const bytes = await this.readOptional(join(this.dir, `${id}.json`));
    return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as StoredRecord) : undefined;
  }

  private async require(id: string): Promise<StoredRecord> {
    const record = await this.read(id);
    if (!record) throw new Error(`Material ${id} is not in the library.`);
    return record;
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
    const files = (await readdir(this.dir)).filter((name) => RECORD_FILE.test(name));
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
    const files = (await readdir(this.dir)).filter((name) => RECORD_FILE.test(name));
    const records = await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(this.dir, name), "utf8")) as StoredRecord));
    const metas = this.meta?.all() ?? new Map<string, MaterialMeta>();
    return records
      .map((record) => summaryOf(effectiveOf(record, metas.get(record.id))))
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  }
}
