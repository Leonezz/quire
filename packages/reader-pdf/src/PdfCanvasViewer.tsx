import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Document, Page, pdfjs, type DocumentProps } from "react-pdf";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  MoveHorizontal,
  PanelLeft,
  RotateCw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import "./pdf-canvas-viewer.css";
import { readPdfOutline, type PdfOutlineEntry } from "./pdf-outline";
import { PdfNavigationThumbnail } from "./PdfNavigationThumbnail";
import type { PdfRegion } from "./pdf-region-locator";
import {
  clampPdfSidebarWidth,
  DEFAULT_PDF_SIDEBAR_WIDTH,
  maximumPdfSidebarWidth,
  MIN_PDF_SIDEBAR_WIDTH,
  pdfSidebarUsesOverlay,
  PDF_SIDEBAR_WIDTH_STEP,
} from "./pdf-reader-sidebar";
import {
  CROSS_PAGE_SELECTION_REASON,
  clampUnit,
  displayedPdfRect,
  enclosingRect,
  normalizedRectsForRange,
  normalizedRotation,
  normalizedSelection,
  pageElementForNode,
  pageFromPdfLocator,
  parsePdfRegionsLocator,
  scrollPageToOffset,
  type PdfSelection,
} from "./pdf-page-geometry";
import {
  searchPdfText,
  textRangeForOccurrence,
  type PdfSearchResult,
} from "./pdf-text-search";
import {
  nextPinchScale,
  PINCH_COMMIT_DELAY_MS,
  scrollPositionAfterZoom,
  type PinchGesture,
  type ScrollAnchor,
  type ScrollPosition,
} from "./pdf-zoom-gesture";
import {
  NO_ZOOM_SNAPSHOTS,
  PdfZoomSnapshotOverlay,
  releaseSnapshotBitmap,
  snapshotsForZoomCommit,
  snapshotsWithinWindow,
  withoutRenderedSnapshot,
  type PdfZoomSnapshots,
} from "./pdf-zoom-snapshot";
import {
  MAX_PDF_ZOOM,
  MIN_PDF_ZOOM,
  normalizedReaderRotation,
  validPdfSidebarView,
  type PdfReaderSidebarView,
  type PdfReaderState,
} from "./reader-state-memory";

// Keep the worker configuration beside the components that use it. React-PDF
// can otherwise reset the worker source depending on module evaluation order.
// The `?url` import makes Vite serve the worker as a same-origin asset in dev
// and in the build alike (a bare specifier inside `new URL()` only resolves in the build).
if (typeof window !== "undefined" && pdfjs.GlobalWorkerOptions) {
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

const ZOOM_STEP = 0.1;
const DEFAULT_PAGE_WIDTH = 720;
const DEFAULT_PAGE_ASPECT_RATIO = 1.4142;
const PAGE_RENDER_RADIUS = 2;
const THUMBNAIL_RENDER_RADIUS = 4;
const SEARCH_DEBOUNCE_MS = 140;
const NAVIGATION_HISTORY_LIMIT = 20;
const COMPACT_VIEWPORT_QUERY = "(max-width: 760px)";

export type PdfCanvasViewerHandle = Readonly<{
  /** Reveals a `pdf-page:v1:N`, `pdf-region:v1:…` or `pdf-regions:v1:…` locator. */
  goToLocator: (locator: string) => void;
  goToPage: (page: number) => void;
  /** Reads the current browser selection as a one-page normalized selection. */
  readSelection: () => PdfSelection | undefined;
}>;

// The sidebar shows page thumbnails only; the host renders the outline from
// `onOutlineChange`. The view id stays in the persisted state for compatibility.
const PDF_SIDEBAR_VIEW: PdfReaderSidebarView = "pages";
const SIDEBAR_HEADING_ID = "pdf-navigation-sidebar-heading";

export type PdfTextLayerStatus = "absent" | "available" | "unknown" | boolean;

/** A host annotation drawn over the page its locator points at. */
export type PdfRegionOverlay = Readonly<{
  id: string;
  /** A `pdf-region:v1:…` or `pdf-regions:v1:…` locator in canonical page space. */
  locator: string;
  /** Any CSS colour; tinted for highlight/comment, drawn as a rule for underline. */
  color: string;
  kind?: "highlight" | "underline" | "comment";
}>;

type PdfRegionOverlayKind = NonNullable<PdfRegionOverlay["kind"]>;

/** One drawable rectangle of an overlay, keyed to the page it belongs to. */
type ResolvedRegionOverlay = Readonly<{
  color: string;
  id: string;
  kind: PdfRegionOverlayKind;
  region: PdfRegion;
}>;

const NO_REGION_OVERLAYS: readonly PdfRegionOverlay[] = [];

export type PdfCanvasViewerProps = Readonly<{
  /** The overlay whose boxes get an emphasized outline. */
  activeRegionId?: string;
  /** A page to reveal after the PDF has loaded. */
  initialPage?: number;
  /** Reader state restored once for this exact representation. */
  initialState?: Partial<PdfReaderState>;
  /**
   * Reports the document outline flattened depth-first with 1-based pages,
   * once per loaded document. An empty list means there is no usable outline.
   */
  onOutlineChange?: (entries: readonly PdfOutlineEntry[]) => void;
  /** Called when the leading visible page changes. */
  onPageChange?: (page: number) => void;
  /** Emits the full resumable reader state. */
  onReaderStateChange?: (state: PdfReaderState) => void;
  /** Called with the overlay id when one of its boxes is clicked. */
  onRegionActivate?: (id: string) => void;
  /** A hint used before PDF.js has read the document metadata. */
  pageCount?: number;
  /** Host annotations to draw on their pages; see `PdfRegionOverlay`. */
  regions?: readonly PdfRegionOverlay[];
  /** A short label for the toolbar and accessible document name. */
  title?: string;
  /** A URL, data URL, or host protocol URL accepted by PDF.js. */
  url: string;
  /** Whether the source has a selectable text layer. */
  textLayer?: PdfTextLayerStatus;
}>;

type PendingNavigation = Readonly<{
  locator?: string;
  page: number;
  pageOffset: number;
  regionY?: number;
}>;

type PdfNavigationHistoryEntry = Readonly<{
  page: number;
  pageOffset: number;
}>;

type PdfDocumentLike = Parameters<
  NonNullable<DocumentProps["onLoadSuccess"]>
>[0];

type SearchStatus = "error" | "idle" | "ready" | "searching" | "unavailable";

function clampPage(page: number, pageCount: number) {
  if (!Number.isSafeInteger(page)) return 1;
  if (!pageCount) return Math.max(1, page);
  return Math.min(pageCount, Math.max(1, page));
}

function clampZoom(value: number) {
  return Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, Number(value.toFixed(2))));
}

/** The CSS width every page is laid out at for this container and zoom. */
function pageWidthFor(containerWidth: number, fitWidth: boolean, zoom: number) {
  const available = containerWidth || DEFAULT_PAGE_WIDTH;
  const fitWidthValue = Math.max(1, Math.floor(available));
  return Math.round(fitWidth ? fitWidthValue : fitWidthValue * zoom);
}

function readerStateFromProps(
  initialPage: number,
  pageCount: number,
  initialState: Partial<PdfReaderState> | undefined,
  defaultSidebarOpen = true,
): PdfReaderState {
  return {
    fitWidth: initialState?.fitWidth ?? true,
    page: clampPage(initialState?.page ?? initialPage, pageCount),
    pageOffset: clampUnit(initialState?.pageOffset ?? 0),
    rotation: normalizedReaderRotation(initialState?.rotation),
    sidebarOpen: initialState?.sidebarOpen ?? defaultSidebarOpen,
    sidebarWidth: clampPdfSidebarWidth(initialState?.sidebarWidth),
    sidebarView: validPdfSidebarView(initialState?.sidebarView),
    zoom: clampZoom(initialState?.zoom ?? 1),
  };
}

