// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ItemRecord } from "../../shared/contracts";
import { mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { neighbourOf, useItemReader } from "./useItemReader";

const item = (id: string): ItemRecord => ({ id, sourceId: "s", sourceTitle: "S", sourceKind: "feed", title: id, gist: "", link: `https://x/${id}`, publishedAt: "2026-09-18T00:00:00.000Z", fetchedAt: "2026-09-18T00:00:00.000Z", readingMinutes: 1, signals: {}, summaryOnly: false });

function setup(selectedId: string) {
  const onSelect = vi.fn();
  const refresh = vi.fn(async () => undefined);
  const hook = renderHook(() => useItemReader({ orderedIds: ["a", "b", "c"], selectedId, onSelect, refresh, leavesOnRead: true, leavesOnKeep: true, shortcuts: { q: "queue", e: "dismiss" } }));
  return { ...hook, onSelect, refresh };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("neighbourOf", () => {
  it("lands on the next row, or the previous one for the last row", () => {
    expect(neighbourOf(["a", "b", "c"], "a")).toBe("b");
    expect(neighbourOf(["a", "b", "c"], "c")).toBe("b");
    expect(neighbourOf(["a"], "a")).toBeUndefined();
    expect(neighbourOf(["a", "b"], "zzz")).toBe("a");
  });
});

describe("useItemReader", () => {
  it("moves the selection to the neighbour after a decision and refreshes", async () => {
    api.read = mockRead({ decideItem: vi.fn(async (id: string) => ({ ...item(id), queuedAt: "now" })) });
    const { result, onSelect, refresh } = setup("a");
    await act(async () => { await result.current.decide("a", "queue"); });
    expect(api.read.decideItem).toHaveBeenCalledWith("a", "queue");
    expect(onSelect).toHaveBeenCalledWith("b");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.decisionError).toBeUndefined();
  });

  it("scopes a failed decision to its item and clears it when the selection changes", async () => {
    api.read = mockRead({ decideItem: vi.fn(async () => { throw new Error("engine says no"); }) });
    const { result, onSelect } = setup("a");
    await act(async () => { await result.current.decide("a", "dismiss"); });
    expect(result.current.decisionError).toEqual({ itemId: "a", message: "engine says no" });
    // The selection did not move: the decision did not go through.
    expect(onSelect).not.toHaveBeenCalled();
    act(() => { result.current.select("b"); });
    expect(onSelect).toHaveBeenCalledWith("b");
    expect(result.current.decisionError).toBeUndefined();
  });

  it("opens the reader on Read now and moves on when the item leaves the list", async () => {
    api.read = mockRead({ readItem: vi.fn(async () => ({ ok: true as const, material: { id: "m1" } as never })) });
    const { result, onSelect } = setup("b");
    await act(async () => { await result.current.readNow("b"); });
    expect(result.current.reading).toEqual({ itemId: "b", materialId: "m1" });
    expect(onSelect).toHaveBeenCalledWith("c");
  });

  it("keeps a read failure on the item it belongs to", async () => {
    api.read = mockRead({ readItem: vi.fn(async () => ({ ok: false as const, code: "X", message: "no engine" })) });
    const { result } = setup("a");
    await act(async () => { await result.current.readNow("a"); });
    expect(result.current.failure).toEqual({ itemId: "a", message: "no engine", action: "read" });
    expect(result.current.reading).toBeUndefined();
  });
});
