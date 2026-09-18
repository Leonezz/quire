import { describe, expect, it } from "vitest";
import { readingMinutes, wordCount } from "./reading-time";

describe("reading time", () => {
  it("counts Latin words by whitespace", () => {
    expect(wordCount("one two  three\nfour")).toBe(4);
    expect(readingMinutes("word ".repeat(720))).toBe(3);
  });
  it("counts each CJK character as a word", () => {
    expect(wordCount("这里记录每周值得分享的科技内容")).toBe(15);
    expect(readingMinutes("字".repeat(4700))).toBe(12);
  });
  it("adds both scripts of a mixed text", () => {
    expect(wordCount("React Native 再见了")).toBe(5);
    expect(readingMinutes("")).toBe(1);
  });
});