function compactPdfViewport() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return false;
  return window.matchMedia(COMPACT_VIEWPORT_QUERY).matches;
}

function defaultSidebarOpenForViewport() {
  return !compactPdfViewport();
}

/**
 * Expands overlays into per-rectangle entries. The locator format is
 * versioned and owned by the host, so a locator this reader cannot parse is
 * left out rather than reported: the host knows which versions it wrote.
 */
function resolvedRegionOverlays(
  overlays: readonly PdfRegionOverlay[],
): readonly ResolvedRegionOverlay[] {
  return overlays.flatMap((overlay) =>
    parsePdfRegionsLocator(overlay.locator).map((region) => ({
      color: overlay.color,
      id: overlay.id,
      kind: overlay.kind ?? "highlight",
      region,
    })),
  );
}

/** A page-relative percentage that stays readable in inline styles. */
function pagePercent(value: number) {
  return `${Number((value * 100).toFixed(4))}%`;
}

function textLayerIsEnabled(value: PdfTextLayerStatus | undefined) {
  return value !== false && value !== "absent";
}

function textLayerNotice(value: PdfTextLayerStatus | undefined) {
  if (value === false || value === "absent") {
    return "Scanned PDF · no selectable text layer. Page navigation is still available.";
  }
  if (value === "unknown") return "Text layer availability is being checked.";
  return undefined;
}

function searchStatusLabel(
  status: SearchStatus,
  textLayerEnabled: boolean,
  query: string,
  resultIndex: number,
  resultCount: number,
) {
  if (!textLayerEnabled || status === "unavailable")
    return "No searchable text layer";
  if (status === "searching") return "Searching…";
  if (status === "error") return "Search could not be completed";
  if (!query.trim()) return "Type to search";
  return resultCount ? `${resultIndex + 1} / ${resultCount}` : "No matches";
}

const FOCUSABLE_IN_DRAWER =
  'button:not([disabled]):not([tabindex="-1"]), a[href]:not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

export const PdfCanvasViewer = forwardRef<
  PdfCanvasViewerHandle,
  PdfCanvasViewerProps
