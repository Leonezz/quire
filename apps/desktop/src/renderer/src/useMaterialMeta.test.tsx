// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MaterialRecord } from "../../shared/contracts";
import { mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { resetPatch, useMaterialMeta, validatePatch } from "./useMaterialMeta";

const extracted = { kind: "webpage" as const, title: "Extracted title", creators: [{ role: "author" as const, name: "Ada Lovelace" }], date: "2024-05-21", url: "https://example.org/a" };
const record = (overrides?: MaterialRecord["overrides"]): MaterialRecord => ({
  id: "m1", url: "https://example.org/a", finalUrl: "https://example.org/a", title: overrides?.title ?? extracted.title, fetchedAt: "2026-09-18T00:00:00.000Z", readingMinutes: 3, origin: "web", mediaType: "text/html",
  quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "strong", safety: "safe", warnings: [] }, tags: [], kind: "webpage", problems: [],
  views: [{ id: "web", label: "Web", url: "https://example.org/a", mediaType: "text/html", status: "ready" }], primaryView: "web", readyViews: ["web"],
  extracted, ...(overrides ? { overrides } : {}), meta: { ...extracted, ...(overrides ?? {}) },
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("useMaterialMeta", () => {
  it("sends the patch, hands the record back and reports the override", async () => {
    const saved = record({ title: "My title" });
    const updateMaterialMeta = vi.fn(async () => saved);
    api.read = mockRead({ updateMaterialMeta });
    const onSaved = vi.fn();
    const { result, rerender } = renderHook(({ material }) => useMaterialMeta(material, onSaved), { initialProps: { material: record() } });
    expect(result.current.overridden("title")).toBe(false);
    let ok = false;
    await act(async () => { ok = await result.current.save({ title: "My title" }); });
    expect(ok).toBe(true);
    expect(updateMaterialMeta).toHaveBeenCalledWith("m1", { title: "My title" });
    expect(onSaved).toHaveBeenCalledWith(saved);
    rerender({ material: saved });
    expect(result.current.overridden("title")).toBe(true);
    expect(result.current.extractedOf("title")).toBe("Extracted title");
    expect(result.current.extractedOf("creators")).toBe("Ada Lovelace");
  });

  it("resets with an empty string for text and an empty list for creators, tags and related", async () => {
    const updateMaterialMeta = vi.fn(async () => record());
    api.read = mockRead({ updateMaterialMeta });
    const { result } = renderHook(() => useMaterialMeta(record({ title: "x", creators: [{ role: "editor", name: "B" }] }), () => undefined));
    await act(async () => { await result.current.reset("title"); });
    expect(updateMaterialMeta).toHaveBeenLastCalledWith("m1", { title: "" });
    await act(async () => { await result.current.reset("creators"); });
    expect(updateMaterialMeta).toHaveBeenLastCalledWith("m1", { creators: [] });
    expect(resetPatch("tags")).toEqual({ tags: [] });
    expect(resetPatch("related")).toEqual({ related: [] });
    expect(resetPatch("kind")).toEqual({ kind: "" });
  });

  it("rejects a malformed date before calling the engine and keeps the message under the field", async () => {
    const updateMaterialMeta = vi.fn(async () => record());
    api.read = mockRead({ updateMaterialMeta });
    const { result } = renderHook(() => useMaterialMeta(record(), () => undefined));
    let ok = true;
    await act(async () => { ok = await result.current.save({ date: "05/2024" }); });
    expect(ok).toBe(false);
    expect(updateMaterialMeta).not.toHaveBeenCalled();
    expect(result.current.errors.date).toMatch(/YYYY-MM/);
    await act(async () => { ok = await result.current.save({ date: "2024-05" }); });
    expect(ok).toBe(true);
    expect(result.current.errors.date).toBeUndefined();
    expect(validatePatch({ creators: [{ role: "author", name: " " }] }).creators).toBeDefined();
  });

  it("surfaces the engine's error for the field it was saving", async () => {
    api.read = mockRead({ updateMaterialMeta: vi.fn(async () => { throw new Error("Unknown material type"); }) });
    const onSaved = vi.fn();
    const { result } = renderHook(() => useMaterialMeta(record(), onSaved));
    await act(async () => { await result.current.save({ kind: "book" }); });
    expect(result.current.errors.kind).toBe("Unknown material type");
    expect(onSaved).not.toHaveBeenCalled();
    expect(result.current.saving).toBeUndefined();
  });
});
