import { describe, expect, it } from "vitest";
import { TILE_PATTERN, planTiles, tileName } from "./tiles";

describe("planTiles", () => {
  it("cuts a region into full tiles and a shorter last one", () => {
    expect(planTiles(0, 4000, 1600, 8)).toEqual({ tiles: [{ index: 0, y: 0, height: 1600 }, { index: 1, y: 1600, height: 1600 }, { index: 2, y: 3200, height: 800 }], truncated: false });
  });

  it("makes exact multiples without an empty tail", () => {
    expect(planTiles(0, 3200, 1600, 8).tiles.map((t) => t.height)).toEqual([1600, 1600]);
  });

  it("offsets tiles by the region top and rounds fractional heights up", () => {
    expect(planTiles(48.6, 1600.2, 1600, 8).tiles).toEqual([{ index: 0, y: 48, height: 1600 }, { index: 1, y: 1648, height: 1 }]);
  });

  it("caps the count and says it truncated", () => {
    const plan = planTiles(0, 26_107, 1600, 8);
    expect(plan.tiles).toHaveLength(8);
    expect(plan.truncated).toBe(true);
    expect(plan.tiles.at(-1)).toEqual({ index: 7, y: 11_200, height: 1600 });
  });

  it("returns nothing for an empty region, and truncated when the cap is 0", () => {
    expect(planTiles(0, 0, 1600, 8)).toEqual({ tiles: [], truncated: false });
    expect(planTiles(0, 10, 1600, 0)).toEqual({ tiles: [], truncated: true });
    expect(() => planTiles(0, 10, 0, 8)).toThrow(/positive/);
  });
});

describe("tileName", () => {
  it("numbers from 01 so names sort, and matches the cleanup pattern", () => {
    expect(tileName("rendered", 0)).toBe("rendered-01.png");
    expect(tileName("reference", 11)).toBe("reference-12.png");
    expect(TILE_PATTERN.test("reference-12.png")).toBe(true);
    expect(TILE_PATTERN.test("manifest.json")).toBe(false);
  });
});
