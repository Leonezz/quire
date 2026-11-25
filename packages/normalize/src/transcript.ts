import {
  type ReaderDocumentV2,
  type ReaderV2FlowNode,
  type ReaderV2PhrasingNode,
  readerDocumentV2Schema,
} from "./reader-document-v2-contract";
import type {
  TranscriptAnchor,
  TranscriptChapter,
  TranscriptCue,
  TranscriptKeyframe,
} from "./transcript-contract";

export type {
  TranscriptAnchor,
  TranscriptChapter,
  TranscriptCue,
  TranscriptKeyframe,
  TranscriptOrigin,
} from "./transcript-contract";

export type NormalizedTranscript = {
  anchors: TranscriptAnchor[];
  document: ReaderDocumentV2;
  markdown: string;
  plain: string;
  reader: { payload: string; schema: "reader.document.v2" };
};

export type NormalizeTranscriptOptions = {
  chapters?: readonly TranscriptChapter[];
  keyframes?: readonly TranscriptKeyframe[];
  title?: string;
};

const NOISE_ONLY_CUE = /^(?:\[(?:music|applause|laughter|silence|inaudible|音乐|掌声|笑声)\]|♪+|🎵+)$/iu;
const SENTENCE_END = /[.?!。？！]["'”’)]?$/u;
const PAUSE_SPLIT_SEC = 1.5;
const FALLBACK_PAUSE_MIN_SEC = 0.4;
const MIN_PAUSE_WORDS = 40;
const TARGET_PARAGRAPH_WORDS = 115;
const MAX_UNPUNCTUATED_WORDS = 145;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function decodeEntities(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/gu, (full, dec, hex, named) => {
    if (dec) {
      const code = Number.parseInt(dec, 10);
      return code >= 0x20 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
    }
    if (hex) {
      const code = Number.parseInt(hex, 16);
      return code >= 0x20 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
    }
    const replacement = NAMED_ENTITIES[String(named).toLowerCase()];
    return replacement ?? full;
  });
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

/**
 * Counts reading units where 2 CJK characters equal ~1 English word so paragraph thresholds behave
 * identically across English, Chinese, and bilingual podcasts.
 */
export function transcriptWordUnits(value: string): number {
  let cjk = 0;
  let latin = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (isCjk(code)) {
      cjk += 1;
      latin += " ";
    } else {
      latin += ch;
    }
  }
  const words = latin.trim() ? latin.trim().split(/\s+/u).length : 0;
  return words + Math.ceil(cjk / 2);
}

/** Formats seconds (`278.4`) into `04:38` or `1:42:10`. */
export function formatTimestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function parseClockSeconds(raw: string): number | undefined {
  const match = /^(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)(?:[.,](\d{1,3}))?$/u.exec(raw.trim());
  if (!match) return undefined;
  const [, hours, minutes, seconds, millis] = match;
  const ms = millis ? Number(millis.padEnd(3, "0")) / 1000 : 0;
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) + ms;
}

function extractLeadingSpeaker(raw: string): { speaker?: string; text: string } {
  const voiceMatch = /^<v(?:\.[^\s>]+)*\s+([^>]+)>([\s\S]*?)(?:<\/v>)?$/iu.exec(raw.trim());
  if (voiceMatch) {
    return {
      speaker: voiceMatch[1]?.replace(/\s+/gu, " ").trim() || undefined,
      text: voiceMatch[2] ?? "",
    };
  }
  const bracketSpeaker = /^(?:\[([A-Za-z\u4e00-\u9fff][\w\s.\u4e00-\u9fff-]{0,36})\]|([A-Z][A-Za-z.\s-]{1,32}|[\u4e00-\u9fff]{2,10})):\s+([\s\S]+)$/u.exec(
    raw.trim(),
  );
  if (bracketSpeaker) {
    const speaker = (bracketSpeaker[1] ?? bracketSpeaker[2] ?? "").replace(/\s+/gu, " ").trim();
    if (speaker && !/^https?$/iu.test(speaker) && !/^note$/iu.test(speaker)) {
      return { speaker, text: bracketSpeaker[3] ?? "" };
    }
  }
  return { text: raw };
}

