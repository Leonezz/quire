import { describe, expect, it } from "vitest";
import { cropWindow, normalizeText, parseSpec } from "./snap-spec";

describe("normalizeText", () => {
  it("drops whitespace and straightens quotes", () => {
    expect(normalizeText("Of course I’d  still\n be “here”")).toBe(`OfcourseI'dstillbe"here"`);
  });
});

describe("parseSpec", () => {
  const entry = { id: "a", slug: "s", caption: "c", reader: { text: "x" }, reference: null };

  it("fills the defaults", () => {
    expect(parseSpec([entry])).toEqual([{ id: "a", slug: "s", caption: "c", reader: { text: "x", before: 250, after: 650, nth: 1, wide: false }, reference: null }]);
  });

  it("keeps a highlight selector", () => {
    expect(parseSpec([{ ...entry, reader: { text: "x", highlight: "iframe" } }])[0]?.reader?.highlight).toBe("iframe");
  });

  it("accepts { entries }", () => {
    expect(parseSpec({ entries: [entry] })).toHaveLength(1);
  });

  it("rejects both sides null, duplicate ids, blank needles and missing sides", () => {
    expect(() => parseSpec([{ ...entry, reader: null }])).toThrow(/both null/);
    expect(() => parseSpec([entry, entry])).toThrow(/used twice/);
    expect(() => parseSpec([{ ...entry, reader: { text: "  " } }])).toThrow(/non-blank/);
    expect(() => parseSpec([{ id: "a", slug: "s", reader: { text: "x" } }])).toThrow(/needs both/);
    expect(() => parseSpec([{ ...entry, reader: { text: "x", before: -1 } }])).toThrow(/before/);
    expect(() => parseSpec([{ ...entry, reader: { text: "x", highlight: " " } }])).toThrow(/highlight/);
  });
});

describe("cropWindow", () => {
  it("clips around the top and stays inside the page", () => {
    expect(cropWindow(1000, { before: 250, after: 650 }, 5000)).toEqual({ y: 750, height: 900 });
    expect(cropWindow(100, { before: 250, after: 650 }, 5000)).toEqual({ y: 0, height: 750 });
    expect(cropWindow(4800, { before: 250, after: 650 }, 5000)).toEqual({ y: 4550, height: 450 });
  });
});
