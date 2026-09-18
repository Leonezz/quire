import type { Annotation, MaterialRecord, MaterialSummary, OpenUrlResult, ReadApi } from "../../shared/contracts";
import sample from "./dev/sample-material.json";
import samplePdf from "./dev/sample-pdf.json";
import { createPreviewM1 } from "./previewM1";

// In Electron the preload bridge provides window.read. In a plain browser (Vite dev
// server, Storybook) there is no engine, so reading works against one sample material
// and every write reports itself unavailable — an explicit preview mode, not a fallback.
const sampleMaterial = sample as unknown as MaterialRecord;
// The PDF sample's bytes are served from public/dev/sample.pdf (not committed; any PDF placed there works).
const samplePdfMaterial = samplePdf as unknown as MaterialRecord;
const samples = [sampleMaterial, samplePdfMaterial];
function summaryOf({ id, url, title, byline, publishedAt, fetchedAt, readingMinutes, origin, mediaType, quality }: MaterialRecord): MaterialSummary {
  return { id, url, title, fetchedAt, readingMinutes, origin, mediaType, quality, ...(byline ? { byline } : {}), ...(publishedAt ? { publishedAt } : {}) };
}
const unavailable: OpenUrlResult = { ok: false, code: "PREVIEW_MODE", message: "The engine is not available in the browser preview. Run the desktop app to add material." };

// The evaluation corpus, when exported (EXPORT=1 in eval), is browsable in the preview too.
// A missing export is the normal state of a fresh checkout, so a 404 means "no corpus", nothing else.
async function corpusIndex(): Promise<MaterialSummary[]> {
  const response = await fetch("/dev/corpus/index.json");
  // The Vite dev server answers unknown paths with index.html (200), so the type is the real signal.
  if (response.status === 404 || !(response.headers.get("content-type") ?? "").includes("json")) return [];
  if (!response.ok) throw new Error(`Preview corpus index failed: HTTP ${response.status}`);
  return (await response.json()) as MaterialSummary[];
}

async function corpusMaterial(id: string): Promise<MaterialRecord | undefined> {
  if (!/^[a-f0-9]{16}$/.test(id)) return undefined;
  const response = await fetch(`/dev/corpus/${id}.json`);
  if (response.status === 404 || !(response.headers.get("content-type") ?? "").includes("json")) return undefined;
  if (!response.ok) throw new Error(`Preview corpus material failed: HTTP ${response.status}`);
  return (await response.json()) as MaterialRecord;
}

function previewAnnotations(materialId: string): Annotation[] {
  try { return JSON.parse(localStorage.getItem(`read:preview-annotations:${materialId}`) ?? "[]") as Annotation[]; }
  catch (error) { throw new Error(`Preview annotations unreadable: ${(error as Error).message}`); }
}
function writePreviewAnnotations(materialId: string, annotations: Annotation[]) {
  localStorage.setItem(`read:preview-annotations:${materialId}`, JSON.stringify(annotations));
}

const previewGetMaterial = async (id: string) => samples.find((material) => material.id === id) ?? (await corpusMaterial(id));
const previewListMaterials = async () => [...samples.map(summaryOf), ...(await corpusIndex())];

const browserPreview: ReadApi = {
  // Sources, Inbox, Queue, events and search: seeded into localStorage (see previewM1.ts).
  ...createPreviewM1({ getMaterial: previewGetMaterial, listMaterials: previewListMaterials }),
  version: "preview",
  platform: "browser",
  // The preview paints its own ground (see styles.css), so there is no native appearance to sync.
  setTheme: async () => undefined,
  onLibraryChanged: () => () => undefined,
  importCorpus: async () => { throw new Error("The evaluation corpus is imported by the desktop app (Developer menu); the browser preview lists it directly."); },
  openUrl: async () => unavailable,
  openFile: async () => unavailable,
  getMaterial: previewGetMaterial,
  // Preview annotations live in localStorage so the reading flow can be exercised without the engine.
  listAnnotations: async (materialId) => previewAnnotations(materialId),
  saveAnnotation: async (annotation) => {
    const now = new Date().toISOString();
    const existing = previewAnnotations(annotation.materialId);
    const previous = existing.find((item) => item.id === annotation.id);
    const saved = { ...annotation, createdAt: previous?.createdAt ?? now, updatedAt: now };
    writePreviewAnnotations(annotation.materialId, previous ? existing.map((item) => (item.id === saved.id ? saved : item)) : [...existing, saved]);
    return saved;
  },
  deleteAnnotation: async (materialId, id) => { writePreviewAnnotations(materialId, previewAnnotations(materialId).filter((item) => item.id !== id)); },
  // No engine in the preview: images stay placeholders (the page CSP blocks remote hosts anyway).
  resolveImage: async () => undefined,
  getMaterialBytes: async (id) => {
    if (id !== samplePdfMaterial.id) return undefined;
    const response = await fetch("/dev/sample.pdf");
    if (!response.ok) throw new Error(`Preview PDF missing: put any PDF at apps/desktop/src/renderer/public/dev/sample.pdf (HTTP ${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
  },
  listMaterials: previewListMaterials,
};

export const read: ReadApi = typeof window !== "undefined" && "read" in window && window.read ? window.read : browserPreview;
export const isPreview = read.platform === "browser";
