// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaterialRecord, Settings, SettingsPatch, TranscribeEvent } from "../../shared/contracts";
import { flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { agentStore } from "./agentStore";
import { MaterialReader } from "./MaterialReader";
import { mediaStore } from "./mediaStore";
import { DEFAULT_PREFS, setReadingPrefs } from "./readingPrefs";
import { SettingsSheet } from "./SettingsSheet";
import { transcribeStore } from "./transcribeStore";

const ABSENT_ID = "fedcba9876543210";
const AUTO_ID = "abcdef0123456789";

const showNotesPayload = JSON.stringify({
  type: "root",
  losses: [],
  children: [{ type: "paragraph", children: [{ type: "text", value: "Episode show notes and links." }] }],
});

const transcribedParagraph = "Welcome to the episode on silence-sliced speech transcription.";
const transcriptPayload = JSON.stringify({
  type: "root",
  losses: [],
  children: [{ type: "paragraph", children: [{ type: "text", value: transcribedParagraph }] }],
});

const absentPodcast: MaterialRecord = {
  id: ABSENT_ID,
  url: "https://podcast.example.test/ep-42",
  finalUrl: "https://podcast.example.test/ep-42",
  title: "Episode 42 — Untranscribed Audio",
  byline: "Host",
  publication: "Example Show",
  fetchedAt: "2026-11-26T00:00:00.000Z",
  readingMinutes: 12,
  origin: "feed",
  mediaType: "text/x-quire-shownotes",
  quality: {
    completeness: "declared_full",
    conformance: "conformant",
    identityConfidence: "strong",
    safety: "safe",
    warnings: [],
  },
  tags: [],
  kind: "podcastEpisode",
  readyViews: ["shownotes"],
  extracted: { kind: "podcastEpisode", title: "Episode 42 — Untranscribed Audio" },
  meta: { kind: "podcastEpisode", title: "Episode 42 — Untranscribed Audio" },
  views: [
    {
      id: "shownotes",
      label: "Show notes",
      url: "https://podcast.example.test/ep-42",
      mediaType: "text/x-quire-shownotes",
      status: "ready",
    },
  ],
  primaryView: "shownotes",
  reader: { schema: "reader.document.v2", payload: showNotesPayload },
  markdown: "Episode show notes and links.",
  plain: "Episode show notes and links.",
  problems: [],
  media: {
    kind: "audio",
    provider: "podcast",
    streamUrl: "https://cdn.example.test/ep-42.mp3",
    durationSec: 720,
    transcriptOrigin: "absent",
  },
};

const transcribedPodcast: MaterialRecord = {
  ...absentPodcast,
  mediaType: "text/x-quire-transcript",
  readyViews: ["transcript", "shownotes"],
  primaryView: "transcript",
  views: [
    {
      id: "transcript",
      label: "Transcript",
      url: `quire-transcript://${ABSENT_ID}`,
      mediaType: "text/x-quire-transcript",
      status: "ready",
    },
    ...absentPodcast.views,
  ],
  reader: { schema: "reader.document.v2", payload: transcriptPayload },
  markdown: `[00:00] ${transcribedParagraph}`,
  plain: transcribedParagraph,
  timeAnchors: [
    {
      paragraphIndex: 0,
      start: 0,
      end: transcribedParagraph.length,
      startSec: 0,
      endSec: 45,
    },
  ],
  media: {
    ...absentPodcast.media!,
    transcriptOrigin: "cloud_asr",
  },
};

const autoCaptionVideo: MaterialRecord = {
  ...transcribedPodcast,
  id: AUTO_ID,
  kind: "videoRecording",
  title: "Lecture — Auto Captions",
  media: {
    kind: "video",
    provider: "youtube",
    streamUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    videoId: "dQw4w9WgXcQ",
    durationSec: 600,
    transcriptOrigin: "auto_captions",
  },
};

beforeEach(() => {
  localStorage.clear();
  mediaStore.stop();
  transcribeStore.stop();
  agentStore.stop();
  setReadingPrefs(DEFAULT_PREFS);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});

afterEach(() => {
  mediaStore.stop();
  transcribeStore.stop();
  agentStore.stop();
  cleanup();
  vi.restoreAllMocks();
});

describe("Interactive ASR transcription & Agent transcript cleanup", () => {
  it("starts transcription on an absent-transcript podcast, renders VAD chunk progress, and switches into the transcript view", async () => {
    let currentMaterial = absentPodcast;
    let emitTranscribe: ((event: TranscribeEvent) => void) | undefined;

    const startTranscription = vi.fn(async (materialId: string) => ({
      jobId: "job-1",
      materialId,
      provider: "openai_compatible" as const,
      phase: "preparing" as const,
      completedChunks: 0,
      totalChunks: 3,
    }));

    api.read = mockRead({
      getMaterial: vi.fn(async () => currentMaterial),
      listAnnotations: vi.fn(async () => []),
      resolveImage: vi.fn(async (u: string) => u),
      getMediaState: vi.fn(async () => undefined),
      saveMediaState: vi.fn(async () => undefined),
      listTranscriptionJobs: vi.fn(async () => []),
      startTranscription,
      onTranscribeEvent: (listener) => {
        emitTranscribe = listener;
        return () => {
          emitTranscribe = undefined;
        };
      },
    });

    render(<MaterialReader id={ABSENT_ID} onOpenLink={() => undefined} onOpenMaterial={() => undefined} />);
    await act(async () => {
      await flush();
      await flush();
    });

    expect(screen.getByText(/No publisher transcript came with this episode/)).toBeTruthy();
    const transcribeBtn = screen.getByRole("button", { name: "Transcribe" });

    await act(async () => {
      fireEvent.click(transcribeBtn);
      await flush();
    });
    expect(startTranscription).toHaveBeenCalledWith(ABSENT_ID, undefined);

    await act(async () => {
      emitTranscribe?.({
        type: "progress",
        jobId: "job-1",
        materialId: ABSENT_ID,
        completedChunks: 2,
        totalChunks: 3,
      });
      await flush();
    });
    expect(screen.getByText("Transcribing segment 2 of 3…")).toBeTruthy();

    currentMaterial = transcribedPodcast;
    await act(async () => {
      emitTranscribe?.({
        type: "completed",
        jobId: "job-1",
        materialId: ABSENT_ID,
      });
      await flush();
      await flush();
    });

    expect(screen.getByText(transcribedParagraph)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clean up with the agent" })).toBeTruthy();
  });

  it("opens the Agent panel and dispatches task cleanup_transcript when clicking Clean up with the agent", async () => {
    const agentAsk = vi.fn(async () => ({ ok: true as const, sessionId: "sess-clean", turnId: "turn-1" }));
    api.read = mockRead({
      getMaterial: vi.fn(async () => autoCaptionVideo),
      listAnnotations: vi.fn(async () => []),
      resolveImage: vi.fn(async (u: string) => u),
      getMediaState: vi.fn(async () => undefined),
      saveMediaState: vi.fn(async () => undefined),
      listTranscriptionJobs: vi.fn(async () => []),
      agentStatus: vi.fn(async () => ({ available: true, version: "0.157.0", account: "me@example.org", running: 0 })),
      listAgentRuns: vi.fn(async () => []),
      listAgentSessions: vi.fn(async () => []),
      getAgentSession: vi.fn(async () => undefined),
      listMaterials: vi.fn(async () => []),
      agentAsk,
    });

    render(<MaterialReader id={AUTO_ID} onOpenLink={() => undefined} onOpenMaterial={() => undefined} />);
    await act(async () => {
      await flush();
      await flush();
    });

    const cleanBtn = screen.getByRole("button", { name: "Clean up with the agent" });
    await act(async () => {
      fireEvent.click(cleanBtn);
      await flush();
      await flush();
    });

    expect(agentAsk).toHaveBeenCalledWith({
      context: { kind: "material", materialId: AUTO_ID },
      task: "cleanup_transcript",
      text: "",
    });
  });

  it("configures OpenAI-compatible ASR settings, runs Test connection, and displays Media/Models storage rows", async () => {
    let current: Settings = {
      syncIntervalMinutes: 30,
      keepCapture: true,
      codexPath: "",
      agentModel: "",
      agentReasoningEffort: "",
      dataDirectory: "/data",
      checkUpdatesAutomatically: false,
      reflowJudge: "rules",
      typesafeApiKeySet: false,
      asrProvider: "openai_compatible",
      asrBaseUrl: "",
      asrModel: "",
      asrApiKeySet: false,
      localWhisperModel: "base",
      removeCachedMediaAfterFinish: false,
    };

    const updateSettings = vi.fn(async (patch: SettingsPatch) => {
      const { asrApiKey, ...rest } = patch;
      current = {
        ...current,
        ...rest,
        ...(asrApiKey !== undefined ? { asrApiKeySet: asrApiKey.length > 0 } : {}),
      };
      return current;
    });
    const testAsrConnection = vi.fn(async () => ({
      latencyMs: 142,
      supportsVerboseJson: true,
      model: "whisper-large-v3-turbo",
    }));

    api.read = mockRead({
      getSettings: vi.fn(async () => current),
      updateSettings,
      storageUsage: vi.fn(async () => ({
        materials: 10 * 1024 * 1024,
        images: 2 * 1024 * 1024,
        figures: 1024 * 1024,
        database: 512 * 1024,
        media: 48 * 1024 * 1024,
        models: 145 * 1024 * 1024,
      })),
      agentStatus: vi.fn(async () => ({ available: false, reason: "Codex is not installed.", running: 0 })),
      getUpdateState: vi.fn(async () => ({ phase: "idle" as const, current: "0.2.0" })),
      feedbackList: vi.fn(async () => []),
      testAsrConnection,
    });

    render(<SettingsSheet open onClose={() => undefined} section="transcription" onOpenLink={() => undefined} />);
    await act(flush);

    const baseUrlInput = screen.getByLabelText("ASR base URL") as HTMLInputElement;
    const modelInput = screen.getByLabelText("ASR model") as HTMLInputElement;
    const keyInput = screen.getByLabelText("ASR API key") as HTMLInputElement;

    fireEvent.change(baseUrlInput, { target: { value: "https://api.groq.com/openai/v1" } });
    fireEvent.change(modelInput, { target: { value: "whisper-large-v3-turbo" } });
    fireEvent.change(keyInput, { target: { value: "gsk-secret-123" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
      await flush();
    });

    expect(updateSettings).toHaveBeenCalledWith({
      asrBaseUrl: "https://api.groq.com/openai/v1",
      asrModel: "whisper-large-v3-turbo",
      asrApiKey: "gsk-secret-123",
    });
    expect(testAsrConnection).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Connected (142 ms · segment timestamps)")).toBeTruthy();
    expect(screen.getByText("ASR key stored")).toBeTruthy();
    expect(document.body.textContent).not.toContain("gsk-secret-123");

    const usageList = screen.getByLabelText("Storage used");
    expect(within(usageList).getByText("Media")).toBeTruthy();
    expect(within(usageList).getByText("Models")).toBeTruthy();
  });

  it("does not open SelectionToolbar when selecting text inside the transcription status banner", async () => {
    api.read = mockRead({
      getMaterial: vi.fn(async () => absentPodcast),
      listAnnotations: vi.fn(async () => []),
      resolveImage: vi.fn(async (u: string) => u),
      getMediaState: vi.fn(async () => undefined),
      saveMediaState: vi.fn(async () => undefined),
      getUpdateState: vi.fn(async () => ({ phase: "idle" as const, current: "0.2.0" })),
    });

    render(
      <MaterialReader id={ABSENT_ID} onOpenLink={() => undefined} onOpenMaterial={() => undefined} />,
    );
    await act(async () => {
      await flush();
      await flush();
    });

    const bannerText = screen.getByText(/No publisher transcript came with this episode/);
    expect(bannerText.closest("[data-reader-chrome]")).toBeTruthy();

    const range = document.createRange();
    range.selectNodeContents(bannerText);
    await act(async () => {
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      await flush();
    });

    expect(screen.queryByRole("toolbar", { name: "Selection" })).toBeNull();
    document.getSelection()?.removeAllRanges();
  });
});
