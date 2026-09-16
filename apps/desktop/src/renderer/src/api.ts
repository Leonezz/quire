import type { MaterialRecord, MaterialSummary, OpenUrlResult, ReadApi } from "../../shared/contracts";
import sample from "./dev/sample-material.json";

// In Electron the preload bridge provides window.read. In a plain browser (Vite dev
// server, Storybook) there is no engine, so reading works against one sample material
// and every write reports itself unavailable — an explicit preview mode, not a fallback.
const sampleMaterial = sample as unknown as MaterialRecord;
const unavailable: OpenUrlResult = { ok: false, code: "PREVIEW_MODE", message: "The engine is not available in the browser preview. Run the desktop app to add material." };

const browserPreview: ReadApi = {
  version: "preview",
  platform: "browser",
  // The preview paints its own ground (see styles.css), so there is no native appearance to sync.
  setTheme: async () => undefined,
  openUrl: async () => unavailable,
  openFile: async () => unavailable,
  getMaterial: async (id) => (id === sampleMaterial.id ? sampleMaterial : undefined),
  listMaterials: async () => {
    const { id, url, title, byline, publishedAt, fetchedAt, readingMinutes, origin, quality } = sampleMaterial;
    const summary: MaterialSummary = { id, url, title, fetchedAt, readingMinutes, origin, quality, ...(byline ? { byline } : {}), ...(publishedAt ? { publishedAt } : {}) };
    return [summary];
  },
};

export const read: ReadApi = typeof window !== "undefined" && "read" in window && window.read ? window.read : browserPreview;
export const isPreview = read.platform === "browser";
