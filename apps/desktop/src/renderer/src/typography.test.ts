import { describe, expect, it } from "vitest";
import { typographic } from "./typography";

describe("typographic", () => {
  it("curls quotes by what comes before them, and keeps apostrophes", () => {
    expect(typographic('One study found that "small chunks raised precision" and it\'s cheap.')).toBe("One study found that “small chunks raised precision” and it’s cheap.");
    expect(typographic("'single' (\"nested\")")).toBe("‘single’ (“nested”)");
    expect(typographic("wait... what")).toBe("wait… what");
    expect(typographic("no punctuation")).toBe("no punctuation");
  });
});