function cleanCueText(raw: string): { speaker?: string; text: string } {
  const { speaker, text: withoutVoice } = extractLeadingSpeaker(raw);
  const stripped = decodeEntities(
    withoutVoice
      .replace(/<(?:\/?[cibuv]|ruby|rt|\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}|[^>]+)>/giu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  );
  if (!stripped || NOISE_ONLY_CUE.test(stripped)) {
    return { ...(speaker ? { speaker } : {}), text: "" };
  }
  return { ...(speaker ? { speaker } : {}), text: stripped };
}

const CUE_TIMING_LINE =
  /^((?:\d{1,3}:)?[0-5]?\d:[0-5]\d(?:[.,]\d{1,3})?)\s*-->\s*((?:\d{1,3}:)?[0-5]?\d:[0-5]\d(?:[.,]\d{1,3})?)(?:\s+.*)?$/u;

/** Parses WebVTT (`.vtt`) subtitles, including `<v Speaker>` voice spans and inline word timestamps. */
export function parseVttCues(source: string): TranscriptCue[] {
  const normalized = source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const blocks = normalized.split(/\n{2,}/u);
  const cues: TranscriptCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const head = lines[0]!;
    if (/^(?:WEBVTT|NOTE|STYLE|REGION)\b/u.test(head)) continue;
    const timingIndex = CUE_TIMING_LINE.test(head) ? 0 : lines[1] && CUE_TIMING_LINE.test(lines[1]) ? 1 : -1;
    if (timingIndex < 0) continue;
    const match = CUE_TIMING_LINE.exec(lines[timingIndex]!);
    if (!match) continue;
    const startSec = parseClockSeconds(match[1]!);
    const endSec = parseClockSeconds(match[2]!);
    if (startSec === undefined || endSec === undefined || endSec < startSec) continue;
    const body = lines.slice(timingIndex + 1).join(" ");
    const cleaned = cleanCueText(body);
    if (!cleaned.text) continue;
    cues.push({
      startSec,
      endSec: Math.max(startSec + 0.1, endSec),
      text: cleaned.text,
      ...(cleaned.speaker ? { speaker: cleaned.speaker } : {}),
    });
  }
  return cues;
}

/** Parses SubRip (`.srt`) subtitles into normalized cues. */
export function parseSrtCues(source: string): TranscriptCue[] {
  return parseVttCues(source);
}

/**
 * Parses JSON transcript formats:
 * - Podcasting 2.0 (`{ segments: [{ startTime, endTime, body, speaker }] }`)
 * - OpenAI / Whisper `verbose_json` or `diarized_json` (`{ segments: [{ start, end, text, speaker }] }`)
 * - YouTube `json3` (`{ events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }`)
 */
export function parseJsonCues(source: string): TranscriptCue[] {
  let root: unknown;
  try {
    root = JSON.parse(source);
  } catch {
    return [];
  }
  const record = root && typeof root === "object" && !Array.isArray(root) ? (root as Record<string, unknown>) : undefined;
  const segments = Array.isArray(root)
    ? root
    : Array.isArray(record?.segments)
    ? record.segments
    : undefined;

  if (segments) {
    const cues: TranscriptCue[] = [];
    for (const item of segments) {
      if (!item || typeof item !== "object") continue;
      const seg = item as Record<string, unknown>;
      const startRaw = seg.startTime ?? seg.start;
      const endRaw = seg.endTime ?? seg.end;
      const textRaw = typeof seg.body === "string" ? seg.body : typeof seg.text === "string" ? seg.text : "";
      const startSec = typeof startRaw === "number" && Number.isFinite(startRaw) ? Math.max(0, startRaw) : undefined;
      if (startSec === undefined || !textRaw) continue;
      const endSec =
        typeof endRaw === "number" && Number.isFinite(endRaw) && endRaw >= startSec
          ? Math.max(startSec + 0.1, endRaw)
          : startSec + 2;
      const declaredSpeaker = typeof seg.speaker === "string" ? seg.speaker.trim() : undefined;
      const cleaned = cleanCueText(textRaw);
      if (!cleaned.text) continue;
      const speaker = declaredSpeaker || cleaned.speaker;
      cues.push({
        startSec,
        endSec,
        text: cleaned.text,
        ...(speaker ? { speaker } : {}),
      });
    }
    return cues;
  }

  if (Array.isArray(record?.events)) {
    const cues: TranscriptCue[] = [];
    for (const item of record.events) {
      if (!item || typeof item !== "object") continue;
      const ev = item as Record<string, unknown>;
      if (!Array.isArray(ev.segs)) continue;
      const tStartMs = typeof ev.tStartMs === "number" ? ev.tStartMs : undefined;
      if (tStartMs === undefined) continue;
      const dDurationMs = typeof ev.dDurationMs === "number" ? ev.dDurationMs : 2000;
      const rawText = ev.segs
        .map((seg) => (seg && typeof seg === "object" && typeof (seg as Record<string, unknown>).utf8 === "string" ? (seg as Record<string, unknown>).utf8 : ""))
        .join("");
      const cleaned = cleanCueText(rawText);
      if (!cleaned.text) continue;
      const startSec = Math.max(0, tStartMs / 1000);
      cues.push({
        startSec,
        endSec: Math.max(startSec + 0.1, (tStartMs + Math.max(100, dDurationMs)) / 1000),
        text: cleaned.text,
      });
    }
    return cues;
  }

  return [];
}

