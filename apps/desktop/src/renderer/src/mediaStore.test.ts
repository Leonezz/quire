// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaterialRecord } from "../../shared/contracts";
import { mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { activeChapterOf, createMediaStore } from "./mediaStore";

function episode(id = "0123456789abcdef"): MaterialRecord {
  const meta = { kind: "podcastEpisode" as const, title: "Scaling Laws", publication: "Dwarkesh Podcast" };
  return {
    id,
    url: "https://dwarkesh.example.test/p/scaling",
    finalUrl: "https://dwarkesh.example.test/p/scaling",
    title: "Scaling Laws",
    fetchedAt: "2026-11-25T00:00:00.000Z",
    readingMinutes: 45,
    origin: "feed",
    mediaType: "text/x-quire-transcript",
    quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "strong", safety: "safe", warnings: [] },
    tags: [],
    kind: "podcastEpisode",
    readyViews: ["transcript", "shownotes"],
    publication: "Dwarkesh Podcast",
    extracted: meta,
    meta,
    views: [{ id: "transcript", label: "Transcript", url: "https://dwarkesh.example.test/ep.vtt", mediaType: "text/x-quire-transcript", status: "ready" }],
    primaryView: "transcript",
    problems: [],
    media: {
      kind: "audio",
      provider: "podcast",
      streamUrl: "https://cdn.example.test/ep.mp3",
      durationSec: 100,
      transcriptOrigin: "official",
      chapters: [
        { startSec: 0, title: "Cold Open" },
        { startSec: 30, title: "Pre-training" },
        { startSec: 75, title: "Reasoning" },
      ],
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mediaStore", () => {
  it("hydrates saved media state, scrubs, remembers per-show speed, and records finished at 90%", async () => {
    const saveMediaState = vi.fn(async () => undefined);
    const recordReadingEvent = vi.fn(async () => ({ id: "e1", kind: "finished" as const, ref: "0123456789abcdef", at: "" }));
    api.read = mockRead({
      getMediaState: vi.fn(async () => ({
        materialId: "0123456789abcdef",
        positionSec: 28,
        durationSec: 100,
        playbackSpeed: 1.5,
        updatedAt: "2026-11-25T00:00:00.000Z",
      })),
      saveMediaState,
      recordReadingEvent,
    });

    const store = createMediaStore();
    const mat = episode();
    await store.hydrateMaterial(mat);
    expect(store.getState().positionSec).toBe(28);
    expect(store.getState().playbackSpeed).toBe(1.5);
    expect(activeChapterOf(store.getState().chapters, 28)?.title).toBe("Cold Open");

    await store.seekTo(89, mat, true);
    expect(store.getState().playing).toBe(true);
    expect(activeChapterOf(store.getState().chapters, 89)?.title).toBe("Reasoning");
    expect(recordReadingEvent).not.toHaveBeenCalled();

    // Advance 1s at 1.5x -> crosses 90s / 100s (90%) threshold
    vi.advanceTimersByTime(1000);
    expect(store.getState().positionSec).toBeGreaterThanOrEqual(90);
    expect(recordReadingEvent).toHaveBeenCalledTimes(1);
    expect(recordReadingEvent).toHaveBeenCalledWith("finished", "0123456789abcdef");

    store.stop();
    expect(store.getState().materialId).toBeUndefined();
  });

  it("plays a selected passage snippet and auto-pauses at the snippet end", async () => {
    api.read = mockRead({
      getMediaState: vi.fn(async () => undefined),
      saveMediaState: vi.fn(async () => undefined),
      recordReadingEvent: vi.fn(async () => ({ id: "e1", kind: "finished" as const, ref: "0123456789abcdef", at: "" })),
    });
    const store = createMediaStore();
    const mat = episode();
    await store.playSnippet(mat, 10, 11);
    expect(store.getState().playing).toBe(true);
    expect(store.getState().positionSec).toBe(10);

    vi.advanceTimersByTime(1500);
    expect(store.getState().playing).toBe(false);
    expect(store.getState().positionSec).toBe(11);
    store.stop();
  });
});
