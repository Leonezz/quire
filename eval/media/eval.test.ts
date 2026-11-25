import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { MEDIA_FIXTURES, evaluateMediaFixture } from "./corpus";
import { writeMediaReport, writeMediaSourcesManifest } from "./report";
import type { MediaEvalRow } from "./types";

const MEDIA_DIR = dirname(fileURLToPath(import.meta.url));
const rows: MediaEvalRow[] = [];

describe("media reading evaluation set (20 podcast & technical video snapshots)", () => {
  it("contains 20 representative podcast and video snapshots across languages and subtitle formats", () => {
    expect(MEDIA_FIXTURES).toHaveLength(20);
    expect(MEDIA_FIXTURES.filter((f) => f.kind === "podcast")).toHaveLength(10);
    expect(MEDIA_FIXTURES.filter((f) => f.kind === "video")).toHaveLength(10);
  });

  it.each(MEDIA_FIXTURES.map((fixture) => [fixture.slug, fixture] as const))(
    "%s",
    (_slug, fixture) => {
      const row = evaluateMediaFixture(fixture);
      rows.push(row);

      expect(row.flags, `Media eval flags for ${fixture.slug}:\n${row.flags.join("\n")}`).toEqual([]);
      expect(row.chapterRecall).toBe(1);
      expect(row.falsePositiveChapters).toBe(0);
      expect(row.offsetMismatches).toBe(0);
      expect(row.maxAnchorStartDriftSec).toBeLessThan(0.5);
      expect(row.maxProbeDriftSec).toBeLessThan(0.5);
      expect(row.minParaUnits).toBeGreaterThanOrEqual(14);
      expect(row.maxParaUnits).toBeLessThanOrEqual(175);
      if (row.agentCleanupChecked) {
        expect(row.agentCleanupPassed).toBe(true);
      }
      expect(row.pass).toBe(true);
    },
  );
});

afterAll(() => {
  if (rows.length === 0) return;
  writeMediaSourcesManifest(join(MEDIA_DIR, "sources.json"), MEDIA_FIXTURES);
  writeMediaReport(join(MEDIA_DIR, "report.md"), rows);
});
