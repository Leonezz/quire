import { act } from "react";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultPdfReaderState,
  loadReaderState,
  pdfReadingProgress,
  readerStateKey,
  saveReaderState,
  usePdfReaderStateMemory,
  type PdfReaderState,
} from "./reader-state-memory";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("readerStateKey", () => {
  it("namespaces the identity under the pdf reader prefix", () => {
    expect(readerStateKey("paper@r3:sha256:abc")).toBe(
      "research-workbench:pdf-reader:paper@r3:sha256:abc",
    );
  });
});

describe("loadReaderState", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(loadReaderState(readerStateKey("missing"))).toEqual(
      defaultPdfReaderState,
    );
  });

  it("round-trips a saved state", () => {
    const key = readerStateKey("paper");
    const state: PdfReaderState = {
      fitWidth: false,
      page: 4,
      pageOffset: 0.25,
      rotation: 90,
      sidebarOpen: false,
      sidebarWidth: 240,
      sidebarView: "pages",
      zoom: 1.4,
    };
    saveReaderState(key, state);
    expect(loadReaderState(key, 10)).toEqual(state);
  });

  it("clamps out-of-range values instead of trusting storage", () => {
    const key = readerStateKey("paper");
    window.localStorage.setItem(
      key,
      JSON.stringify({
        fitWidth: "yes",
        page: 42,
        pageOffset: 7,
        rotation: 45,
        sidebarOpen: "no",
        sidebarWidth: 5000,
        sidebarView: "annotations",
        zoom: 9,
      }),
    );
    expect(loadReaderState(key, 12)).toEqual({
      fitWidth: true,
      page: 12,
      pageOffset: 1,
      rotation: 0,
      sidebarOpen: true,
      sidebarWidth: 400,
      sidebarView: "pages",
      zoom: 1,
    });
  });

  it("keeps a page beyond an unknown page count until the count is known", () => {
    const key = readerStateKey("paper");
    window.localStorage.setItem(key, JSON.stringify({ page: 42 }));
    expect(loadReaderState(key).page).toBe(42);
    expect(loadReaderState(key, 0).page).toBe(42);
    expect(loadReaderState(key, 7).page).toBe(7);
  });

  it("normalizes negative and oversized rotations onto the quarter turns", () => {
    const key = readerStateKey("paper");
    window.localStorage.setItem(key, JSON.stringify({ rotation: -90 }));
    expect(loadReaderState(key).rotation).toBe(270);
    window.localStorage.setItem(key, JSON.stringify({ rotation: 450 }));
    expect(loadReaderState(key).rotation).toBe(90);
  });

  it("falls back to defaults on invalid JSON or non-object payloads", () => {
    const key = readerStateKey("paper");
    window.localStorage.setItem(key, "{not json");
    expect(loadReaderState(key)).toEqual(defaultPdfReaderState);
    window.localStorage.setItem(key, "42");
    expect(loadReaderState(key)).toEqual(defaultPdfReaderState);
    window.localStorage.setItem(key, "null");
    expect(loadReaderState(key)).toEqual(defaultPdfReaderState);
  });

  it("treats unavailable storage as a no-memory mode", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const key = readerStateKey("paper");
    expect(loadReaderState(key)).toEqual(defaultPdfReaderState);
    expect(() => saveReaderState(key, defaultPdfReaderState)).not.toThrow();
  });
});

describe("pdfReadingProgress", () => {
  it("is undefined without a usable page count", () => {
    expect(pdfReadingProgress({ page: 1, pageOffset: 0 }, undefined)).toBe(
      undefined,
    );
    expect(pdfReadingProgress({ page: 1, pageOffset: 0 }, 0)).toBe(undefined);
    expect(pdfReadingProgress({ page: 1, pageOffset: 0 }, 2.5)).toBe(undefined);
  });

  it("maps page plus intra-page offset onto a 0..1 fraction", () => {
    expect(pdfReadingProgress({ page: 1, pageOffset: 0 }, 4)).toBe(0);
    expect(pdfReadingProgress({ page: 1, pageOffset: 0.5 }, 4)).toBe(0.125);
    expect(pdfReadingProgress({ page: 3, pageOffset: 0 }, 4)).toBe(0.5);
    expect(pdfReadingProgress({ page: 4, pageOffset: 1 }, 4)).toBe(1);
  });

  it("clamps pages and offsets outside the document", () => {
    expect(pdfReadingProgress({ page: 9, pageOffset: 3 }, 4)).toBe(1);
    expect(pdfReadingProgress({ page: -2, pageOffset: -1 }, 4)).toBe(0);
    expect(pdfReadingProgress({ page: 2.9, pageOffset: 0 }, 4)).toBe(0.25);
  });
});

describe("usePdfReaderStateMemory", () => {
  function mountHook(identity: string, pageCount?: number) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const latest: {
      current?: ReturnType<typeof usePdfReaderStateMemory>;
    } = {};
    function Probe(props: { identity: string; pageCount?: number }) {
      latest.current = usePdfReaderStateMemory(props.identity, props.pageCount);
      return null;
    }
    const render = (nextIdentity: string, nextPageCount?: number) =>
      root.render(
        createElement(Probe, { identity: nextIdentity, pageCount: nextPageCount }),
      );
    act(() => render(identity, pageCount));
    return { latest, render, root };
  }

  it("loads the stored state once and debounces writes by 280 ms", () => {
    vi.useFakeTimers();
    const key = readerStateKey("paper");
    saveReaderState(key, { ...defaultPdfReaderState, page: 3, zoom: 1.2 });

    const hook = mountHook("paper", 10);
    expect(hook.latest.current?.initialState).toMatchObject({
      page: 3,
      zoom: 1.2,
    });

    act(() => {
      hook.latest.current?.remember({ ...defaultPdfReaderState, page: 5 });
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(loadReaderState(key).page).toBe(3);
    act(() => {
      hook.latest.current?.remember({ ...defaultPdfReaderState, page: 6 });
      vi.advanceTimersByTime(200);
    });
    expect(loadReaderState(key).page).toBe(3);
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(loadReaderState(key).page).toBe(6);

    act(() => hook.root.unmount());
  });

  it("flushes the latest state on unmount even inside the debounce window", () => {
    vi.useFakeTimers();
    const key = readerStateKey("paper");
    const hook = mountHook("paper", 10);
    act(() => {
      hook.latest.current?.remember({ ...defaultPdfReaderState, page: 8 });
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    act(() => hook.root.unmount());
    expect(loadReaderState(key).page).toBe(8);
    expect(setItem).toHaveBeenCalledTimes(1);
    // The pending debounce was cancelled: nothing writes again later.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("keeps separate memory per identity", () => {
    vi.useFakeTimers();
    const hook = mountHook("first", 10);
    act(() => {
      hook.latest.current?.remember({ ...defaultPdfReaderState, page: 2 });
    });
    act(() => hook.render("second", 10));
    expect(loadReaderState(readerStateKey("first")).page).toBe(2);
    expect(hook.latest.current?.initialState.page).toBe(1);
    act(() => hook.root.unmount());
  });
});
