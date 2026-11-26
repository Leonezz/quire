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

  it("upgrades collapsed podcast show notes into headings and clickable timestamp outline items while deduplicating identical host/publication", async () => {
    const collapsedNotes =
      "本期嘉宾 Oliver Schusser 负责 Apple Music 副总裁 赛博对话官 电动Emma 节目介绍 从iPod到AI音乐创作。 核心议题01:14 AI生成音乐浪潮下如何应对挑战 04:08 音乐行业真正稀缺的价值是什么";
    const showNotesOnly: MaterialRecord = {
      ...podcastMaterial,
      id: "b2c3d4e5f6071829",
      title: "vol.62 | 播客到底怎么赚钱？",
      byline: "赛博对话",
      publication: "赛博对话",
      mediaType: "text/x-quire-shownotes",
      primaryView: "shownotes",
      readyViews: ["shownotes"],
      views: [
        {
          id: "shownotes",
          label: "Show notes",
          url: "https://podcasts.apple.com/cn/podcast/id1?i=2",
          mediaType: "text/x-quire-shownotes",
          status: "ready",
        },
      ],
      extracted: {
        kind: "podcastEpisode",
        title: "vol.62 | 播客到底怎么赚钱？",
        publication: "赛博对话",
        creators: [{ role: "host", name: "赛博对话" }],
        date: "2026-11-24",
      },
      meta: {
        kind: "podcastEpisode",
        title: "vol.62 | 播客到底怎么赚钱？",
        publication: "赛博对话",
        creators: [{ role: "host", name: "赛博对话" }],
        date: "2026-11-24",
      },
      reader: {
        schema: "reader.document.v2",
        payload: JSON.stringify({
          type: "root",
          losses: [],
          children: [{ type: "paragraph", children: [{ type: "text", value: collapsedNotes }] }],
        }),
      },
      markdown: collapsedNotes,
      plain: collapsedNotes,
      timeAnchors: undefined,
      media: {
        kind: "audio",
        provider: "podcast",
        streamUrl: "https://cdn.example.test/ep62.m4a",
        durationSec: 1635,
        transcriptOrigin: "absent",
      },
    };

    api.read = mockRead({
      getMaterial: vi.fn(async () => showNotesOnly),
      listAnnotations: vi.fn(async () => []),
      resolveImage: vi.fn(async (u: string) => u),
      getMediaState: vi.fn(async () => undefined),
      saveMediaState: vi.fn(async () => undefined),
      getUpdateState: vi.fn(async () => ({ phase: "idle" as const, current: "0.2.0" })),
    });

    render(
      <MaterialReader id={showNotesOnly.id} onOpenLink={() => undefined} onOpenMaterial={() => undefined} />,
    );
    await act(async () => {
      await flush();
      await flush();
    });

    // Host and publication ("赛博对话") appear once in the header byline, not twice
    expect(screen.getAllByText("赛博对话")).toHaveLength(1);

    // Structured headings and list items are rendered instead of one collapsed paragraph
    expect(screen.getByRole("heading", { name: "本期嘉宾" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "节目介绍" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "核心议题" })).toBeTruthy();

    const jumpBtn = screen.getByRole("button", { name: "Jump to 04:08" });
    await act(async () => {
      fireEvent.click(jumpBtn);
      await flush();
    });
    expect(mediaStore.getState().playing).toBe(true);
    expect(mediaStore.getState().positionSec).toBe(248);
  });

  it("renders margin timestamps and speaker labels inside sectioned agent-refined transcripts and protects cached media behind a confirmation menu", async () => {
    const refinedP0 = "今天我们聊聊双十一最早是怎么从校园光棍节变成线上促销的。";
    const refinedP1 = "其实最早做打折专场的并不是电商平台，而是盛大游戏的点卡充值活动。";
    const refinedPlain = `促销起源\n\n${refinedP0}\n\n${refinedP1}`;
    const refinedMaterial: MaterialRecord = {
      ...podcastMaterial,
      id: "c3d4e5f60718293a",
      reader: {
        schema: "reader.document.v2",
        payload: JSON.stringify({
          type: "root",
          losses: [],
          children: [
            {
              type: "section",
              anchor: "t-0",
              children: [
                { type: "heading", depth: 2, anchor: "t-0", children: [{ type: "text", value: "促销起源" }] },
                { type: "paragraph", children: [{ type: "text", value: refinedP0 }] },
                { type: "paragraph", children: [{ type: "text", value: refinedP1 }] },
              ],
            },
          ],
        }),
      },
      markdown: `## 促销起源\n\n[00:12] **主持人**: ${refinedP0}\n\n[00:45] **嘉宾**: ${refinedP1}`,
      plain: refinedPlain,
      timeAnchors: [
        { paragraphIndex: 0, start: 6, end: 6 + refinedP0.length, startSec: 12, endSec: 45, speaker: "主持人" },
        {
          paragraphIndex: 1,
          start: refinedPlain.length - refinedP1.length,
          end: refinedPlain.length,
          startSec: 45,
          endSec: 90,
          speaker: "嘉宾",
        },
      ],
      media: {
        kind: "audio",
        provider: "podcast",
        streamUrl: "https://cdn.example.test/ep-refined.m4a",
        durationSec: 4642,
        cachedBytes: 65_011_712,
        transcriptOrigin: "agent_refined",
      },
    };

    const removeMediaCache = vi.fn(async () => ({
      ...refinedMaterial,
      media: { ...refinedMaterial.media!, cachedBytes: undefined },
    }));

    api.read = mockRead({
      getMaterial: vi.fn(async () => refinedMaterial),
      getMaterialView: vi.fn(async (_id, view) =>
        view === "shownotes"
          ? {
              view: "shownotes" as const,
              mediaType: "text/x-quire-shownotes",
              markdown: "本期简介",
              plain: "本期简介",
              readingMinutes: 1,
              quality: refinedMaterial.quality,
              problems: [],
            }
          : undefined,
      ),
      listAnnotations: vi.fn(async () => []),
      resolveImage: vi.fn(async (u: string) => u),
      getMediaState: vi.fn(async () => undefined),
      saveMediaState: vi.fn(async () => undefined),
      removeMediaCache,
      listTranscriptionJobs: vi.fn(async () => []),
      getUpdateState: vi.fn(async () => ({ phase: "idle" as const, current: "0.2.0" })),
    });

    const { container } = render(
      <MaterialReader id={refinedMaterial.id} onOpenLink={() => undefined} onOpenMaterial={() => undefined} />,
    );
    await act(async () => {
      await flush();
      await flush();
    });

    // Sectioned `<section> > <p>` paragraphs receive margin timestamps flush with speaker header (`0px` extra offset) and `data-speaker` attributes
    const stamp0 = screen.getByText("00:12") as HTMLElement;
    const stamp1 = screen.getByText("00:45") as HTMLElement;
    expect(stamp0).toBeTruthy();
    expect(stamp1).toBeTruthy();
    expect(stamp0.style.top).toBe("0px");
    const speakerParas = container.querySelectorAll("p[data-speaker]");
    expect(speakerParas).toHaveLength(2);
    expect(speakerParas[0]?.getAttribute("data-speaker")).toBe("主持人");
    expect(speakerParas[1]?.getAttribute("data-speaker")).toBe("嘉宾");

    // Clicking the cached checkmark opens a menu instead of immediately deleting the offline file
    const cachedBtn = screen.getByRole("button", { name: /Downloaded offline/i });
    await act(async () => {
      fireEvent.click(cachedBtn);
      await flush();
    });
    expect(removeMediaCache).not.toHaveBeenCalled();
    expect(screen.getByText(/Remove offline copy/i)).toBeTruthy();
  });
});
