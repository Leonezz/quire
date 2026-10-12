import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { RENDERING_PROBLEM_KINDS, type MaterialRecord, type MaterialViewContent, type MaterialViewId, type RenderingFeedback, type RenderingFeedbackDraft, type RenderingProblemKind } from "../../shared/contracts";
import { isMaterialViewId } from "./material-views";

// A reader's report that a page rendered badly. Nothing leaves the machine: every report is a
// bundle under <userData>/feedback/<id>/ in the eval corpus's own entry layout, so
// `pnpm --filter @read/eval import-feedback <dir>` can turn it into a corpus case as it is:
//   report.json   the RenderingFeedback record (what the Settings list shows)
//   meta.json     the corpus entry (slug, url, finalUrl, status, contentType, bytes, generator, fetchedAt, framework, tags = kinds)
//   page.html.gz  the saved original page, gzipped, only when the reader chose to include the capture
//   original.pdf  instead of page.html.gz for the pdf and text views: the PDF itself
//   extracted.md  what Quire made of it (the view's markdown, or its plain text when there is no markdown)
// A one-step report (createSubmission, then feedback-submit.ts) adds:
//   reader-document.json  the view's reader document ({ schema, document }), when it has one
//   screenshots/          the reader and original-page screenshots and composite.png
//   quire-report-<slug>-<id>.zip  all of the above, to drag into the issue

const ID = /^[a-f0-9]{16}$/;
export const MAX_FEEDBACK_NOTE = 20_000;
const MAX_SLUG = 80;
const REPORT_FILE = "report.json";

/** The material fields a report is built from; MaterialStore.get() returns a superset. */
export type FeedbackMaterialRecord = Pick<MaterialRecord, "id" | "url" | "finalUrl" | "title" | "fetchedAt" | "mediaType" | "capture" | "pdf"> & { primaryView?: MaterialViewId };

export interface FeedbackMaterials {
  get(id: string): Promise<FeedbackMaterialRecord | undefined>;
  /** Content of a stored view (the primary view's is assembled from the record); undefined when not stored. */
  getView(id: string, view: MaterialViewId): Promise<MaterialViewContent | undefined>;
  /** The saved original page; undefined when none was kept. */
  captureBytes(id: string): Promise<Uint8Array | undefined>;
  /** A stored PDF's bytes (the primary one, or the given view's); undefined when none is stored. */
  bytes(id: string, view?: MaterialViewId): Promise<Uint8Array | undefined>;
}

/** The one-step report's input: the draft plus the reader's current reading settings. */
export type SubmitDraft = RenderingFeedbackDraft & { prefs: Record<string, unknown> };

/** The original the bundle carries: the saved page, or the PDF for the pdf and text views. */
export type FeedbackOriginal = { kind: "page"; bytes: Uint8Array } | { kind: "pdf"; bytes: Uint8Array };

/** What createSubmission wrote, with what the screenshot steps need next. */
export interface FeedbackSubmission {
  record: RenderingFeedback;
  material: FeedbackMaterialRecord;
  content: MaterialViewContent;
  /** The corpus slug (meta.json), used in the zip's name. */
  slug: string;
  original?: FeedbackOriginal;
  /** Parts of the bundle that could not be written as intended; the report goes on. */
  warnings: string[];
}

/** The views whose original is the PDF rather than the saved page. */
const PDF_VIEWS: readonly MaterialViewId[] = ["pdf", "text"];
export const READER_DOCUMENT_FILE = "reader-document.json";

export interface FeedbackStoreOptions {
  materials: FeedbackMaterials;
  /** Versions written on every record: the app, and the normalize package that extracted the page. */
  app: { version: string; platform: string; normalize: string };
  now?: () => Date;
  warn: (message: string) => void;
}

/** A corpus entry as eval/corpus/<slug>/meta.json holds it (eval/src/corpus.ts reads url, finalUrl, generator, fetchedAt). */
export interface CorpusMeta {
  slug: string;
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: number;
  generator: string;
  fetchedAt: string;
  framework: string;
  tags: string[];
}

