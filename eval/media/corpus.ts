import {
  anchorForTimeRange,
  dedupeRollingCues,
  extractDescriptionChapters,
  normalizeTranscript,
  parseTranscriptCues,
  stripShowNotesBoilerplate,
  timeRangeForOffsets,
  transcriptWordUnits,
  validateRefinedTranscript,
  type TranscriptChapter,
  type TranscriptCue,
} from "@read/normalize";
import { PODCAST_FIXTURES } from "./fixtures-podcasts";
import { VIDEO_FIXTURES } from "./fixtures-videos";
import type { MediaEvalRow, MediaFixture } from "./types";

export const MEDIA_FIXTURES: readonly MediaFixture[] = [
  ...PODCAST_FIXTURES,
  ...VIDEO_FIXTURES,
];

/**
 * Mirrors `cues_from_plain_chunk_text` in `apps/desktop/src-tauri/src/transcribe.rs`:
 * splits a VAD silence-sliced chunk's plain text into sentences and distributes `[startSec, endSec]`
 * proportionally by character count when an ASR model returns only `{"text"}` without segments.
 */
export function cuesFromVadPlainChunks(
  chunks: readonly { endSec: number; startSec: number; text: string }[],
): TranscriptCue[] {
  const out: TranscriptCue[] = [];
  for (const chunk of chunks) {
    const cleaned = chunk.text.replace(/\s+/gu, " ").trim();
    if (!cleaned) continue;
    const sentences: string[] = [];
    let buf = "";
    for (const ch of cleaned) {
      buf += ch;
      if (".?!。？！".includes(ch) && buf.trim().length >= 8) {
        sentences.push(buf.trim());
        buf = "";
      }
    }
    if (buf.trim()) sentences.push(buf.trim());
    const totalChars = Math.max(1, sentences.reduce((sum, s) => sum + [...s].length, 0));
    const span = Math.max(0.2, chunk.endSec - chunk.startSec);
    let cursor = chunk.startSec;
    for (const sentence of sentences) {
      const dur = span * ([...sentence].length / totalChars);
      const end = Math.min(chunk.endSec, cursor + Math.max(0.2, dur));
      out.push({
        startSec: Number(cursor.toFixed(2)),
        endSec: Number(end.toFixed(2)),
        text: sentence,
      });
      cursor = end;
    }
  }
  return out;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx]!;
}

type DocNode = { children?: DocNode[]; depth?: number; type: string; value?: string };

function walkNodes(node: DocNode, visit: (n: DocNode) => void): void {
  visit(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walkNodes(child, visit);
  }
}

function nodePlainText(node: DocNode): string {
  if (node.type === "text") return node.value ?? "";
  return Array.isArray(node.children) ? node.children.map(nodePlainText).join("") : "";
}

