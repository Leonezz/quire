import {
  Slider,
  SliderThumb,
  SliderTrack,
  ToggleButton,
} from "react-aria-components";
import {
  ArrowDownToLine,
  Check,
  LocateFixed,
  MonitorPlay,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  X,
} from "lucide-react";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { Menu, MenuItem, MenuTrigger } from "./Menu";
import { cx } from "../cx";

export const PLAYBACK_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export function formatMediaClock(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export type MediaCacheBadgeState =
  | { status: "none" }
  | { status: "downloading"; percent?: number | undefined }
  | { status: "cached" };

export interface CompanionPlayerProps {
  playing: boolean;
  positionSec: number;
  durationSec: number;
  playbackSpeed: number;
  skipBackSec?: number | undefined;
  skipForwardSec?: number | undefined;
  chapterTitle?: string | undefined;
  /** True when playback automatically scrolls the active transcript paragraph into view. */
  following?: boolean | undefined;
  /** True when the reader manually scrolled away during playback; reveals the return button. */
  drifted?: boolean | undefined;
  /** Video materials: shows the toggle for the collapsible companion video dock (`m`). */
  hasVideo?: boolean | undefined;
  videoOpen?: boolean | undefined;
  cacheState?: MediaCacheBadgeState | undefined;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onSkip: (deltaSeconds: number) => void;
  onSpeedChange: (speed: number) => void;
  onToggleFollow?: (() => void) | undefined;
  onJumpToCurrent?: (() => void) | undefined;
  onToggleVideo?: (() => void) | undefined;
  onToggleCache?: (() => void) | undefined;
  className?: string | undefined;
}

/**
 * Single-line companion audio/video bar anchored at the bottom of a media material.
 * Never steals `Space` from page scrolling; scrubbable by pointer and arrow keys.
 */
export function CompanionPlayer({
  playing,
  positionSec,
  durationSec,
  playbackSpeed,
  skipBackSec = 15,
  skipForwardSec = 30,
  chapterTitle,
  following = true,
  drifted = false,
  hasVideo = false,
  videoOpen = false,
  cacheState,
  onTogglePlay,
  onSeek,
  onSkip,
  onSpeedChange,
  onToggleFollow,
  onJumpToCurrent,
  onToggleVideo,
  onToggleCache,
  className,
}: CompanionPlayerProps) {
  const maxSec = Math.max(1, Math.ceil(durationSec || positionSec || 1));
  const clampedPos = Math.min(maxSec, Math.max(0, Math.floor(positionSec)));
  const fillPercent = Math.min(100, Math.max(0, (clampedPos / maxSec) * 100));
  const speedItems = PLAYBACK_SPEEDS.map((s) => ({ id: String(s), speed: s, label: `${s}×` }));

  return (
    <div
      role="region"
      aria-label="Media player"
      className={cx(
        "glass-strong flex flex-col gap-1 rounded-card px-3 py-2 shadow-float",
        className,
      )}
    >
      {(chapterTitle || (drifted && onJumpToCurrent)) ? (
        <div className="flex min-w-0 items-center justify-between gap-2 px-0.5 text-[11.5px]">
          <span className="min-w-0 truncate text-label-2">{chapterTitle ?? ""}</span>
          {drifted && onJumpToCurrent ? (
            <Button
              variant="plain"
              size="sm"
              className="h-5 px-2 text-[11.5px]"
              onPress={onJumpToCurrent}
            >
              <Icon of={LocateFixed} size="sm" />
              Jump to {formatMediaClock(clampedPos)}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-1.5">
        <Button
          variant="primary"
          size="sm"
          aria-label={playing ? "Pause (k)" : "Play (k)"}
          onPress={onTogglePlay}
        >
          <Icon of={playing ? Pause : Play} size="sm" />
        </Button>

        <Button
          variant="quiet"
          size="sm"
          aria-label={`Back ${skipBackSec} seconds (j)`}
          onPress={() => onSkip(-skipBackSec)}
        >
          <Icon of={RotateCcw} size="sm" />
        </Button>

        <Button
          variant="quiet"
          size="sm"
          aria-label={`Forward ${skipForwardSec} seconds (l)`}
          onPress={() => onSkip(skipForwardSec)}
        >
          <Icon of={RotateCw} size="sm" />
        </Button>

        <span className="min-w-[88px] px-1 text-center text-[12px] font-medium tabular-nums text-label-2">
          {formatMediaClock(clampedPos)}
          <span className="text-label-3"> / {durationSec > 0 ? formatMediaClock(durationSec) : "--:--"}</span>
        </span>

        <Slider
          aria-label="Playback position"
          minValue={0}
          maxValue={maxSec}
          step={1}
          value={clampedPos}
          onChange={(val) => onSeek(typeof val === "number" ? val : val[0] ?? 0)}
          className="flex min-w-[96px] flex-1 items-center px-1.5"
        >
          <SliderTrack className="relative h-5 w-full cursor-pointer">
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-pill bg-fill-2">
              <div
                className="h-full rounded-pill bg-accent"
                style={{ width: `${fillPercent}%` }}
              />
            </div>
            <SliderThumb
              aria-label="Seek"
              className="top-1/2 size-3 rounded-full bg-accent outline-none transition-[scale] data-[dragging]:scale-125 data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring"
            />
          </SliderTrack>
        </Slider>

        <MenuTrigger>
          <Button
            variant="quiet"
            size="sm"
            aria-label={`Playback speed: ${playbackSpeed}×`}
            className="px-2 tabular-nums text-[12px]"
          >
            {playbackSpeed}×
          </Button>
          <Menu
            aria-label="Playback speed"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[String(playbackSpeed)]}
            items={speedItems}
            onSelectionChange={(keys) => {
              const key = keys === "all" ? undefined : [...keys][0];
              const next = Number(key);
              if (Number.isFinite(next) && next > 0 && next !== playbackSpeed) onSpeedChange(next);
            }}
          >
            {(item) => (
              <MenuItem id={item.id} textValue={item.label}>
                <span className="tabular-nums">{item.label}</span>
              </MenuItem>
            )}
          </Menu>
        </MenuTrigger>

        {hasVideo && onToggleVideo ? (
          <ToggleButton
            aria-label={videoOpen ? "Hide video (m)" : "Show video (m)"}
            isSelected={videoOpen}
            onChange={() => onToggleVideo()}
            className={cx(
              "inline-flex h-7 min-w-7 items-center justify-center rounded-pill px-2 text-[11.5px] font-medium outline-none transition-colors duration-100",
              "text-label-2 data-[hovered]:bg-fill data-[hovered]:text-label",
              "data-[selected]:bg-accent-soft data-[selected]:text-accent-text",
              "data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring",
            )}
          >
            <Icon of={MonitorPlay} size="sm" />
          </ToggleButton>
        ) : null}

        {onToggleFollow ? (
          <ToggleButton
            aria-label="Follow transcript"
            isSelected={following && !drifted}
            onChange={() => onToggleFollow()}
            className={cx(
              "inline-flex h-7 min-w-7 items-center justify-center rounded-pill px-2 text-[11.5px] font-medium outline-none transition-colors duration-100",
              "text-label-2 data-[hovered]:bg-fill data-[hovered]:text-label",
              "data-[selected]:bg-accent-soft data-[selected]:text-accent-text",
              "data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring",
            )}
          >
            <Icon of={LocateFixed} size="sm" />
          </ToggleButton>
        ) : null}

        {onToggleCache && cacheState ? (
          <Button
            variant="quiet"
            size="sm"
            isDisabled={cacheState.status === "downloading"}
            aria-label={
              cacheState.status === "cached"
                ? "Cached offline (click to remove cached media)"
                : cacheState.status === "downloading"
                  ? "Downloading for offline playback"
                  : "Keep media offline"
            }
            onPress={onToggleCache}
            {...(cacheState.status === "cached" ? { className: "text-accent-text" } : {})}
          >
            {cacheState.status === "cached" ? (
              <Icon of={Check} size="sm" />
            ) : cacheState.status === "downloading" ? (
              <span className="px-1 text-[11px] tabular-nums text-label-2">
                {cacheState.percent !== undefined ? `${cacheState.percent}%` : "…"}
              </span>
            ) : (
              <Icon of={ArrowDownToLine} size="sm" />
            )}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export interface NowPlayingBarProps {
  title: string;
  subtitle?: string | undefined;
  playing: boolean;
  positionSec: number;
  durationSec: number;
  onTogglePlay: () => void;
  onOpen: () => void;
  onClose: () => void;
  className?: string | undefined;
}

/**
 * Compact persistent mini-player shown at the bottom of the sidebar when audio continues
 * playing while the reader browses Inbox, Queue, or another material.
 */
export function NowPlayingBar({
  title,
  subtitle,
  playing,
  positionSec,
  durationSec,
  onTogglePlay,
  onOpen,
  onClose,
  className,
}: NowPlayingBarProps) {
  const progress = durationSec > 0 ? Math.min(100, Math.max(0, (positionSec / durationSec) * 100)) : 0;
  return (
    <div
      role="region"
      aria-label="Now playing"
      className={cx(
        "mx-2.5 mb-1.5 overflow-hidden rounded-card bg-fill px-2.5 py-2 shadow-[inset_0_0_0_1px_var(--separator-soft)]",
        className,
      )}
    >
      <div className="flex items-center gap-1.5">
        <Button
          variant="quiet"
          size="sm"
          aria-label={playing ? "Pause" : "Play"}
          onPress={onTogglePlay}
        >
          <Icon of={playing ? Pause : Play} size="sm" />
        </Button>
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 cursor-default flex-col border-0 bg-transparent p-0 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-accent-ring rounded-control"
        >
          <span className="truncate text-[12.5px] font-medium leading-[16px] text-label">
            {title}
          </span>
          <span className="truncate text-[11px] leading-[14px] tabular-nums text-label-2">
            {subtitle ? `${subtitle} · ` : ""}
            {formatMediaClock(positionSec)}
          </span>
        </button>
        <Button
          variant="quiet"
          size="sm"
          aria-label="Stop playback"
          onPress={onClose}
        >
          <Icon of={X} size="sm" />
        </Button>
      </div>
      {durationSec > 0 ? (
        <div className="mt-1.5 h-[2px] w-full overflow-hidden rounded-pill bg-separator-soft">
          <div className="h-full bg-accent" style={{ width: `${progress}%` }} />
        </div>
      ) : null}
    </div>
  );
}

export interface VideoDockFrameProps {
  title?: string | undefined;
  onClose: () => void;
  children?: React.ReactNode;
  className?: string | undefined;
}

/**
 * Collapsible top video stage (`m`) for video materials. Bounded in height so the transcript
 * stays the primary reading surface rather than turning the page into a full-screen theater.
 */
export function VideoDockFrame({
  title,
  onClose,
  children,
  className,
}: VideoDockFrameProps) {
  return (
    <div
      role="region"
      aria-label="Companion video"
      className={cx(
        "border-b border-separator-soft bg-surface px-6 py-2.5",
        className,
      )}
    >
      <div className="mx-auto flex max-w-[680px] flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2 text-[11.5px] text-label-2">
          <span className="min-w-0 truncate font-medium">{title ?? "Video"}</span>
          <Button
            variant="quiet"
            size="sm"
            aria-label="Hide video (m)"
            onPress={onClose}
          >
            <Icon of={X} size="sm" />
          </Button>
        </div>
        <div className="mx-auto aspect-video max-h-[240px] w-full max-w-[426px] overflow-hidden rounded-control bg-[#0b0c0f] shadow-sm">
          {children}
        </div>
      </div>
    </div>
  );
}