export class FeedbackError extends Error {
  constructor(message: string) { super(message); this.name = "FeedbackError"; }
}

/** A corpus slug from the page's host and path, `[a-z0-9-]` only: `acoup-blog-2019-05-10-collections-the-siege-of-gondor`. */
export function slugForUrl(url: string, fallback: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return fallback; }
  const host = parsed.hostname.replace(/^www\./, "") || parsed.protocol.replace(/:$/, "");
  const slug = `${host}${parsed.pathname}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_SLUG).replace(/-+$/, "");
  return slug || fallback;
}

function validId(value: string): string {
  if (!ID.test(value)) throw new FeedbackError(`Not a feedback id: ${value}`);
  return value;
}

function validKinds(value: readonly RenderingProblemKind[], requireOne: boolean): RenderingProblemKind[] {
  if (!Array.isArray(value)) throw new FeedbackError("kinds must be a list of problem kinds.");
  const unknown = value.find((kind) => !RENDERING_PROBLEM_KINDS.includes(kind));
  if (unknown !== undefined) throw new FeedbackError(`Unknown problem kind: ${String(unknown)}`);
  const kinds = [...new Set(value)];
  if (requireOne && kinds.length === 0) throw new FeedbackError("Pick at least one thing that went wrong.");
  return kinds;
}

/** The two-step form asks for at least one kind; the one-step report makes kinds optional. */
function validDraft<T extends RenderingFeedbackDraft>(draft: T, requireKind: boolean): T {
  if (!ID.test(draft.materialId)) throw new FeedbackError(`Not a material id: ${draft.materialId}`);
  if (!isMaterialViewId(draft.view)) throw new FeedbackError(`Not a view: ${String(draft.view)}`);
  if (typeof draft.note !== "string" || draft.note.length > MAX_FEEDBACK_NOTE) throw new FeedbackError(`The note must be at most ${MAX_FEEDBACK_NOTE} characters.`);
  if (typeof draft.includeCapture !== "boolean") throw new FeedbackError("includeCapture must be true or false.");
  return { ...draft, kinds: validKinds(draft.kinds, requireKind) };
}

/** A file of the bundle, relative to its directory. */
interface BundleFile { path: string; data: Uint8Array | string }

/** reader-document.json: the reader document as JSON, tagged with its schema. A payload that is not JSON is kept as text, with a warning. */
export function readerDocumentFileOf(reader: NonNullable<MaterialViewContent["reader"]>): { text: string; warning?: string } {
  try {
    return { text: JSON.stringify({ schema: reader.schema, document: JSON.parse(reader.payload) as unknown }, null, 2) };
  } catch (error) {
    return {
      text: JSON.stringify({ schema: reader.schema, payload: reader.payload }, null, 2),
      warning: `The reader document is not valid JSON (${error instanceof Error ? error.message : String(error)}); it is kept as text in ${READER_DOCUMENT_FILE}.`,
    };
  }
}

/** GitHub only: the issue link the reader pastes back must point at github.com over https. */
export function validIssueUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new FeedbackError(`Not a URL: ${value}`); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") throw new FeedbackError(`The issue link must be an https://github.com/… URL, not ${value}`);
  return parsed.toString();
}

function mintId(materialId: string, createdAt: string): string {
  return createHash("sha256").update(`${materialId}\n${createdAt}\n${randomUUID()}`).digest("hex").slice(0, 16);
}

/** The bundle's extracted.md: the view's markdown, or its plain text (the text view only has plain). */
export function extractedTextOf(content: Pick<MaterialViewContent, "markdown" | "plain">): string {
  return content.markdown ?? content.plain ?? "";
}

/** Reports on disk, one bundle directory each. Records are written last so a half-written bundle never lists. */
export class FeedbackStore {
  private readonly materials: FeedbackMaterials;
  private readonly app: FeedbackStoreOptions["app"];
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;

  constructor(private readonly root: string, options: FeedbackStoreOptions) {
    this.materials = options.materials;
    this.app = options.app;
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn;
  }

  bundleDir(id: string): string { return join(this.root, validId(id)); }
  private reportPath(id: string) { return join(this.bundleDir(id), REPORT_FILE); }

