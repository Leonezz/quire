// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ItemRecord } from "../../shared/contracts";
import { deferred, flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { orderBy, reorderIds, useQueueOrder } from "./useQueueOrder";

const item = (id: string, opened = false): ItemRecord => ({ id, sourceId: "s", sourceTitle: "S", sourceKind: "feed", title: id, gist: "", link: `https://x/${id}`, publishedAt: "2026-09-18T00:00:00.000Z", fetchedAt: "2026-09-18T00:00:00.000Z", readingMinutes: 1, signals: {}, summaryOnly: false, queuedAt: "q", ...(opened ? { openedAt: "o" } : {}) });
const ids = (list: readonly ItemRecord[]) => list.map((entry) => entry.id);

afterEach(() => { vi.restoreAllMocks(); });

describe("reorderIds / orderBy", () => {
  it("places the moved ids before or after the target", () => {
    expect(reorderIds(["a", "b", "c", "d"], ["d"], "b", "before")).toEqual(["a", "d", "b", "c"]);
    expect(reorderIds(["a", "b", "c", "d"], ["a"], "c", "after")).toEqual(["b", "c", "a", "d"]);
    expect(reorderIds(["a", "b"], ["a"], "zzz", "after")).toEqual(["b", "a"]);
  });
  it("sorts items by a given order and keeps unnamed ones at the end", () => {
    expect(ids(orderBy([item("a"), item("b"), item("c")], ["c", "a"]))).toEqual(["c", "a", "b"]);
  });
});

describe("useQueueOrder", () => {
  it("applies each drop locally at once and a second drop starts from the local order, not the stale list", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const reorderQueue = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    api.read = mockRead({ reorderQueue });
    const refresh = vi.fn(async () => undefined);
    const items = [item("a", true), item("b"), item("c"), item("d")];
    const { result } = renderHook(() => useQueueOrder(items, refresh));
    expect(ids(result.current.continuing)).toEqual(["a"]);
    expect(ids(result.current.upNext)).toEqual(["b", "c", "d"]);

    act(() => { result.current.reorderUpNext(["d"], "b", "before"); });
    expect(ids(result.current.upNext)).toEqual(["d", "b", "c"]);
    expect(reorderQueue).toHaveBeenLastCalledWith(["a", "d", "b", "c"]);

    // Before the first save has come back, a second drop: computed from [d, b, c], never from the server's [b, c, d].
    act(() => { result.current.reorderUpNext(["c"], "d", "before"); });
    expect(ids(result.current.upNext)).toEqual(["c", "d", "b"]);
    expect(reorderQueue).toHaveBeenLastCalledWith(["a", "c", "d", "b"]);

    // The first save lands late: its refresh must not hand the order back to the (stale) list.
    await act(async () => { first.resolve(); await flush(); });
    expect(ids(result.current.upNext)).toEqual(["c", "d", "b"]);
    await act(async () => { second.resolve(); await flush(); });
    expect(refresh).toHaveBeenCalledTimes(2);
    // Only the latest save releases the local order to whatever the list now says.
    expect(ids(result.current.upNext)).toEqual(["b", "c", "d"]);
    expect(result.current.error).toBeUndefined();
  });

  it("drops the local order and reports the failure when the save is rejected", async () => {
    api.read = mockRead({ reorderQueue: vi.fn(async () => { throw new Error("order mismatch"); }) });
    const refresh = vi.fn(async () => undefined);
    const { result } = renderHook(() => useQueueOrder([item("b"), item("c")], refresh));
    await act(async () => { result.current.reorderUpNext(["c"], "b", "before"); await flush(); });
    expect(ids(result.current.upNext)).toEqual(["b", "c"]);
    expect(result.current.error).toBe("order mismatch");
    expect(refresh).not.toHaveBeenCalled();
  });
});
