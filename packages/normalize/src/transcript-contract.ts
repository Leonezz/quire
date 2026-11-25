// Browser-safe transcript vocabulary shared by @read/normalize and the desktop renderer.

export type TranscriptOrigin =
  | "official"
  | "captions"
  | "auto_captions"
  | "local_asr"
  | "cloud_asr"
  | "agent_refined"
  | "absent";

export type TranscriptCue = {
  endSec: number;
  speaker?: string;
  startSec: number;
  text: string;
};

export type TranscriptChapter = {
  startSec: number;
  title: string;
};

export type TranscriptKeyframe = {
  caption?: string;
  height?: number;
  timeSec: number;
  url: string;
  width?: number;
};

/**
 * Maps one merged transcript paragraph in a `transcript` view to both its `[start, end)` character
 * span inside `view.plain` (matching PDF `TextViewAnchor`) and its `[startSec, endSec]` media window.
 */
export type TranscriptAnchor = {
  end: number;
  endSec: number;
  paragraphIndex: number;
  speaker?: string;
  start: number;
  startSec: number;
};