/**
 * Parses YouTube `srv3` XML (`<timedtext><body><p t="4120" d="3000"><s>...</s></p></body></timedtext>`)
 * and classic `<transcript><text start="4.12" dur="3.0">...</text></transcript>`.
 */
export function parseTimedTextXmlCues(source: string): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  const srv3Pattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/giu;
  for (const match of source.matchAll(srv3Pattern)) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const tAttr = /\bt\s*=\s*["'](\d+)["']/iu.exec(attrs)?.[1];
    if (!tAttr) continue;
    const dAttr = /\bd\s*=\s*["'](\d+)["']/iu.exec(attrs)?.[1];
    const startSec = Number(tAttr) / 1000;
    const durSec = dAttr ? Number(dAttr) / 1000 : 2;
    const textWithSpaces = body.replace(/<\/?s\b[^>]*>/giu, "");
    const cleaned = cleanCueText(textWithSpaces);
    if (!cleaned.text) continue;
    cues.push({
      startSec,
      endSec: Math.max(startSec + 0.1, startSec + Math.max(0.1, durSec)),
      text: cleaned.text,
      ...(cleaned.speaker ? { speaker: cleaned.speaker } : {}),
    });
  }
  if (cues.length > 0) return cues;

  const classicPattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/giu;
  for (const match of source.matchAll(classicPattern)) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const startAttr = /\bstart\s*=\s*["']([\d.]+)["']/iu.exec(attrs)?.[1];
    if (!startAttr) continue;
    const durAttr = /\bdur\s*=\s*["']([\d.]+)["']/iu.exec(attrs)?.[1];
    const startSec = Number(startAttr);
    const durSec = durAttr ? Number(durAttr) : 2;
    if (!Number.isFinite(startSec)) continue;
    const cleaned = cleanCueText(body);
    if (!cleaned.text) continue;
    cues.push({
      startSec,
      endSec: Math.max(startSec + 0.1, startSec + (Number.isFinite(durSec) ? Math.max(0.1, durSec) : 2)),
      text: cleaned.text,
      ...(cleaned.speaker ? { speaker: cleaned.speaker } : {}),
    });
  }
  return cues;
}

/** Auto-detects or dispatches by MIME type to parse any supported transcript payload into cues. */
export function parseTranscriptCues(source: string, mediaType?: string): TranscriptCue[] {
  const essence = mediaType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const trimmed = source.replace(/^\uFEFF/u, "").trimStart();
  if (!trimmed) return [];
  if (essence === "application/json" || essence.endsWith("+json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseJsonCues(trimmed);
  }
  if (
    essence === "text/xml" ||
    essence === "application/xml" ||
    /^<(?:<\?xml|\?xml|timedtext|transcript)\b/iu.test(trimmed)
  ) {
    return parseTimedTextXmlCues(trimmed);
  }
  if (essence === "text/vtt" || trimmed.startsWith("WEBVTT")) {
    return parseVttCues(trimmed);
  }
  return parseSrtCues(trimmed);
}

function joinSegmentsText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  const leftLast = left.codePointAt(left.length - 1) ?? 0;
  const rightFirst = right.codePointAt(0) ?? 0;
  if (isCjk(leftLast) && isCjk(rightFirst)) return `${left}${right}`;
  return `${left} ${right}`.replace(/\s+/gu, " ").trim();
}

function trimOverlappingPrefix(previous: string, current: string): string {
  const prevNorm = previous.trim();
  const currNorm = current.trim();
  if (!prevNorm || !currNorm) return currNorm;
  if (currNorm.toLowerCase() === prevNorm.toLowerCase()) return "";
  if (currNorm.toLowerCase().startsWith(prevNorm.toLowerCase())) {
    const rest = currNorm.slice(prevNorm.length).trim();
    return rest;
  }

  // Word-level suffix-to-prefix overlap (e.g. YouTube 2-line rolling captions)
  const prevWords = prevNorm.split(/\s+/u);
  const currWords = currNorm.split(/\s+/u);
  if (prevWords.length >= 2 && currWords.length >= 2) {
    const maxOverlap = Math.min(prevWords.length, currWords.length, 14);
    for (let k = maxOverlap; k >= 2; k -= 1) {
      const suffix = prevWords.slice(prevWords.length - k).join(" ").toLowerCase();
      const prefix = currWords.slice(0, k).join(" ").toLowerCase();
      if (suffix === prefix) {
        return currWords.slice(k).join(" ").trim();
      }
    }
  }

  // CJK character suffix-to-prefix overlap
  const maxChars = Math.min(prevNorm.length, currNorm.length, 24);
  for (let k = maxChars; k >= 4; k -= 1) {
    if (prevNorm.slice(prevNorm.length - k) === currNorm.slice(0, k)) {
      return currNorm.slice(k).trim();
    }
  }
  return currNorm;
}

/**
 * Eliminates rolling caption duplicates and suffix-to-prefix overlaps produced by YouTube and live ASR.
 */
export function dedupeRollingCues(cues: readonly TranscriptCue[]): TranscriptCue[] {
  const sorted = [...cues]
    .filter((cue) => cue.text.trim().length > 0 && Number.isFinite(cue.startSec))
    .sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec);

  const out: TranscriptCue[] = [];
  for (const cue of sorted) {
    const prev = out[out.length - 1];
    if (!prev || (cue.speaker && prev.speaker && cue.speaker !== prev.speaker) || cue.startSec - prev.endSec > 1.0) {
      out.push({ ...cue, text: cue.text.trim() });
      continue;
    }
    const overlapsInTime = cue.startSec <= prev.endSec + 0.05;
    if (overlapsInTime && prev.text.toLowerCase().startsWith(cue.text.trim().toLowerCase())) {
      prev.endSec = Math.max(prev.endSec, cue.endSec);
      continue;
    }
    if (!overlapsInTime && cue.text.trim().toLowerCase() === prev.text.toLowerCase()) {
      // Distinct non-overlapping sequential cues (e.g. "Right." followed 0.6s later by "Right.") stay separate.
      out.push({ ...cue, text: cue.text.trim() });
      continue;
    }
    const remainder = trimOverlappingPrefix(prev.text, cue.text);
    if (!remainder) {
      prev.endSec = Math.max(prev.endSec, cue.endSec);
      continue;
    }
    out.push({ ...cue, text: remainder });
  }
  return out;
}

