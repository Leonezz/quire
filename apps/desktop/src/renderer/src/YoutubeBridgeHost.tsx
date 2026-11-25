import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatMediaClock } from "@read/ui";
import { MEDIA_SCHEME, PLAYER_SCHEME } from "../../shared/contracts";
import { isPreview } from "./api";
import { activeChapterOf, mediaStore, useMediaPlayback } from "./mediaStore";

export const VIDEO_DOCK_SLOT_ID = "quire-video-dock-slot";

/**
 * Singleton companion video stage mounted at the root of `App`.
 * When `videoOpen` is active on the mounted video material, portals the live `<video>` or
 * `quire-player://youtube/<videoId>` frame into `#quire-video-dock-slot`; when collapsed or
 * browsing another scope, keeps the active session alive offscreen so audio never drops.
 */
export function YoutubeBridgeHost() {
  const playback = useMediaPlayback();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [dockTarget, setDockTarget] = useState<HTMLElement | null>(null);

  const isVideoActive = Boolean(
    playback.materialId &&
      playback.mediaKind === "video" &&
      (playback.videoOpen || playback.playing),
  );
  const shouldDock = Boolean(
    playback.materialId &&
      playback.mountedReaderId === playback.materialId &&
      playback.videoOpen,
  );

  useEffect(() => {
    if (!shouldDock || typeof document === "undefined") {
      setDockTarget(null);
      return;
    }
    const syncSlot = () => {
      setDockTarget(document.getElementById(VIDEO_DOCK_SLOT_ID));
    };
    syncSlot();
    const raf = requestAnimationFrame(syncSlot);
    return () => cancelAnimationFrame(raf);
  }, [shouldDock, playback.materialId, playback.videoOpen]);

  useEffect(() => {
    if (isPreview || !isVideoActive || playback.provider !== "youtube") {
      mediaStore.bindExternalController(undefined);
      return;
    }

    if (playback.cachedVideo) {
      const el = videoRef.current;
      if (!el) return;
      mediaStore.bindExternalController({
        play: () => {
          void el.play().catch(() => undefined);
        },
        pause: () => el.pause(),
        seekTo: (sec) => {
          try {
            el.currentTime = sec;
          } catch {
            // Ignore before metadata loads
          }
        },
        setPlaybackRate: (rate) => {
          el.playbackRate = rate;
        },
      });
      return () => mediaStore.bindExternalController(undefined);
    }

    const postCmd = (cmd: string, value?: number) => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      win.postMessage({ quirePlayer: 1, cmd, ...(value !== undefined ? { value } : {}) }, "*");
    };

    mediaStore.bindExternalController({
      play: () => postCmd("play"),
      pause: () => postCmd("pause"),
      seekTo: (sec) => postCmd("seek", sec),
      setPlaybackRate: (rate) => postCmd("rate", rate),
    });

    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as Record<string, unknown> | null;
      if (!data || data.quirePlayer !== 1 || data.videoId !== playback.videoId) return;
      if (data.event === "ready") {
        const snap = mediaStore.getState();
        postCmd("rate", snap.playbackSpeed);
        if (snap.positionSec > 0) postCmd("seek", snap.positionSec);
        if (snap.playing) postCmd("play");
      } else if (data.event === "time") {
        mediaStore.reportExternalProgress(
          Number(data.currentTime ?? 0),
          typeof data.duration === "number" ? data.duration : undefined,
        );
      } else if (data.event === "state") {
        if (typeof data.currentTime === "number") {
          mediaStore.reportExternalProgress(
            data.currentTime,
            typeof data.duration === "number" ? data.duration : undefined,
          );
        }
        mediaStore.reportExternalState(Boolean(data.playing), Boolean(data.ended));
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      mediaStore.bindExternalController(undefined);
    };
  }, [isVideoActive, playback.provider, playback.videoId, playback.cachedVideo]);

  if (!isVideoActive || !playback.materialId) return null;

  const chapter = activeChapterOf(playback.chapters, playback.positionSec)?.title;
  const stage = isPreview ? (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-[#0b0c0f] px-4 text-center text-white/85 select-none">
      <span className="font-mono text-[13px] tabular-nums">{formatMediaClock(playback.positionSec)}</span>
      {chapter ? <span className="max-w-full truncate text-[11.5px] text-white/65">{chapter}</span> : null}
    </div>
  ) : playback.cachedVideo ? (
    <video
      ref={videoRef}
      src={`${MEDIA_SCHEME}://stream/${playback.materialId}`}
      playsInline
      onTimeUpdate={(e) => mediaStore.reportExternalProgress(e.currentTarget.currentTime, e.currentTarget.duration)}
      onPlay={() => mediaStore.reportExternalState(true, false)}
      onPause={() => mediaStore.reportExternalState(false, false)}
      onEnded={() => mediaStore.reportExternalState(false, true)}
      className="h-full w-full object-contain"
    />
  ) : playback.videoId ? (
    <iframe
      ref={iframeRef}
      title="Companion video player"
      src={`${PLAYER_SCHEME}://youtube/${playback.videoId}`}
      allow="autoplay"
      className="h-full w-full border-0"
    />
  ) : null;

  if (!stage) return null;
  if (dockTarget) return createPortal(stage, dockTarget);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed -left-[9999px] top-0 h-px w-px overflow-hidden opacity-0"
    >
      {stage}
    </div>
  );
}
