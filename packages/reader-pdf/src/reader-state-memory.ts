import { useCallback, useEffect, useMemo, useRef } from "react";
import { clampPdfSidebarWidth, DEFAULT_PDF_SIDEBAR_WIDTH } from "./pdf-reader-sidebar";

/**
 * The sidebar only shows page thumbnails now; the outline is reported to the
 * host as data. The field stays in the persisted state so older entries load.
 */
export type PdfReaderSidebarView = "pages";

export type PdfReaderState = Readonly<{
  fitWidth: boolean;
  page: number;
  /** The normalized vertical position inside the leading page. */
  pageOffset: number;
  rotation: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
  sidebarView: PdfReaderSidebarView;
  zoom: number;
}>;

export const MIN_PDF_ZOOM = 0.5;
export const MAX_PDF_ZOOM = 2.5;
const STORAGE_PREFIX = "research-workbench:pdf-reader:";
const SAVE_DELAY_MS = 280;

export const defaultPdfReaderState: PdfReaderState = {
  fitWidth: true,
  page: 1,
  pageOffset: 0,
  rotation: 0,
  sidebarOpen: true,
  sidebarWidth: DEFAULT_PDF_SIDEBAR_WIDTH,
  sidebarView: "pages",
  zoom: 1,
};

export function readerStateKey(identity: string) {
  return `${STORAGE_PREFIX}${identity}`;
}

export function validPdfSidebarView(_value: unknown): PdfReaderSidebarView {
  return "pages";
}

export function normalizedReaderRotation(value: unknown) {
  const rotation = Number(value);
  return Number.isSafeInteger(rotation) && rotation % 90 === 0
    ? ((rotation % 360) + 360) % 360
    : 0;
}

function clampedPage(value: unknown, pageCount: number | undefined) {
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1) return 1;
  return pageCount && pageCount > 0 ? Math.min(pageCount, page) : page;
}

/** Coerces any stored or partial value into a valid, clamped reader state. */
export function coerceReaderState(
  value: Partial<PdfReaderState> | undefined,
  pageCount?: number,
): PdfReaderState {
  if (!value) return defaultPdfReaderState;
  const pageOffset = Number(value.pageOffset);
  const zoom = Number(value.zoom);
  return {
    fitWidth: typeof value.fitWidth === "boolean" ? value.fitWidth : true,
    page: clampedPage(value.page, pageCount),
    pageOffset: Number.isFinite(pageOffset)
      ? Math.min(1, Math.max(0, pageOffset))
      : 0,
    rotation: normalizedReaderRotation(value.rotation),
    sidebarOpen:
      typeof value.sidebarOpen === "boolean" ? value.sidebarOpen : true,
    sidebarWidth: clampPdfSidebarWidth(value.sidebarWidth),
    sidebarView: validPdfSidebarView(value.sidebarView),
    zoom:
      Number.isFinite(zoom) && zoom >= MIN_PDF_ZOOM && zoom <= MAX_PDF_ZOOM
        ? zoom
        : 1,
  };
}

function storageArea(): Storage | undefined {
  // Storage can be missing or throw on access (sandboxed frames, disabled
  // cookies, private windows). Running without memory is a legitimate mode:
  // the reader still opens, it just starts from the defaults.
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export function loadReaderState(key: string, pageCount?: number): PdfReaderState {
  const storage = storageArea();
  if (!storage) return defaultPdfReaderState;
  let stored: string | null;
  try {
    stored = storage.getItem(key);
  } catch {
    // Same legitimate no-memory mode as above: reads may throw even when the
    // storage object exists.
    return defaultPdfReaderState;
  }
  if (!stored) return defaultPdfReaderState;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") return defaultPdfReaderState;
    return coerceReaderState(parsed as Partial<PdfReaderState>, pageCount);
  } catch {
    // A corrupt entry is stale data, not a failure of the reader; the caller
    // will overwrite it with the next remembered state.
    return defaultPdfReaderState;
  }
}

export function saveReaderState(key: string, state: PdfReaderState) {
  const storage = storageArea();
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(state));
  } catch {
    // Quota or access errors: reader-state persistence must never prevent
    // the PDF from being read. Nothing to recover here.
  }
}

export function pdfReadingProgress(
  position: Readonly<{ page: number; pageOffset: number }>,
  pageCount: number | undefined,
): number | undefined {
  if (!Number.isSafeInteger(pageCount) || !pageCount || pageCount < 1)
    return undefined;
  const page = Math.min(pageCount, Math.max(1, Math.trunc(position.page)));
  const pageOffset = Math.min(1, Math.max(0, position.pageOffset));
  return Math.min(1, Math.max(0, (page - 1 + pageOffset) / pageCount));
}

/**
 * Device-local memory of the reader state for one document identity. The
 * returned `initialState` feeds the viewer once; `remember` receives every
 * `onReaderStateChange` and writes it back after a short debounce, flushing
 * on unmount or when the identity changes.
 */
export function usePdfReaderStateMemory(identity: string, pageCount?: number) {
  const key = useMemo(() => readerStateKey(identity), [identity]);
  const initialState = useMemo(
    () => loadReaderState(key, pageCount),
    [key, pageCount],
  );
  const latestStateRef = useRef(initialState);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    latestStateRef.current = initialState;
    return () => {
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
      saveReaderState(key, latestStateRef.current);
    };
  }, [initialState, key]);

  const remember = useCallback(
    (state: PdfReaderState) => {
      latestStateRef.current = state;
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        saveReaderState(key, latestStateRef.current);
        timerRef.current = undefined;
      }, SAVE_DELAY_MS);
    },
    [key],
  );

  return { initialState, remember };
}