type MergedParagraph = {
  cues: TranscriptCue[];
  endSec: number;
  speaker?: string;
  startSec: number;
  text: string;
};

function flushCueBuffer(buffer: readonly TranscriptCue[]): MergedParagraph {
  const first = buffer[0]!;
  const last = buffer[buffer.length - 1]!;
  let combined = "";
  for (const cue of buffer) combined = joinSegmentsText(combined, cue.text);
  return {
    cues: [...buffer],
    endSec: Math.max(first.startSec + 0.1, last.endSec),
    startSec: first.startSec,
    text: combined,
    ...(first.speaker ? { speaker: first.speaker } : {}),
  };
}

function splitCueGroupIntoParagraphs(cues: readonly TranscriptCue[]): MergedParagraph[] {
  if (cues.length === 0) return [];
  const paragraphs: MergedParagraph[] = [];
  let buffer: TranscriptCue[] = [];
  let bufferUnits = 0;

  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index]!;
    const prev = buffer[buffer.length - 1];
    if (prev) {
      const speakerChanged = Boolean(cue.speaker && prev.speaker && cue.speaker !== prev.speaker) ||
        Boolean(cue.speaker && !prev.speaker);
      const gap = cue.startSec - prev.endSec;
      const pauseBreak = gap >= PAUSE_SPLIT_SEC && bufferUnits >= MIN_PAUSE_WORDS;
      const sentenceBreak = bufferUnits >= TARGET_PARAGRAPH_WORDS && SENTENCE_END.test(prev.text);

      if (speakerChanged || pauseBreak || sentenceBreak) {
        paragraphs.push(flushCueBuffer(buffer));
        buffer = [];
        bufferUnits = 0;
      } else if (bufferUnits >= MAX_UNPUNCTUATED_WORDS) {
        // Unpunctuated ASR fallback: cut at the largest pause (>= 0.4s) in the second half of the buffer
        let bestSplit = buffer.length;
        let bestGap = -1;
        const searchStart = Math.max(1, Math.floor(buffer.length / 2));
        for (let j = searchStart; j < buffer.length; j += 1) {
          const candidateGap = buffer[j]!.startSec - buffer[j - 1]!.endSec;
          if (candidateGap > bestGap) {
            bestGap = candidateGap;
            bestSplit = j;
          }
        }
        if (bestGap >= FALLBACK_PAUSE_MIN_SEC && bestSplit < buffer.length) {
          paragraphs.push(flushCueBuffer(buffer.slice(0, bestSplit)));
          const kept = buffer.slice(bestSplit);
          buffer = kept;
          bufferUnits = kept.reduce((sum, item) => sum + transcriptWordUnits(item.text), 0);
        } else {
          paragraphs.push(flushCueBuffer(buffer));
          buffer = [];
          bufferUnits = 0;
        }
      }
    }
    buffer.push(cue);
    bufferUnits += transcriptWordUnits(cue.text);
  }
  if (buffer.length > 0) paragraphs.push(flushCueBuffer(buffer));
  return paragraphs;
}

