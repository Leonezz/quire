// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { SplitGroup } from "@read/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ItemRecord } from "../../shared/contracts";
import { flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { InboxView } from "./InboxView";

const item = (id: string, title: string): ItemRecord => ({ id, sourceId: "s", sourceTitle: "S", sourceKind: "feed", title, gist: "", link: `https://x/${id}`, publishedAt: "2026-09-18T00:00:00.000Z", fetchedAt: "2026-09-18T00:00:00.000Z", readingMinutes: 1, signals: {}, summaryOnly: false });
const shell = { listToolbar: null, trailing: null, agentPanel: undefined };

/** The Inbox as App drives it: the selection lives above the view, and refresh drops decided items. */
function Inbox({ initial, decided }: { initial: ItemRecord[]; decided: Set<string> }) {
  const [items, setItems] = useState(initial);
  const [selectedId, setSelectedId] = useState<string | undefined>(initial[0]?.id);
  const refresh = async () => { setItems((current) => current.filter((entry) => !decided.has(entry.id))); };
  return (
    <SplitGroup id="content" aria-label="Content">
      <InboxView items={items} selectedId={selectedId} onSelect={setSelectedId} refresh={refresh} onOpenLink={() => undefined} onOpenMaterial={() => undefined} shell={shell} empty="Nothing new." />
    </SplitGroup>
  );
}

const selectedRow = () => screen.getAllByRole("row").find((row) => row.getAttribute("aria-selected") === "true");

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("InboxView", () => {
  it("queues the selected row on q even when another row starts with Q, twice in a row", async () => {
    const decided = new Set<string>();
    const decideItem = vi.fn(async (id: string) => { decided.add(id); return { ...item(id, id), queuedAt: "now" }; });
    api.read = mockRead({ decideItem });
    render(<Inbox decided={decided} initial={[item("a", "Alpha"), item("b", "Bravo"), item("c", "Quoting The New York Times"), item("d", "Error Rate is Not Enough")]} />);

    // The decision letters are not typeahead: q on a focused row queues it instead of jumping to "Quoting…".
    const first = selectedRow();
    expect(first?.textContent).toContain("Alpha");
    act(() => { first?.focus(); });
    await act(async () => { fireEvent.keyDown(first!, { key: "q" }); await flush(); });
    expect(decideItem).toHaveBeenCalledTimes(1);
    expect(decideItem).toHaveBeenLastCalledWith("a", "queue");

    // The selection moved on to the next row; with focus back on the list, q queues that one too.
    const second = selectedRow();
    expect(second?.textContent).toContain("Bravo");
    act(() => { second?.focus(); });
    await act(async () => { fireEvent.keyDown(second!, { key: "q" }); await flush(); });
    expect(decideItem).toHaveBeenCalledTimes(2);
    expect(decideItem).toHaveBeenLastCalledWith("b", "queue");
    expect(selectedRow()?.textContent).toContain("Quoting The New York Times");
  });
});