  /** Writes the bundle and returns the record. The material and the reported view must be in the library. */
  async create(input: RenderingFeedbackDraft): Promise<RenderingFeedback> {
    return (await this.build(validDraft(input, true), undefined)).record;
  }

  /**
   * The one-step report's bundle: what create writes, plus reader-document.json, the selection and the
   * reader's position and settings on the record. Kinds may be empty. Fails loudly when nothing can be written.
   */
  async createSubmission(input: SubmitDraft): Promise<FeedbackSubmission> {
    const draft = validDraft(input, false);
    if (!draft.prefs || typeof draft.prefs !== "object" || Array.isArray(draft.prefs)) throw new FeedbackError("prefs must be an object of reading settings.");
    return this.build(draft, {
      readerState: { scrollFraction: draft.viewport?.scrollFraction ?? 0, prefs: { ...draft.prefs } },
      ...(draft.selection ? { selection: { quote: draft.selection.quote, prefix: draft.selection.prefix, suffix: draft.selection.suffix } } : {}),
    });
  }

  private async build(draft: RenderingFeedbackDraft, extras: Pick<RenderingFeedback, "selection" | "readerState"> | undefined): Promise<FeedbackSubmission> {
    const material = await this.materials.get(draft.materialId);
    if (!material) throw new FeedbackError(`Material ${draft.materialId} is not in the library.`);
    const content = await this.materials.getView(draft.materialId, draft.view);
    if (!content) throw new FeedbackError(`The ${draft.view} view of "${material.title}" is not stored, so there is nothing to report on; open it first.`);
    const original = draft.includeCapture ? await this.requireOriginal(material, draft.view) : undefined;
    const createdAt = this.now().toISOString();
    const id = mintId(material.id, createdAt);
    const record: RenderingFeedback = {
      id, createdAt, materialId: material.id, url: material.url, title: material.title, view: draft.view, kinds: draft.kinds, note: draft.note,
      app: { ...this.app },
      quality: content.quality, problems: content.problems,
      ...(draft.view === "text" && content.report ? { report: content.report } : {}),
      capture: captureOf(material, original),
      bundleDir: this.bundleDir(id),
      ...extras,
    };
    const meta = metaOf(record, material, original);
    const warnings: string[] = [];
    const files: BundleFile[] = [
      { path: "meta.json", data: JSON.stringify(meta, null, 2) },
      { path: "extracted.md", data: extractedTextOf(content) },
      ...(original?.kind === "page" ? [{ path: "page.html.gz", data: gzipSync(original.bytes) }] : []),
      ...(original?.kind === "pdf" ? [{ path: "original.pdf", data: original.bytes }] : []),
    ];
    if (extras && content.reader) {
      const readerFile = readerDocumentFileOf(content.reader);
      files.push({ path: READER_DOCUMENT_FILE, data: readerFile.text });
      if (readerFile.warning) warnings.push(readerFile.warning);
    }
    await this.writeBundle(record, files);
    return { record, material, content, slug: meta.slug, ...(original ? { original } : {}), warnings };
  }

  private async requireOriginal(material: FeedbackMaterialRecord, view: MaterialViewId): Promise<FeedbackOriginal> {
    if (!PDF_VIEWS.includes(view)) return { kind: "page", bytes: await this.requireCapture(material) };
    const bytes = await this.materials.bytes(material.id, "pdf");
    if (!bytes) throw new FeedbackError(`The PDF of "${material.title}" is not stored; fetch the PDF view first, or report it without the original.`);
    return { kind: "pdf", bytes };
  }

  private async requireCapture(material: FeedbackMaterialRecord): Promise<Uint8Array> {
    if (!material.capture) throw new FeedbackError(`"${material.title}" has no saved original page (captures are off in Settings, or it was opened from a file or a feed); report it without the page.`);
    const bytes = await this.materials.captureBytes(material.id);
    if (!bytes) throw new FeedbackError(`The saved page of "${material.title}" is listed but its file is missing; reopen the page or report it without the page.`);
    return bytes;
  }

