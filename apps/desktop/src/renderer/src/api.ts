import type { MaterialRecord, MaterialSummary, OpenUrlResult, ReadApi } from "../../shared/contracts";
import sample from "./dev/sample-material.json";
import samplePdf from "./dev/sample-pdf.json";

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

const browserPreview: ReadApi = {
  version: "preview",
  platform: "browser",
  // The preview paints its own ground (see styles.css), so there is no native appearance to sync.
  setTheme: async () => undefined,
  openUrl: async () => unavailable,
  openFile: async () => unavailable,
  getMaterial: async (id) => samples.find((material) => material.id === id),
  getMaterialBytes: async (id) => {
    if (id !== samplePdfMaterial.id) return undefined;
    const response = await fetch("/dev/sample.pdf");
    if (!response.ok) throw new Error(`Preview PDF missing: put any PDF at apps/desktop/src/renderer/public/dev/sample.pdf (HTTP ${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
  },
  listMaterials: async () => samples.map(summaryOf),
};

export const read: ReadApi = typeof window !== "undefined" && "read" in window && window.read ? window.read : browserPreview;
export const isPreview = read.platform === "browser";
