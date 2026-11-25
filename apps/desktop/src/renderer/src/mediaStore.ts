import { useSyncExternalStore } from "react";
import { MEDIA_SCHEME, type MaterialRecord, type MediaCacheProgress, type NormalizedMediaChapter } from "../../shared/contracts";
import { isPreview, read } from "./api";
import { hostLabel } from "./ArtifactLineage";

export interface ExternalMediaController {
  play: () => void;
  pause: () => void;
  seekTo: (seconds: number) => void;
  setPlaybackRate: (speed: number) => void;
}

export interface MediaPlaybackSnapshot {
  materialId: string | undefined;
  mountedReaderId: string | undefined;
  title: string;
  subtitle: string;
  mediaKind: "audio" | "video";
  provider: "podcast" | "youtube" | "web";
  videoId: string | undefined;
  cachedVideo: boolean;
  videoOpen: boolean;
  playing: boolean;
  positionSec: number;
  durationSec: number;
  playbackSpeed: number;
  following: boolean;
  chapters: readonly NormalizedMediaChapter[];
  snippetEndSec: number | undefined;
  cacheProgress: MediaCacheProgress | undefined;
  error: string | undefined;
}

const INITIAL_STATE: MediaPlaybackSnapshot = {
  materialId: undefined,
  mountedReaderId: undefined,
  title: "",
  subtitle: "",
  mediaKind: "audio",
  provider: "podcast",
  videoId: undefined,
  cachedVideo: false,
  videoOpen: false,
  playing: false,
  positionSec: 0,
  durationSec: 0,
  playbackSpeed: 1,
  following: true,
  chapters: [],
  snippetEndSec: undefined,
  cacheProgress: undefined,
  error: undefined,
};

const SAVE_THROTTLE_MS = 5000;
const FINISHED_MEDIA_THRESHOLD = 0.9;

/** Current chapter whose `startSec <= positionSec`. */
export function activeChapterOf(
  chapters: readonly NormalizedMediaChapter[] | undefined,
  positionSec: number,
): NormalizedMediaChapter | undefined {
  if (!chapters || chapters.length === 0) return undefined;
  let active: NormalizedMediaChapter | undefined;
  for (const ch of chapters) {
    if (ch.startSec <= positionSec + 0.25) active = ch;
    else break;
  }
  return active;
}

