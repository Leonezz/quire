// @vitest-environment jsdom
import { encodeTextQuoteV2Locator } from "@read/reader";
import { describe, expect, it } from "vitest";
import type { TranscriptAnchor } from "../../shared/contracts";
import {
  activeParagraphForTime,
  deepLinkWithTimestamp,
  fallbackQuoteForTimeRange,
  timeRangeForQuote,
} from "./transcriptAnchors";

const p0 = "Welcome back to the podcast where we discuss scaling laws.";
const p1 = "Pretraining compute grew faster than tokens until data became finite.";
const plain = `${p0}\n\n${p1}`;
const timeAnchors: TranscriptAnchor[] = [
  { paragraphIndex: 0, start: 0, end: p0.length, startSec: 0, endSec: 10, speaker: "Host" },
  { paragraphIndex: 1, start: p0.length + 2, end: plain.length, startSec: 12, endSec: 32, speaker: "Guest" },
];

describe("transcriptAnchors", () => {
  it("maps a text quote to its proportional [startSec, endSec] media window and recovers after re-punctuation", () => {
    const capture = {
      locator: encodeTextQuoteV2Locator({ occurrence: 0, position: 0, prefix: "", suffix: "" }),
      quote: "Pretraining compute grew faster",
    };
    const range = timeRangeForQuote({ plain, timeAnchors }, capture);
    expect(range).toBeDefined();
    expect(range![0]).toBeCloseTo(12, 0);
    expect(range![1]).toBeGreaterThan(15);
    expect(range![1]).toBeLessThan(25);

    // Simulate Agent cleanup rewriting paragraph 1 wording while keeping timeAnchors
    const cleanedP1 = "Pre-training compute grew much faster than tokens — until internet data became finite.";
    const cleanedPlain = `${p0}\n\n${cleanedP1}`;
    const cleanedAnchors: TranscriptAnchor[] = [
      timeAnchors[0]!,
      { paragraphIndex: 1, start: p0.length + 2, end: cleanedPlain.length, startSec: 12, endSec: 32, speaker: "Guest" },
    ];
    const recovered = fallbackQuoteForTimeRange({ plain: cleanedPlain, timeAnchors: cleanedAnchors }, range!);
    expect(recovered?.quote).toBe(cleanedP1);
  });

  it("tracks active paragraph by playback second and formats timestamped deep links", () => {
    expect(activeParagraphForTime(timeAnchors, 4)?.paragraphIndex).toBe(0);
    expect(activeParagraphForTime(timeAnchors, 11)?.paragraphIndex).toBe(0);
    expect(activeParagraphForTime(timeAnchors, 18)?.paragraphIndex).toBe(1);

    expect(deepLinkWithTimestamp("https://www.youtube.com/watch?v=abc123", 278.9)).toBe("https://www.youtube.com/watch?v=abc123&t=278");
    expect(deepLinkWithTimestamp("https://dwarkesh.example.test/p/ep1", 278.9)).toBe("https://dwarkesh.example.test/p/ep1#t=278");
  });
});
