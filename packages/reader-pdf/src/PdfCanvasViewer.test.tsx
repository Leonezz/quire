import { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pdfMockState = vi.hoisted(() => ({
  deferredPageLoads: new Map<number, () => void>(),
  deferPageLoads: false,
  // Like react-pdf, the mocked page reports a render per width/rotation; a
  // deferred report stands in for pdf.js still drawing the page.
  deferredPageRenders: new Map<number, () => void>(),
  deferPageRenders: false,
  nativeRotations: {} as Record<number, number>,
  resolveDeferredSearch: undefined as
    | ((value: { items: readonly { str: string }[] }) => void)
    | undefined,
}));

type MockOutlineNode = {
  dest: string | readonly unknown[] | null;
  items: readonly MockOutlineNode[];
  title: string;
};

// Two levels; one string (named) destination, one explicit array destination,
// and one item whose named destination does not exist in the document.
const MOCK_OUTLINE: readonly MockOutlineNode[] = [
  {
    dest: "intro",
    items: [
      {
        dest: [{ gen: 0, num: 3 }, { name: "XYZ" }],
        items: [],
        title: "Background",
      },
    ],
    title: "Introduction",
  },
  { dest: "missing", items: [], title: "Dangling" },
];

vi.mock("react-pdf", () => ({
  Document: ({
    children,
    file,
    onItemClick,
    onLoadSuccess,
  }: {
    children: React.ReactNode;
    file?: string;
    onItemClick?: (input: {
      dest?: unknown;
      pageIndex: number;
      pageNumber: number;
    }) => void;
    onLoadSuccess?: (document: {
      getDestination: (id: string) => Promise<readonly unknown[] | null>;
      getOutline: () => Promise<readonly MockOutlineNode[] | null>;
      getPage: (page: number) => Promise<{
        getTextContent: () => Promise<{
          items: readonly { str: string }[];
        }>;
      }>;
      getPageIndex: (ref: unknown) => Promise<number>;
      numPages: number;
    }) => void;
  }) => {
    const called = useRef(false);
    const [ready, setReady] = useState(!file?.includes("deferred"));
    useEffect(() => {
      if (called.current) return;
      called.current = true;
      pdfMockState.nativeRotations = file?.includes("mixed-native-rotation")
        ? { 1: 90, 2: 270 }
        : {};
      pdfMockState.deferPageLoads = Boolean(file?.includes("late-page-load"));
      const numPages = file?.includes("large") ? 12 : 3;
      onLoadSuccess?.({
        getDestination: async (id) =>
          id === "intro" ? [{ gen: 0, num: 2 }, { name: "Fit" }] : null,
        getOutline: async () =>
          file?.includes("outline") ? MOCK_OUTLINE : null,
        getPageIndex: async (ref) => {
          const num = (ref as { num?: number }).num;
          if (num === undefined) throw new Error("Not a page reference");
          return num - 1;
        },
        getPage: async (page) => ({
          getTextContent: async () => {
            if (file?.includes("deferred-search")) {
              return await new Promise<{ items: readonly { str: string }[] }>(
                (resolve) => {
                  pdfMockState.resolveDeferredSearch = resolve;
                },
              );
            }
            return {
              items:
                page === 1
                  ? [{ str: "alpha beta alpha" }]
                  : page === 2
                    ? [{ str: "gamma alpha" }]
                    : [],
            };
          },
        }),
        numPages,
      });
      setReady(true);
    }, [file, onLoadSuccess]);
    return (
      <div className="react-pdf__Document">
        {ready && file?.includes("internal-link") ? (
          <button
            aria-label="Internal PDF link to page 3"
            onClick={() => onItemClick?.({ pageIndex: 2, pageNumber: 3 })}
            type="button"
          >
            Internal link
          </button>
        ) : null}
        {ready ? children : null}
      </div>
    );
  },
  Page: ({
    onLoadSuccess,
    onRenderSuccess,
    pageNumber,
    rotate,
    width,
  }: {
    onLoadSuccess?: (page: {
      rotate: number;
      getViewport: () => { height: number; width: number };
    }) => void;
    onRenderSuccess?: () => void;
    pageNumber: number;
    rotate?: number;
    width?: number;
  }) => {
    const nativeRotation = pdfMockState.nativeRotations[pageNumber] ?? 0;
    useEffect(() => {
      const reportLoaded = () => onLoadSuccess?.({
        getViewport: () => nativeRotation === 90 || nativeRotation === 270
          ? { height: 600, width: 800 }
          : { height: 800, width: 600 },
        rotate: nativeRotation,
      });
      if (pdfMockState.deferPageLoads) {
        pdfMockState.deferredPageLoads.set(pageNumber, reportLoaded);
        return () => {
          if (pdfMockState.deferredPageLoads.get(pageNumber) === reportLoaded)
            pdfMockState.deferredPageLoads.delete(pageNumber);
        };
      }
      reportLoaded();
    }, [nativeRotation, onLoadSuccess]);
    // The render report uses the callback from the render that started it,
    // exactly as react-pdf's canvas effect does, so it is left out of the deps.
    useEffect(() => {
      const reportRendered = () => onRenderSuccess?.();
      if (pdfMockState.deferPageRenders) {
        pdfMockState.deferredPageRenders.set(pageNumber, reportRendered);
        return () => {
          if (pdfMockState.deferredPageRenders.get(pageNumber) === reportRendered)
            pdfMockState.deferredPageRenders.delete(pageNumber);
        };
      }
      reportRendered();
    }, [pageNumber, rotate, width]);
    return (
      <div className="react-pdf__Page" data-render-rotation={rotate} data-render-width={width}>
        <canvas className="react-pdf__Page__canvas" height={3} width={2} />
        <div className="react-pdf__Page__textContent">
          {pageNumber === 1
            ? "alpha beta alpha"
            : pageNumber === 2
              ? "gamma alpha"
              : `Selectable page ${pageNumber}`}
        </div>
      </div>
    );
  },
  Thumbnail: ({
    onItemClick,
    pageNumber,
  }: {
    onItemClick?: (input: { pageIndex: number; pageNumber: number }) => void;
    pageNumber: number;
  }) => (
    <a
      className="react-pdf__Thumbnail"
      href="#"
      onClick={(event) => {
        event.preventDefault();
        onItemClick?.({ pageIndex: pageNumber - 1, pageNumber });
      }}
    >
      Thumbnail {pageNumber}
    </a>
  ),
  pdfjs: { GlobalWorkerOptions: {} },
}));

import { PdfCanvasViewer, type PdfCanvasViewerHandle } from "./PdfCanvasViewer";
import { canonicalPdfRect, displayedPdfRect } from "./pdf-page-geometry";
import { PINCH_COMMIT_DELAY_MS } from "./pdf-zoom-gesture";

// Pinch tests drive the per-frame transform and the settle timeout by hand.
function useFakeGestureTimers() {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const rangeGetClientRectsDescriptor = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getClientRects",
);

function renderViewer(
  props: Partial<React.ComponentProps<typeof PdfCanvasViewer>> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    root,
    render: (
      nextProps: React.ComponentProps<typeof PdfCanvasViewer> = {
        title: "A paper",
        url: "research-resource://paper.pdf",
        ...props,
      },
    ) => root.render(<PdfCanvasViewer {...nextProps} />),
  };
}