const textNode = (value: string): ReaderV2PhrasingNode => ({ type: "text", value });

function allowedKeyframeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "quire-figure:" || parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

/**
 * Normalizes raw cues, chapters, and optional video keyframes into a conformant `ReaderDocumentV2`,
 * Agent Markdown (carrying `[MM:SS]` markers), clean `plain` text, and `TranscriptAnchor[]` offsets.
 */
export function normalizeTranscript(
  rawCues: readonly TranscriptCue[],
  options: NormalizeTranscriptOptions = {},
): NormalizedTranscript {
  const cues = dedupeRollingCues(rawCues);
  const sortedChapters = [...(options.chapters ?? [])]
    .filter((ch) => ch.title.trim().length > 0 && Number.isFinite(ch.startSec) && ch.startSec >= 0)
    .sort((a, b) => a.startSec - b.startSec);
  const validKeyframes = [...(options.keyframes ?? [])]
    .filter((kf) => Number.isFinite(kf.timeSec) && kf.timeSec >= 0 && allowedKeyframeUrl(kf.url))
    .sort((a, b) => a.timeSec - b.timeSec);

  type BlockItem =
    | { anchorId: string; kind: "heading"; startSec: number; title: string }
    | { caption: string; height?: number; kind: "figure"; timeSec: number; url: string; width?: number }
    | { kind: "paragraph"; paragraph: MergedParagraph };

  const blocks: BlockItem[] = [];

  if (sortedChapters.length === 0) {
    const paragraphs = splitCueGroupIntoParagraphs(cues);
    let kfCursor = 0;
    for (const paragraph of paragraphs) {
      while (kfCursor < validKeyframes.length && validKeyframes[kfCursor]!.timeSec <= paragraph.endSec) {
        const kf = validKeyframes[kfCursor]!;
        blocks.push({
          caption: kf.caption?.trim() || `${formatTimestamp(kf.timeSec)}`,
          kind: "figure",
          timeSec: kf.timeSec,
          url: kf.url,
          ...(kf.width ? { width: kf.width } : {}),
          ...(kf.height ? { height: kf.height } : {}),
        });
        kfCursor += 1;
      }
      blocks.push({ kind: "paragraph", paragraph });
    }
    while (kfCursor < validKeyframes.length) {
      const kf = validKeyframes[kfCursor]!;
      blocks.push({
        caption: kf.caption?.trim() || `${formatTimestamp(kf.timeSec)}`,
        kind: "figure",
        timeSec: kf.timeSec,
        url: kf.url,
        ...(kf.width ? { width: kf.width } : {}),
        ...(kf.height ? { height: kf.height } : {}),
      });
      kfCursor += 1;
    }
  } else {
    let kfCursor = 0;
    // Any cues before the first chapter (> 3s earlier) stay before the first heading
    const firstChapterStart = sortedChapters[0]!.startSec;
    const preCues = firstChapterStart > 3 ? cues.filter((cue) => cue.startSec < firstChapterStart - 0.5) : [];
    for (const paragraph of splitCueGroupIntoParagraphs(preCues)) {
      blocks.push({ kind: "paragraph", paragraph });
    }

    for (let i = 0; i < sortedChapters.length; i += 1) {
      const chapter = sortedChapters[i]!;
      const nextStart = sortedChapters[i + 1]?.startSec ?? Number.POSITIVE_INFINITY;
      const lowerBound = i === 0 && preCues.length === 0 ? -1 : chapter.startSec - 0.5;
      const chapterCues = cues.filter((cue) => cue.startSec >= lowerBound && cue.startSec < nextStart - 0.5);
      blocks.push({
        anchorId: `t-${Math.max(0, Math.floor(chapter.startSec))}`,
        kind: "heading",
        startSec: chapter.startSec,
        title: chapter.title.trim(),
      });

      const paragraphs = splitCueGroupIntoParagraphs(chapterCues);
      for (const paragraph of paragraphs) {
        while (kfCursor < validKeyframes.length && validKeyframes[kfCursor]!.timeSec < nextStart && validKeyframes[kfCursor]!.timeSec <= paragraph.endSec) {
          const kf = validKeyframes[kfCursor]!;
          blocks.push({
            caption: kf.caption?.trim() || `${formatTimestamp(kf.timeSec)} · ${chapter.title.trim()}`,
            kind: "figure",
            timeSec: kf.timeSec,
            url: kf.url,
            ...(kf.width ? { width: kf.width } : {}),
            ...(kf.height ? { height: kf.height } : {}),
          });
          kfCursor += 1;
        }
        blocks.push({ kind: "paragraph", paragraph });
      }
      while (kfCursor < validKeyframes.length && validKeyframes[kfCursor]!.timeSec < nextStart) {
        const kf = validKeyframes[kfCursor]!;
        blocks.push({
          caption: kf.caption?.trim() || `${formatTimestamp(kf.timeSec)} · ${chapter.title.trim()}`,
          kind: "figure",
          timeSec: kf.timeSec,
          url: kf.url,
          ...(kf.width ? { width: kf.width } : {}),
          ...(kf.height ? { height: kf.height } : {}),
        });
        kfCursor += 1;
      }
    }
  }

  // Assemble plain, markdown, anchors, and ReaderDocumentV2 (sections grouped under depth-2 headings)
  const plainLines: string[] = [];
  const markdownParts: string[] = [];
  const anchors: TranscriptAnchor[] = [];
  const rootChildren: ReaderV2FlowNode[] = [];
  let currentSectionChildren: ReaderV2FlowNode[] | undefined;
  let currentSectionAnchor: string | undefined;

  const flushSection = () => {
    if (currentSectionChildren && currentSectionChildren.length > 0) {
      rootChildren.push({
        type: "section",
        ...(currentSectionAnchor ? { anchor: currentSectionAnchor } : {}),
        children: currentSectionChildren,
      });
    }
    currentSectionChildren = undefined;
    currentSectionAnchor = undefined;
  };

  let offset = 0;
  let paragraphIndex = 0;
  let previousSpeaker: string | undefined;

  for (const block of blocks) {
    if (block.kind === "heading") {
      flushSection();
      const line = block.title;
      plainLines.push(line);
      offset += line.length + 2;
      markdownParts.push(`## ${line}`);
      const headingNode: ReaderV2FlowNode = {
        anchor: block.anchorId,
        children: [textNode(line)],
        depth: 2,
        type: "heading",
      };
      currentSectionAnchor = block.anchorId;
      currentSectionChildren = [headingNode];
      previousSpeaker = undefined;
      continue;
    }

    if (block.kind === "figure") {
      const line = block.caption;
      plainLines.push(line);
      offset += line.length + 2;
      markdownParts.push(`![${line.replace(/[[\]]/gu, "")}](${block.url})\n\n*${line}*`);
      const figureNode: ReaderV2FlowNode = {
        caption: [textNode(line)],
        credit: [],
        media: [
          {
            alt: line,
            title: null,
            type: "image",
            url: block.url,
            ...(block.width ? { width: block.width } : {}),
            ...(block.height ? { height: block.height } : {}),
          },
        ],
        type: "figure",
      };
      if (currentSectionChildren) currentSectionChildren.push(figureNode);
      else rootChildren.push(figureNode);
      continue;
    }

    const { paragraph } = block;
    const line = paragraph.text.trim();
    if (!line) continue;
    const start = offset;
    const end = start + line.length;
    plainLines.push(line);
    offset = end + 2;

    const showSpeaker = paragraph.speaker && paragraph.speaker !== previousSpeaker ? paragraph.speaker : undefined;
    if (paragraph.speaker) previousSpeaker = paragraph.speaker;

    anchors.push({
      end,
      endSec: Number(paragraph.endSec.toFixed(2)),
      paragraphIndex,
      start,
      startSec: Number(paragraph.startSec.toFixed(2)),
      ...(paragraph.speaker ? { speaker: paragraph.speaker } : {}),
    });
    paragraphIndex += 1;

    const speakerPrefix = showSpeaker ? `**${showSpeaker}**: ` : "";
    markdownParts.push(`[${formatTimestamp(paragraph.startSec)}] ${speakerPrefix}${line}`);

    const paraNode: ReaderV2FlowNode = {
      children: [textNode(line)],
      type: "paragraph",
    };
    if (currentSectionChildren) currentSectionChildren.push(paraNode);
    else rootChildren.push(paraNode);
  }
  flushSection();

  const document: ReaderDocumentV2 = {
    children: rootChildren,
    losses: [],
    type: "root",
  };
  const parsed = readerDocumentV2Schema.safeParse(document);
  if (!parsed.success) {
    throw new Error(`TRANSCRIPT_DOCUMENT_INVALID: ${parsed.error.issues[0]?.message ?? "schema check failed"}`);
  }

  const payload = JSON.stringify(parsed.data);
  const titleHeader = options.title?.trim() ? `# ${options.title.trim()}\n\n` : "";
  return {
    anchors,
    document: parsed.data,
    markdown: `${titleHeader}${markdownParts.join("\n\n")}`.trim(),
    plain: plainLines.join("\n\n"),
    reader: { payload, schema: "reader.document.v2" },
  };
}

