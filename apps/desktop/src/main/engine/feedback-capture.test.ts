import { describe, expect, it } from "vitest";
import {
  MAX_FIND_TEXT, compositeCaption, compositeHtml, compositeLayout, decodeCapture, findTextOf, fullTileName, injectBase,
  planTiles, renderWidthOf, roundRect, selectionCaptureRect, windowCaptureRect,
} from "./feedback-capture";

describe("windowCaptureRect", () => {
  const window = { width: 1360, height: 880 };

  it("is the CSS rectangle rounded outwards at zoom 1", () => {
    expect(windowCaptureRect({ x: 561.99, y: 54, width: 798.01, height: 826 }, 1, window)).toEqual({ x: 561, y: 54, width: 799, height: 826 });
  });

  it("scales by the zoom factor and clips to the window", () => {
    expect(windowCaptureRect({ x: 600, y: 50, width: 700, height: 900 }, 1.25, window)).toEqual({ x: 750, y: 62, width: 610, height: 818 });
    expect(windowCaptureRect({ x: -20, y: -10, width: 100, height: 50 }, 1, window)).toEqual({ x: 0, y: 0, width: 80, height: 40 });
  });

  it("is undefined for a rectangle outside the window, and refuses a bad zoom", () => {
    expect(windowCaptureRect({ x: 0, y: 2_000, width: 100, height: 50 }, 1, window)).toBeUndefined();
    expect(() => windowCaptureRect({ x: 0, y: 0, width: 1, height: 1 }, 0, window)).toThrow("zoom factor");
  });
});

describe("selectionCaptureRect", () => {
  const viewport = { x: 240, y: 52, width: 760, height: 800 };

  it("spans the reading column, 120 px above and below the passage", () => {
    expect(selectionCaptureRect({ x: 300, y: 400, width: 120, height: 20 }, viewport)).toEqual({ x: 240, y: 280, width: 760, height: 260 });
  });

  it("clamps to the viewport at its top and bottom", () => {
    expect(selectionCaptureRect({ x: 300, y: 60, width: 120, height: 20 }, viewport)).toEqual({ x: 240, y: 52, width: 760, height: 148 });
    expect(selectionCaptureRect({ x: 300, y: 800, width: 120, height: 40 }, viewport)).toEqual({ x: 240, y: 680, width: 760, height: 172 });
    // A selection scrolled out of the viewport still gives a one-pixel band inside it, never a negative size.
    expect(selectionCaptureRect({ x: 0, y: 5_000, width: 10, height: 10 }, viewport).height).toBeGreaterThanOrEqual(1);
  });

  it("pads the passage's own box when the viewport is unknown, never above the window", () => {
    expect(selectionCaptureRect({ x: 10.4, y: 50, width: 100, height: 20 }, undefined)).toEqual({ x: 10, y: 0, width: 101, height: 190 });
  });
});

describe("roundRect / renderWidthOf / fullTileName", () => {
  it("rounds outwards to whole pixels", () => {
    expect(roundRect({ x: 1.5, y: 2.5, width: 10.2, height: 0 })).toEqual({ x: 1, y: 2, width: 11, height: 1 });
    expect(roundRect({ x: -4, y: -1, width: 10, height: 10 })).toEqual({ x: 0, y: 0, width: 6, height: 9 });
  });

  it("renders at the viewport's width within the harness's bounds, 1280 without one", () => {
    expect(renderWidthOf(undefined)).toBe(1280);
    expect(renderWidthOf({ x: 0, y: 0, width: 760.4, height: 1, scrollFraction: 0 })).toBe(760);
    expect(renderWidthOf({ x: 0, y: 0, width: 100, height: 1, scrollFraction: 0 })).toBe(320);
    expect(renderWidthOf({ x: 0, y: 0, width: 9_000, height: 1, scrollFraction: 0 })).toBe(4_000);
  });

  it("names tiles 1-based with two digits", () => {
    expect(fullTileName(0)).toBe("screenshots/reader-full-01.jpg");
    expect(fullTileName(11)).toBe("screenshots/reader-full-12.jpg");
  });
});

describe("planTiles", () => {
  it("cuts the article into 1600 px tiles from its top, at most maxTiles", () => {
    expect(planTiles(40.7, 3_500, 1_600, 8)).toEqual({ tiles: [{ index: 0, y: 40, height: 1_600 }, { index: 1, y: 1_640, height: 1_600 }, { index: 2, y: 3_240, height: 300 }], truncated: false });
    expect(planTiles(0, 20_000, 1_600, 8)).toMatchObject({ truncated: true });
    expect(planTiles(0, 20_000, 1_600, 8).tiles).toHaveLength(8);
    expect(planTiles(0, 0, 1_600, 8)).toEqual({ tiles: [], truncated: false });
    expect(() => planTiles(0, 10, 0, 8)).toThrow("tile height must be positive");
  });
});

