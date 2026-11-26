import type { TranscriptChapter, TranscriptKeyframe } from "@read/normalize";

export type MediaFixtureFormat =
  | "vtt"
  | "srt"
  | "podcast-json"
  | "whisper-verbose-json"
  | "youtube-json3"
  | "youtube-srv3"
  | "youtube-xml"
  | "vad-plain-asr";

export interface MediaTimeProbe {
  /** Exact substring appearing in the normalized `plain` transcript. */
  phrase: string;
  /** Ground-truth media start timestamp in seconds for this spoken phrase. */
  expectedSec: number;
}

export interface MediaAgentCleanupCase {
  /** Faithful Agent-refined Markdown (`## Chapter` + `[MM:SS] **Speaker**: ...`). */
  validMarkdown: string;
  /** Quote highlighted by the reader on the unrefined transcript before Agent cleanup. */
  highlightedRawQuote: string;
  /** Substring expected inside the re-anchored paragraph after Agent cleanup. */
  expectedRefinedSubstring: string;
  /** Invalid Agent draft that summarizes away > 20% of words (must be rejected). */
  overSummarizedMarkdown: string;
  /** Invalid Agent draft with non-monotonic `[MM:SS]` markers (must be rejected). */
  nonMonotonicMarkdown: string;
}

export interface MediaFixture {
  slug: string;
  title: string;
  url: string;
  kind: "podcast" | "video";
  language: "en" | "zh" | "bilingual";
  format: MediaFixtureFormat;
  scenario: string;
  mediaType?: string;
  /** Raw transcript file payload (or JSON array of `{ startSec, endSec, text }` VAD chunks for `vad-plain-asr`). */
  rawTranscript: string;
  /** Optional show notes / YouTube description used to test `extractDescriptionChapters` & boilerplate stripping. */
  descriptionSource?: string;
  /** Optional structured chapters (Podcasting 2.0 JSON chapters or YouTube `macroMarkersListItemRenderer`). */
  structuredChapters?: readonly TranscriptChapter[];
  /** Optional storyboard keyframes cropped into `quire-figure://` URLs. */
  keyframes?: readonly TranscriptKeyframe[];
  /** Expected chapter headings in document order (`[]` when no chapters should be emitted). */
  expectedChapters: readonly string[];
  /** Ground-truth timestamp probes verified against `TranscriptAnchor` & `timeRangeForOffsets` (`< 0.5s`). */
  probes: readonly MediaTimeProbe[];
  /** Minimum and maximum expected paragraph count after natural-paragraph merging. */
  expectedParagraphRange: readonly [min: number, max: number];
  /** Substrings that must NEVER appear in `plain` (e.g. rolling duplicate phrases, `[music]`, `<c>` tags). */
  forbiddenSubstrings?: readonly string[];
  /** Optional Agent `cleanup_transcript` fidelity & guardrail test bundle. */
  agentCleanup?: MediaAgentCleanupCase;
}

export interface MediaEvalRow {
  slug: string;
  kind: "podcast" | "video";
  language: "en" | "zh" | "bilingual";
  format: MediaFixtureFormat;
  scenario: string;
  rawCues: number;
  paragraphs: number;
  figures: number;
  expectedChapters: number;
  matchedChapters: number;
  chapterRecall: number;
  falsePositiveChapters: number;
  wordUnitsTotal: number;
  minParaUnits: number;
  p50ParaUnits: number;
  p90ParaUnits: number;
  maxParaUnits: number;
  offsetMismatches: number;
  maxAnchorStartDriftSec: number;
  maxProbeDriftSec: number;
  agentCleanupChecked: boolean;
  agentCleanupPassed: boolean;
  flags: string[];
  pass: boolean;
}
