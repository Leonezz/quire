// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaterialRecord } from "../../shared/contracts";
import { flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { AppSidebar } from "./AppSidebar";
import { MaterialReader } from "./MaterialReader";
import { mediaStore } from "./mediaStore";
import { DEFAULT_PREFS, setReadingPrefs } from "./readingPrefs";

const ID = "a1b2c3d4e5f60718";
const p0 = "Welcome back to the podcast where we discuss scaling laws.";
const p1 = "Pretraining compute grew faster than tokens until the internet became finite.";
const plain = `${p0}\n\n${p1}`;

const docPayload = JSON.stringify({
  type: "root",
  losses: [],
  children: [
    { type: "paragraph", children: [{ type: "text", value: p0 }] },
    { type: "paragraph", children: [{ type: "text", value: p1 }] },
  ],
});

const podcastMaterial: MaterialRecord = {
  id: ID,
  url: "https://dwarkesh.example.test/p/scaling",
  finalUrl: "https://dwarkesh.example.test/p/scaling",
  title: "Ilya Sutskever — Scaling",
  byline: "Dwarkesh Patel",
  publication: "Dwarkesh Podcast",
  fetchedAt: "2026-11-25T10:00:00.000Z",
  readingMinutes: 62,
  origin: "feed",
  mediaType: "text/x-quire-transcript",
  quality: {
    completeness: "declared_full",
    conformance: "conformant",
    identityConfidence: "strong",
    safety: "safe",
    warnings: [],
  },
  tags: [],
  kind: "podcastEpisode",
  readyViews: ["transcript", "shownotes"],
  extracted: {
    kind: "podcastEpisode",
    title: "Ilya Sutskever — Scaling",
    publication: "Dwarkesh Podcast",
    creators: [{ role: "host", name: "Dwarkesh Patel" }],
  },
  meta: {
    kind: "podcastEpisode",
    title: "Ilya Sutskever — Scaling",
    publication: "Dwarkesh Podcast",
    creators: [{ role: "host", name: "Dwarkesh Patel" }],
  },
  views: [
    {
      id: "transcript",
      label: "Transcript",
      url: "https://dwarkesh.example.test/ep.vtt",
      mediaType: "text/x-quire-transcript",
      status: "ready",
    },
    {
      id: "shownotes",
      label: "Show notes",
      url: "https://dwarkesh.example.test/p/scaling",
      mediaType: "text/x-quire-shownotes",
      status: "ready",
    },
  ],
  primaryView: "transcript",
  reader: { schema: "reader.document.v2", payload: docPayload },
  markdown: `[00:00] **Dwarkesh**: ${p0}\n\n[04:38] **Ilya**: ${p1}`,
  plain,
  timeAnchors: [
    { paragraphIndex: 0, start: 0, end: p0.length, startSec: 0, endSec: 278, speaker: "Dwarkesh Patel" },
    { paragraphIndex: 1, start: p0.length + 2, end: plain.length, startSec: 278, endSec: 600, speaker: "Ilya Sutskever" },
  ],
  problems: [],
  media: {
    kind: "audio",
    provider: "podcast",
    streamUrl: "https://cdn.example.test/scaling.mp3",
    durationSec: 3720,
    transcriptOrigin: "official",
    chapters: [
      { startSec: 0, title: "Cold Open" },
      { startSec: 278, title: "Why Pre-training Changed" },
    ],
  },
};

beforeEach(() => {
  localStorage.clear();
  mediaStore.stop();
  setReadingPrefs(DEFAULT_PREFS);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});

afterEach(() => {
  mediaStore.stop();
  cleanup();
  vi.restoreAllMocks();
});

describe("Podcast reading and companion player", () => {
  it("renders margin timestamps in aria-hidden slots, syncs speaker turns and active paragraph, binds k/j/l without touching Space, and keeps NowPlayingBar in sidebar when navigating away", async () => {
    api.read = mockRead({
      getMaterial: vi.fn(async () => podcastMaterial),
      listAnnotations: vi.fn(async () => []),
      resolveImage: vi.fn(async (u: string) => u),
      getMediaState: vi.fn(async () => undefined),
      saveMediaState: vi.fn(async () => undefined),
      getUpdateState: vi.fn(async () => ({ phase: "idle" as const, current: "0.2.0" })),
    });

    const { unmount } = render(
      <MaterialReader id={ID} onOpenLink={() => undefined} onOpenMaterial={() => undefined} />,
    );
    await act(async () => {
      await flush();
      await flush();
    });

    // Quality pill shows publisher transcript
    expect(screen.getByRole("button", { name: "Quality: publisher transcript" })).toBeTruthy();

    // Margin timestamps sit inside an aria-hidden container so text selection & copy stay unpolluted
    const stampBtn = screen.getByText("04:38");
    expect(stampBtn.closest("[aria-hidden='true']")).toBeTruthy();

    // Speaker turns are set via data-speaker attribute (rendered with CSS ::before, not DOM text)
    const paragraphs = document.querySelectorAll<HTMLParagraphElement>(".reader-document > p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.getAttribute("data-speaker")).toBe("Dwarkesh Patel");
    expect(paragraphs[1]!.getAttribute("data-speaker")).toBe("Ilya Sutskever");
    expect(paragraphs[1]!.textContent).toBe(p1);

    // Clicking margin timestamp seeks to 04:38 (278s), starts playback, and marks paragraph 1 active
    await act(async () => {
      fireEvent.click(stampBtn);
      await flush();
    });
    expect(mediaStore.getState().playing).toBe(true);
    expect(mediaStore.getState().positionSec).toBe(278);
    expect(paragraphs[1]!.getAttribute("data-active-turn")).toBe("true");

    // Space does NOT pause playback (reserved for scrolling)
    const spaceEvent = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    document.dispatchEvent(spaceEvent);
    expect(spaceEvent.defaultPrevented).toBe(false);
    expect(mediaStore.getState().playing).toBe(true);

    // Pressing `k` toggles pause
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "k" });
      await flush();
    });
    expect(mediaStore.getState().playing).toBe(false);

    // Resume playback, then unmount reader (simulating switching back to Inbox): NowPlayingBar appears in AppSidebar
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "k" });
      await flush();
    });
    expect(mediaStore.getState().playing).toBe(true);
    unmount();

    const onOpenMaterial = vi.fn();
    render(
      <AppSidebar
        scope={{ kind: "inbox" }}
        onScope={() => undefined}
        inbox={[]}
        queueCount={0}
        conversationCount={0}
        runningCount={0}
        tags={[]}
        sources={[]}
        onHide={() => undefined}
        onOpenSettings={() => undefined}
        onOpenMaterial={onOpenMaterial}
      />,
    );
    const nowPlaying = screen.getByRole("region", { name: "Now playing" });
    expect(within(nowPlaying).getByText("Ilya Sutskever — Scaling")).toBeTruthy();
    fireEvent.click(within(nowPlaying).getByText("Ilya Sutskever — Scaling"));
    expect(onOpenMaterial).toHaveBeenCalledWith(ID);
  });
});
