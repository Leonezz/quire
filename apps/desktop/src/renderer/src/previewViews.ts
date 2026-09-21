import type { MaterialRecord, MaterialSummary, MaterialView, MaterialViewContent, MaterialViewId, OpenUrlResult, PdfInfo } from "../../shared/contracts";
import { contentOfRecord, viewOf } from "./materialViews";
import { PREVIEW_TEXT_VIEW_MEDIA_TYPE } from "./previewTextView";

// The views half of the browser preview: which `available` views were fetched (a PDF the dev server
// serves), which fetches failed and why, and which view was made primary — in localStorage, mirroring
// what the engine keeps next to the record. Everything the preview lists reads through `getMaterial` /
// `listMaterials` here so statuses, readyViews and the record's own content follow. The text view
// "builds" after a short pause into the hand-written reflow of previewTextView.ts.

const VIEWS_KEY = "read:preview-views";
const MEDIA_TYPES: Record<MaterialViewId, string> = { web: "text/html", pdf: "application/pdf", markdown: "text/markdown", text: PREVIEW_TEXT_VIEW_MEDIA_TYPE };
const TEXT_BUILD_MS = 800;

interface FetchedView { fetchedAt: string; byteLength: number; pdf?: PdfInfo }
interface StoredViews { fetched?: Partial<Record<MaterialViewId, FetchedView>>; failed?: Partial<Record<MaterialViewId, string>>; primary?: MaterialViewId }
type ViewsState = Record<string, StoredViews>;

function readState(): ViewsState {
  const raw = localStorage.getItem(VIEWS_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw) as ViewsState; }
  catch (error) { throw new Error(`Preview view state unreadable (${(error as Error).message}); clear localStorage key ${VIEWS_KEY}.`); }
}
function writeState(id: string, patch: (stored: StoredViews) => StoredViews) {
  const state = readState();
  localStorage.setItem(VIEWS_KEY, JSON.stringify({ ...state, [id]: patch(state[id] ?? {}) }));
}

