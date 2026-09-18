// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchHit } from "../../shared/contracts";
import { deferred, flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { SearchPalette } from "./SearchPalette";

const hit = (id: string, title: string): SearchHit => ({ kind: "material", id, title, subtitle: "example.org" });
// The debounce is 120 ms of real time: the overlay mounts through a portal on its own schedule, so the clock stays real.
const settle = () => act(() => new Promise<void>((resolve) => { setTimeout(resolve, 160); }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("SearchPalette", () => {
  it("debounces typing into one search and ignores a stale response", async () => {
    const first = deferred<SearchHit[]>();
    const second = deferred<SearchHit[]>();
    const search = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    api.read = mockRead({ search });
    const onOpenMaterial = vi.fn();
    render(<SearchPalette open onOpenChange={() => undefined} onOpenMaterial={onOpenMaterial} onOpenItem={() => undefined} />);
    const input = await screen.findByRole("searchbox", { name: "Search" });

    fireEvent.change(input, { target: { value: "h" } });
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.change(input, { target: { value: "hig" } });
    expect(search).not.toHaveBeenCalled();
    await settle();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("hig");

    fireEvent.change(input, { target: { value: "highlight" } });
    await settle();
    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenLastCalledWith("highlight");

    // The older search answers last: its hits must not replace the newer ones.
    await act(async () => { second.resolve([hit("b", "Highlight API")]); await flush(); });
    await act(async () => { first.resolve([hit("a", "Stale hit")]); await flush(); });
    expect(screen.getByText("Highlight API")).toBeTruthy();
    expect(screen.queryByText("Stale hit")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("1 hit");
  });

  it("shows a failed search as an error", async () => {
    api.read = mockRead({ search: vi.fn(async () => { throw new Error("index locked"); }) });
    render(<SearchPalette open onOpenChange={() => undefined} onOpenMaterial={() => undefined} onOpenItem={() => undefined} />);
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search" }), { target: { value: "x" } });
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("index locked");
  });
});