export function evaluateMediaFixture(fixture: MediaFixture): MediaEvalRow {
  const flags: string[] = [];

  const cues: TranscriptCue[] =
    fixture.format === "vad-plain-asr"
      ? cuesFromVadPlainChunks(
          JSON.parse(fixture.rawTranscript) as { endSec: number; startSec: number; text: string }[],
        )
      : parseTranscriptCues(fixture.rawTranscript, fixture.mediaType);

  if (cues.length === 0) {
    flags.push("P0 zero cues parsed");
  }

  const chapters: readonly TranscriptChapter[] =
    fixture.structuredChapters ??
    (fixture.descriptionSource ? extractDescriptionChapters(fixture.descriptionSource) : []);

  if (fixture.descriptionSource) {
    const strippedGist = stripShowNotesBoilerplate(fixture.descriptionSource);
    for (const forbidden of fixture.forbiddenSubstrings ?? []) {
      if (strippedGist.includes(forbidden)) {
        flags.push(`boilerplate leaked into gist: ${forbidden}`);
      }
    }
  }

  const normalized = normalizeTranscript(cues, {
    title: fixture.title,
    chapters,
    ...(fixture.keyframes ? { keyframes: fixture.keyframes } : {}),
  });

  if (normalized.document.losses.length > 0) {
    flags.push(`P0 lossy document (${normalized.document.losses.length})`);
  }

  const docHeadings: string[] = [];
  const docParagraphs: string[] = [];
  let figures = 0;

  walkNodes(normalized.document as unknown as DocNode, (node) => {
    if (node.type === "heading" && node.depth === 2) {
      docHeadings.push(nodePlainText(node).trim());
    } else if (node.type === "paragraph") {
      docParagraphs.push(nodePlainText(node));
    } else if (node.type === "figure") {
      figures += 1;
    }
  });

  if (fixture.keyframes && figures !== fixture.keyframes.length) {
    flags.push(`expected ${fixture.keyframes.length} keyframes, got ${figures}`);
  }

  // 1. Chapter recall & false-positive check
  const matchedChapters = fixture.expectedChapters.filter((expected) =>
    docHeadings.includes(expected),
  ).length;
  const chapterRecall =
    fixture.expectedChapters.length === 0
      ? docHeadings.length === 0
        ? 1
        : 0
      : matchedChapters / fixture.expectedChapters.length;
  const falsePositiveChapters = Math.max(0, docHeadings.length - matchedChapters);

  if (chapterRecall < 1) {
    flags.push(
      `P0 chapter recall ${matchedChapters}/${fixture.expectedChapters.length} (got: ${docHeadings.join(" | ") || "none"})`,
    );
  }
  if (falsePositiveChapters > 0) {
    flags.push(`P0 false-positive chapters (${falsePositiveChapters}): ${docHeadings.join(" | ")}`);
  }

  // 2. Natural paragraph length distribution
  const paraUnits = docParagraphs.map((p) => transcriptWordUnits(p)).sort((a, b) => a - b);
  const wordUnitsTotal = paraUnits.reduce((sum, n) => sum + n, 0);
  const minParaUnits = paraUnits[0] ?? 0;
  const p50ParaUnits = percentile(paraUnits, 0.5);
  const p90ParaUnits = percentile(paraUnits, 0.9);
  const maxParaUnits = paraUnits[paraUnits.length - 1] ?? 0;

  const [expectedMinParas, expectedMaxParas] = fixture.expectedParagraphRange;
  if (docParagraphs.length < expectedMinParas || docParagraphs.length > expectedMaxParas) {
    flags.push(
      `paragraph count ${docParagraphs.length} outside expected [${expectedMinParas}, ${expectedMaxParas}]`,
    );
  }
  if (minParaUnits < 14) {
    flags.push(`fragmented caption-soup paragraph (${minParaUnits} units < 14)`);
  }
  if (maxParaUnits > 175) {
    flags.push(`wall-of-text paragraph (${maxParaUnits} units > 175)`);
  }

  // 3. Forbidden substrings (rolling duplicates, [music], karaoke tags, unescaped HTML entities)
  for (const forbidden of fixture.forbiddenSubstrings ?? []) {
    if (normalized.plain.includes(forbidden)) {
      flags.push(`P0 forbidden residue in plain text: "${forbidden}"`);
    }
  }

  // 4. Character-offset exactness & < 0.5s media timestamp drift
  const deduped = dedupeRollingCues(cues);
  let offsetMismatches = 0;
  let maxAnchorStartDriftSec = 0;

  if (normalized.anchors.length !== docParagraphs.length) {
    offsetMismatches += Math.abs(normalized.anchors.length - docParagraphs.length);
    flags.push(`P0 anchor count ${normalized.anchors.length} !== paragraph count ${docParagraphs.length}`);
  }

  for (let i = 0; i < normalized.anchors.length; i += 1) {
    const anchor = normalized.anchors[i]!;
    const sliced = normalized.plain.slice(anchor.start, anchor.end);
    const expectedText = docParagraphs[i] ?? "";
    if (sliced !== expectedText) {
      offsetMismatches += 1;
    }
    const nearestCueDrift = deduped.reduce(
      (best, cue) => Math.min(best, Math.abs(cue.startSec - anchor.startSec)),
      Number.POSITIVE_INFINITY,
    );
    if (Number.isFinite(nearestCueDrift)) {
      maxAnchorStartDriftSec = Math.max(maxAnchorStartDriftSec, Number(nearestCueDrift.toFixed(3)));
    }
  }
  if (offsetMismatches > 0) {
    flags.push(`P0 character offset mismatches: ${offsetMismatches}`);
  }
  if (maxAnchorStartDriftSec >= 0.5) {
    flags.push(`P0 anchor start drift ${maxAnchorStartDriftSec}s >= 0.5s`);
  }

  let maxProbeDriftSec = 0;
  for (const probe of fixture.probes) {
    const startIdx = normalized.plain.indexOf(probe.phrase);
    if (startIdx < 0) {
      flags.push(`P0 missing probe phrase: "${probe.phrase}"`);
      maxProbeDriftSec = Math.max(maxProbeDriftSec, 999);
      continue;
    }
    const resolved = timeRangeForOffsets(
      normalized.anchors,
      startIdx,
      startIdx + probe.phrase.length,
    );
    if (!resolved) {
      flags.push(`P0 unresolvable timeRange for probe: "${probe.phrase}"`);
      maxProbeDriftSec = Math.max(maxProbeDriftSec, 999);
      continue;
    }
    const drift = Number(Math.abs(resolved[0] - probe.expectedSec).toFixed(3));
    maxProbeDriftSec = Math.max(maxProbeDriftSec, drift);
    if (drift >= 0.5) {
      flags.push(`P0 probe "${probe.phrase.slice(0, 28)}…" drifted ${drift}s >= 0.5s`);
    }
  }

  // 5. Agent `cleanup_transcript` guardrails & dual-anchor highlight survival
  let agentCleanupChecked = false;
  let agentCleanupPassed = true;

  if (fixture.agentCleanup) {
    agentCleanupChecked = true;
    const {
      validMarkdown,
      highlightedRawQuote,
      expectedRefinedSubstring,
      overSummarizedMarkdown,
      nonMonotonicMarkdown,
    } = fixture.agentCleanup;

    const validCheck = validateRefinedTranscript(validMarkdown, cues);
    if (!validCheck.ok) {
      agentCleanupPassed = false;
      flags.push(`P0 valid refined transcript rejected: ${validCheck.issues.join("; ")}`);
    } else {
      const refined = normalizeTranscript(validCheck.cues, {
        title: fixture.title,
        chapters: validCheck.chapters,
      });
      const rawQuoteStart = normalized.plain.indexOf(highlightedRawQuote);
      const savedRange =
        rawQuoteStart >= 0
          ? timeRangeForOffsets(
              normalized.anchors,
              rawQuoteStart,
              rawQuoteStart + highlightedRawQuote.length,
            )
          : undefined;
      const reanchored = savedRange ? anchorForTimeRange(refined.anchors, savedRange) : undefined;
      const reanchoredText = reanchored ? refined.plain.slice(reanchored.start, reanchored.end) : "";
      if (!reanchoredText.includes(expectedRefinedSubstring)) {
        agentCleanupPassed = false;
        flags.push("P0 highlight failed to re-anchor onto refined paragraph via timeRange");
      }
    }

    const summaryCheck = validateRefinedTranscript(overSummarizedMarkdown, cues);
    if (summaryCheck.ok) {
      agentCleanupPassed = false;
      flags.push("P0 guardrail failed to reject over-summarized (>20% loss) Agent transcript");
    }

    const monotonicCheck = validateRefinedTranscript(nonMonotonicMarkdown, cues);
    if (monotonicCheck.ok) {
      agentCleanupPassed = false;
      flags.push("P0 guardrail failed to reject non-monotonic [MM:SS] Agent transcript");
    }
  }

  return {
    slug: fixture.slug,
    kind: fixture.kind,
    language: fixture.language,
    format: fixture.format,
    scenario: fixture.scenario,
    rawCues: cues.length,
    paragraphs: docParagraphs.length,
    figures,
    expectedChapters: fixture.expectedChapters.length,
    matchedChapters,
    chapterRecall,
    falsePositiveChapters,
    wordUnitsTotal,
    minParaUnits,
    p50ParaUnits,
    p90ParaUnits,
    maxParaUnits,
    offsetMismatches,
    maxAnchorStartDriftSec,
    maxProbeDriftSec,
    agentCleanupChecked,
    agentCleanupPassed,
    flags,
    pass: flags.length === 0,
  };
}
