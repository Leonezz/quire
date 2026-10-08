import { describe, expect, it } from "vitest";
import { parseRenderArgs } from "./args";

describe("parseRenderArgs", () => {
  it("defaults to every case, 8/6 tiles, 1280 wide, building, 3 at a time", () => {
    expect(parseRenderArgs([])).toEqual({ slugs: [], force: false, build: true, maxTiles: 8, maxReferenceTiles: 6, width: 1280, concurrency: 3 });
  });

  it("reads slugs and every flag in any order, without duplicate slugs", () => {
    expect(parseRenderArgs(["a", "--force", "--max-tiles", "4", "b", "--max-reference-tiles", "0", "--width", "1024", "--no-build", "--concurrency", "1", "a"]))
      .toEqual({ slugs: ["a", "b"], force: true, build: false, maxTiles: 4, maxReferenceTiles: 0, width: 1024, concurrency: 1 });
  });

  it("rejects unknown options, missing and malformed values, and out-of-range numbers", () => {
    expect(() => parseRenderArgs(["--fast"])).toThrow(/Unknown option --fast/);
    expect(() => parseRenderArgs(["--max-tiles"])).toThrow(/needs a value/);
    expect(() => parseRenderArgs(["--max-tiles", "--force"])).toThrow(/needs a value/);
    expect(() => parseRenderArgs(["--width", "12.5"])).toThrow(/integer/);
    expect(() => parseRenderArgs(["--max-tiles", "0"])).toThrow(/between 1 and 100/);
    expect(() => parseRenderArgs(["--concurrency", "99"])).toThrow(/between 1 and 16/);
  });
});
