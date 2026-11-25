import { encodeTextQuoteV2Locator } from "@read/reader";
import type { MaterialViewContent, TranscriptAnchor } from "../../shared/contracts";
import { locateQuote, type TextQuote } from "./textViewAnchors";

export type TranscriptViewSource = Pick<MaterialViewContent, "plain" | "timeAnchors">;

const CONTEXT_CHARS = 32;
const stripSpace = (value: string) => value.replace(/\s+/g, "");

function allIndexesOf(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let cursor = 0;
  while ((cursor = haystack.indexOf(needle, cursor)) >= 0) {
    found.push(cursor);
    cursor += Math.max(1, needle.length);
  }
  return found;
}

/**
 * Computes the media `[startSec, endSec]` window corresponding to a text-quote capture in a transcript view,
 * interpolating proportionally within the first and last covered paragraph anchors.
 */
export function timeRangeForQuote(
  content: TranscriptViewSource | undefined,
  capture: TextQuote,
): [number, number] | undefined {
  const anchors = content?.timeAnchors ?? [];
  const plain = content?.plain;
  if (!plain || anchors.length === 0) return undefined;
  const span = locateQuote(plain, capture);
  if (!span) return undefined;

  const covered = anchors.filter((a) => a.start < span.end && a.end > span.start);
  if (covered.length === 0) return undefined;

  const first = covered[0]!;
  const last = covered[covered.length - 1]!;
  const firstLen = Math.max(1, first.end - first.start);
  const lastLen = Math.max(1, last.end - last.start);

  const startRatio = Math.min(1, Math.max(0, (span.start - first.start) / firstLen));
  const endRatio = Math.min(1, Math.max(0, (span.end - last.start) / lastLen));

  const startSec = Math.round((first.startSec + startRatio * (first.endSec - first.startSec)) * 10) / 10;
  const endSec = Math.round((last.startSec + endRatio * (last.endSec - last.startSec)) * 10) / 10;
  return [startSec, Math.max(startSec + 0.5, endSec)];
}

/**
 * Re-anchors a highlight using its `timeRange` when the transcript prose was re-punctuated or cleaned up
 * by the agent and the original exact `text-quote` no longer matches.
 */
export function fallbackQuoteForTimeRange(
  content: TranscriptViewSource | undefined,
  timeRange: readonly [number, number],
): TextQuote | undefined {
  const anchors = content?.timeAnchors ?? [];
  const plain = content?.plain;
  if (!plain || anchors.length === 0) return undefined;

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
  if (!best) return undefined;

  let from = Math.max(0, best.start);
  let to = Math.min(plain.length, best.end);
  while (from < to && /\s/.test(plain[from] ?? "")) from += 1;
  while (to > from && /\s/.test(plain[to - 1] ?? "")) to -= 1;
  const quote = plain.slice(from, to).replace(/\s+/g, " ").trim();
  if (!quote) return undefined;

  const before = stripSpace(plain.slice(0, from));
  const after = stripSpace(plain.slice(to));
  const occurrence = allIndexesOf(before, stripSpace(quote)).length;
  return {
    locator: encodeTextQuoteV2Locator({
      occurrence,
      position: before.length,
      prefix: before.slice(-CONTEXT_CHARS),
      suffix: after.slice(0, CONTEXT_CHARS),
    }),
    quote,
  };
}

/** Finds the transcript paragraph anchor currently speaking at `positionSec`. */
export function activeParagraphForTime(
  anchors: readonly TranscriptAnchor[] | undefined,
  positionSec: number,
): TranscriptAnchor | undefined {
  if (!anchors || anchors.length === 0) return undefined;
  let candidate: TranscriptAnchor | undefined;
  for (const anchor of anchors) {
    if (anchor.startSec <= positionSec + 0.05) {
      candidate = anchor;
    } else {
      break;
    }
  }
  return candidate;
}

/** Appends a standard timestamp deep link (`?t=278` for YouTube, `#t=278` elsewhere). */
export function deepLinkWithTimestamp(rawUrl: string, startSec: number): string {
  const whole = Math.max(0, Math.floor(startSec));
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) {
      parsed.searchParams.set("t", String(whole));
      return parsed.toString();
    }
    parsed.hash = `t=${whole}`;
    return parsed.toString();
  } catch {
    return `${rawUrl}#t=${whole}`;
  }
}
