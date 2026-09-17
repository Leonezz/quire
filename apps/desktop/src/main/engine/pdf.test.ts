import { describe, expect, it } from "vitest";
import { largestTextRun } from "./pdf";

const upright = (str: string, height: number) => ({ str, height, transform: [height, 0, 0, height, 72, 700] });
const rotated = (str: string, height: number) => ({ str, height, transform: [0, height, -height, 0, 20, 300] });

describe("largestTextRun", () => {
  it("joins the first run of the largest upright type and ignores stamps", () => {
    const items = [rotated("arXiv:1706.03762v7 [cs.CL] 2 Aug 2023", 20), upright("Attention Is", 17.2), upright("All You Need", 17.2), upright("Ashish Vaswani", 12), upright("Abstract", 12)];
    expect(largestTextRun(items)).toBe("Attention Is All You Need");
  });

  it("stops at the first smaller item and tolerates slight size differences within the title", () => {
    expect(largestTextRun([upright("Momentum,", 14), upright("revisited", 13.3), upright("by someone", 10)])).toBe("Momentum, revisited");
  });

  it("returns nothing for empty, tiny or unreasonably long candidates", () => {
    expect(largestTextRun([])).toBeUndefined();
    expect(largestTextRun([upright("  ", 30), upright("A", 30)])).toBeUndefined();
    expect(largestTextRun([upright("x".repeat(301), 30)])).toBeUndefined();
  });
});
