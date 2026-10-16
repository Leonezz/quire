// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { SplitGroup, type Selection } from "@read/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MaterialSummary } from "../../shared/contracts";
import { flush, mockRead } from "./testApi";
import type { Library } from "./useLibrary";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));
// The reader of the selected material is not what these tests look at.
vi.mock("./MaterialReader", () => ({ MaterialReader: ({ id }: { id: string }) => <div>Reader of {id}</div> }));

import { LibraryView, type LibraryNotice } from "./LibraryView";

const summary = (id: string, title: string): MaterialSummary => ({ id, url: `https://example.test/${id}`, title, fetchedAt: "2026-09-18T00:00:00.000Z", readingMinutes: 3, origin: "web", mediaType: "text/html", quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "strong", safety: "safe", warnings: [] }, tags: [], kind: "webpage", readyViews: ["web"] });
const materials = [summary("aaaaaaaaaaaaaaaa", "Cache keys"), summary("bbbbbbbbbbbbbbbb", "Momentum")];
const library: Library = { materials, tags: [], sort: "newest", query: "", error: undefined, loading: false, setSort: () => undefined, setQuery: () => undefined, refresh: async () => undefined };
const shell = { listToolbar: null, trailing: null, agentPanel: undefined };

function renderLibrary(selected: Selection, notice: LibraryNotice | undefined) {
  render(
    <SplitGroup id="content" aria-label="Content">
      <LibraryView library={library} selected={selected} onSelectionChange={() => undefined} onOpenLink={() => undefined} onOpenMaterial={() => undefined} onOpenSettings={() => undefined} shell={shell} narrowed={false} notice={notice} />
    </SplitGroup>,
  );
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("LibraryView notice", () => {
  it("says a material added again was in the library already while it is the one selected", () => {
    api.read = mockRead();
    renderLibrary(new Set(["aaaaaaaaaaaaaaaa"]), { materialId: "aaaaaaaaaaaaaaaa", text: "Already in your library" });
    expect(screen.getByRole("status").textContent).toBe("Already in your library");
    expect(screen.queryByText("1 selected")).toBeNull();
    // Its own line: next to Copy BibTeX and Delete a narrow list column cut it to "Already in …".
    expect(screen.getByRole("status").closest(".truncate")).toBeNull();
  });

  it("shows the selection count instead once another material is selected", () => {
    api.read = mockRead();
    renderLibrary(new Set(["bbbbbbbbbbbbbbbb"]), { materialId: "aaaaaaaaaaaaaaaa", text: "Already in your library" });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("1 selected")).toBeTruthy();
  });
});

describe("LibraryView delete", () => {
  /** The view with its selection held the way App holds it, so a delete can clear it. */
  function SelectingLibrary({ initial }: { initial: Selection }) {
    const [selected, setSelected] = useState<Selection>(initial);
    return (
      <SplitGroup id="content" aria-label="Content">
        <LibraryView library={library} selected={selected} onSelectionChange={setSelected} onOpenLink={() => undefined} onOpenMaterial={() => undefined} onOpenSettings={() => undefined} shell={shell} narrowed={false} />
      </SplitGroup>
    );
  }

  it("closes the sheet on a delete that kept the pictures, and says why they were kept", async () => {
    const picturesKept = "The materials were deleted, but their cached pictures were kept: EACCES";
    api.read = mockRead({ deleteMaterials: vi.fn(async () => ({ picturesKept })) });
    render(<SelectingLibrary initial={new Set(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"])} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Delete 2/ })); await flush(); });
    const sheet = screen.getByRole("dialog", { name: "Delete 2 materials?" });
    await act(async () => { fireEvent.click(within(sheet).getByRole("button", { name: "Delete 2" })); await flush(); });
    expect(api.read.deleteMaterials).toHaveBeenCalledWith(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("2 selected")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe(picturesKept);
    // Selecting something again retires it: it does not come back once the selection is cleared.
    const row = screen.getAllByRole("row")[0]!;
    await act(async () => { fireEvent.click(row); await flush(); });
    expect(screen.getByText("1 selected")).toBeTruthy();
    await act(async () => { fireEvent.keyDown(row, { key: "Escape" }); await flush(); });
    expect(screen.queryByText("1 selected")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