describe("findTextOf", () => {
  it("collapses whitespace, ends on a word boundary and caps the length", () => {
    expect(findTextOf("  The   siege\nof Gondor ")).toBe("The siege of Gondor");
    const long = findTextOf("word ".repeat(40))!;
    expect(long.length).toBeLessThanOrEqual(MAX_FIND_TEXT);
    expect(long.endsWith("word")).toBe(true);
    expect(findTextOf("最".repeat(200))).toHaveLength(MAX_FIND_TEXT);
    expect(findTextOf(" \n ")).toBeUndefined();
  });
});

describe("injectBase", () => {
  const url = "https://example.test/posts/a/";

  it("puts <base href> first in <head>", () => {
    expect(injectBase("<!doctype html><html><head><title>T</title></head><body></body></html>", url)).toBe(`<!doctype html><html><head><base href="${url}"><title>T</title></head><body></body></html>`);
  });

  it("creates <head> under <html>, or after the doctype when there is no <html>", () => {
    expect(injectBase("<html lang=en><body>x</body></html>", url)).toBe(`<html lang=en><head><base href="${url}"></head><body>x</body></html>`);
    expect(injectBase("<!DOCTYPE html><p>x</p>", url)).toBe(`<!DOCTYPE html><head><base href="${url}"></head><p>x</p>`);
    expect(injectBase("<p>x</p>", url)).toBe(`<head><base href="${url}"></head><p>x</p>`);
  });

  it("keeps the page's own base, resolved against the final URL, and escapes the attribute", () => {
    expect(injectBase(`<head><base href="/blog/"><base target=_blank></head>`, url)).toBe(`<head><base href="https://example.test/blog/"></head>`);
    expect(injectBase("<head></head>", "https://example.test/?a=1&b=\"2\"")).toBe(`<head><base href="https://example.test/?a=1&amp;b=&quot;2&quot;"></head>`);
  });
});

describe("decodeCapture", () => {
  it("decodes in the declared charset, UTF-8 otherwise, and warns about unknown ones", () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    expect(decodeCapture(latin1, "text/html; charset=ISO-8859-1")).toEqual({ html: "café" });
    expect(decodeCapture(new TextEncoder().encode("café"), "text/html")).toEqual({ html: "café" });
    expect(decodeCapture(new TextEncoder().encode("x"), undefined)).toEqual({ html: "x" });
    const unknown = decodeCapture(new TextEncoder().encode("x"), 'text/html; charset="x-klingon"');
    expect(unknown.html).toBe("x");
    expect(unknown.warning).toMatch(/x-klingon/);
  });
});

describe("the composite", () => {
  it("captions with title, URL, view and kinds", () => {
    expect(compositeCaption({ title: " Collections:\n The Siege ", url: "https://acoup.blog/x/", view: "web", kinds: ["images", "tables"] })).toEqual({ title: "Collections: The Siege", detail: "https://acoup.blog/x/ · web view · images, tables" });
    expect(compositeCaption({ title: "T", url: "u", view: "markdown", kinds: [] }).detail).toBe("u · markdown view · no kind picked");
  });

  it("lays two screenshots side by side, scaled to the column, and one alone", () => {
    const two = compositeLayout({ width: 1_520, height: 1_600 }, { width: 1_280, height: 1_600 });
    expect(two.columns.map((column) => [column.label, column.width, column.height])).toEqual([["Quire reader", 776, 817], ["Original page", 776, 970]]);
    expect(two.width).toBe(16 + 2 * (776 + 16));
    expect(two.height).toBe(16 * 2 + 56 + 24 + 970);
    const one = compositeLayout({ width: 400, height: 10_000 }, undefined);
    expect(one.columns).toHaveLength(1);
    expect(one.columns[0]).toMatchObject({ height: 1_800, width: 72 });
    expect(() => compositeLayout({ width: 0, height: 10 }, undefined)).toThrow("must have a size");
  });

  it("writes a static page with the images and the escaped caption", () => {
    const layout = compositeLayout({ width: 100, height: 100 }, { width: 100, height: 100 });
    const html = compositeHtml(layout, ["data:image/png;base64,AAA", "data:image/png;base64,BBB"], { title: "<script>alert(1)</script>", detail: "a & b" });
    expect(html).toContain('src="data:image/png;base64,AAA"');
    expect(html).toContain('src="data:image/png;base64,BBB"');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("a &amp; b");
    expect(() => compositeHtml(layout, ["one"], { title: "", detail: "" })).toThrow("2 columns but 1 images");
  });
});