/**
 * Resolves a `[start, end)` character span inside `plain` into a media `[startSec, endSec]` window,
 * interpolating proportionally within the boundary paragraphs.
 */
export function timeRangeForOffsets(
  anchors: readonly TranscriptAnchor[],
  start: number,
  end: number,
): [startSec: number, endSec: number] | undefined {
  if (end <= start || anchors.length === 0) return undefined;
  const overlapping = anchors.filter((anchor) => anchor.start < end && anchor.end > start);
  if (overlapping.length === 0) return undefined;

  const first = overlapping[0]!;
  const last = overlapping[overlapping.length - 1]!;
  const firstLen = Math.max(1, first.end - first.start);
  const lastLen = Math.max(1, last.end - last.start);
  const firstRatio = Math.max(0, Math.min(1, (start - first.start) / firstLen));
  const lastRatio = Math.max(0, Math.min(1, (end - last.start) / lastLen));

  const startSec = first.startSec + (first.endSec - first.startSec) * firstRatio;
  const endSec = last.startSec + (last.endSec - last.startSec) * lastRatio;
  return [Number(startSec.toFixed(2)), Number(Math.max(startSec + 0.1, endSec).toFixed(2))];
}

/**
 * Finds the best-matching `TranscriptAnchor` for a saved `[startSec, endSec]` window (used to
 * re-anchor highlights after Agent punctuation/cleanup changes the prose wording).
 */