>(function PdfCanvasViewer(
  {
    activeRegionId,
    initialPage = 1,
    initialState,
    onOutlineChange,
    onPageChange,
    onReaderStateChange,
    onRegionActivate,
    pageCount: pageCountHint = 0,
    regions = NO_REGION_OVERLAYS,
    textLayer,
    title = "PDF document",
    url,
  },
  ref,
) {
  const regionOverlays = useMemo(() => resolvedRegionOverlays(regions), [regions]);
  const startingStateRef = useRef(
    readerStateFromProps(
      initialPage,
      pageCountHint,
      initialState,
      defaultSidebarOpenForViewport(),
    ),
  );
  const startingState = startingStateRef.current;
  const [pdf, setPdf] = useState<PdfDocumentLike>();
  const [loadedPageCount, setLoadedPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(startingState.page);
  const [pageNumberDraft, setPageNumberDraft] = useState<string>();
  const [pageOffset, setPageOffset] = useState(startingState.pageOffset);
  const [sidebarOpen, setSidebarOpen] = useState(startingState.sidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(startingState.sidebarWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [compactViewport, setCompactViewport] = useState(compactPdfViewport);
  const [compactSidebarOpen, setCompactSidebarOpen] = useState(false);
  const [zoom, setZoom] = useState(startingState.zoom);
  const [fitWidth, setFitWidth] = useState(startingState.fitWidth);
  const [rotation, setRotation] = useState(startingState.rotation);
  const [containerWidth, setContainerWidth] = useState(0);
  const [readerBodyWidth, setReaderBodyWidth] = useState(0);
  const [textLayerError, setTextLayerError] = useState(false);
  const [progress, setProgress] = useState<number>();
  // React-PDF starts loading during the first render; a blob: document can report
  // progress before this component has committed, and setting state then is an error.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [loadError, setLoadError] = useState<string>();
  const [pageAspectRatios, setPageAspectRatios] = useState<
    Readonly<Record<number, number>>
  >({});
  const [pageNativeRotations, setPageNativeRotations] = useState<
    Readonly<Record<number, number>>
  >({});
  const [visibleThumbnailPages, setVisibleThumbnailPages] = useState<
    ReadonlySet<number>
  >(
    () =>
      new Set(
        Array.from(
          { length: THUMBNAIL_RENDER_RADIUS * 2 + 1 },
          (_, index) => startingState.page - THUMBNAIL_RENDER_RADIUS + index,
        ).filter((page) => page > 0),
      ),
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    readonly PdfSearchResult[]
  >([]);
  const [searchResultIndex, setSearchResultIndex] = useState(0);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const [activeSearchRegions, setActiveSearchRegions] = useState<
    readonly PdfRegion[]
  >([]);
  const [navigationHistory, setNavigationHistory] = useState<
    readonly PdfNavigationHistoryEntry[]
  >([]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef(new Map<number, HTMLElement>());
  const pendingNavigationRef = useRef<PendingNavigation | undefined>(undefined);
  const lastReportedPageRef = useRef(currentPage);
  const sourceUrlRef = useRef(url);
  const sourceInitialStateRef = useRef(startingState);
  const thumbnailRefs = useRef(new Map<number, HTMLDivElement>());
  const thumbnailScrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchRequestRef = useRef(0);
  const searchTextCacheRef = useRef(new Map<number, string>());
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const readerBodyRef = useRef<HTMLDivElement | null>(null);
  const readerBodyWidthRef = useRef(0);
  const compactViewportRef = useRef(compactPdfViewport());
  const sidebarToggleRef = useRef<HTMLButtonElement | null>(null);
  const sidebarResizeRef = useRef<
    | Readonly<{
        pointerId: number;
        startWidth: number;
        startX: number;
      }>
    | undefined
  >(undefined);
  const readerPositionRef = useRef<PdfNavigationHistoryEntry>({
    page: startingState.page,
    pageOffset: startingState.pageOffset,
  });
  const zoomRef = useRef(startingState.zoom);
  const fitWidthRef = useRef(startingState.fitWidth);
  const containerWidthRef = useRef(0);
  // A pinch only CSS-scales the pages container; `pinchGesture` is the rendered
  // snapshot of `pinchGestureRef`, updated at most once per animation frame.
  const [pinchGesture, setPinchGesture] = useState<PinchGesture>();
  const pinchGestureRef = useRef<PinchGesture | undefined>(undefined);
  const pinchFrameRef = useRef<number | undefined>(undefined);
  const pinchTimerRef = useRef<number | undefined>(undefined);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  // Scroll offsets to apply once the pages have re-laid out at a committed zoom.
  const pendingScrollRef = useRef<ScrollPosition | undefined>(undefined);
  // Copies of the page bitmaps taken right before a zoom commit; each covers
  // its page until pdf.js has rendered that page at the committed zoom.
  const [zoomSnapshots, setZoomSnapshots] =
    useState<PdfZoomSnapshots>(NO_ZOOM_SNAPSHOTS);
  const shownZoomSnapshotsRef = useRef<PdfZoomSnapshots>(NO_ZOOM_SNAPSHOTS);
  const onOutlineChangeRef = useRef(onOutlineChange);

  const knownPageCount = loadedPageCount || Math.max(0, pageCountHint);
  const renderedPageCount = pdf?.numPages ?? 0;
  const sidebarUsesOverlay =
    compactViewport || pdfSidebarUsesOverlay(readerBodyWidth);
  const visibleSidebarOpen = sidebarUsesOverlay
    ? compactSidebarOpen
    : sidebarOpen;
  const sidebarMaximum = maximumPdfSidebarWidth(readerBodyWidth);
  const renderedSidebarWidth = clampPdfSidebarWidth(
    sidebarWidth,
    sidebarMaximum,
  );
  const textLayerEnabled = textLayerIsEnabled(textLayer);
  const notice = textLayerNotice(textLayer);
  const activeSearchResult = searchResults[searchResultIndex];
  const activeSearchPage = activeSearchResult?.page;

  // Full pages render in a window around the current page (plus the active
  // search hit); the other shells keep their size and show a placeholder.
  const pageIsRendered = useCallback(
    (page: number) =>
      Math.abs(page - currentPage) <= PAGE_RENDER_RADIUS ||
      activeSearchPage === page,
    [activeSearchPage, currentPage],
  );

  const displayRotationForPage = useCallback(
    (page: number) =>
      normalizedRotation((pageNativeRotations[page] ?? 0) + rotation),
    [pageNativeRotations, rotation],
  );

  const displayedBoundsForLocator = useCallback(
    (locator: string, page: number) => {
      const regions = parsePdfRegionsLocator(locator).filter(
        (region) => region.page === page,
      );
      if (!regions.length) return undefined;
      const displayRotation = displayRotationForPage(page);
      return enclosingRect(
        regions.map((region) => displayedPdfRect(region, displayRotation)),
      );
    },
    [displayRotationForPage],
  );

  const reportPosition = useCallback(
    (page: number, offset: number) => {
      const next = clampPage(page, loadedPageCount || pageCountHint);
      const nextOffset = clampUnit(offset);
      readerPositionRef.current = { page: next, pageOffset: nextOffset };
      setCurrentPage((previous) => (previous === next ? previous : next));
      setPageOffset((previous) =>
        Math.abs(previous - nextOffset) < 0.001 ? previous : nextOffset,
      );
    },
    [loadedPageCount, pageCountHint],
  );

  useEffect(() => {
    if (lastReportedPageRef.current === currentPage) return;
    lastReportedPageRef.current = currentPage;
    onPageChange?.(currentPage);
  }, [currentPage, onPageChange]);

  useEffect(() => {
    onReaderStateChange?.({
      fitWidth,
      page: currentPage,
      pageOffset,
      rotation,
      sidebarOpen,
      sidebarWidth,
      sidebarView: PDF_SIDEBAR_VIEW,
      zoom,
    });
  }, [
    currentPage,
    fitWidth,
    onReaderStateChange,
    pageOffset,
    rotation,
    sidebarOpen,
    sidebarWidth,
    zoom,
  ]);

  const performPendingNavigation = useCallback(() => {
    const pending = pendingNavigationRef.current;
    if (!pending) return false;
    const hasRegion = Boolean(
      pending.locator && parsePdfRegionsLocator(pending.locator).length,
    );
    // A region can only be placed once the page's intrinsic rotation is known.
    if (hasRegion && pageNativeRotations[pending.page] === undefined)
      return false;
    const pageElement = pageRefs.current.get(pending.page);
    const root = scrollRef.current;
    if (!root || !pageElement) return false;
    const displayedRegion = pending.locator
      ? displayedBoundsForLocator(pending.locator, pending.page)
      : undefined;
    const targetOffset = displayedRegion?.y ?? pending.pageOffset;
    const regionY = displayedRegion?.y ?? pending.regionY;
    scrollPageToOffset(root, pageElement, targetOffset, "auto", regionY);
    pendingNavigationRef.current = undefined;
    reportPosition(pending.page, regionY ?? targetOffset);
    return true;
  }, [displayedBoundsForLocator, pageNativeRotations, reportPosition]);

  const rememberNavigationOrigin = useCallback(
    (target?: PdfNavigationHistoryEntry) => {
      const origin = readerPositionRef.current;
      if (
        target &&
        origin.page === target.page &&
        Math.abs(origin.pageOffset - target.pageOffset) < 0.001
      )
        return;
      setNavigationHistory((history) => [
        ...history.slice(-(NAVIGATION_HISTORY_LIMIT - 1)),
        { ...origin },
      ]);
    },
    [],
  );

  const closeOverlaySidebarAfterNavigation = useCallback(() => {
    if (!sidebarUsesOverlay) return;
    const focusWasInSidebar = Boolean(
      sidebarRef.current?.contains(
        sidebarRef.current.ownerDocument.activeElement,
      ),
    );
    setCompactSidebarOpen(false);
    if (focusWasInSidebar)
      window.setTimeout(() => scrollRef.current?.focus(), 0);
  }, [sidebarUsesOverlay]);

  const goToPage = useCallback(
    (requestedPage: number) => {
      const next = clampPage(requestedPage, loadedPageCount || pageCountHint);
      rememberNavigationOrigin({ page: next, pageOffset: 0 });
      pendingNavigationRef.current = { page: next, pageOffset: 0 };
      reportPosition(next, 0);
      performPendingNavigation();
      closeOverlaySidebarAfterNavigation();
    },
    [
      closeOverlaySidebarAfterNavigation,
      loadedPageCount,
      pageCountHint,
      performPendingNavigation,
      rememberNavigationOrigin,
      reportPosition,
    ],
  );

  const commitPageNumber = () => {
    if (pageNumberDraft === undefined) return;
    const requestedPage = Number(pageNumberDraft);
    setPageNumberDraft(undefined);
    if (Number.isSafeInteger(requestedPage) && requestedPage > 0)
      goToPage(requestedPage);
  };

  const goToLocator = useCallback(
    (locator: string) => {
      const page = pageFromPdfLocator(locator);
      if (!page) return;
      rememberNavigationOrigin();
      pendingNavigationRef.current = { locator, page, pageOffset: 0 };
      reportPosition(page, 0);
      performPendingNavigation();
    },
    [performPendingNavigation, rememberNavigationOrigin, reportPosition],
  );

  const returnToPreviousReadingPosition = useCallback(() => {
    const previous = navigationHistory.at(-1);
    if (!previous) return;
    setNavigationHistory((history) => history.slice(0, -1));
    pendingNavigationRef.current = {
      page: previous.page,
      pageOffset: previous.pageOffset,
    };
    reportPosition(previous.page, previous.pageOffset);
    performPendingNavigation();
    scrollRef.current?.focus({ preventScroll: true });
  }, [navigationHistory, performPendingNavigation, reportPosition]);

  const readSelection = useCallback<
    PdfCanvasViewerHandle["readSelection"]
  >(() => {
    const selection = globalThis.getSelection?.();
    if (!selection || selection.isCollapsed || !selection.rangeCount)
      return undefined;
    const range = selection.getRangeAt(0);
    const startPage = pageElementForNode(range.startContainer);
    const endPage = pageElementForNode(range.endContainer);
    if (!startPage || !endPage) return undefined;
    if (startPage !== endPage) {
      return { kind: "blocked", reason: CROSS_PAGE_SELECTION_REASON };
    }
    const page = Number(startPage.dataset.pdfPageNumber);
    if (!Number.isSafeInteger(page) || page < 1) return undefined;
    return normalizedSelection(
      selection,
      startPage,
      displayRotationForPage(page),
    );
  }, [displayRotationForPage]);

  useImperativeHandle(
    ref,
    () => ({ goToLocator, goToPage, readSelection }),
    [goToLocator, goToPage, readSelection],
  );

  const focusToggleBeforeSidebarModeChange = useCallback(() => {
    const sidebar = sidebarRef.current;
    if (sidebar?.contains(sidebar.ownerDocument.activeElement))
      sidebarToggleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(COMPACT_VIEWPORT_QUERY);
    const update = () => {
      const nextCompactViewport = query.matches;
      const containerUsesOverlay = pdfSidebarUsesOverlay(
        readerBodyWidthRef.current,
      );
      const previousUsesOverlay =
        compactViewportRef.current || containerUsesOverlay;
      const nextUsesOverlay = nextCompactViewport || containerUsesOverlay;
      if (previousUsesOverlay !== nextUsesOverlay)
        focusToggleBeforeSidebarModeChange();
      compactViewportRef.current = nextCompactViewport;
      setCompactViewport(nextCompactViewport);
      if (!nextUsesOverlay) setCompactSidebarOpen(false);
    };
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, [focusToggleBeforeSidebarModeChange]);

  useEffect(() => {
    if (!sidebarUsesOverlay || !compactSidebarOpen) return;
    const focusTimer = window.setTimeout(() => {
      thumbnailScrollRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [compactSidebarOpen, sidebarUsesOverlay]);

  useEffect(() => {
    if (!sidebarUsesOverlay) setCompactSidebarOpen(false);
  }, [sidebarUsesOverlay]);

  useEffect(() => {
    if (sourceUrlRef.current === url) return;
    const nextState = readerStateFromProps(
      initialPage,
      pageCountHint,
      initialState,
      defaultSidebarOpenForViewport(),
    );
    sourceUrlRef.current = url;
    sourceInitialStateRef.current = nextState;
    setPdf(undefined);
    setLoadedPageCount(0);
    setCurrentPage(nextState.page);
    setPageNumberDraft(undefined);
    setPageOffset(nextState.pageOffset);
    setSidebarOpen(nextState.sidebarOpen);
    setSidebarWidth(nextState.sidebarWidth);
    setCompactSidebarOpen(false);
    zoomRef.current = nextState.zoom;
    fitWidthRef.current = nextState.fitWidth;
    setZoom(nextState.zoom);
    setFitWidth(nextState.fitWidth);
    setRotation(nextState.rotation);
    setTextLayerError(false);
    setProgress(undefined);
    setLoadError(undefined);
    searchRequestRef.current += 1;
    setSearchQuery("");
    setSearchResults([]);
    setActiveSearchRegions([]);
    setSearchStatus("idle");
    setNavigationHistory([]);
    searchTextCacheRef.current.clear();
    setPageAspectRatios({});
    setPageNativeRotations({});
    setZoomSnapshots(NO_ZOOM_SNAPSHOTS);
    pageRefs.current.clear();
    pendingNavigationRef.current = {
      page: nextState.page,
      pageOffset: nextState.pageOffset,
    };
    readerPositionRef.current = {
      page: nextState.page,
      pageOffset: nextState.pageOffset,
    };
  }, [initialPage, initialState, pageCountHint, url]);

  useEffect(() => {
    if (visibleSidebarOpen && !sidebarUsesOverlay) return;
    sidebarResizeRef.current = undefined;
    setSidebarResizing(false);
  }, [sidebarUsesOverlay, visibleSidebarOpen]);

  const startSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (
        event.button !== 0 ||
        !event.isPrimary ||
        sidebarUsesOverlay ||
        !visibleSidebarOpen
      )
        return;
      event.preventDefault();
      sidebarResizeRef.current = {
        pointerId: event.pointerId,
        startWidth: renderedSidebarWidth,
        startX: event.clientX,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setSidebarResizing(true);
    },
    [renderedSidebarWidth, sidebarUsesOverlay, visibleSidebarOpen],
  );

  const moveSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resize = sidebarResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      setSidebarWidth(
        clampPdfSidebarWidth(
          resize.startWidth + event.clientX - resize.startX,
          sidebarMaximum,
        ),
      );
    },
    [sidebarMaximum],
  );

  const finishSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resize = sidebarResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      sidebarResizeRef.current = undefined;
      setSidebarResizing(false);
    },
    [],
  );

  const handleSidebarResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      let nextWidth: number | undefined;
      if (event.key === "Home") nextWidth = MIN_PDF_SIDEBAR_WIDTH;
      if (event.key === "End") nextWidth = sidebarMaximum;
      if (event.key === "ArrowLeft") {
        nextWidth = renderedSidebarWidth -
          PDF_SIDEBAR_WIDTH_STEP * (event.shiftKey ? 2 : 1);
      }
      if (event.key === "ArrowRight") {
        nextWidth = renderedSidebarWidth +
          PDF_SIDEBAR_WIDTH_STEP * (event.shiftKey ? 2 : 1);
      }
      if (nextWidth === undefined) return;
      event.preventDefault();
      setSidebarWidth(clampPdfSidebarWidth(nextWidth, sidebarMaximum));
    },
    [renderedSidebarWidth, sidebarMaximum],
  );

  useLayoutEffect(() => {
    const node = readerBodyRef.current;
    if (!node) return;
    const measure = () => {
      const nextWidth = node.clientWidth;
      const previousUsesOverlay =
        compactViewport || pdfSidebarUsesOverlay(readerBodyWidthRef.current);
      const nextUsesOverlay =
        compactViewport || pdfSidebarUsesOverlay(nextWidth);
      if (previousUsesOverlay !== nextUsesOverlay)
        focusToggleBeforeSidebarModeChange();
      readerBodyWidthRef.current = nextWidth;
      setReaderBodyWidth(nextWidth);
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [compactViewport, focusToggleBeforeSidebarModeChange, renderedPageCount]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const measure = () => {
      const style = window.getComputedStyle(node);
      const paddingLeft = Number.parseFloat(style.paddingLeft);
      const paddingRight = Number.parseFloat(style.paddingRight);
      const horizontalPadding =
        Number.isFinite(paddingLeft) && Number.isFinite(paddingRight)
          ? paddingLeft + paddingRight
          : 64;
      const nextWidth = Math.max(1, node.clientWidth - horizontalPadding);
      containerWidthRef.current = nextWidth;
      setContainerWidth(nextWidth);
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [renderedPageCount, visibleSidebarOpen]);

  useEffect(() => {
    if (!renderedPageCount) return;
    performPendingNavigation();
  }, [
    currentPage,
    containerWidth,
    performPendingNavigation,
    renderedPageCount,
    rotation,
    visibleSidebarOpen,
    zoom,
  ]);

  const visiblePageFromScroll = useCallback(() => {
    if (pendingNavigationRef.current) return;
    const root = scrollRef.current;
    if (!root || !pageRefs.current.size) return;
    const rootRect = root.getBoundingClientRect();
    const atDocumentEnd =
      root.scrollHeight > root.clientHeight &&
      root.scrollTop >= root.scrollHeight - root.clientHeight - 1;
    const viewportLead = atDocumentEnd
      ? rootRect.bottom - 24
      : rootRect.top + 24;
    let nearestPage: number | undefined;
    let nearestOffset = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let hasGeometry = false;
    for (const [page, pageElement] of pageRefs.current) {
      const rect = pageElement.getBoundingClientRect();
      hasGeometry ||= Boolean(
        rect.width || rect.height || rect.top || rect.left,
      );
      const distance =
        viewportLead < rect.top
          ? rect.top - viewportLead
          : viewportLead > rect.bottom
            ? viewportLead - rect.bottom
            : 0;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestPage = page;
        nearestOffset = rect.height
          ? clampUnit((viewportLead - rect.top) / rect.height)
          : 0;
      }
    }
    if (hasGeometry && nearestPage) reportPosition(nearestPage, nearestOffset);
  }, [reportPosition]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    root.addEventListener("scroll", visiblePageFromScroll, { passive: true });
    visiblePageFromScroll();
    return () => root.removeEventListener("scroll", visiblePageFromScroll);
  }, [
    renderedPageCount,
    visiblePageFromScroll,
    visibleSidebarOpen,
    containerWidth,
    rotation,
    zoom,
  ]);

  const pageWidth = useMemo(
    () => pageWidthFor(containerWidth, fitWidth, zoom),
    [containerWidth, fitWidth, zoom],
  );

  const assignPageRef = useCallback(
    (page: number, element: HTMLElement | null) => {
      if (element) pageRefs.current.set(page, element);
      else pageRefs.current.delete(page);
    },
    [],
  );

  const assignThumbnailRef = useCallback(
    (page: number, element: HTMLDivElement | null) => {
      if (element) thumbnailRefs.current.set(page, element);
      else thumbnailRefs.current.delete(page);
    },
    [],
  );

  useEffect(() => {
    if (!renderedPageCount || !visibleSidebarOpen) return;
    const nearCurrent = new Set<number>();
    for (
      let page = Math.max(1, currentPage - THUMBNAIL_RENDER_RADIUS);
      page <=
      Math.min(renderedPageCount, currentPage + THUMBNAIL_RENDER_RADIUS);
      page += 1
    )
      nearCurrent.add(page);
    setVisibleThumbnailPages(nearCurrent);
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleThumbnailPages((previous) => {
          const next = new Set(previous);
          for (const entry of entries) {
            const page = Number(
              (entry.target as HTMLElement).dataset.pdfThumbnailPage,
            );
            if (!Number.isSafeInteger(page)) continue;
            if (entry.isIntersecting) next.add(page);
            else if (!nearCurrent.has(page)) next.delete(page);
          }
          return next;
        });
      },
      { root: thumbnailScrollRef.current, rootMargin: "320px 0px" },
    );
    for (const element of thumbnailRefs.current.values())
      observer.observe(element);
    return () => observer.disconnect();
  }, [currentPage, renderedPageCount, visibleSidebarOpen]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchResults([]);
    setActiveSearchRegions([]);
    setSearchStatus("idle");
  }, []);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }, []);

  // Zooming re-lays out every page. The scroll offsets that keep the document
  // point under `anchor` (default: the viewport centre) in place are computed
  // arithmetically here and applied in a layout effect after the re-layout.
  // The refs let the wheel and keyboard handlers stay stable across renders.
  const commitZoom = useCallback(
    (next: number, nextFitWidth: boolean, anchor?: ScrollAnchor) => {
      const previous = zoomRef.current;
      if (next === previous && nextFitWidth === fitWidthRef.current) return;
      const root = scrollRef.current;
      if (root) {
        const pages = pagesRef.current;
        pendingScrollRef.current = scrollPositionAfterZoom(
          { left: root.scrollLeft, top: root.scrollTop },
          anchor ?? { x: root.clientWidth / 2, y: root.clientHeight / 2 },
          next / previous,
          pages?.offsetLeft ?? 0,
          pages?.offsetTop ?? 0,
        );
      }
      // The snapshots are taken now, synchronously, and committed in the same
      // render as the zoom: the overlays are in the DOM before the browser
      // paints the new layout, so the reader never sees the hidden canvases
      // react-pdf mounts while pdf.js redraws each page. A commit that leaves
      // the page width as it is re-renders nothing, so it needs no bridge.
      const containerWidth = containerWidthRef.current;
      const currentWidth = pageWidthFor(
        containerWidth,
        fitWidthRef.current,
        previous,
      );
      const nextWidth = pageWidthFor(containerWidth, nextFitWidth, next);
      if (nextWidth !== currentWidth) {
        setZoomSnapshots(
          snapshotsForZoomCommit(
            pageRefs.current,
            shownZoomSnapshotsRef.current,
            currentWidth,
            nextWidth,
          ),
        );
      }
      zoomRef.current = next;
      fitWidthRef.current = nextFitWidth;
      pinchGestureRef.current = undefined;
      setPinchGesture(undefined);
      setFitWidth(nextFitWidth);
      setZoom(next);
    },
    [],
  );

  const releaseZoomSnapshot = useCallback(
    (page: number, renderedWidth: number) => {
      setZoomSnapshots((current) =>
        withoutRenderedSnapshot(current, page, renderedWidth),
      );
    },
    [],
  );

  // A page scrolled out of the render window unmounts its <Page> and can no
  // longer report a render, so its snapshot is dropped with it.
  useEffect(() => {
    setZoomSnapshots((current) => snapshotsWithinWindow(current, pageIsRendered));
  }, [pageIsRendered]);

  // Bitmaps that left the map are released as soon as they are off screen;
  // the ref lets the next commit reuse a snapshot for a page still rendering.
  useEffect(() => {
    const shown = shownZoomSnapshotsRef.current;
    shownZoomSnapshotsRef.current = zoomSnapshots;
    for (const [page, snapshot] of shown) {
      if (zoomSnapshots.get(page) !== snapshot) releaseSnapshotBitmap(snapshot);
    }
  }, [zoomSnapshots]);

  useEffect(
    () => () => {
      for (const snapshot of shownZoomSnapshotsRef.current.values())
        releaseSnapshotBitmap(snapshot);
      shownZoomSnapshotsRef.current = NO_ZOOM_SNAPSHOTS;
    },
    [],
  );
  const zoomOut = useCallback(
    () => commitZoom(clampZoom(zoomRef.current - ZOOM_STEP), false),
    [commitZoom],
  );
  const zoomIn = useCallback(
    () => commitZoom(clampZoom(zoomRef.current + ZOOM_STEP), false),
    [commitZoom],
  );
  const fitToWidth = useCallback(() => commitZoom(1, true), [commitZoom]);

  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    const root = scrollRef.current;
    if (!pending || !root) return;
    pendingScrollRef.current = undefined;
    root.scrollLeft = pending.left;
    root.scrollTop = pending.top;
  }, [fitWidth, zoom]);

  useEffect(() => {
    const trapFocusInDrawer = (event: KeyboardEvent) => {
      const focusable = Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>(
          FOCUSABLE_IN_DRAWER,
        ) ?? [],
      ).filter((element) => !element.closest("[hidden], [inert]"));
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = sidebarRef.current?.ownerDocument.activeElement;
      if (!first || !last) return;
      if (!sidebarRef.current?.contains(active ?? null)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (sidebarUsesOverlay && compactSidebarOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setCompactSidebarOpen(false);
          sidebarToggleRef.current?.focus();
        } else if (event.key === "Tab") {
          trapFocusInDrawer(event);
        }
        return;
      }
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openSearch();
      } else if (modifier && (event.key === "=" || event.key === "+")) {
        event.preventDefault();
        zoomIn();
      } else if (modifier && event.key === "-") {
        event.preventDefault();
        zoomOut();
      } else if (modifier && event.key === "0") {
        event.preventDefault();
        fitToWidth();
      } else if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        closeSearch();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    closeSearch,
    compactSidebarOpen,
    fitToWidth,
    openSearch,
    searchOpen,
    sidebarUsesOverlay,
    zoomIn,
    zoomOut,
  ]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const cancelPinchScheduling = () => {
      if (pinchFrameRef.current !== undefined)
        window.cancelAnimationFrame(pinchFrameRef.current);
      if (pinchTimerRef.current !== undefined)
        window.clearTimeout(pinchTimerRef.current);
      pinchFrameRef.current = undefined;
      pinchTimerRef.current = undefined;
    };
    // The rendered transform follows the ref at most once per frame.
    const renderPinchFrame = () => {
      pinchFrameRef.current = undefined;
      setPinchGesture(pinchGestureRef.current);
    };
    // The gesture is over once no pinch event has arrived for a short while;
    // only then does the real zoom (and pdf.js re-render) happen, once.
    const commitPinch = () => {
      pinchTimerRef.current = undefined;
      const gesture = pinchGestureRef.current;
      if (!gesture) return;
      commitZoom(
        clampZoom(zoomRef.current * gesture.scale),
        false,
        gesture.anchor,
      );
    };
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rootRect = root.getBoundingClientRect();
      const anchor = {
        x: event.clientX - rootRect.left,
        y: event.clientY - rootRect.top,
      };
      const pages = pagesRef.current;
      const current = pinchGestureRef.current;
      pinchGestureRef.current = {
        anchor,
        // The origin is fixed at the gesture start: the transformed container's
        // geometry would otherwise feed back into itself on later events.
        originX:
          current?.originX ??
          anchor.x + root.scrollLeft - (pages?.offsetLeft ?? 0),
        originY:
          current?.originY ??
          anchor.y + root.scrollTop - (pages?.offsetTop ?? 0),
        scale: nextPinchScale(
          current?.scale ?? 1,
          event.deltaY,
          zoomRef.current,
          MIN_PDF_ZOOM,
          MAX_PDF_ZOOM,
        ),
      };
      pinchFrameRef.current ??= window.requestAnimationFrame(renderPinchFrame);
      if (pinchTimerRef.current !== undefined)
        window.clearTimeout(pinchTimerRef.current);
      pinchTimerRef.current = window.setTimeout(
        commitPinch,
        PINCH_COMMIT_DELAY_MS,
      );
    };
    root.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      root.removeEventListener("wheel", handleWheel);
      cancelPinchScheduling();
      pinchGestureRef.current = undefined;
    };
  }, [commitZoom, renderedPageCount]);

  useEffect(() => {
    const request = ++searchRequestRef.current;
    const query = searchQuery.trim();
    if (searchOpen && !textLayerEnabled) {
      setSearchResults([]);
      setActiveSearchRegions([]);
      setSearchResultIndex(0);
      setSearchStatus("unavailable");
      return;
    }
    if (!searchOpen || !query) {
      setSearchResults([]);
      setActiveSearchRegions([]);
      setSearchResultIndex(0);
      setSearchStatus("idle");
      return;
    }
    if (!pdf) return;
    setSearchStatus("searching");
    const isStale = () => request !== searchRequestRef.current;
    const timer = window.setTimeout(() => {
      searchPdfText(pdf, query, searchTextCacheRef.current, isStale)
        .then((outcome) => {
          if (!outcome || isStale()) return;
          setSearchResults(outcome.results);
          setSearchResultIndex(0);
          setSearchStatus(outcome.hasText ? "ready" : "unavailable");
          if (outcome.results[0]) goToPage(outcome.results[0].page);
        })
        .catch(() => {
          // The failure surfaces in the searchbar as an explicit error state.
          if (!isStale()) setSearchStatus("error");
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      if (request === searchRequestRef.current) searchRequestRef.current += 1;
    };
  }, [goToPage, pdf, searchOpen, searchQuery, textLayerEnabled]);

  const activateSearchResult = useCallback(
    (requestedIndex: number) => {
      if (!searchResults.length) return;
      const next =
        (requestedIndex + searchResults.length) % searchResults.length;
      setSearchResultIndex(next);
      goToPage(searchResults[next]!.page);
    },
    [goToPage, searchResults],
  );

  useEffect(() => {
    const result = activeSearchResult;
    const query = searchQuery.trim();
    if (!result || !query) {
      setActiveSearchRegions([]);
      return;
    }
    const pageElement = pageRefs.current.get(result.page);
    if (!pageElement) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    let observer: MutationObserver | undefined;
    const locate = () => {
      if (cancelled) return true;
      const textLayerElement = pageElement.querySelector<HTMLElement>(
        ".react-pdf__Page__textContent",
      );
      if (!textLayerElement?.textContent) return false;
      const range = textRangeForOccurrence(
        textLayerElement,
        query,
        result.occurrence,
      );
      if (!range) return false;
      const rects = normalizedRectsForRange(range, pageElement).map((rect) => ({
        page: result.page,
        ...rect,
      }));
      if (!rects.length) return false;
      setActiveSearchRegions(rects);
      pendingNavigationRef.current = {
        page: result.page,
        pageOffset: rects[0]!.y,
        regionY: rects[0]!.y,
      };
      performPendingNavigation();
      observer?.disconnect();
      return true;
    };
    const scheduleLocate = () => {
      window.requestAnimationFrame(() => {
        if (locate() || cancelled) return;
        retryTimer = window.setTimeout(locate, 80);
      });
    };
    scheduleLocate();
    if (typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(scheduleLocate);
      observer.observe(pageElement, { childList: true, subtree: true });
    }
    return () => {
      cancelled = true;
      observer?.disconnect();
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [activeSearchResult, pageWidth, performPendingNavigation, rotation, searchQuery]);

  const handleDocumentLoadSuccess = useCallback(
    (loadedPdf: PdfDocumentLike) => {
      const restored = sourceInitialStateRef.current;
      const targetPage = clampPage(restored.page, loadedPdf.numPages);
      setPdf(loadedPdf);
      setLoadedPageCount(loadedPdf.numPages);
      setLoadError(undefined);
      setProgress(100);
      setCurrentPage(targetPage);
      setPageOffset(restored.pageOffset);
      readerPositionRef.current = {
        page: targetPage,
        pageOffset: restored.pageOffset,
      };
      pendingNavigationRef.current = {
        page: targetPage,
        pageOffset: restored.pageOffset,
      };
    },
    [],
  );

  const handleDocumentError = useCallback((error: Error) => {
    setPdf(undefined);
    setLoadError(error.message || "The PDF could not be opened.");
  }, []);

  useEffect(() => {
    onOutlineChangeRef.current = onOutlineChange;
  }, [onOutlineChange]);

  useEffect(() => {
    if (!pdf) {
      onOutlineChangeRef.current?.([]);
      return;
    }
    let cancelled = false;
    readPdfOutline(pdf, () => cancelled)
      .then((entries) => {
        if (!cancelled) onOutlineChangeRef.current?.(entries);
      })
      .catch(() => {
        // A document whose outline cannot be read is still readable page by
        // page, so this is reported as "no outline" rather than as a document
        // error. An unusable document already surfaces through onLoadError.
        if (!cancelled) onOutlineChangeRef.current?.([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  const documentError = loadError ? (
    <div className="pdf-canvas-viewer__state" role="alert">
      <strong>Could not render this PDF</strong>
      <p>{loadError}</p>
      <p>Open the original source if the document remains unavailable.</p>
    </div>
  ) : undefined;

  const previousReadingPosition = navigationHistory.at(-1);

  return (
    <section aria-label={`PDF reader: ${title}`} className="pdf-canvas-viewer">
      <div
        aria-label="PDF reader toolbar"
        className="pdf-canvas-viewer__toolbar"
        role="toolbar"
        title={title}
      >
        <div className="pdf-canvas-viewer__toolbar-leading">
          {previousReadingPosition ? (
            <button
              aria-label={`Back to page ${previousReadingPosition.page}`}
              className="pdf-canvas-viewer__text-button pdf-canvas-viewer__mobile-tool-button pdf-canvas-viewer__navigation-back"
              onClick={returnToPreviousReadingPosition}
              title={`Back to page ${previousReadingPosition.page}`}
              type="button"
            >
              <span
                aria-hidden="true"
                className="pdf-canvas-viewer__responsive-icon"
              >
                <ArrowLeft />
              </span>
              <span className="pdf-canvas-viewer__responsive-label">
                Back · page {previousReadingPosition.page}
              </span>
            </button>
          ) : null}
          <button
            aria-controls="pdf-navigation-sidebar"
            aria-expanded={visibleSidebarOpen}
            aria-label={
              visibleSidebarOpen ? "Hide PDF sidebar" : "Show PDF sidebar"
            }
            className="pdf-canvas-viewer__icon-button"
            onClick={() => {
              if (sidebarUsesOverlay) {
                setCompactSidebarOpen(!visibleSidebarOpen);
                return;
              }
              setSidebarOpen(!visibleSidebarOpen);
            }}
            ref={sidebarToggleRef}
            title={visibleSidebarOpen ? "Hide sidebar" : "Show sidebar"}
            type="button"
          >
            <PanelLeft aria-hidden="true" />
          </button>
          <button
            aria-expanded={searchOpen}
            aria-label="Search PDF"
            className="pdf-canvas-viewer__icon-button"
            onClick={() => (searchOpen ? closeSearch() : openSearch())}
            title="Search PDF (⌘F)"
            type="button"
          >
            <Search aria-hidden="true" />
          </button>
        </div>

        <div className="pdf-canvas-viewer__toolbar-controls">
          <label className="pdf-canvas-viewer__page-control">
            <span className="pdf-canvas-viewer__sr-only">Current page</span>
            <input
              aria-label="Current page"
              className="pdf-canvas-viewer__page-input"
              inputMode="numeric"
              max={knownPageCount || undefined}
              min={1}
              onBlur={commitPageNumber}
              onChange={(event) => setPageNumberDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitPageNumber();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setPageNumberDraft(undefined);
                }
              }}
              type="number"
              value={pageNumberDraft ?? currentPage}
            />
            <span aria-label={`${knownPageCount || "unknown"} total pages`}>
              / {knownPageCount || "—"}
            </span>
          </label>
          <span
            className="pdf-canvas-viewer__toolbar-divider"
            aria-hidden="true"
          />
          <button
            aria-label="Zoom out"
            className="pdf-canvas-viewer__icon-button"
            disabled={zoom <= MIN_PDF_ZOOM}
            onClick={zoomOut}
            title="Zoom out"
            type="button"
          >
            <ZoomOut aria-hidden="true" />
          </button>
          <output
            aria-label="Zoom level"
            className="pdf-canvas-viewer__zoom-level"
          >
            {Math.round(zoom * (pinchGesture?.scale ?? 1) * 100)}%
          </output>
          <button
            aria-label="Zoom in"
            className="pdf-canvas-viewer__icon-button"
            disabled={zoom >= MAX_PDF_ZOOM}
            onClick={zoomIn}
            title="Zoom in"
            type="button"
          >
            <ZoomIn aria-hidden="true" />
          </button>
          <button
            aria-pressed={fitWidth}
            aria-label="Fit page width"
            className="pdf-canvas-viewer__text-button pdf-canvas-viewer__mobile-tool-button"
            onClick={fitToWidth}
            title="Fit page width"
            type="button"
          >
            <span aria-hidden="true" className="pdf-canvas-viewer__responsive-icon">
              <MoveHorizontal />
            </span>
            <span className="pdf-canvas-viewer__responsive-label">Fit width</span>
          </button>
          <button
            aria-label="Rotate clockwise"
            className="pdf-canvas-viewer__icon-button"
            onClick={() => setRotation((value) => (value + 90) % 360)}
            title="Rotate clockwise"
            type="button"
          >
            <RotateCw aria-hidden="true" />
          </button>
        </div>
      </div>

      {searchOpen ? (
        <form
          aria-label="Search this PDF"
          className="pdf-canvas-viewer__searchbar"
          onSubmit={(event) => {
            event.preventDefault();
            activateSearchResult(searchResultIndex + 1);
          }}
          role="search"
        >
          <label className="pdf-canvas-viewer__search-field">
            <span className="pdf-canvas-viewer__sr-only">Search text</span>
            <input
              aria-label="Search text"
              disabled={!textLayerEnabled}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={
                textLayerEnabled
                  ? "Find in document"
                  : "Text search unavailable"
              }
              ref={searchInputRef}
              type="search"
              value={searchQuery}
            />
          </label>
          <output
            aria-live="polite"
            className="pdf-canvas-viewer__search-count"
          >
            {searchStatusLabel(
              searchStatus,
              textLayerEnabled,
              searchQuery,
              searchResultIndex,
              searchResults.length,
            )}
          </output>
          <button
            aria-label="Previous search result"
            className="pdf-canvas-viewer__icon-button"
            disabled={!searchResults.length}
            onClick={() => activateSearchResult(searchResultIndex - 1)}
            type="button"
          >
            <ChevronUp aria-hidden="true" />
          </button>
          <button
            aria-label="Next search result"
            className="pdf-canvas-viewer__icon-button"
            disabled={!searchResults.length}
            onClick={() => activateSearchResult(searchResultIndex + 1)}
            type="button"
          >
            <ChevronDown aria-hidden="true" />
          </button>
          <button
            aria-label="Close PDF search"
            className="pdf-canvas-viewer__icon-button"
            onClick={closeSearch}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </form>
      ) : null}

      {notice || textLayerError ? (
        <div className="pdf-canvas-viewer__notice" role="status">
          {textLayerError
            ? "Some pages could not render a selectable text layer."
            : notice}
        </div>
      ) : null}

      <Document
        className="pdf-canvas-viewer__document"
        error={documentError}
        externalLinkRel="noopener noreferrer"
        externalLinkTarget="_blank"
        file={url}
        loading={
          <div className="pdf-canvas-viewer__state" role="status">
            <strong>Loading PDF</strong>
            <p>
              {progress === undefined
                ? "Preparing the reader…"
                : `${progress}% loaded`}
            </p>
          </div>
        }
        noData={
          <div className="pdf-canvas-viewer__state" role="alert">
            No PDF source was provided.
          </div>
        }
        onItemClick={({ pageNumber }) => goToPage(pageNumber)}
        onLoadError={handleDocumentError}
        onLoadProgress={({ loaded, total }) => {
          if (total > 0 && mountedRef.current)
            setProgress(Math.min(99, Math.round((loaded / total) * 100)));
        }}
        onLoadSuccess={handleDocumentLoadSuccess}
      >
        <div
          className={`pdf-canvas-viewer__body${visibleSidebarOpen ? "" : " is-sidebar-collapsed"}${sidebarUsesOverlay ? " is-sidebar-overlay" : ""}${sidebarResizing ? " is-sidebar-resizing" : ""}`}
          style={
            {
              "--pdf-reader-sidebar-width": `${renderedSidebarWidth}px`,
            } as CSSProperties
          }
          ref={readerBodyRef}
        >
          {sidebarUsesOverlay && visibleSidebarOpen ? (
            <button
              aria-label="Dismiss PDF navigation"
              className="pdf-canvas-viewer__sidebar-backdrop"
              onClick={() => {
                setCompactSidebarOpen(false);
                sidebarToggleRef.current?.focus();
              }}
              type="button"
            />
          ) : null}
          <div
            aria-modal={sidebarUsesOverlay ? true : undefined}
            aria-label="PDF navigation sidebar"
            className="pdf-canvas-viewer__sidebar"
            id="pdf-navigation-sidebar"
            ref={sidebarRef}
            role={sidebarUsesOverlay ? "dialog" : "complementary"}
          >
            <h2
              className="pdf-canvas-viewer__sidebar-heading"
              id={SIDEBAR_HEADING_ID}
            >
              Pages
            </h2>
            <div
              aria-labelledby={SIDEBAR_HEADING_ID}
              className="pdf-canvas-viewer__sidebar-scroll"
              ref={thumbnailScrollRef}
              role="group"
              tabIndex={0}
            >
              {renderedPageCount ? (
                Array.from({ length: renderedPageCount }, (_, index) => {
                  const page = index + 1;
                  return (
                    <PdfNavigationThumbnail
                      current={currentPage === page}
                      key={page}
                      onActivate={goToPage}
                      onElement={(element) => assignThumbnailRef(page, element)}
                      page={page}
                      visible={visibleThumbnailPages.has(page)}
                    />
                  );
                })
              ) : (
                <p className="pdf-canvas-viewer__sidebar-empty">
                  Thumbnails appear after the PDF loads.
                </p>
              )}
            </div>
          </div>

          {visibleSidebarOpen && !sidebarUsesOverlay ? (
            <div
              aria-label="Resize PDF navigation sidebar"
              aria-orientation="vertical"
              aria-valuemax={sidebarMaximum}
              aria-valuemin={MIN_PDF_SIDEBAR_WIDTH}
              aria-valuenow={renderedSidebarWidth}
              aria-valuetext={`${renderedSidebarWidth} pixels`}
              className="pdf-canvas-viewer__sidebar-resizer"
              onDoubleClick={() =>
                setSidebarWidth(DEFAULT_PDF_SIDEBAR_WIDTH)
              }
              onKeyDown={handleSidebarResizeKeyDown}
              onLostPointerCapture={finishSidebarResize}
              onPointerCancel={finishSidebarResize}
              onPointerDown={startSidebarResize}
              onPointerMove={moveSidebarResize}
              onPointerUp={finishSidebarResize}
              role="separator"
              tabIndex={0}
              title="Drag to resize PDF navigation; double-click to reset"
            />
          ) : null}

          <div
            aria-label="PDF pages"
            className="pdf-canvas-viewer__page-scroll"
            ref={scrollRef}
            role="region"
            tabIndex={0}
          >
            <div
              className="pdf-canvas-viewer__pages"
              ref={pagesRef}
              style={
                pinchGesture
                  ? {
                      transform: `scale(${pinchGesture.scale})`,
                      transformOrigin: `${pinchGesture.originX}px ${pinchGesture.originY}px`,
                      willChange: "transform",
                    }
                  : undefined
              }
            >
              {renderedPageCount ? (
                Array.from({ length: renderedPageCount }, (_, index) => {
                  const page = index + 1;
                  const shouldRenderPage = pageIsRendered(page);
                  const zoomSnapshot = shouldRenderPage
                    ? zoomSnapshots.get(page)
                    : undefined;
                  const baseAspectRatio =
                    pageAspectRatios[page] ?? DEFAULT_PAGE_ASPECT_RATIO;
                  const pageAspectRatio =
                    rotation === 90 || rotation === 270
                      ? 1 / baseAspectRatio
                      : baseAspectRatio;
                  const displayRotation = displayRotationForPage(page);
                  const searchRegions = activeSearchRegions.filter(
                    (region) => region.page === page,
                  );
                  const pageOverlays = regionOverlays.filter(
                    (overlay) => overlay.region.page === page,
                  );
                  return (
                    <article
                      aria-label={`PDF page ${page}`}
                      className={`pdf-canvas-viewer__page-shell${currentPage === page ? " is-current" : ""}${activeSearchResult?.page === page ? " has-active-search-result" : ""}`}
                      data-pdf-page-number={page}
                      key={page}
                      ref={(element) => assignPageRef(page, element)}
                      style={{
                        minHeight: Math.round(pageWidth * pageAspectRatio),
                        width: pageWidth,
                      }}
                    >
                      {shouldRenderPage ? (
                        <Page
                          onLoadSuccess={(loadedPage) => {
                            const nativeRotation = normalizedRotation(
                              loadedPage.rotate ?? 0,
                            );
                            const viewport = loadedPage.getViewport({
                              scale: 1,
                            });
                            if (!viewport.width || !viewport.height) return;
                            const ratio = viewport.height / viewport.width;
                            setPageAspectRatios((previous) =>
                              Math.abs(
                                (previous[page] ?? DEFAULT_PAGE_ASPECT_RATIO) -
                                  ratio,
                              ) < 0.001
                                ? previous
                                : { ...previous, [page]: ratio },
                            );
                            setPageNativeRotations((previous) =>
                              previous[page] === nativeRotation
                                ? previous
                                : { ...previous, [page]: nativeRotation },
                            );
                          }}
                          // react-pdf calls these from the render that mounted
                          // the canvas, so this `pageWidth` identifies which
                          // commit the render belongs to.
                          onRenderError={() =>
                            releaseZoomSnapshot(page, pageWidth)
                          }
                          onRenderSuccess={() =>
                            releaseZoomSnapshot(page, pageWidth)
                          }
                          pageNumber={page}
                          renderAnnotationLayer
                          renderTextLayer={textLayerEnabled}
                          rotate={displayRotation}
                          width={pageWidth}
                          onRenderTextLayerError={() => setTextLayerError(true)}
                        />
                      ) : (
                        <span className="pdf-canvas-viewer__page-placeholder">
                          Page {page}
                        </span>
                      )}
                      {zoomSnapshot ? (
                        <PdfZoomSnapshotOverlay snapshot={zoomSnapshot} />
                      ) : null}
                      {searchRegions.length ? (
                        <div
                          aria-hidden="true"
                          className="pdf-canvas-viewer__search-regions"
                        >
                          {searchRegions.map((region, regionIndex) => (
                            <span
                              className="pdf-canvas-viewer__search-region"
                              key={`${searchResultIndex}:${regionIndex}`}
                              style={{
                                height: `${region.height * 100}%`,
                                left: `${region.x * 100}%`,
                                top: `${region.y * 100}%`,
                                width: `${region.width * 100}%`,
                              }}
                            />
                          ))}
                        </div>
                      ) : null}
                      {pageOverlays.length ? (
                        <div className="pdf-canvas-viewer__annotation-regions">
                          {pageOverlays.map((overlay, overlayIndex) => {
                            const rect = displayedPdfRect(
                              overlay.region,
                              displayRotation,
                            );
                            const isActive = overlay.id === activeRegionId;
                            return (
                              <button
                                aria-current={isActive ? "true" : undefined}
                                aria-label={`${overlay.kind} annotation`}
                                className={`pdf-canvas-viewer__annotation-region is-${overlay.kind}${isActive ? " is-active" : ""}`}
                                data-annotation-id={overlay.id}
                                key={`${overlay.id}:${overlayIndex}`}
                                onClick={() => onRegionActivate?.(overlay.id)}
                                style={
                                  {
                                    "--pdf-annotation-color": overlay.color,
                                    height: pagePercent(rect.height),
                                    left: pagePercent(rect.x),
                                    top: pagePercent(rect.y),
                                    width: pagePercent(rect.width),
                                  } as CSSProperties
                                }
                                type="button"
                              />
                            );
                          })}
                        </div>
                      ) : null}
                      {activeSearchResult?.page === page ? (
                        <span
                          aria-live="polite"
                          className="pdf-canvas-viewer__search-page-marker"
                        >
                          Match {searchResultIndex + 1} of{" "}
                          {searchResults.length}
                        </span>
                      ) : null}
                    </article>
                  );
                })
              ) : (
                <div className="pdf-canvas-viewer__state" role="status">
                  <strong>Preparing pages</strong>
                  <p>
                    PDF.js will show the document here when the source is ready.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </Document>
    </section>
  );
});

PdfCanvasViewer.displayName = "PdfCanvasViewer";