async function flushViewer() {
  await act(async () => {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
}

async function flushSearch() {
  await act(async () => {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 180));
    await Promise.resolve();
  });
}

async function flushSearchHighlight() {
  await act(async () => {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flushAnimationFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

// One ctrl+wheel notch (≈165%), then the settle delay that commits the zoom.
async function pinchAndCommit(region: HTMLElement) {
  useFakeGestureTimers();
  await act(async () => {
    region.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -50,
      }),
    );
  });
  await act(async () => {
    vi.advanceTimersByTime(16);
  });
  await act(async () => {
    vi.advanceTimersByTime(PINCH_COMMIT_DELAY_MS + 10);
  });
}

function isThumbnailGroup(element: Element | null) {
  return Boolean(
    element?.classList.contains("pdf-canvas-viewer__sidebar-scroll"),
  );
}

function keydown(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init }),
  );
}

// jsdom has no canvas 2D context; the snapshot copy only needs drawImage.
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ({ drawImage() {} }) as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  vi.useRealTimers();
  pdfMockState.deferredPageLoads.clear();
  pdfMockState.deferPageLoads = false;
  pdfMockState.deferredPageRenders.clear();
  pdfMockState.deferPageRenders = false;
  pdfMockState.nativeRotations = {};
  pdfMockState.resolveDeferredSearch?.({ items: [] });
  pdfMockState.resolveDeferredSearch = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (rangeGetClientRectsDescriptor) {
    Object.defineProperty(
      Range.prototype,
      "getClientRects",
      rangeGetClientRectsDescriptor,
    );
  } else {
    Reflect.deleteProperty(Range.prototype, "getClientRects");
  }
});

