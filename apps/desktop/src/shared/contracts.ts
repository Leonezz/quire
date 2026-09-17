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

export interface ReadApi {
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
