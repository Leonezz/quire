// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MaterialRecord, MaterialView, MaterialViewContent } from "../../shared/contracts";
import { deferred, flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { useMaterialView } from "./useMaterialView";

const quality = { completeness: "declared_full" as const, conformance: "conformant" as const, identityConfidence: "strong" as const, safety: "safe" as const, warnings: [] };
const webView: MaterialView = { id: "web", label: "Web", url: "https://example.org/a", mediaType: "text/html", status: "ready", fetchedAt: "2026-09-18T00:00:00.000Z" };
const pdfAvailable: MaterialView = { id: "pdf", label: "PDF", url: "https://example.org/a.pdf", mediaType: "application/pdf", status: "available" };
const pdfInfo = { pages: 12, byteLength: 4096, textLayer: "available" as const };
const pdfReady: MaterialView = { ...pdfAvailable, status: "ready", fetchedAt: "2026-09-19T00:00:00.000Z", byteLength: 4096, pdf: pdfInfo };
const pdfContent: MaterialViewContent = { view: "pdf", mediaType: "application/pdf", pdf: pdfInfo, readingMinutes: 30, quality, problems: [] };

function record(views: MaterialView[], primaryView: MaterialRecord["primaryView"] = "web"): MaterialRecord {
  const extracted = { kind: "webpage" as const, title: "A page", url: "https://example.org/a" };
  const base = { id: "m1", url: "https://example.org/a", finalUrl: "https://example.org/a", title: "A page", fetchedAt: "2026-09-18T00:00:00.000Z", origin: "web" as const, tags: [], kind: "webpage" as const, problems: [], views, primaryView, readyViews: views.filter((view) => view.status === "ready").map((view) => view.id), extracted, meta: extracted };
  return primaryView === "pdf"
    ? { ...base, mediaType: "application/pdf", pdf: pdfInfo, readingMinutes: 30, quality }
    : { ...base, mediaType: "text/html", markdown: "# A page", readingMinutes: 3, quality };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

describe("useMaterialView", () => {
  it("opens the primary view with the record's own content", () => {
    api.read = mockRead();
    const material = record([webView, pdfAvailable]);
    const { result } = renderHook(() => useMaterialView(material));
    expect(result.current.view).toBe("web");
    expect(result.current.content).toEqual({ status: "ready", content: { view: "web", mediaType: "text/html", markdown: "# A page", readingMinutes: 3, quality, problems: [] } });
    expect(api.read.getMaterialView).not.toHaveBeenCalled();
  });

  it("opens the remembered view when it is stored, loading its content through getMaterialView", async () => {
    localStorage.setItem("read:view:m1", "pdf");
    const getMaterialView = vi.fn(async () => pdfContent);
    api.read = mockRead({ getMaterialView });
    const material = record([webView, pdfReady]);
    const { result } = renderHook(() => useMaterialView(material));
    expect(result.current.view).toBe("pdf");
    expect(result.current.content).toEqual({ status: "loading" });
    await act(flush);
    expect(getMaterialView).toHaveBeenCalledWith("m1", "pdf");
    expect(result.current.content).toEqual({ status: "ready", content: pdfContent });
  });

  it("falls back to the primary when the remembered view is not stored", () => {
    localStorage.setItem("read:view:m1", "pdf");
    api.read = mockRead();
    const material = record([webView, pdfAvailable]);
    const { result } = renderHook(() => useMaterialView(material));
    expect(result.current.view).toBe("web");
  });

  it("fetches an available view before switching to it and remembers the choice", async () => {
    const fetched = record([webView, pdfReady]);
    const fetch = deferred<{ ok: true; material: MaterialRecord }>();
    const fetchMaterialView = vi.fn(() => fetch.promise);
    const getMaterialView = vi.fn(async () => pdfContent);
    api.read = mockRead({ fetchMaterialView, getMaterialView });
    const onMaterialChanged = vi.fn();
    const { result, rerender } = renderHook(({ material }) => useMaterialView(material, onMaterialChanged), { initialProps: { material: record([webView, pdfAvailable]) } });
    act(() => { result.current.select("pdf"); });
    expect(fetchMaterialView).toHaveBeenCalledWith("m1", "pdf");
    expect(result.current.fetching).toBe("pdf");
    expect(result.current.view).toBe("web");
    await act(async () => { fetch.resolve({ ok: true, material: fetched }); await flush(); });
    expect(onMaterialChanged).toHaveBeenCalledWith(fetched);
    rerender({ material: fetched });
    await act(flush);
    expect(result.current.fetching).toBeUndefined();
    expect(result.current.view).toBe("pdf");
    expect(localStorage.getItem("read:view:m1")).toBe("pdf");
    expect(result.current.content).toEqual({ status: "ready", content: pdfContent });
  });

  it("keeps the current view when the fetch fails, and retries on the next select", async () => {
    const fetchMaterialView = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: "FETCH_FAILED", message: "arxiv.org did not answer." })
      .mockResolvedValueOnce({ ok: true, material: record([webView, pdfReady]) });
    api.read = mockRead({ fetchMaterialView, getMaterialView: vi.fn(async () => pdfContent) });
    const material = record([webView, pdfAvailable]);
    const { result } = renderHook(() => useMaterialView(material));
    await act(async () => { result.current.select("pdf"); await flush(); });
    expect(result.current.view).toBe("web");
    expect(result.current.fetchError).toEqual({ view: "pdf", message: "arxiv.org did not answer." });
    expect(localStorage.getItem("read:view:m1")).toBeNull();
    await act(async () => { result.current.select("pdf"); await flush(); });
    expect(fetchMaterialView).toHaveBeenCalledTimes(2);
    expect(result.current.fetchError).toBeUndefined();
    expect(result.current.view).toBe("pdf");
  });

  it("surfaces a failed view's retry through fetch without switching, and reports the engine's refusal", async () => {
    const failed: MaterialView = { ...pdfAvailable, status: "failed", error: "HTTP 503" };
    const fetchMaterialView = vi.fn(async () => ({ ok: false as const, code: "PREVIEW_MODE", message: "Not in the preview." }));
    api.read = mockRead({ fetchMaterialView });
    const material = record([webView, failed]);
    const { result } = renderHook(() => useMaterialView(material));
    await act(async () => { await result.current.fetch("pdf"); });
    expect(fetchMaterialView).toHaveBeenCalledWith("m1", "pdf");
    expect(result.current.fetchError).toEqual({ view: "pdf", message: "Not in the preview." });
    expect(result.current.view).toBe("web");
    act(() => { result.current.dismissFetchError(); });
    expect(result.current.fetchError).toBeUndefined();
  });

  it("makes a view primary and then reads the record's own content for it", async () => {
    const promoted = record([webView, pdfReady], "pdf");
    const setPrimaryView = vi.fn(async () => promoted);
    const getMaterialView = vi.fn(async () => pdfContent);
    api.read = mockRead({ setPrimaryView, getMaterialView });
    const onMaterialChanged = vi.fn();
    const { result, rerender } = renderHook(({ material }) => useMaterialView(material, onMaterialChanged), { initialProps: { material: record([webView, pdfReady]) } });
    act(() => { result.current.select("pdf"); });
    await act(flush);
    expect(getMaterialView).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.makePrimary("pdf"); });
    expect(setPrimaryView).toHaveBeenCalledWith("m1", "pdf");
    expect(onMaterialChanged).toHaveBeenCalledWith(promoted);
    rerender({ material: promoted });
    expect(result.current.primaryView).toBe("pdf");
    expect(result.current.view).toBe("pdf");
    expect(result.current.content).toEqual({ status: "ready", content: pdfContent });
    expect(getMaterialView).toHaveBeenCalledTimes(1);
  });
});
