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
//   extracted.md  what Quire made of it (the view's markdown, or its plain text when there is no markdown)

const ID = /^[a-f0-9]{16}$/;
export const MAX_FEEDBACK_NOTE = 20_000;
const MAX_SLUG = 80;
const REPORT_FILE = "report.json";

/** The material fields a report is built from; MaterialStore.get() returns a superset. */
export type FeedbackMaterialRecord = Pick<MaterialRecord, "id" | "url" | "finalUrl" | "title" | "fetchedAt" | "mediaType" | "capture" | "pdf">;

export interface FeedbackMaterials {
  get(id: string): Promise<FeedbackMaterialRecord | undefined>;
  /** Content of a stored view (the primary view's is assembled from the record); undefined when not stored. */
  getView(id: string, view: MaterialViewId): Promise<MaterialViewContent | undefined>;
  /** The saved original page; undefined when none was kept. */
  captureBytes(id: string): Promise<Uint8Array | undefined>;
}

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

function validKinds(value: readonly RenderingProblemKind[]): RenderingProblemKind[] {
  const unknown = value.find((kind) => !RENDERING_PROBLEM_KINDS.includes(kind));
  if (unknown !== undefined) throw new FeedbackError(`Unknown problem kind: ${String(unknown)}`);
  const kinds = [...new Set(value)];
  if (kinds.length === 0) throw new FeedbackError("Pick at least one thing that went wrong.");
  return kinds;
}

function validDraft(draft: RenderingFeedbackDraft): RenderingFeedbackDraft {
  if (!ID.test(draft.materialId)) throw new FeedbackError(`Not a material id: ${draft.materialId}`);
  if (!isMaterialViewId(draft.view)) throw new FeedbackError(`Not a view: ${String(draft.view)}`);
  if (typeof draft.note !== "string" || draft.note.length > MAX_FEEDBACK_NOTE) throw new FeedbackError(`The note must be at most ${MAX_FEEDBACK_NOTE} characters.`);
  if (typeof draft.includeCapture !== "boolean") throw new FeedbackError("includeCapture must be true or false.");
  return { ...draft, kinds: validKinds(draft.kinds) };
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
    const draft = validDraft(input);
    const material = await this.materials.get(draft.materialId);
    if (!material) throw new FeedbackError(`Material ${draft.materialId} is not in the library.`);
    const content = await this.materials.getView(draft.materialId, draft.view);
    if (!content) throw new FeedbackError(`The ${draft.view} view of "${material.title}" is not stored, so there is nothing to report on; open it first.`);
    const capture = draft.includeCapture ? await this.requireCapture(material) : undefined;
    const createdAt = this.now().toISOString();
    const id = mintId(material.id, createdAt);
    const record: RenderingFeedback = {
      id, createdAt, materialId: material.id, url: material.url, title: material.title, view: draft.view, kinds: draft.kinds, note: draft.note,
      app: { ...this.app },
      quality: content.quality, problems: content.problems,
      ...(draft.view === "text" && content.report ? { report: content.report } : {}),
      capture: { included: capture !== undefined, ...(material.capture ? { byteLength: material.capture.byteLength, mediaType: material.capture.mediaType } : {}) },
      bundleDir: this.bundleDir(id),
    };
    await this.writeBundle(record, metaOf(record, material), extractedTextOf(content), capture);
    return record;
  }

  private async requireCapture(material: FeedbackMaterialRecord): Promise<Uint8Array> {
    if (!material.capture) throw new FeedbackError(`"${material.title}" has no saved original page (captures are off in Settings, or it was opened from a file or a feed); report it without the page.`);
    const bytes = await this.materials.captureBytes(material.id);
    if (!bytes) throw new FeedbackError(`The saved page of "${material.title}" is listed but its file is missing; reopen the page or report it without the page.`);
    return bytes;
  }

  /** The bundle is assembled under a staging name and renamed into place, so a crash leaves no half bundle behind. */
  private async writeBundle(record: RenderingFeedback, meta: CorpusMeta, extracted: string, capture: Uint8Array | undefined): Promise<void> {
    const staging = join(this.root, `.${record.id}.partial`);
    await mkdir(staging, { recursive: true });
    try {
      await writeFile(join(staging, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
      await writeFile(join(staging, "extracted.md"), extracted, "utf8");
      if (capture) await writeFile(join(staging, "page.html.gz"), gzipSync(capture));
      await writeFile(join(staging, REPORT_FILE), JSON.stringify(record, null, 2), "utf8");
      await rename(staging, record.bundleDir);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
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

/** The corpus entry for the bundle. `bytes` is the saved page's size (or the PDF's) — the same number a fetch would have reported. */
function metaOf(record: RenderingFeedback, material: FeedbackMaterialRecord): CorpusMeta {
  return {
    slug: slugForUrl(material.finalUrl, record.id),
    url: material.url,
    finalUrl: material.finalUrl,
    status: 200,
    contentType: material.capture?.mediaType ?? material.mediaType,
    bytes: material.capture?.byteLength ?? material.pdf?.byteLength ?? 0,
    generator: "",
    fetchedAt: material.fetchedAt,
    framework: "unknown",
    tags: [...record.kinds],
  };
}