export function anchorForTimeRange(
  anchors: readonly TranscriptAnchor[],
  timeRange: readonly [number, number],
): TranscriptAnchor | undefined {
  if (anchors.length === 0) return undefined;
  const [targetStart, targetEnd] = timeRange;
  let best: TranscriptAnchor | undefined;
  let bestOverlap = -1;
  for (const anchor of anchors) {
    const overlap = Math.min(anchor.endSec, targetEnd) - Math.max(anchor.startSec, targetStart);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = anchor;
    }
  }
  return best;
}

export type RefinedTranscriptValidation =
  | { chapters: TranscriptChapter[]; cues: TranscriptCue[]; ok: true }
  | { issues: string[]; ok: false };

const REFINED_HEADING = /^#{2,3}\s+(.+)$/u;
const REFINED_PARAGRAPH =
  /^\[(\d{1,3}:[0-5]\d(?::[0-5]\d)?)\]\s*(?:\*\*([^*]{1,48})\*\*:\s*)?([\s\S]+)$/u;

/**
 * Parses and validates Agent-refined transcript Markdown against the original raw cues:
 * 1. Every paragraph must carry a monotonically non-decreasing `[MM:SS]` timestamp within `[0, maxEndSec + 5]`.
 * 2. Total word/CJK units must stay within `±20%` of the raw cues so the Agent cannot summarize away detail.
 */
