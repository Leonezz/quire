// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeTextQuoteV2Locator } from "@read/reader";
import type { Annotation, MaterialRecord } from "../../shared/contracts";
import { flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { MaterialReader } from "./MaterialReader";
import { NotesPanel, type NotePlacement } from "./NotesPanel";
import { DEFAULT_PREFS, setReadingPrefs } from "./readingPrefs";

// A highlight whose text changed under it is drawn approximately and says so; one whose text is gone is listed
// apart in the Notes panel, still copyable, exported and deletable, with nothing to jump to.

const quality = { completeness: "declared_full" as const, conformance: "conformant" as const, identityConfidence: "strong" as const, safety: "safe" as const, warnings: [] };
const ID = "526130b61f003c33";
const extracted = { kind: "webpage" as const, title: "CSS Custom Highlight API" };
const material: MaterialRecord = {
  id: ID, url: "https://example.org/a", finalUrl: "https://example.org/a", title: "CSS Custom Highlight API", fetchedAt: "2026-09-18T00:00:00.000Z", origin: "web", tags: [], kind: "webpage", problems: [],
  views: [{ id: "web", label: "Web", url: "https://example.org/a", mediaType: "text/html", status: "ready" }], primaryView: "web", readyViews: ["web"], mediaType: "text/html", readingMinutes: 3, quality, extracted, meta: extracted,
  markdown: "## Concepts\n\nThe API provides a mechanism for styling arbitrary text ranges on a document by using JavaScript.\n\n## Usage\n\nMore words follow here.",
};
const annotation = (partial: Partial<Annotation> & Pick<Annotation, "id" | "quote">): Annotation => ({
  materialId: ID, kind: "highlight", color: "#ffd400", createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z",
  locator: encodeTextQuoteV2Locator({ occurrence: 0, prefix: "", suffix: "" }), ...partial,
});
const placedNote = annotation({ id: "a1", quote: "More words follow here." });
// Highlighted when the sentence said "a method for"; the page now says "a mechanism for".
const editedNote = annotation({ id: "a2", quote: "The API provides a method for styling arbitrary text ranges on a document by using JavaScript.", locator: encodeTextQuoteV2Locator({ occurrence: 0, prefix: "Concepts", suffix: "Usage" }) });
// Highlighted in a paragraph this version no longer has.
const removedNote = annotation({ id: "a3", quote: "An earlier draft explained the registry in a paragraph of its own.", note: "Compare with the spec.", locator: encodeTextQuoteV2Locator({ occurrence: 0, prefix: "byusingJavaScript.", suffix: "Usage" }) });
const removedComment = annotation({ id: "a4", kind: "comment", quote: "A second passage that went away with it." });

const writeText = vi.fn(async (_text: string) => undefined);
beforeEach(() => {
  localStorage.clear();
  setReadingPrefs(DEFAULT_PREFS);
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("NotesPanel placements", () => {
  const placements: Record<string, NotePlacement> = { a1: "current", a2: "stale", a3: "unplaced", a4: "unplaced" };
  const panel = (props: { onJump?: (annotation: Annotation) => void; onDelete?: (id: string) => void } = {}) => render(
    <NotesPanel material={material} view="web" annotations={[placedNote, editedNote, removedNote, removedComment]} error={undefined} activeId={undefined} draft={null} onDraftChange={() => undefined}
      onJump={props.onJump ?? (() => undefined)} onUpdateNote={() => undefined} onDelete={props.onDelete ?? (() => undefined)} sectionFor={() => undefined} placementOf={(entry) => placements[entry.id]} />,
  );

  it("lists the notes it could not place apart, with their quote and note, and nothing to jump to", () => {
    const onJump = vi.fn();
    panel({ onJump });
    const unplaced = screen.getByRole("region", { name: "2 highlights could not be placed in this version" });
    const cards = within(unplaced).getAllByRole("listitem");
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining("An earlier draft explained the registry in a paragraph of its own."),
      expect.stringContaining("A second passage that went away with it."),
    ]);
    expect(cards[0]!.textContent).toContain("Compare with the spec.");
    expect(within(cards[0]!).getByText(/nothing to jump to/)).toBeTruthy();
    fireEvent.click(within(cards[0]!).getByText(/An earlier draft/));
    expect(onJump).not.toHaveBeenCalled();
    // Placed notes keep their jump; the panel's count still covers every note.
    expect(screen.getByRole("heading", { name: "4 notes" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /More words follow here/ }));
    expect(onJump).toHaveBeenCalledWith(placedNote);
  });

  it("keeps an unplaced note copyable, exported and deletable", async () => {
    const onDelete = vi.fn();
    panel({ onDelete });
    const card = within(screen.getByRole("region", { name: /could not be placed/ })).getAllByRole("listitem")[0]!;
    await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Copy citation" })); await flush(); });
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining("> An earlier draft explained the registry in a paragraph of its own."));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy all as Markdown" })); await flush(); });
    const markdown = writeText.mock.calls.at(-1)![0];
    expect(markdown).toContain("> An earlier draft explained the registry in a paragraph of its own.\n\nCompare with the spec.");
    expect(markdown).toContain("> A second passage that went away with it.");
    fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("a3");
  });

  it("says when a note was re-placed approximately, and still jumps to it", () => {
    const onJump = vi.fn();
    panel({ onJump });
    const jump = screen.getByRole("button", { name: /The API provides a method for/ });
    expect(jump.textContent).toContain("Re-placed approximately");
    fireEvent.click(jump);
    expect(onJump).toHaveBeenCalledWith(editedNote);
  });

  it("shows no unplaced line while every note is placed", () => {
    render(
      <NotesPanel material={material} view="web" annotations={[placedNote]} error={undefined} activeId={undefined} draft={null} onDraftChange={() => undefined}
        onJump={() => undefined} onUpdateNote={() => undefined} onDelete={() => undefined} sectionFor={() => undefined} placementOf={() => "current"} />,
    );
    expect(screen.queryByText(/could not be placed/)).toBeNull();
    expect(screen.queryByText(/Re-placed approximately/)).toBeNull();
  });
});

describe("Notes in the reader", () => {
  it("re-places an edited highlight approximately and lists a removed one as unplaced", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    api.read = mockRead({
      getMaterial: vi.fn(async () => material), listAnnotations: vi.fn(async () => [placedNote, editedNote, removedNote]), resolveImage: vi.fn(async (url: string) => url),
    });
    render(<MaterialReader id={ID} onOpenLink={() => undefined} onOpenMaterial={() => undefined} />);
    await act(async () => { await flush(); await flush(); });
    await act(async () => { fireEvent.keyDown(document.body, { key: "n" }); await flush(); });

    const unplaced = screen.getByRole("region", { name: "1 highlight could not be placed in this version" });
    expect(within(unplaced).getByText("An earlier draft explained the registry in a paragraph of its own.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /The API provides a method for/ }).textContent).toContain("Re-placed approximately");
    expect(screen.getByRole("button", { name: /More words follow here/ }).textContent).not.toContain("Re-placed");
    // The edited highlight's section comes from where the reader placed it.
    await act(async () => { fireEvent.click(within(screen.getByRole("button", { name: /The API provides a method for/ }).closest("li")!).getByRole("button", { name: "Copy citation" })); await flush(); });
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining(" · Concepts"));
  });
});