describe("PdfCanvasViewer", () => {
  it("keeps PDF regions in canonical page coordinates across rotations", () => {
    const canonical = { height: 0.1, width: 0.3, x: 0.1, y: 0.2 };

    expect(displayedPdfRect(canonical, 90)).toEqual({
      height: 0.3,
      width: 0.1,
      x: 0.7,
      y: 0.1,
    });
    for (const rotation of [90, 180, 270]) {
      expect(
        canonicalPdfRect(displayedPdfRect(canonical, rotation), rotation),
      ).toEqual(canonical);
    }
  });

  it("renders a compact reader toolbar, continuous pages, and collapsible navigation", async () => {
    const view = renderViewer({ pageCount: 3, textLayer: "available" });
    await act(async () => {
      view.render();
    });
    await flushViewer();

    expect(
      view.container.querySelector('[aria-label="PDF reader toolbar"]'),
    ).toBeTruthy();
    expect(
      view.container.querySelectorAll(".pdf-canvas-viewer__page-shell"),
    ).toHaveLength(3);
    expect(
      view.container.querySelectorAll("[aria-label^='Go to page ']"),
    ).toHaveLength(3);
    expect(view.container.textContent).toContain("/ 3");

    expect(
      view.container.querySelector(".pdf-canvas-viewer__sidebar-heading")
        ?.textContent,
    ).toBe("Pages");
    expect(view.container.querySelector('[role="tablist"]')).toBeNull();

    const sidebarToggle = view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Hide PDF sidebar"]',
    );
    await act(async () => sidebarToggle?.click());
    expect(
      view.container
        .querySelector(".pdf-canvas-viewer__body")
        ?.classList.contains("is-sidebar-collapsed"),
    ).toBe(true);

    await act(async () => view.root.unmount());
  });

  it("reports a flattened, page-resolved outline and skips unresolvable items", async () => {
    const onOutlineChange = vi.fn();
    const view = renderViewer({
      onOutlineChange,
      pageCount: 3,
      url: "research-resource://outline.pdf",
    });
    await act(async () => view.render());
    await flushViewer();

    expect(onOutlineChange).toHaveBeenLastCalledWith([
      { id: "outline:0", level: 1, page: 2, title: "Introduction" },
      { id: "outline:0.0", level: 2, page: 3, title: "Background" },
    ]);
    await act(async () => view.root.unmount());
  });

  it("reports an empty outline for a PDF without one", async () => {
    const onOutlineChange = vi.fn();
    const view = renderViewer({ onOutlineChange, pageCount: 3 });
    await act(async () => view.render());
    await flushViewer();

    expect(onOutlineChange).toHaveBeenLastCalledWith([]);
    await act(async () => view.root.unmount());
  });

  it("pinch-zooms with ctrl+wheel on the page region and leaves plain scrolling alone", async () => {
    const view = renderViewer({ pageCount: 3 });
    await act(async () => view.render());
    await flushViewer();

    const region = view.container.querySelector<HTMLElement>(
      '[role="region"][aria-label="PDF pages"]',
    )!;
    const zoomLevel = () =>
      Number.parseInt(
        view.container.querySelector('[aria-label="Zoom level"]')
          ?.textContent ?? "",
        10,
      );
    const fitWidthPressed = () =>
      view.container
        .querySelector('[aria-label="Fit page width"]')
        ?.getAttribute("aria-pressed");
    expect(zoomLevel()).toBe(100);
    expect(fitWidthPressed()).toBe("true");

    const plain = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -50,
    });
    await act(async () => region.dispatchEvent(plain));
    await flushAnimationFrame();
    expect(plain.defaultPrevented).toBe(false);
    expect(zoomLevel()).toBe(100);
    expect(fitWidthPressed()).toBe("true");

    const pages = view.container.querySelector<HTMLElement>(
      ".pdf-canvas-viewer__pages",
    )!;
    const renderedWidth = () =>
      view.container
        .querySelector(".react-pdf__Page")
        ?.getAttribute("data-render-width");
    const widthBeforePinch = renderedWidth();
    useFakeGestureTimers();
    const pinches = [0, 1].map(
      () =>
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -50,
        }),
    );
    await act(async () => {
      for (const pinch of pinches) region.dispatchEvent(pinch);
    });
    await act(async () => {
      vi.advanceTimersByTime(16);
    });
    expect(pinches.every((pinch) => pinch.defaultPrevented)).toBe(true);
    // While the fingers are down only a CSS transform and the provisional
    // label move; the real zoom (and pdf.js render width) stays untouched.
    expect(zoomLevel()).toBeGreaterThan(100);
    expect(pages.style.transform).toMatch(/^scale\(/);
    expect(pages.style.willChange).toBe("transform");
    expect(fitWidthPressed()).toBe("true");
    expect(renderedWidth()).toBe(widthBeforePinch);

    await act(async () => {
      vi.advanceTimersByTime(PINCH_COMMIT_DELAY_MS + 10);
    });
    expect(zoomLevel()).toBeGreaterThan(100);
    expect(fitWidthPressed()).toBe("false");
    expect(pages.style.transform).toBe("");
    expect(renderedWidth()).not.toBe(widthBeforePinch);

    await act(async () => view.root.unmount());
  });

  it("keeps the document point under the cursor stable across a zoom commit", async () => {
    const view = renderViewer({ pageCount: 3 });
    await act(async () => view.render());
    await flushViewer();

    const root = view.container.querySelector<HTMLElement>(
      ".pdf-canvas-viewer__page-scroll",
    )!;
    const pages = view.container.querySelector<HTMLElement>(
      ".pdf-canvas-viewer__pages",
    )!;
    const zoomLevel = () =>
      view.container.querySelector('[aria-label="Zoom level"]')?.textContent;
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 500 },
      clientWidth: { configurable: true, value: 800 },
      scrollLeft: { configurable: true, value: 0, writable: true },
      scrollTop: { configurable: true, value: 300, writable: true },
    });

    useFakeGestureTimers();
    await act(async () => {
      root.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: 200,
          clientY: 100,
          ctrlKey: true,
          deltaY: -50,
        }),
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(16);
    });
    // exp(50 * 0.01) ≈ 1.6487, scaled around the cursor's document point.
    expect(zoomLevel()).toBe("165%");
    expect(pages.style.transformOrigin).toBe("200px 400px");
    expect(root.scrollTop).toBe(300);

    await act(async () => {
      vi.advanceTimersByTime(PINCH_COMMIT_DELAY_MS + 10);
    });
    expect(zoomLevel()).toBe("165%");
    expect(root.scrollTop).toBeCloseTo((300 + 100) * 1.65 - 100);
    expect(root.scrollLeft).toBeCloseTo((0 + 200) * 1.65 - 200);

    // Keyboard zoom commits at once and anchors on the viewport centre.
    const topBeforeKeyboard = root.scrollTop;
    await act(async () => keydown(window, "=", { metaKey: true }));
    expect(zoomLevel()).toBe("175%");
    expect(root.scrollTop).toBeCloseTo(
      (topBeforeKeyboard + 250) * (1.75 / 1.65) - 250,
    );

    await act(async () => view.root.unmount());
  });

  it("covers each rendered page with its previous bitmap until it re-renders at the committed zoom", async () => {
    // Twelve pages, three of them rendered: the overlays must follow the
    // rendered window, not the shells.
    pdfMockState.deferPageRenders = true;
    const view = renderViewer({
      pageCount: 12,
      url: "research-resource://large.pdf",
    });
    await act(async () => view.render());
    await flushViewer();

    const overlays = () =>
      view.container.querySelectorAll(".pdf-canvas-viewer__zoom-snapshot");
    const overlayBitmap = (page: number) =>
      view.container.querySelector(
        `[data-pdf-page-number="${page}"] .pdf-canvas-viewer__zoom-snapshot > canvas`,
      );
    const renderedWidth = () =>
      view.container
        .querySelector(".react-pdf__Page")
        ?.getAttribute("data-render-width");
    expect(view.container.querySelectorAll(".react-pdf__Page")).toHaveLength(3);
    expect(overlays()).toHaveLength(0);
    // A render report that belongs to the zoom before the commit.
    const staleReport = pdfMockState.deferredPageRenders.get(1)!;
    const widthBeforePinch = renderedWidth();

    const region = view.container.querySelector<HTMLElement>(
      '[role="region"][aria-label="PDF pages"]',
    )!;
    await pinchAndCommit(region);
    // The pages re-lay out at the new width and, in the same commit, every
    // rendered page is already covered by a copy of its previous bitmap.
    expect(renderedWidth()).not.toBe(widthBeforePinch);
    expect(overlays()).toHaveLength(3);
    expect(overlayBitmap(1)).toBeInstanceOf(HTMLCanvasElement);
    expect(overlayBitmap(4)).toBeNull();

    // A late report from the previous zoom does not uncover the page.
    await act(async () => staleReport());
    expect(overlays()).toHaveLength(3);

    await act(async () => pdfMockState.deferredPageRenders.get(1)?.());
    expect(overlayBitmap(1)).toBeNull();
    expect(overlays()).toHaveLength(2);
    await act(async () => {
      for (const report of pdfMockState.deferredPageRenders.values()) report();
    });
    expect(overlays()).toHaveLength(0);

    await act(async () => view.root.unmount());
  });

  it("re-renders without a snapshot when no canvas 2D context is available", async () => {
    // jsdom's own behaviour: the copy target cannot provide a context.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => null,
    );
    pdfMockState.deferPageRenders = true;
    const view = renderViewer({ pageCount: 3 });
    await act(async () => view.render());
    await flushViewer();

    const renderedWidth = () =>
      view.container
        .querySelector(".react-pdf__Page")
        ?.getAttribute("data-render-width");
    const widthBeforePinch = renderedWidth();
    await pinchAndCommit(
      view.container.querySelector<HTMLElement>(
        '[role="region"][aria-label="PDF pages"]',
      )!,
    );
    expect(renderedWidth()).not.toBe(widthBeforePinch);
    expect(
      view.container.querySelectorAll(".pdf-canvas-viewer__zoom-snapshot"),
    ).toHaveLength(0);

    await act(async () => view.root.unmount());
  });

  it("zooms with the command keyboard shortcuts", async () => {
    const view = renderViewer({ pageCount: 3 });
    await act(async () => view.render());
    await flushViewer();

    const zoomLevel = () =>
      view.container.querySelector('[aria-label="Zoom level"]')?.textContent;
    await act(async () => keydown(window, "=", { metaKey: true }));
    expect(zoomLevel()).toBe("110%");
    await act(async () => keydown(window, "-", { ctrlKey: true }));
    await act(async () => keydown(window, "-", { ctrlKey: true }));
    expect(zoomLevel()).toBe("90%");
    await act(async () => keydown(window, "0", { metaKey: true }));
    expect(zoomLevel()).toBe("100%");
    expect(
      view.container
        .querySelector('[aria-label="Fit page width"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");

    await act(async () => view.root.unmount());
  });

  it("reports the trailing page when the scroll range cannot align it to the top", async () => {
    const onPageChange = vi.fn();
    const view = renderViewer({ onPageChange, pageCount: 3 });
    await act(async () => view.render());
    await flushViewer();

    const root = view.container.querySelector<HTMLElement>(
      ".pdf-canvas-viewer__page-scroll",
    )!;
    const pages = Array.from(
      view.container.querySelectorAll<HTMLElement>("[data-pdf-page-number]"),
    );
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 800 },
      scrollTop: { configurable: true, value: 300, writable: true },
    });
    Object.defineProperty(root, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 500,
        height: 500,
        left: 0,
        right: 800,
        top: 0,
        width: 800,
        x: 0,
        y: 0,
      }),
    });
    const pageRects = [
      { bottom: 300, top: -400 },
      { bottom: 900, top: 320 },
      { bottom: 1_500, top: 920 },
    ];
    for (const [index, page] of pages.entries()) {
      Object.defineProperty(page, "getBoundingClientRect", {
        configurable: true,
        value: () => ({
          ...pageRects[index],
          height: pageRects[index]!.bottom - pageRects[index]!.top,
          left: 0,
          right: 600,
          width: 600,
          x: 0,
          y: pageRects[index]!.top,
        }),
      });
    }

    await act(async () => root.dispatchEvent(new Event("scroll")));
    expect(onPageChange).toHaveBeenLastCalledWith(2);
    expect(
      view.container.querySelector<HTMLInputElement>(
        '[aria-label="Current page"]',
      )?.value,
    ).toBe("2");

    await act(async () => view.root.unmount());
  });

  it("treats navigation as a transient drawer on narrow viewports", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: true,
        media: "(max-width: 760px)",
        onchange: null,
        removeEventListener: vi.fn(),
      })),
    );
    const compact = renderViewer({ pageCount: 3 });
    await act(async () => compact.render());
    await flushViewer();

    expect(
      compact.container
        .querySelector(".pdf-canvas-viewer__body")
        ?.classList.contains("is-sidebar-collapsed"),
    ).toBe(true);
    expect(
      compact.container.querySelector('[aria-label="Fit page width"]'),
    ).toBeTruthy();
    expect(
      compact.container
        .querySelector('[aria-label="Fit page width"]')
        ?.classList.contains("pdf-canvas-viewer__mobile-tool-button"),
    ).toBe(true);

    await act(async () => {
      compact.container
        .querySelector<HTMLButtonElement>('[aria-label="Show PDF sidebar"]')
        ?.click();
    });
    await flushViewer();
    expect(
      compact.container.querySelector('[aria-label="Dismiss PDF navigation"]'),
    ).toBeTruthy();
    expect(isThumbnailGroup(document.activeElement)).toBe(true);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          cancelable: true,
          key: "Tab",
          shiftKey: true,
        }),
      );
    });
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Go to page 3",
    );
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { cancelable: true, key: "Tab" }),
      );
    });
    expect(isThumbnailGroup(document.activeElement)).toBe(true);

    await act(async () => {
      compact.container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Dismiss PDF navigation"]',
        )
        ?.click();
    });
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Show PDF sidebar",
    );
    await act(async () => {
      compact.container
        .querySelector<HTMLButtonElement>('[aria-label="Show PDF sidebar"]')
        ?.click();
    });
    await flushViewer();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(
      compact.container
        .querySelector(".pdf-canvas-viewer__body")
        ?.classList.contains("is-sidebar-collapsed"),
    ).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Show PDF sidebar",
    );
    await act(async () => {
      compact.container
        .querySelector<HTMLButtonElement>('[aria-label="Show PDF sidebar"]')
        ?.click();
    });
    await flushViewer();
    await act(async () => {
      compact.container
        .querySelector<HTMLAnchorElement>('[aria-label="Go to page 2"]')
        ?.click();
    });
    await flushViewer();
    expect(
      compact.container
        .querySelector(".pdf-canvas-viewer__body")
        ?.classList.contains("is-sidebar-collapsed"),
    ).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "PDF pages",
    );
    expect(
      compact.container.querySelector(
        '[role="separator"][aria-label="Resize PDF navigation sidebar"]',
      ),
    ).toBeNull();
    await act(async () => compact.root.unmount());

    const restored = renderViewer({
      initialState: { sidebarOpen: true },
      pageCount: 3,
    });
    await act(async () => restored.render());
    await flushViewer();
    expect(
      restored.container
        .querySelector(".pdf-canvas-viewer__body")
        ?.classList.contains("is-sidebar-collapsed"),
    ).toBe(true);
    await act(async () => restored.root.unmount());
  });

  it("preserves intrinsic PDF page rotation and composes reader rotation", async () => {
    const view = renderViewer({
      pageCount: 3,
      url: "research-resource://mixed-native-rotation.pdf",
    });
    await act(async () => view.render());
    await flushViewer();

    const renderedPages = () => Array.from(
      view.container.querySelectorAll<HTMLElement>(".react-pdf__Page"),
    );
    expect(renderedPages()[0]?.dataset.renderRotation).toBe("90");
    expect(renderedPages()[1]?.dataset.renderRotation).toBe("270");

    await act(async () => {
      view.container
        .querySelector<HTMLButtonElement>('[aria-label="Rotate clockwise"]')
        ?.click();
    });
    expect(renderedPages()[0]?.dataset.renderRotation).toBe("180");
    expect(renderedPages()[1]?.dataset.renderRotation).toBe("0");

    await act(async () => view.root.unmount());
  });

  it("measures the page viewport after the PDF document mounts its children", async () => {
    const observedNodes: Element[] = [];
    class ResizeObserverMock {
      constructor(private readonly callback: ResizeObserverCallback) {}

      disconnect() {}

      observe(node: Element) {
        observedNodes.push(node);
        Object.defineProperty(node, "clientWidth", {
          configurable: true,
          value: 1280,
        });
        this.callback([], this as unknown as ResizeObserver);
      }

      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const view = renderViewer({
      pageCount: 3,
      url: "research-resource://deferred.pdf",
    });

    await act(async () => view.render());
    await flushViewer();

    const observedPageScrolls = observedNodes.filter((node) =>
      node.classList.contains("pdf-canvas-viewer__page-scroll"),
    );
    expect(observedPageScrolls).toHaveLength(1);
    expect(
      view.container
        .querySelector(".react-pdf__Page")
        ?.getAttribute("data-render-width"),
    ).toBe("1216");

    await act(async () => view.root.unmount());
  });

  it("honors initialPage and exposes programmatic page navigation", async () => {
    const scrollTo = vi.fn(function (
      this: HTMLElement,
      options: ScrollToOptions,
    ) {
      this.scrollTop = Number(options.top ?? 0);
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const onPageChange = vi.fn();
    const viewerRef = {
      current: null,
    } as React.RefObject<PdfCanvasViewerHandle | null>;
    const view = renderViewer({
      initialPage: 2,
      onPageChange,
      pageCount: 3,
    });

    await act(async () => {
      view.root.render(
        <PdfCanvasViewer
          initialPage={2}
          onPageChange={onPageChange}
          pageCount={3}
          ref={viewerRef}
          title="A paper"
          url="research-resource://paper.pdf"
        />,
      );
    });
    await flushViewer();

    expect(
      view.container
        .querySelector('[aria-current="page"]')
        ?.getAttribute("aria-label"),
    ).toBe("Go to page 2");
    expect(scrollTo).toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();

    await act(async () => {
      viewerRef.current?.goToPage(3);
      await Promise.resolve();
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ behavior: "auto", top: 0 });
    expect(onPageChange).toHaveBeenCalledWith(3);

    const zoomIn = view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Zoom in"]',
    );
    await act(async () => zoomIn?.click());
    expect(
      view.container.querySelector('[aria-label="Zoom level"]')?.textContent,
    ).toBe("110%");

    await act(async () => view.root.unmount());
  });

  it("keeps an exact return path after an explicit PDF jump", async () => {
    const scrollTo = vi.fn(function (
      this: HTMLElement,
      options: ScrollToOptions,
    ) {
      this.scrollTop = Number(options.top ?? 0);
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const onReaderStateChange = vi.fn();
    const view = renderViewer({
      initialState: { page: 1, pageOffset: 0.4 },
      onReaderStateChange,
      pageCount: 3,
      url: "research-resource://internal-link.pdf",
    });

    await act(async () => {
      view.root.render(
        <PdfCanvasViewer
          initialState={{ page: 1, pageOffset: 0.4 }}
          onReaderStateChange={onReaderStateChange}
          pageCount={3}
          title="A paper"
          url="research-resource://internal-link.pdf"
        />,
      );
    });
    await flushViewer();

    expect(
      view.container.querySelector('[aria-label^="Back to page"]'),
    ).toBeNull();
    await act(async () =>
      view.container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Internal PDF link to page 3"]',
        )
        ?.click(),
    );
    const back = view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Back to page 1"]',
    );
    expect(back).not.toBeNull();
    expect(back?.textContent).toContain("Back · page 1");

    await act(async () => back?.click());
    expect(
      view.container.querySelector('[aria-label^="Back to page"]'),
    ).toBeNull();
    expect(onReaderStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, pageOffset: 0.4 }),
    );
    expect(document.activeElement).toBe(
      view.container.querySelector<HTMLElement>(
        ".pdf-canvas-viewer__page-scroll",
      ),
    );

    await act(async () => view.root.unmount());
  });

  it("does not reinterpret an observed page echo as a new navigation", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const viewerRef = {
      current: null,
    } as React.RefObject<PdfCanvasViewerHandle | null>;
    const view = renderViewer({ pageCount: 3 });
    await act(async () => {
      view.root.render(
        <PdfCanvasViewer
          initialPage={1}
          pageCount={3}
          ref={viewerRef}
          title="A paper"
          url="research-resource://paper.pdf"
        />,
      );
    });
    await flushViewer();

    await act(async () => viewerRef.current?.goToPage(2));
    scrollTo.mockClear();
    await act(async () => {
      view.root.render(
        <PdfCanvasViewer
          initialPage={2}
          pageCount={3}
          ref={viewerRef}
          title="A paper"
          url="research-resource://paper.pdf"
        />,
      );
    });
    await flushViewer();

    expect(scrollTo).not.toHaveBeenCalled();
    expect(
      view.container
        .querySelector('[aria-current="page"]')
        ?.getAttribute("aria-label"),
    ).toBe("Go to page 2");
    await act(async () => view.root.unmount());
  });

  it("keeps all page shells while windowing full pages and thumbnails", async () => {
    const view = renderViewer({
      pageCount: 12,
      url: "research-resource://large.pdf",
    });
    await act(async () => view.render());
    await flushViewer();

    expect(
      view.container.querySelectorAll(".pdf-canvas-viewer__page-shell"),
    ).toHaveLength(12);
    expect(view.container.querySelectorAll(".react-pdf__Page")).toHaveLength(3);
    expect(
      view.container.querySelectorAll(".react-pdf__Thumbnail"),
    ).toHaveLength(5);

    const pageTen = view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Go to page 10"]',
    );
    await act(async () => pageTen?.click());
    expect(
      Array.from(
        view.container.querySelectorAll(".react-pdf__Page__textContent"),
      ).map((element) => element.textContent?.trim()),
    ).toEqual([
      "Selectable page 8",
      "Selectable page 9",
      "Selectable page 10",
      "Selectable page 11",
      "Selectable page 12",
    ]);

    await act(async () => view.root.unmount());
  });

  it("searches PDF.js text with keyboard navigation and reports scanned PDFs", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value(this: Range) {
        const top = this.startOffset > 0 ? 300 : 100;
        return [{
          bottom: top + 20,
          height: 20,
          left: 120,
          right: 240,
          top,
          width: 120,
          x: 120,
          y: top,
        }];
      },
    });
    const view = renderViewer({ pageCount: 3, textLayer: "available" });
    await act(async () => view.render());
    await flushViewer();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", metaKey: true }),
      );
    });
    const firstPage = view.container.querySelector<HTMLElement>(
      '[data-pdf-page-number="1"]',
    )!;
    Object.defineProperty(firstPage, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 800,
        height: 800,
        left: 0,
        right: 600,
        top: 0,
        width: 600,
        x: 0,
        y: 0,
      }),
    });
    const input = view.container.querySelector<HTMLInputElement>(
      '[aria-label="Search text"]',
    )!;
    await act(async () => setInputValue(input, "alpha"));
    await flushSearch();
    await flushSearchHighlight();

    expect(view.container.textContent).toContain("1 / 3");
    expect(view.container.textContent).toContain("Match 1 of 3");
    expect(
      view.container.querySelector<HTMLElement>(
        ".pdf-canvas-viewer__search-region",
      )?.style.top,
    ).toBe("12.5%");
    const next = view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Next search result"]',
    );
    await act(async () => next?.click());
    await flushSearchHighlight();
    expect(
      view.container.querySelector<HTMLElement>(
        ".pdf-canvas-viewer__search-region",
      )?.style.top,
    ).toBe("37.5%");
    await act(async () => next?.click());
    expect(view.container.textContent).toContain("3 / 3");
    expect(
      view.container
        .querySelector('[aria-current="page"]')
        ?.getAttribute("aria-label"),
    ).toBe("Go to page 2");

    await act(async () => view.root.unmount());

    const scanned = renderViewer({ pageCount: 3, textLayer: "absent" });
    await act(async () => scanned.render());
    await flushViewer();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { ctrlKey: true, key: "f" }),
      );
    });
    expect(
      scanned.container.querySelector<HTMLInputElement>(
        '[aria-label="Search text"]',
      )?.disabled,
    ).toBe(true);
    expect(scanned.container.textContent).toContain("No searchable text layer");
    await act(async () => scanned.root.unmount());
  });

  it("cancels an in-flight full-document search when the search surface closes", async () => {
    const view = renderViewer({
      pageCount: 3,
      textLayer: "available",
      url: "research-resource://deferred-search.pdf",
    });
    await act(async () => view.render());
    await flushViewer();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", metaKey: true }),
      );
    });
    const input = view.container.querySelector<HTMLInputElement>(
      '[aria-label="Search text"]',
    )!;
    await act(async () => setInputValue(input, "alpha"));
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 160));
    });
    expect(pdfMockState.resolveDeferredSearch).toBeTypeOf("function");

    await act(async () => {
      view.container
        .querySelector<HTMLButtonElement>('[aria-label="Close PDF search"]')
        ?.click();
      pdfMockState.resolveDeferredSearch?.({
        items: [{ str: "alpha beta alpha" }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      view.container.querySelector(".pdf-canvas-viewer__search-page-marker"),
    ).toBeNull();
    expect(
      view.container.querySelector(".pdf-canvas-viewer__search-region"),
    ).toBeNull();
    await act(async () => view.root.unmount());
  });

  it("restores and reports full reader state including intra-page offset", async () => {
    const onReaderStateChange = vi.fn();
    const view = renderViewer({
      initialState: {
        fitWidth: false,
        page: 1,
        pageOffset: 0.25,
        rotation: 0,
        sidebarOpen: false,
        zoom: 1.4,
      },
      onReaderStateChange,
      pageCount: 3,
    });
    await act(async () => view.render());
    await flushViewer();

    expect(
      view.container
        .querySelector(".pdf-canvas-viewer__body")
        ?.classList.contains("is-sidebar-collapsed"),
    ).toBe(true);
    expect(
      view.container.querySelector('[aria-label="Zoom level"]')?.textContent,
    ).toBe("140%");

    const root = view.container.querySelector<HTMLElement>(
      ".pdf-canvas-viewer__page-scroll",
    )!;
    const pages = Array.from(
      view.container.querySelectorAll<HTMLElement>("[data-pdf-page-number]"),
    );
    Object.defineProperty(root, "clientHeight", {
      configurable: true,
      value: 500,
    });
    Object.defineProperty(root, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 500,
        height: 500,
        left: 0,
        right: 800,
        top: 0,
        width: 800,
        x: 0,
        y: 0,
      }),
    });
    Object.defineProperty(pages[0], "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 424,
        height: 800,
        left: 0,
        right: 600,
        top: -376,
        width: 600,
        x: 0,
        y: -376,
      }),
    });
    Object.defineProperty(pages[1], "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 1246,
        height: 800,
        left: 0,
        right: 600,
        top: 446,
        width: 600,
        x: 0,
        y: 446,
      }),
    });
    await act(async () => root.dispatchEvent(new Event("scroll")));

    expect(onReaderStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fitWidth: false,
        page: 1,
        pageOffset: 0.5,
        sidebarOpen: false,
        sidebarView: "pages",
        zoom: 1.4,
      }),
    );
    await act(async () => view.root.unmount());
  });

  it("resizes the desktop navigation sidebar and reports the exact width", async () => {
    const onReaderStateChange = vi.fn();
    const view = renderViewer({ onReaderStateChange, pageCount: 3 });
    await act(async () => view.render());
    await flushViewer();

    const separator = view.container.querySelector<HTMLElement>(
      '[role="separator"][aria-label="Resize PDF navigation sidebar"]',
    );
    expect(separator).not.toBeNull();
    expect(separator?.getAttribute("aria-valuenow")).toBe("216");

    await act(async () => keydown(separator!, "End"));
    expect(separator?.getAttribute("aria-valuenow")).toBe("400");
    expect(onReaderStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ sidebarWidth: 400 }),
    );

    await act(async () => keydown(separator!, "Home"));
    expect(separator?.getAttribute("aria-valuenow")).toBe("180");

    await act(async () => {
      separator?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(separator?.getAttribute("aria-valuenow")).toBe("216");
    await act(async () => view.root.unmount());
  });

  it("reserves readable PDF canvas width inside a narrow desktop pane", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const view = renderViewer({ pageCount: 3 });
    await act(async () => view.render());
    await flushViewer();

    const body = view.container.querySelector<HTMLElement>(
      ".pdf-canvas-viewer__body",
    )!;
    Object.defineProperty(body, "clientWidth", {
      configurable: true,
      value: 808,
    });
    await act(async () => window.dispatchEvent(new Event("resize")));

    const separator = view.container.querySelector<HTMLElement>(
      '[role="separator"][aria-label="Resize PDF navigation sidebar"]',
    )!;
    expect(separator.getAttribute("aria-valuemax")).toBe("200");
    expect(separator.getAttribute("aria-valuenow")).toBe("200");
    expect(body.style.getPropertyValue("--pdf-reader-sidebar-width")).toBe(
      "200px",
    );
    await act(async () => view.root.unmount());
  });

  it("uses an accessible overlay drawer when the reader pane is too narrow", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const view = renderViewer({ pageCount: 3 });
    await act(async () => view.render());
    await flushViewer();

    const body = view.container.querySelector<HTMLElement>(
      ".pdf-canvas-viewer__body",
    )!;
    Object.defineProperty(body, "clientWidth", {
      configurable: true,
      value: 482,
    });
    await act(async () => window.dispatchEvent(new Event("resize")));

    expect(body.classList.contains("is-sidebar-overlay")).toBe(true);
    expect(body.classList.contains("is-sidebar-collapsed")).toBe(true);
    expect(
      view.container.querySelector(
        '[role="separator"][aria-label="Resize PDF navigation sidebar"]',
      ),
    ).toBeNull();

    await act(async () => {
      view.container
        .querySelector<HTMLButtonElement>('[aria-label="Show PDF sidebar"]')
        ?.click();
    });
    await flushViewer();
    expect(
      view.container
        .querySelector('[aria-label="PDF navigation sidebar"]')
        ?.getAttribute("role"),
    ).toBe("dialog");
    expect(
      view.container.querySelector('[aria-label="Dismiss PDF navigation"]'),
    ).toBeTruthy();
    await act(async () => view.root.unmount());
  });

  it("returns focus to the toggle when a layout transition hides navigation", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const view = renderViewer({ pageCount: 3 });
    await act(async () => view.render());
    await flushViewer();

    let bodyWidth = 808;
    const body = view.container.querySelector<HTMLElement>(
      ".pdf-canvas-viewer__body",
    )!;
    Object.defineProperty(body, "clientWidth", {
      configurable: true,
      get: () => bodyWidth,
    });
    await act(async () => window.dispatchEvent(new Event("resize")));

    view.container
      .querySelector<HTMLElement>(".pdf-canvas-viewer__sidebar-scroll")
      ?.focus();
    bodyWidth = 780;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Show PDF sidebar",
    );

    bodyWidth = 808;
    await act(async () => window.dispatchEvent(new Event("resize")));
    await act(async () => {
      view.container
        .querySelector<HTMLButtonElement>('[aria-label="Hide PDF sidebar"]')
        ?.click();
    });
    bodyWidth = 780;
    await act(async () => window.dispatchEvent(new Event("resize")));
    await act(async () => {
      view.container
        .querySelector<HTMLButtonElement>('[aria-label="Show PDF sidebar"]')
        ?.click();
    });
    await flushViewer();
    expect(isThumbnailGroup(document.activeElement)).toBe(true);

    bodyWidth = 808;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Show PDF sidebar",
    );
    await act(async () => view.root.unmount());
  });

  it("returns one-page normalized text selections and blocks cross-page selections", async () => {
    const view = renderViewer({ pageCount: 3, textLayer: "available" });
    const viewerRef = {
      current: null,
    } as React.RefObject<PdfCanvasViewerHandle | null>;
    await act(async () => {
      view.root.render(
        <PdfCanvasViewer
          pageCount={3}
          ref={viewerRef}
          title="A paper"
          url="research-resource://paper.pdf"
        />,
      );
    });
    await flushViewer();

    const pages = Array.from(
      view.container.querySelectorAll<HTMLElement>("[data-pdf-page-number]"),
    );
    const firstText = pages[0]!.querySelector(
      ".react-pdf__Page__textContent",
    )!.firstChild!;
    const range = document.createRange();
    range.setStart(firstText, 0);
    range.setEnd(firstText, firstText.textContent!.length);
    Object.defineProperty(pages[0], "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 100,
        top: 50,
        right: 500,
        bottom: 850,
        width: 400,
        height: 800,
      }),
    });
    Object.defineProperty(range, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 140,
        top: 130,
        right: 340,
        bottom: 170,
        width: 200,
        height: 40,
      }),
    });
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(viewerRef.current?.readSelection()).toEqual({
      height: 0.05,
      kind: "selection",
      pageNumber: 1,
      rects: [{
        height: 0.05,
        width: 0.5,
        x: 0.1,
        y: 0.1,
      }],
      text: "alpha beta alpha",
      width: 0.5,
      x: 0.1,
      y: 0.1,
    });

    const secondText = pages[1]!.querySelector(
      ".react-pdf__Page__textContent",
    )!.firstChild!;
    const crossPageRange = document.createRange();
    crossPageRange.setStart(firstText, 0);
    crossPageRange.setEnd(secondText, secondText.textContent!.length);
    selection.removeAllRanges();
    selection.addRange(crossPageRange);
    expect(viewerRef.current?.readSelection()).toEqual({
      kind: "blocked",
      reason: "Select text from one page at a time to create an excerpt.",
    });
    selection.removeAllRanges();

    await act(async () => view.root.unmount());
  });
});
