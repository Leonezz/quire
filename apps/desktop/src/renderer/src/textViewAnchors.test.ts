// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { decodeTextQuoteLocator, encodeTextQuoteV2Locator } from "@read/reader";
import { parsePdfRegionsLocator } from "@read/reader-pdf";
import type { TextViewAnchor } from "../../shared/contracts";
import { locateQuote, pdfRegionsForQuote, textQuoteForRegions } from "./textViewAnchors";

// Three lines: two on page 1, one on page 2. Every line is 0.8 wide from x 0.1, 0.02 high.
const plain = "Alpha beta gamma\n\ndelta epsilon zeta eta\n\ntheta iota";
const anchors: TextViewAnchor[] = [
  { page: 1, rect: [0.1, 0.1, 0.8, 0.02], start: 0, end: 16 },
  { page: 1, rect: [0.1, 0.13, 0.8, 0.02], start: 18, end: 40 },
  { page: 2, rect: [0.1, 0.1, 0.8, 0.02], start: 42, end: 52 },
];
const content = { plain, anchors };
const quoteOf = (quote: string, hint: { prefix?: string; suffix?: string } = {}) => ({ quote, locator: encodeTextQuoteV2Locator({ occurrence: 0, prefix: hint.prefix ?? "", suffix: hint.suffix ?? "" }) });

describe("pdfRegionsForQuote", () => {
  it("clips the first and last line to the quoted characters and lists the regions of one page", () => {
    const regions = pdfRegionsForQuote(content, quoteOf("gamma delta"));
    expect(regions).toEqual({ page: 1, otherPages: [], locator: "pdf-regions:v1:1:0.6500,0.1000,0.2500,0.0200;0.1000,0.1300,0.1818,0.0200" });
    expect(parsePdfRegionsLocator(regions!.locator)).toHaveLength(2);
  });

  it("keeps a whole line whole and a quote inside one line to its characters", () => {
    expect(pdfRegionsForQuote(content, quoteOf("delta epsilon zeta eta"))?.locator).toBe("pdf-regions:v1:1:0.1000,0.1300,0.8000,0.0200");
    // "beta" is characters 6..10 of a 16-character line.
    expect(pdfRegionsForQuote(content, quoteOf("beta"))?.locator).toBe("pdf-regions:v1:1:0.4000,0.1000,0.2000,0.0200");
  });

  it("carries the first page in the locator and names the pages the quote runs on to", () => {
    const regions = pdfRegionsForQuote(content, quoteOf("zeta eta theta"));
    expect(regions?.page).toBe(1);
    expect(regions?.otherPages).toEqual([2]);
    expect(parsePdfRegionsLocator(regions!.locator)).toEqual([{ page: 1, x: 0.6091, y: 0.13, width: 0.2909, height: 0.02 }]);
  });

  it("is undefined without anchors, without text, or when the quote is not in the text", () => {
    expect(pdfRegionsForQuote({ plain, anchors: [] }, quoteOf("beta"))).toBeUndefined();
    expect(pdfRegionsForQuote({ plain: "", anchors }, quoteOf("beta"))).toBeUndefined();
    expect(pdfRegionsForQuote(content, quoteOf("omega"))).toBeUndefined();
  });
});

describe("locateQuote", () => {
  const repeated = "one two three. four two three.";
  it("tells repeated occurrences apart by the locator's prefix, and falls back to the first", () => {
    expect(locateQuote(repeated, quoteOf("two three", { prefix: "four" }))).toEqual({ start: 20, end: 29 });
    expect(locateQuote(repeated, quoteOf("two three", { prefix: "one" }))).toEqual({ start: 4, end: 13 });
    expect(locateQuote(repeated, quoteOf("two three"))).toEqual({ start: 4, end: 13 });
    expect(locateQuote(repeated, { quote: "two three", locator: "not-a-locator" })).toEqual({ start: 4, end: 13 });
  });

  it("matches across whitespace differences", () => {
    expect(locateQuote(plain, quoteOf("gamma   delta"))).toEqual({ start: 11, end: 23 });
  });
});

describe("textQuoteForRegions", () => {
  it("quotes the lines a region covers, with prefix and suffix from the text", () => {
    const quote = textQuoteForRegions(content, "pdf-regions:v1:1:0.1,0.13,0.8,0.02");
    expect(quote?.quote).toBe("delta epsilon zeta eta");
    expect(decodeTextQuoteLocator(quote!.locator)).toEqual({ occurrence: 0, position: 14, prefix: "Alphabetagamma", suffix: "thetaiota" });
  });

  it("narrows a line to the characters under a partial region and joins several regions", () => {
    expect(textQuoteForRegions(content, "pdf-regions:v1:1:0.1,0.13,0.4,0.02")?.quote).toBe("delta epsil");
    // From "gamma" (character 11 of 16, x 0.65) on the first line to the first 9 characters (x 0.1–0.4 of 0.8) of the second.
    expect(textQuoteForRegions(content, "pdf-regions:v1:1:0.65,0.1,0.25,0.02;0.1,0.13,0.3,0.02")?.quote).toBe("gamma delta eps");
  });

  it("ignores lines a region covers by less than half their height, and other pages", () => {
    expect(textQuoteForRegions(content, "pdf-regions:v1:1:0.1,0.145,0.8,0.02")).toBeUndefined();
    expect(textQuoteForRegions(content, "pdf-regions:v1:2:0.1,0.1,0.8,0.02")?.quote).toBe("theta iota");
    expect(textQuoteForRegions(content, "pdf-regions:v1:3:0.1,0.1,0.8,0.02")).toBeUndefined();
  });

  it("is undefined without anchors or for a locator that is not regions", () => {
    expect(textQuoteForRegions({ plain, anchors: [] }, "pdf-regions:v1:1:0.1,0.13,0.8,0.02")).toBeUndefined();
    expect(textQuoteForRegions(content, "text-quote:v2:e30=")).toBeUndefined();
  });

  it("round-trips a quote through regions and back", () => {
    const regions = pdfRegionsForQuote(content, quoteOf("gamma delta"))!;
    expect(textQuoteForRegions(content, regions.locator)?.quote).toBe("gamma delta");
  });
});
