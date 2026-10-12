import { describe, expect, it, vi } from "vitest";

// ipc-feedback.ts registers handlers on ipcMain; only its argument validation is tested here, without Electron.
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
const { feedbackSubmitDraft } = await import("./ipc-feedback");

const valid = {
  materialId: "0123456789abcdef", view: "web", kinds: [], note: "", includeCapture: true,
  viewport: { x: 240, y: 52, width: 760, height: 800, scrollFraction: 0.5 },
  selection: { quote: "The siege.", prefix: "Gondor ", suffix: "", rect: { x: 300, y: 400, width: 80, height: 20 } },
  prefs: { fontSize: 18, nested: { a: 1 } },
};

describe("feedbackSubmitDraft", () => {
  it("accepts a full draft with no kinds, and copies prefs as plain data", () => {
    const draft = feedbackSubmitDraft(valid);
    expect(draft).toEqual(valid);
    expect(draft.prefs).not.toBe(valid.prefs);
    const minimal = feedbackSubmitDraft({ ...valid, viewport: undefined, selection: undefined });
    expect(minimal).not.toHaveProperty("viewport");
    expect(minimal).not.toHaveProperty("selection");
  });

  it("drops fields it does not know", () => {
    expect(feedbackSubmitDraft({ ...valid, extra: "x" })).not.toHaveProperty("extra");
  });

  it.each([
    ["no object", null, "IPC_INVALID_FEEDBACK"],
    ["a bad material id", { ...valid, materialId: "../x" }, "IPC_INVALID_ID"],
    ["an unknown kind", { ...valid, kinds: ["typos"] }, "IPC_INVALID_FEEDBACK_KINDS"],
    ["a viewport without size", { ...valid, viewport: { ...valid.viewport, width: 0 } }, "IPC_INVALID_FEEDBACK_GEOMETRY"],
    ["a scroll fraction past the end", { ...valid, viewport: { ...valid.viewport, scrollFraction: 1.5 } }, "IPC_INVALID_FEEDBACK_GEOMETRY"],
    ["a non-finite coordinate", { ...valid, viewport: { ...valid.viewport, x: Number.NaN } }, "IPC_INVALID_FEEDBACK_GEOMETRY"],
    ["a blank quote", { ...valid, selection: { ...valid.selection, quote: "  " } }, "IPC_INVALID_FEEDBACK_SELECTION"],
    ["an oversized prefix", { ...valid, selection: { ...valid.selection, prefix: "x".repeat(2_001) } }, "IPC_INVALID_FEEDBACK_SELECTION"],
    ["a selection without a box", { ...valid, selection: { ...valid.selection, rect: undefined } }, "IPC_INVALID_FEEDBACK_GEOMETRY"],
    ["prefs that are a list", { ...valid, prefs: [] }, "IPC_INVALID_FEEDBACK_PREFS"],
    ["missing prefs", { ...valid, prefs: undefined }, "IPC_INVALID_FEEDBACK_PREFS"],
    ["huge prefs", { ...valid, prefs: { blob: "x".repeat(10_001) } }, "IPC_INVALID_FEEDBACK_PREFS"],
  ])("rejects %s", (_name, value, code) => {
    expect(() => feedbackSubmitDraft(value)).toThrow(code);
  });
});
