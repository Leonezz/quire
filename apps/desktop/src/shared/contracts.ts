// The only vocabulary that crosses the preload bridge. Types only.
import type { ContentNormalizationQuality, NormalizationProblem } from "@read/normalize/contract";

export interface MaterialSummary {
  id: string;
  url: string;
  title: string;
  byline?: string;
  publishedAt?: string;
  fetchedAt: string;
  readingMinutes: number;
  origin: "web" | "feed" | "file";
  mediaType: string;
  quality: ContentNormalizationQuality;
}

/** Present when the material is a PDF; the bytes live next to the record and are read with getMaterialBytes. */
export interface PdfInfo {
  pages: number;
  byteLength: number;
  textLayer: "available" | "absent";
}

export interface MaterialRecord extends MaterialSummary {
  finalUrl: string;
  pdf?: PdfInfo;
  lang?: string;
  dir?: "ltr" | "rtl";
  /** Reader representation: schema id and JSON payload (v2 preferred, v1 otherwise). */
  reader?: { schema: "reader.document.v1" | "reader.document.v2"; payload: string };
  /** GitHub-flavoured Markdown for the agent and as the reader fallback. */
  markdown?: string;
  /** Plain text when nothing richer could be produced. */
  plain?: string;
  problems: NormalizationProblem[];
}

export type OpenUrlResult =
  | { ok: true; material: MaterialRecord }
  | { ok: false; code: string; message: string };