/** Pages of a PDF by its page objects: a heuristic that reads the sample fine and is only a hint to pdf.js. */
export function countPdfPages(bytes: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(bytes);
  return (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

function overlayView(view: MaterialView, stored: StoredViews): MaterialView {
  const fetched = stored.fetched?.[view.id];
  if (fetched) {
    const { error: _error, ...rest } = view;
    return { ...rest, status: "ready", fetchedAt: fetched.fetchedAt, byteLength: fetched.byteLength, ...(fetched.pdf ? { pdf: fetched.pdf } : {}) };
  }
  const failed = stored.failed?.[view.id];
  return failed ? { ...view, status: "failed", error: failed } : view;
}

/** The hand-written text view of a material, when the preview has one for it. */
type TextViewOf = (base: MaterialRecord) => MaterialViewContent | undefined;

/** The content of one view of the base record: the record's own for its primary, the built reflow for text, the fetched PDF otherwise. */
function contentOf(base: MaterialRecord, view: MaterialViewId, stored: StoredViews, textViewOf: TextViewOf): MaterialViewContent | undefined {
  if (view === base.primaryView) return contentOfRecord(base);
  const fetched = stored.fetched?.[view];
  if (!fetched) return undefined;
  if (view === "text") return textViewOf(base);
  if (!fetched.pdf) return undefined;
  return { view, mediaType: MEDIA_TYPES.pdf, pdf: fetched.pdf, readingMinutes: base.readingMinutes, quality: base.quality, problems: [] };
}

/** A record or summary the preview stored before views existed (an old rebuilt artifact) lists none; it still reads. */
const legacyViews = (views: MaterialView[] | undefined): MaterialView[] => views ?? [];
const legacyReadyViews = (ids: MaterialViewId[] | undefined): MaterialViewId[] => ids ?? [];

function overlayRecord(base: MaterialRecord, stored: StoredViews, textViewOf: TextViewOf): MaterialRecord {
  const views = legacyViews(base.views).map((view) => overlayView(view, stored));
  const primaryView = stored.primary && viewOf(views, stored.primary)?.status === "ready" ? stored.primary : base.primaryView;
  const readyViews = views.filter((view) => view.status === "ready").map((view) => view.id);
  if (primaryView === base.primaryView) return { ...base, views, readyViews };
  const content = contentOf(base, primaryView, stored, textViewOf);
  if (!content) return { ...base, views, readyViews };
  const { pdf: _pdf, reader: _reader, markdown: _markdown, plain: _plain, ...rest } = base;
  const { view: _view, ...fields } = content;
  return { ...rest, ...fields, views, primaryView, readyViews };
}

function overlaySummary(summary: MaterialSummary, stored: StoredViews): MaterialSummary {
  const fetched = Object.keys(stored.fetched ?? {}) as MaterialViewId[];
  const readyViews = [...new Set([...legacyReadyViews(summary.readyViews), ...fetched])];
  const mediaType = stored.primary && readyViews.includes(stored.primary) ? MEDIA_TYPES[stored.primary] : summary.mediaType;
  return { ...summary, readyViews, mediaType };
}

export interface PreviewViews {
  getMaterial: (id: string) => Promise<MaterialRecord | undefined>;
  listMaterials: () => Promise<MaterialSummary[]>;
  fetchMaterialView: (id: string, view: MaterialViewId) => Promise<OpenUrlResult>;
  getMaterialView: (id: string, view: MaterialViewId) => Promise<MaterialViewContent | undefined>;
  /** Stores the choice; the caller reloads the record (with the metadata overlay) and notifies. */
  setPrimaryView: (id: string, view: MaterialViewId) => Promise<void>;
  getMaterialBytes: (id: string, view?: MaterialViewId) => Promise<Uint8Array | undefined>;
}

export function createPreviewViews(deps: {
  getMaterial: (id: string) => Promise<MaterialRecord | undefined>;
  listMaterials: () => Promise<MaterialSummary[]>;
  /** Where a PDF view's bytes are served in the preview; undefined when the preview cannot fetch that view. */
  pdfUrlOf: (materialId: string, view: MaterialView) => string | undefined;
  /** The text view the preview "builds" for a material; undefined when it has none to offer. */
  textViewOf: TextViewOf;
}): PreviewViews {
  const storedOf = (id: string) => readState()[id] ?? {};
  const getMaterial = async (id: string) => {
    const base = await deps.getMaterial(id);
    return base ? overlayRecord(base, storedOf(id), deps.textViewOf) : undefined;
  };
  const requireBase = async (id: string) => {
    const base = await deps.getMaterial(id);
    if (!base) throw new Error("This material is no longer in the library.");
    return base;
  };
  const fetchPdf = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Preview PDF missing: put any PDF at apps/desktop/src/renderer/public${url} (HTTP ${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
  };

  return {
    getMaterial,
    listMaterials: async () => { const state = readState(); return (await deps.listMaterials()).map((summary) => overlaySummary(summary, state[summary.id] ?? {})); },

    fetchMaterialView: async (id, viewId) => {
      const record = await getMaterial(id);
      if (!record) return { ok: false, code: "NOT_FOUND", message: "This material is no longer in the library." };
      const view = viewOf(record.views, viewId);
      if (!view) return { ok: false, code: "NO_SUCH_VIEW", message: `This material has no ${viewId} view.` };
      if (view.status === "ready") return { ok: false, code: "VIEW_ALREADY_STORED", message: `The ${view.label} view is already stored.` };
      if (viewId === "text") {
        const base = await requireBase(id);
        const built = deps.textViewOf(base);
        if (!built) {
          const message = "The browser preview has no reflow for this PDF; run the desktop app to build the Text view.";
          writeState(id, (stored) => ({ ...stored, failed: { ...stored.failed, text: message } }));
          return { ok: false, code: "PREVIEW_MODE", message };
        }
        await new Promise<void>((resolve) => { setTimeout(resolve, TEXT_BUILD_MS); });
        writeState(id, ({ failed, ...stored }) => {
          const { text: _cleared, ...otherFailures } = failed ?? {};
          return { ...stored, fetched: { ...stored.fetched, text: { fetchedAt: new Date().toISOString(), byteLength: JSON.stringify(built).length } }, ...(Object.keys(otherFailures).length ? { failed: otherFailures } : {}) };
        });
        const rebuilt = await getMaterial(id);
        return rebuilt ? { ok: true, material: rebuilt } : { ok: false, code: "NOT_FOUND", message: "This material is no longer in the library." };
      }
      const url = view.mediaType === MEDIA_TYPES.pdf ? deps.pdfUrlOf(id, view) : undefined;
      if (!url) {
        const message = `The engine is not available in the browser preview, so ${view.url} cannot be fetched here. Run the desktop app to fetch the ${view.label} view.`;
        writeState(id, (stored) => ({ ...stored, failed: { ...stored.failed, [viewId]: message } }));
        return { ok: false, code: "PREVIEW_MODE", message };
      }
      try {
        const bytes = await fetchPdf(url);
        const fetched: FetchedView = { fetchedAt: new Date().toISOString(), byteLength: bytes.byteLength, pdf: { pages: countPdfPages(bytes), byteLength: bytes.byteLength, textLayer: "available" } };
        writeState(id, ({ failed, ...stored }) => {
          const { [viewId]: _cleared, ...otherFailures } = failed ?? {};
          return { ...stored, fetched: { ...stored.fetched, [viewId]: fetched }, ...(Object.keys(otherFailures).length ? { failed: otherFailures } : {}) };
        });
      } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : "The fetch failed.";
        writeState(id, (stored) => ({ ...stored, failed: { ...stored.failed, [viewId]: message } }));
        return { ok: false, code: "FETCH_FAILED", message };
      }
      const updated = await getMaterial(id);
      return updated ? { ok: true, material: updated } : { ok: false, code: "NOT_FOUND", message: "This material is no longer in the library." };
    },

    getMaterialView: async (id, viewId) => {
      const base = await deps.getMaterial(id);
      return base ? contentOf(base, viewId, storedOf(id), deps.textViewOf) : undefined;
    },

    setPrimaryView: async (id, viewId) => {
      const record = await getMaterial(id);
      if (!record) throw new Error("This material is no longer in the library.");
      const view = viewOf(record.views, viewId);
      if (!view) throw new Error(`This material has no ${viewId} view.`);
      if (view.status !== "ready") throw new Error(`The ${view.label} view is not stored yet; fetch it first.`);
      writeState(id, (stored) => ({ ...stored, primary: viewId }));
    },

    getMaterialBytes: async (id, viewId) => {
      const base = await requireBase(id);
      const record = overlayRecord(base, storedOf(id), deps.textViewOf);
      const view = viewOf(record.views, viewId ?? record.primaryView);
      if (!view || view.mediaType !== MEDIA_TYPES.pdf || view.status !== "ready") return undefined;
      const url = deps.pdfUrlOf(id, view);
      return url ? fetchPdf(url) : undefined;
    },
  };
}