  /** The bundle is assembled under a staging name and renamed into place, so a crash leaves no half bundle behind. */
  private async writeBundle(record: RenderingFeedback, files: readonly BundleFile[]): Promise<void> {
    const staging = join(this.root, `.${record.id}.partial`);
    await mkdir(staging, { recursive: true });
    try {
      for (const file of files) await writeFile(join(staging, file.path), file.data, typeof file.data === "string" ? "utf8" : undefined);
      await writeFile(join(staging, REPORT_FILE), JSON.stringify(record, null, 2), "utf8");
      await rename(staging, record.bundleDir);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  /** Rewrites the record of an existing bundle (the one-step report adds its package once it is built). */
  async save(record: RenderingFeedback): Promise<RenderingFeedback> {
    const current = await this.require(record.id);
    if (current.bundleDir !== record.bundleDir) throw new FeedbackError(`Feedback ${record.id} lives in ${current.bundleDir}, not ${record.bundleDir}.`);
    await writeFile(this.reportPath(record.id), JSON.stringify(record, null, 2), "utf8");
    return record;
  }

  /** Every report, newest first. A bundle whose record cannot be read is reported through `warn` and left out. */
  async list(): Promise<RenderingFeedback[]> {
    await mkdir(this.root, { recursive: true });
    const entries = (await readdir(this.root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && ID.test(entry.name));
    const records = await Promise.all(entries.map(async (entry) => {
      try { return await this.readRecord(entry.name); }
      catch (error) { this.warn(`[feedback] ${entry.name}/${REPORT_FILE} is unreadable: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
    }));
    return records
      .filter((record): record is RenderingFeedback => record !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  async get(id: string): Promise<RenderingFeedback | undefined> {
    try { return await this.readRecord(validId(id)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  private async require(id: string): Promise<RenderingFeedback> {
    const record = await this.get(id);
    if (!record) throw new FeedbackError(`Feedback ${id} does not exist.`);
    return record;
  }

  /** Removes the whole bundle. Unknown ids are an error, never a silent no-op. */
  async delete(id: string): Promise<void> {
    await this.require(id);
    await rm(this.bundleDir(id), { recursive: true, force: true });
  }

  /** The reader filed the issue and pasted its link back; it is kept on the record. */
  async setIssueUrl(id: string, issueUrl: string): Promise<RenderingFeedback> {
    const record = await this.require(id);
    const next: RenderingFeedback = { ...record, issueUrl: validIssueUrl(issueUrl) };
    await writeFile(this.reportPath(id), JSON.stringify(next, null, 2), "utf8");
    return next;
  }

  private async readRecord(id: string): Promise<RenderingFeedback> {
    return JSON.parse(await readFile(this.reportPath(id), "utf8")) as RenderingFeedback;
  }
}

/** What the record says about the original: the saved page's size and type, or the PDF's when the bundle carries the PDF. */
function captureOf(material: FeedbackMaterialRecord, original: FeedbackOriginal | undefined): RenderingFeedback["capture"] {
  if (original?.kind === "pdf") return { included: true, byteLength: original.bytes.byteLength, mediaType: "application/pdf" };
  return { included: original !== undefined, ...(material.capture ? { byteLength: material.capture.byteLength, mediaType: material.capture.mediaType } : {}) };
}

/** The corpus entry for the bundle. `bytes` is the saved page's size (or the PDF's) — the same number a fetch would have reported. */
function metaOf(record: RenderingFeedback, material: FeedbackMaterialRecord, original: FeedbackOriginal | undefined): CorpusMeta {
  const pdf = original?.kind === "pdf";
  return {
    slug: slugForUrl(material.finalUrl, record.id),
    url: material.url,
    finalUrl: material.finalUrl,
    status: 200,
    contentType: pdf ? "application/pdf" : material.capture?.mediaType ?? material.mediaType,
    bytes: pdf ? original.bytes.byteLength : material.capture?.byteLength ?? material.pdf?.byteLength ?? 0,
    generator: "",
    fetchedAt: material.fetchedAt,
    framework: "unknown",
    tags: [...record.kinds],
  };
}