export interface OpenFileInput {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

export type AnnotationKind = "highlight" | "underline" | "comment";
export type AnnotationColor = "#ffd400" | "#5fb236" | "#2ea8e5" | "#e56eee";

/** A highlight or a note, anchored by a locator the reader understands (text-quote for pages, pdf-region for PDFs). */
export interface Annotation {
  id: string;
  materialId: string;
  locator: string;
  quote: string;
  note?: string;
  kind: AnnotationKind;
  color: AnnotationColor;
  createdAt: string;
  updatedAt: string;
}

export type ThemeSource = "system" | "light" | "dark";

export interface CorpusImportResult {
  imported: number;
  skipped: number;
  failed: { slug: string; message: string }[];
}

export interface ReadApi extends ReadApiM1 {
  version: string;
  platform: string;
  /** Fires after the main process changed the library on its own (an import); the renderer reloads the list. */
  onLibraryChanged: (listener: () => void) => () => void;
  /** Development only: materialize every snapshot of the evaluation corpus into the library. */
  importCorpus: () => Promise<CorpusImportResult>;
  /** Sync the window's native appearance (vibrancy, menus) with the reading theme. */
  setTheme: (theme: ThemeSource) => Promise<void>;
  openUrl: (url: string) => Promise<OpenUrlResult>;
  openFile: (input: OpenFileInput) => Promise<OpenUrlResult>;
  getMaterial: (id: string) => Promise<MaterialRecord | undefined>;
  /** A remote image as a data: URL from the local cache (fetched once); undefined when it cannot be cached. */
  resolveImage: (url: string) => Promise<string | undefined>;
  listAnnotations: (materialId: string) => Promise<Annotation[]>;
  saveAnnotation: (annotation: Annotation) => Promise<Annotation>;
  deleteAnnotation: (materialId: string, id: string) => Promise<void>;
  /** Raw bytes of a stored PDF; undefined when the material has none. */
  getMaterialBytes: (id: string) => Promise<Uint8Array | undefined>;
  listMaterials: () => Promise<MaterialSummary[]>;
}

// ---------------------------------------------------------------------------
// M1: sources, the Inbox / Queue loop, reading events, search.
// ---------------------------------------------------------------------------

export type SourceKind = "feed" | "arxiv";

/** A subscription. `locator` is the feed URL, or the arXiv category (e.g. "cs.CL") for kind "arxiv". */
export interface SourceRecord {
  id: string;
  kind: SourceKind;
  locator: string;
  title: string;
  /** The site the feed belongs to, when the feed declares one. */
  siteUrl?: string;
  addedAt: string;
  /** Refresh cadence; the scheduler skips a source whose last sync is younger than this. */
  intervalMinutes: number;
  lastSyncAt?: string;
  lastSuccessAt?: string;
  /** Message of the most recent failed sync; cleared by the next success. */
  lastError?: string;
  /** Consecutive failed syncs. */
  failureCount: number;
  pausedAt?: string;
  itemCount: number;
  keptCount: number;
  /** Items per week, averaged over the last four weeks of published dates. */
  weeklyRate: number;
}

export interface ItemSignals {
  code?: boolean;
  math?: boolean;
  figures?: boolean;
  lang?: string;
}

/**
 * One entry a source produced. Undecided until read, queued or dismissed; the Inbox lists
 * only undecided items, the Queue only queued ones (ordered by queuePosition).
 */
export interface ItemRecord {
  id: string;
  sourceId: string;
  sourceTitle: string;
  sourceKind: SourceKind;
  title: string;
  /** The first sentences of the entry, for the row and the preview. Plain text, at most ~300 chars. */
  gist: string;
  /** Where the full material lives (the article URL, or the arXiv abstract page). */
  link: string;
  publishedAt: string;
  fetchedAt: string;
  readingMinutes: number;
  signals: ItemSignals;
  /** True when the feed carried only a summary; the full text is fetched on Read. */
  summaryOnly: boolean;
  /** Set once the item has been read (opened) at least once. */
  openedAt?: string;
  finishedAt?: string;
  queuedAt?: string;
  queuePosition?: number;
  dismissedAt?: string;
  /** The library material this item was read as, once it has been opened. */
  materialId?: string;
  introducedBy?: "agent";
}

export type ItemDecision = "queue" | "dismiss" | "unqueue" | "undismiss";

export type SourceDetection =
  | { kind: "feed"; url: string; title?: string }
  | { kind: "arxiv"; category: string; title: string }
  | { kind: "page"; url: string };

export type AddSourceResult =
  | { ok: true; source: SourceRecord; added: number }
  | { ok: false; code: string; message: string };

export type SyncSourceResult =
  | { ok: true; source: SourceRecord; added: number }
  | { ok: false; code: string; message: string; source: SourceRecord };

export type ReadingEventKind = "opened" | "finished" | "kept" | "queued" | "dismissed";

export interface ReadingEvent {
  id: string;
  kind: ReadingEventKind;
  /** The item id (opened / queued / dismissed) or the material id (finished / kept). */
  ref: string;
  at: string;
}

/** The north star, computed locally: materials read to completion in the current ISO week and the one before. */
export interface ReadingStats {
  weekStart: string;
  finishedThisWeek: number;
  finishedLastWeek: number;
  openedThisWeek: number;
}

export interface SearchHit {
  kind: "material" | "item";
  id: string;
  title: string;
  /** Source or host, then a date when known. */
  subtitle: string;
}

export interface ReadApiM1 {
  /** What a pasted string is: a feed, an arXiv category, or a plain page. Fetches the URL once when needed. */
  detectSource: (input: string) => Promise<SourceDetection>;
  /** Subscribe (feed URL or arXiv category, as detectSource reports it) and run the first sync. */
  addSource: (input: string) => Promise<AddSourceResult>;
  listSources: () => Promise<SourceRecord[]>;
  syncSource: (id: string) => Promise<SyncSourceResult>;
  /** Refresh every source that is due; resolves when all are done. */
  syncAllSources: () => Promise<void>;
  pauseSource: (id: string, paused: boolean) => Promise<SourceRecord>;
  /** Disconnects the source and drops its undecided items; read and kept material stays. */
  removeSource: (id: string) => Promise<void>;
  /** Fires after the scheduler (or an add / sync / decision made elsewhere) changed sources or items. */
  onSourcesChanged: (listener: () => void) => () => void;

  /** Undecided items, newest first. */
  listInbox: () => Promise<ItemRecord[]>;
  /** Queued items in queue order. */
  listQueue: () => Promise<ItemRecord[]>;
  getItem: (id: string) => Promise<ItemRecord | undefined>;
  /** Read now: materializes the link (arXiv: HTML first, then PDF), marks the item opened, returns the material. */
  readItem: (id: string) => Promise<OpenUrlResult>;
  decideItem: (id: string, decision: ItemDecision) => Promise<ItemRecord>;
  /** The complete new order of the queue, as item ids. */
  reorderQueue: (ids: string[]) => Promise<void>;

  /** finished / kept refer to a material id; the others to an item id. */
  recordReadingEvent: (kind: ReadingEventKind, ref: string) => Promise<ReadingEvent>;
  readingStats: () => Promise<ReadingStats>;

  /** Titles (and bylines / source titles) of materials and items matching every word of the query; at most 50 hits. */
  search: (query: string) => Promise<SearchHit[]>;
}
