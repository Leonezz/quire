// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaterialRecord } from "../../shared/contracts";
import { flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { MaterialReader } from "./MaterialReader";
import { YoutubeBridgeHost } from "./YoutubeBridgeHost";
import { mediaStore } from "./mediaStore";
import { DEFAULT_PREFS, setReadingPrefs } from "./readingPrefs";

const VID_MAT_ID = "0123456789abcdef";
const p0 = "Welcome to this deep dive into large language models and pretraining.";
const p1 = "Here on the whiteboard is how tokenization converts UTF-8 bytes into integer ids.";
const cap1 = "05:00 · Tokenization & BPE";
const plain = `Intro\n\n${p0}\n\nTokenization & BPE\n\n${cap1}\n\n${p1}`;

const videoDocPayload = JSON.stringify({
  type: "root",
  losses: [],
  children: [
    {
      type: "section",
      anchor: "t-0",
      children: [
        { type: "heading", depth: 2, anchor: "t-0", children: [{ type: "text", value: "Intro" }] },
        { type: "paragraph", children: [{ type: "text", value: p0 }] },
      ],
    },
    {
      type: "section",
      anchor: "t-300",
      children: [
        { type: "heading", depth: 2, anchor: "t-300", children: [{ type: "text", value: "Tokenization & BPE" }] },
        {
          type: "figure",
          media: [
            {
              type: "image",
              url: `quire-figure://${VID_MAT_ID}/1.png`,
              alt: cap1,
              title: null,
              width: 320,
              height: 180,
            },
          ],
          caption: [{ type: "text", value: cap1 }],
          credit: [],
        },
        { type: "paragraph", children: [{ type: "text", value: p1 }] },
      ],
    },
  ],
});

const videoMaterial: MaterialRecord = {
  id: VID_MAT_ID,
  url: "https://www.youtube.com/watch?v=zjkBMFhNj_g",
  finalUrl: "https://www.youtube.com/watch?v=zjkBMFhNj_g",
  title: "Deep Dive into LLMs",
  byline: "Andrej Karpathy",
  publication: "Andrej Karpathy",
  fetchedAt: "2026-11-25T12:00:00.000Z",
  readingMinutes: 60,
  origin: "web",
  mediaType: "text/x-quire-transcript",
  quality: {
    completeness: "declared_full",
    conformance: "conformant",
    identityConfidence: "strong",
    safety: "safe",
    warnings: [],
  },
  tags: [],
  kind: "videoRecording",
  readyViews: ["transcript", "shownotes"],
  extracted: {
    kind: "videoRecording",
    title: "Deep Dive into LLMs",
    publication: "Andrej Karpathy",
    creators: [{ role: "author", name: "Andrej Karpathy" }],
  },
  meta: {
    kind: "videoRecording",
    title: "Deep Dive into LLMs",
    publication: "Andrej Karpathy",
    creators: [{ role: "author", name: "Andrej Karpathy" }],
  },
  views: [
    {
      id: "transcript",
      label: "Transcript",
      url: "https://www.youtube.com/api/timedtext?v=zjkBMFhNj_g",
      mediaType: "text/x-quire-transcript",
      status: "ready",
    },
    {
      id: "shownotes",
      label: "Show notes",
      url: "https://www.youtube.com/watch?v=zjkBMFhNj_g",
      mediaType: "text/x-quire-shownotes",
      status: "ready",
    },
  ],
  primaryView: "transcript",
  reader: { schema: "reader.document.v2", payload: videoDocPayload },
  markdown: `## Intro\n\n[00:00] ${p0}\n\n## Tokenization & BPE\n\n![${cap1}](quire-figure://${VID_MAT_ID}/1.png)\n\n[05:00] ${p1}`,
  plain,
  timeAnchors: [
    { paragraphIndex: 0, start: 7, end: 7 + p0.length, startSec: 0, endSec: 299 },
    { paragraphIndex: 1, start: plain.length - p1.length, end: plain.length, startSec: 300, endSec: 600 },
  ],
  problems: [],
  media: {
    kind: "video",
    provider: "youtube",
    streamUrl: "https://www.youtube.com/watch?v=zjkBMFhNj_g",
    videoId: "zjkBMFhNj_g",
    durationSec: 3600,
    transcriptOrigin: "captions",
    chapters: [
      { startSec: 0, title: "Intro" },
      { startSec: 300, title: "Tokenization & BPE" },
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

describe("YouTube video article-first reading and collapsible VideoDock", () => {
  it("opens with video collapsed showing inline keyframe figures, expands VideoDock when clicking a keyframe or pressing m, and skips ±10s with j/l", async () => {
    api.read = mockRead({
      getMaterial: vi.fn(async () => videoMaterial),
      listAnnotations: vi.fn(async () => []),
      resolveImage: vi.fn(async () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
      getMediaState: vi.fn(async () => undefined),
      saveMediaState: vi.fn(async () => undefined),
    });

    render(
      <>
        <MaterialReader id={VID_MAT_ID} onOpenLink={() => undefined} onOpenMaterial={() => undefined} />
        <YoutubeBridgeHost />
      </>,
    );
    await act(async () => {
      await flush();
      await flush();
    });

    // Default state: quiet article page with captions badge, inline keyframe figure, and NO video dock open
    expect(screen.getByRole("button", { name: "Quality: captions" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Companion video" })).toBeNull();
    const captionNode = screen.getByText("05:00 · Tokenization & BPE");
    expect(captionNode.closest("figure")).toBeTruthy();

    // Clicking the inline keyframe figure seeks to 05:00 (300s), starts playback, and expands VideoDock
    await act(async () => {
      fireEvent.click(captionNode);
      await flush();
      await flush();
    });
    expect(mediaStore.getState().positionSec).toBe(300);
    expect(mediaStore.getState().playing).toBe(true);
    expect(mediaStore.getState().videoOpen).toBe(true);
    expect(screen.getByRole("region", { name: "Companion video" })).toBeTruthy();

    // Video skip keys use ±10s (`l` -> +10s, `j` -> -10s)
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "l" });
      await flush();
    });
    expect(mediaStore.getState().positionSec).toBe(310);

    // Pressing `m` collapses the video dock without interrupting audio playback
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "m" });
      await flush();
    });
    expect(mediaStore.getState().videoOpen).toBe(false);
    expect(mediaStore.getState().playing).toBe(true);
    expect(screen.queryByRole("region", { name: "Companion video" })).toBeNull();
  });
});
