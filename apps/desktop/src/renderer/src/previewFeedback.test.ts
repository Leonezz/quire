// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaterialRecord } from "../../shared/contracts";
import { PREVIEW_STEP_MS, createPreviewFeedback } from "./previewFeedback";

const quality: MaterialRecord["quality"] = { completeness: "declared_full", conformance: "recoverable", identityConfidence: "strong", safety: "safe", warnings: [] };
const material = {
  id: "a1b2c3d4e5f60718", url: "https://example.org/post", finalUrl: "https://example.org/post", title: "A Post, Twice", fetchedAt: "2026-09-20T10:00:00.000Z", readingMinutes: 4, origin: "web", mediaType: "text/html",
  quality, tags: [], kind: "webpage", readyViews: ["web"], extracted: {}, meta: {}, views: [], primaryView: "web", problems: [], capture: { byteLength: 20_000, mediaType: "text/html" },
} as MaterialRecord;

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the preview's one-step report", () => {
  it("walks through the progress steps and returns a packaged record, kept for Settings", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const api = createPreviewFeedback({ getMaterial: async () => material });
    const steps: string[] = [];
    const unsubscribe = api.onFeedbackProgress((progress) => steps.push(progress.step));
    const selection = { quote: "a passage", prefix: "before", suffix: "after", rect: { x: 1, y: 2, width: 3, height: 4 } };
    const running = api.feedbackSubmit({ materialId: material.id, view: "web", kinds: [], note: "", includeCapture: true, viewport: { x: 0, y: 0, width: 800, height: 600, scrollFraction: 0.5 }, selection, prefs: { font: "serif" } });
    await vi.advanceTimersByTimeAsync(PREVIEW_STEP_MS * 4);
    const record = await running;
    unsubscribe();
    expect(steps).toEqual(["capturing", "rendering-original", "packaging", "opening"]);
    expect(record.package?.zipPath).toMatch(new RegExp(`/${record.id}/quire-report-a-post-twice-${record.id}\\.zip$`));
    expect(record.package?.screenshots).toContain("screenshots/original-selection.png");
    expect(record.package?.warnings).toEqual([]);
    expect(record.selection).toEqual({ quote: "a passage", prefix: "before", suffix: "after" });
    expect(record.readerState).toEqual({ scrollFraction: 0.5, prefs: { font: "serif" } });
    expect(open).toHaveBeenCalledWith(expect.stringContaining("Problems%3A**+not+given"), "_blank", "noopener");
    expect((await api.feedbackList())[0]?.package?.zipBytes).toBe(record.package?.zipBytes);
    await expect(api.feedbackCopyScreenshot(record.id)).resolves.toBeUndefined();
  });

  it("refuses an original the material does not have", async () => {
    const { capture: _capture, ...bare } = material;
    const api = createPreviewFeedback({ getMaterial: async () => bare });
    await expect(api.feedbackSubmit({ materialId: material.id, view: "web", kinds: [], note: "", includeCapture: true, prefs: {} })).rejects.toThrow("no saved original page");
  });
});