export function createMediaStore() {
  let state: MediaPlaybackSnapshot = INITIAL_STATE;
  const listeners = new Set<() => void>();
  let audio: HTMLAudioElement | undefined;
  let externalCtrl: ExternalMediaController | undefined;
  let previewTimer: ReturnType<typeof setInterval> | undefined;
  let lastSavedAt = 0;
  let unsubscribeCache: (() => void) | undefined;
  const finishedIds = new Set<string>();
  const hydratedSpeeds = new Map<string, number>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const setState = (patch: Partial<MediaPlaybackSnapshot>) => {
    state = { ...state, ...patch };
    emit();
  };

  const usesExternalBridge = (): boolean => !isPreview && state.provider === "youtube" && !state.cachedVideo;

  const persistNow = (force = false) => {
    const id = state.materialId;
    if (!id) return;
    const now = Date.now();
    if (!force && now - lastSavedAt < SAVE_THROTTLE_MS) return;
    lastSavedAt = now;
    void read
      .saveMediaState({
        materialId: id,
        positionSec: state.positionSec,
        ...(state.durationSec > 0 ? { durationSec: state.durationSec } : {}),
        playbackSpeed: state.playbackSpeed,
      })
      .catch(() => undefined);
  };

  const maybeRecordFinished = (materialId: string, pos: number, dur: number) => {
    if (dur <= 0 || pos / dur < FINISHED_MEDIA_THRESHOLD || finishedIds.has(materialId)) return;
    finishedIds.add(materialId);
    void read.recordReadingEvent("finished", materialId).catch(() => {
      finishedIds.delete(materialId);
    });
  };

  const stopPreviewTicker = () => {
    if (previewTimer !== undefined) {
      clearInterval(previewTimer);
      previewTimer = undefined;
    }
  };

  const startPreviewTicker = () => {
    stopPreviewTicker();
    previewTimer = setInterval(() => {
      if (!state.playing || !state.materialId) {
        stopPreviewTicker();
        return;
      }
      const nextPos = state.positionSec + 0.25 * state.playbackSpeed;
      if (state.snippetEndSec !== undefined && nextPos >= state.snippetEndSec) {
        setState({ positionSec: state.snippetEndSec, playing: false, snippetEndSec: undefined });
        stopPreviewTicker();
        persistNow(true);
        return;
      }
      if (state.durationSec > 0 && nextPos >= state.durationSec) {
        setState({ positionSec: state.durationSec, playing: false });
        maybeRecordFinished(state.materialId, state.durationSec, state.durationSec);
        stopPreviewTicker();
        persistNow(true);
        return;
      }
      setState({ positionSec: nextPos });
      maybeRecordFinished(state.materialId, nextPos, state.durationSec);
      persistNow(false);
    }, 250);
  };

  const ensureSubscriptions = () => {
    if (unsubscribeCache) return;
    unsubscribeCache = read.onMediaCacheProgress((progress) => {
      if (progress.materialId === state.materialId) {
        setState({
          cacheProgress: progress,
          ...(progress.phase === "done" && state.mediaKind === "video" ? { cachedVideo: true } : {}),
        });
      }
    });
  };

  const ensureAudio = (): HTMLAudioElement | undefined => {
    if (typeof document === "undefined") return undefined;
    if (audio) return audio;
    const el = document.createElement("audio");
    el.preload = "metadata";
    el.addEventListener("loadedmetadata", () => {
      if (usesExternalBridge()) return;
      if (Number.isFinite(el.duration) && el.duration > 0) {
        setState({ durationSec: el.duration });
      }
    });
    el.addEventListener("timeupdate", () => {
      if (!state.materialId || usesExternalBridge()) return;
      const pos = el.currentTime;
      const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : state.durationSec;
      if (state.snippetEndSec !== undefined && pos >= state.snippetEndSec) {
        el.pause();
        setState({ positionSec: state.snippetEndSec, playing: false, snippetEndSec: undefined });
        persistNow(true);
        return;
      }
      setState({ positionSec: pos, ...(dur > 0 ? { durationSec: dur } : {}) });
      maybeRecordFinished(state.materialId, pos, dur);
      persistNow(false);
    });
    el.addEventListener("play", () => {
      if (!usesExternalBridge()) setState({ playing: true, error: undefined });
    });
    el.addEventListener("pause", () => {
      if (!usesExternalBridge()) {
        setState({ playing: false });
        persistNow(true);
      }
    });
    el.addEventListener("ended", () => {
      if (usesExternalBridge()) return;
      if (state.materialId && state.durationSec > 0) {
        maybeRecordFinished(state.materialId, state.durationSec, state.durationSec);
      }
      setState({ playing: false, snippetEndSec: undefined });
      persistNow(true);
    });
    el.addEventListener("error", () => {
      if (!isPreview && !usesExternalBridge()) {
        setState({ playing: false, error: "Could not play this media stream." });
      }
    });
    audio = el;
    return el;
  };

  const streamSrcFor = (material: MaterialRecord): string => {
    const raw = material.media?.streamUrl ?? "";
    if (raw.startsWith("blob:") || raw.startsWith("data:")) return raw;
    return `${MEDIA_SCHEME}://stream/${material.id}`;
  };

  const hydrateMaterial = async (material: MaterialRecord): Promise<void> => {
    if (!material.media) return;
    ensureSubscriptions();
    const isCachedVideo = material.media.kind === "video" && (material.media.cachedBytes ?? 0) > 0;
    if (state.materialId === material.id) {
      setState({
        title: material.title,
        subtitle: material.publication ?? hostLabel(material),
        videoId: material.media.videoId,
        cachedVideo: isCachedVideo,
        chapters: material.media.chapters ?? [],
        ...(material.media.durationSec && state.durationSec === 0 ? { durationSec: material.media.durationSec } : {}),
      });
      return;
    }

    if (state.materialId) {
      persistNow(true);
      audio?.pause();
      externalCtrl?.pause();
      stopPreviewTicker();
    }

    const saved = await read.getMediaState(material.id).catch(() => undefined);
    const pubKey = material.publication ?? hostLabel(material);
    const speed = saved?.playbackSpeed ?? hydratedSpeeds.get(pubKey) ?? 1;
    const positionSec = saved?.positionSec ?? 0;
    const durationSec = saved?.durationSec ?? material.media.durationSec ?? 0;

    setState({
      materialId: material.id,
      title: material.title,
      subtitle: pubKey,
      mediaKind: material.media.kind,
      provider: material.media.provider,
      videoId: material.media.videoId,
      cachedVideo: isCachedVideo,
      videoOpen: false,
      playing: false,
      positionSec,
      durationSec,
      playbackSpeed: speed,
      following: true,
      chapters: material.media.chapters ?? [],
      snippetEndSec: undefined,
      cacheProgress: undefined,
      error: undefined,
    });

    if (
      material.media.provider !== "youtube" &&
      (!isPreview || material.media.streamUrl.startsWith("data:") || material.media.streamUrl.startsWith("blob:"))
    ) {
      const el = ensureAudio();
      if (el) {
        el.src = streamSrcFor(material);
        el.playbackRate = speed;
        try {
          el.currentTime = positionSec;
        } catch {
          // Metadata not loaded yet; applied on play/seek.
        }
      }
    }
  };

  const play = async (material?: MaterialRecord): Promise<void> => {
    if (material && material.id !== state.materialId) {
      await hydrateMaterial(material);
    }
    if (!state.materialId) return;
    setState({ error: undefined });

    if (isPreview) {
      setState({ playing: true });
      startPreviewTicker();
      return;
    }

    if (usesExternalBridge()) {
      setState({ playing: true });
      if (externalCtrl) {
        externalCtrl.setPlaybackRate(state.playbackSpeed);
        externalCtrl.seekTo(state.positionSec);
        externalCtrl.play();
      }
      return;
    }

    const el = ensureAudio();
    if (!el) return;
    if (material && !el.src) {
      el.src = streamSrcFor(material);
    }
    el.playbackRate = state.playbackSpeed;
    if (Math.abs(el.currentTime - state.positionSec) > 0.5) {
      try {
        el.currentTime = state.positionSec;
      } catch {
        // Ignore before metadata loads
      }
    }
    try {
      await el.play();
      setState({ playing: true });
    } catch (cause: unknown) {
      setState({
        playing: false,
        error: cause instanceof Error ? cause.message : "Playback failed.",
      });
    }
  };

  const pause = (): void => {
    stopPreviewTicker();
    audio?.pause();
    externalCtrl?.pause();
    setState({ playing: false, snippetEndSec: undefined });
    persistNow(true);
  };

  const togglePlay = async (material?: MaterialRecord): Promise<void> => {
    if (material && material.id !== state.materialId) {
      await play(material);
      return;
    }
    if (state.playing) pause();
    else await play(material);
  };

  const seekTo = async (seconds: number, material?: MaterialRecord, autoPlay = false): Promise<void> => {
    if (material && material.id !== state.materialId) {
      await hydrateMaterial(material);
    }
    if (!state.materialId) return;
    const max = state.durationSec > 0 ? state.durationSec : Number.POSITIVE_INFINITY;
    const clamped = Math.min(max, Math.max(0, seconds));
    setState({ positionSec: clamped, snippetEndSec: undefined });
    if (!isPreview) {
      if (usesExternalBridge()) {
        externalCtrl?.seekTo(clamped);
      } else if (audio) {
        try {
          audio.currentTime = clamped;
        } catch {
          // Ignore if not seekable yet
        }
      }
    }
    persistNow(true);
    if (autoPlay && !state.playing) {
      await play(material);
    }
  };

  const skip = (deltaSeconds: number, material?: MaterialRecord): void => {
    void seekTo(state.positionSec + deltaSeconds, material, false);
  };

  const setPlaybackSpeed = (speed: number): void => {
    const clamped = Math.min(3, Math.max(0.5, Math.round(speed * 100) / 100));
    if (state.subtitle) hydratedSpeeds.set(state.subtitle, clamped);
    if (audio) audio.playbackRate = clamped;
    externalCtrl?.setPlaybackRate(clamped);
    setState({ playbackSpeed: clamped });
    persistNow(true);
  };

  const stepPlaybackSpeed = (delta: number): void => {
    setPlaybackSpeed(state.playbackSpeed + delta);
  };

  const setFollowing = (following: boolean): void => {
    setState({ following });
  };

  const setVideoOpen = (videoOpen: boolean): void => {
    if (state.videoOpen === videoOpen) return;
    setState({ videoOpen });
  };

  const toggleVideoOpen = (): void => {
    setState({ videoOpen: !state.videoOpen });
  };

  const bindExternalController = (ctrl: ExternalMediaController | undefined): void => {
    externalCtrl = ctrl;
    if (ctrl && usesExternalBridge()) {
      ctrl.setPlaybackRate(state.playbackSpeed);
      if (state.positionSec > 0) ctrl.seekTo(state.positionSec);
      if (state.playing) ctrl.play();
    }
  };

  const reportExternalProgress = (pos: number, dur?: number): void => {
    if (!state.materialId) return;
    const effDur = dur && dur > 0 ? dur : state.durationSec;
    if (state.snippetEndSec !== undefined && pos >= state.snippetEndSec) {
      externalCtrl?.pause();
      setState({ positionSec: state.snippetEndSec, playing: false, snippetEndSec: undefined });
      persistNow(true);
      return;
    }
    setState({ positionSec: pos, ...(effDur > 0 ? { durationSec: effDur } : {}) });
    maybeRecordFinished(state.materialId, pos, effDur);
    persistNow(false);
  };

  const reportExternalState = (playing: boolean, ended = false): void => {
    if (ended && state.materialId && state.durationSec > 0) {
      maybeRecordFinished(state.materialId, state.durationSec, state.durationSec);
    }
    setState({ playing, ...(ended ? { snippetEndSec: undefined } : {}) });
    if (!playing) persistNow(true);
  };

  const playSnippet = async (material: MaterialRecord, startSec: number, endSec: number): Promise<void> => {
    await seekTo(startSec, material, false);
    setState({ snippetEndSec: Math.max(startSec + 0.5, endSec) });
    await play(material);
  };

  const stop = (): void => {
    persistNow(true);
    stopPreviewTicker();
    externalCtrl?.pause();
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
    }
    state = { ...INITIAL_STATE, mountedReaderId: state.mountedReaderId };
    emit();
  };

  const setMountedReader = (materialId: string | undefined): void => {
    if (state.mountedReaderId === materialId) return;
    setState({ mountedReaderId: materialId });
  };

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    setMountedReader,
    hydrateMaterial,
    play,
    pause,
    togglePlay,
    seekTo,
    skip,
    setPlaybackSpeed,
    stepPlaybackSpeed,
    setFollowing,
    setVideoOpen,
    toggleVideoOpen,
    bindExternalController,
    reportExternalProgress,
    reportExternalState,
    playSnippet,
    stop,
  };
}

export const mediaStore = createMediaStore();

export function useMediaPlayback(): MediaPlaybackSnapshot {
  return useSyncExternalStore(mediaStore.subscribe, mediaStore.getState, mediaStore.getState);
}
