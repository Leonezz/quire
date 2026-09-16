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
  quality: ContentNormalizationQuality;
}

export interface MaterialRecord extends MaterialSummary {
  finalUrl: string;
  mediaType: string;
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

export interface ReadApi {
  version: string;
  platform: string;
  openUrl: (url: string) => Promise<OpenUrlResult>;
  getMaterial: (id: string) => Promise<MaterialRecord | undefined>;
  listMaterials: () => Promise<MaterialSummary[]>;
}