export function validateRefinedTranscript(
  markdown: string,
  rawCues: readonly TranscriptCue[],
): RefinedTranscriptValidation {
  const issues: string[] = [];
  const blocks = markdown
    .replace(/^\s*#\s+[^\n]+\n+/u, "")
    .split(/\n\s*\n/u)
    .map((block) => block.trim())
    .filter(Boolean);

  const chapters: TranscriptChapter[] = [];
  const parsedParagraphs: { speaker?: string; startSec: number; text: string }[] = [];
  let pendingHeading: string | undefined;
  let lastSec = -1;

  for (const block of blocks) {
    const headingMatch = REFINED_HEADING.exec(block);
    if (headingMatch) {
      pendingHeading = headingMatch[1]!.trim();
      continue;
    }
    const paraMatch = REFINED_PARAGRAPH.exec(block);
    if (!paraMatch) {
      issues.push(`Paragraph is missing a leading [MM:SS] timestamp: "${block.slice(0, 60)}…"`);
      continue;
    }
    const startSec = parseClockSeconds(paraMatch[1]!);
    if (startSec === undefined) {
      issues.push(`Invalid timestamp [${paraMatch[1]}]`);
      continue;
    }
    if (startSec < lastSec) {
      issues.push(`Timestamps must not go backwards ([${paraMatch[1]}] came after ${formatTimestamp(lastSec)}).`);
    }
    lastSec = Math.max(lastSec, startSec);
    const speaker = paraMatch[2]?.trim() || undefined;
    const text = paraMatch[3]!.replace(/\s+/gu, " ").trim();
    if (!text) continue;
    if (pendingHeading) {
      chapters.push({ startSec, title: pendingHeading });
      pendingHeading = undefined;
    }
    parsedParagraphs.push({ startSec, text, ...(speaker ? { speaker } : {}) });
  }

  if (parsedParagraphs.length === 0) {
    issues.push("No timestamped paragraphs were found in the refined transcript.");
    return { issues, ok: false };
  }

  const dedupedRaw = dedupeRollingCues(rawCues);
  const rawMaxEnd = dedupedRaw.reduce((max, cue) => Math.max(max, cue.endSec), 0);
  if (rawMaxEnd > 0 && lastSec > rawMaxEnd + 5) {
    issues.push(
      `Timestamp ${formatTimestamp(lastSec)} exceeds the recording's end (${formatTimestamp(rawMaxEnd)}).`,
    );
  }

  const rawUnits = dedupedRaw.reduce((sum, cue) => sum + transcriptWordUnits(cue.text), 0);
  const refinedUnits = parsedParagraphs.reduce((sum, item) => sum + transcriptWordUnits(item.text), 0);
  if (rawUnits >= 50) {
    const ratio = refinedUnits / rawUnits;
    if (ratio < 0.8 || ratio > 1.2) {
      issues.push(
        `Word count drifted to ${Math.round(ratio * 100)}% of the original (${refinedUnits} vs ${rawUnits} units); keep within 80%–120% without summarizing.`,
      );
    }
  }

  if (issues.length > 0) return { issues, ok: false };

  const cues: TranscriptCue[] = parsedParagraphs.map((item, idx) => {
    const nextStart = parsedParagraphs[idx + 1]?.startSec;
    const endSec = nextStart !== undefined && nextStart > item.startSec
      ? nextStart
      : Math.max(item.startSec + 2, rawMaxEnd);
    return {
      endSec,
      startSec: item.startSec,
      text: item.text,
      ...(item.speaker ? { speaker: item.speaker } : {}),
    };
  });

  return { chapters, cues, ok: true };
}
