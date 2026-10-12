import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { packWithinBudget, zipEntries, type ZipEntry, type Zipper } from "./feedback-zip";

const bytes = (size: number, fill = 1) => new Uint8Array(size).fill(fill);
const entry = (path: string, size: number): ZipEntry => ({ path, bytes: bytes(size) });
/** A zip whose size is the sum of its entries, so the budget arithmetic is exact. */
const sizeZip: Zipper = (entries) => new Uint8Array(entries.reduce((total, item) => total + item.bytes.byteLength, 0));

describe("zipEntries", () => {
  it("round-trips the entries with their paths", () => {
    const text = new TextEncoder().encode("# Gondor\n".repeat(100));
    const zip = zipEntries([{ path: "extracted.md", bytes: text }, { path: "screenshots/reader-viewport.png", bytes: bytes(64, 7) }]);
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(["extracted.md", "screenshots/reader-viewport.png"]);
    expect(files["extracted.md"]).toEqual(text);
    expect(files["screenshots/reader-viewport.png"]).toEqual(bytes(64, 7));
    // Text is deflated; the same entries zip to the same bytes.
    expect(zip.byteLength).toBeLessThan(text.byteLength);
    expect(zipEntries([{ path: "extracted.md", bytes: text }])).toEqual(zipEntries([{ path: "extracted.md", bytes: text }]));
  });
});

describe("packWithinBudget", () => {
  const entries = [
    entry("meta.json", 10), entry("page.html.gz", 100),
    entry("screenshots/reader-viewport.png", 50),
    entry("screenshots/reader-full-01.jpg", 40), entry("screenshots/reader-full-02.jpg", 40), entry("screenshots/reader-full-03.jpg", 40),
  ];

  it("keeps everything that fits", () => {
    const packed = packWithinBudget(entries, 1_000, sizeZip);
    expect(packed).toMatchObject({ dropped: [], overBudget: false });
    expect(packed.kept).toHaveLength(6);
    expect(packed.zip.byteLength).toBe(280);
  });

  it("drops full-article tiles from the end until the zip fits", () => {
    const packed = packWithinBudget(entries, 200, sizeZip);
    expect(packed.dropped).toEqual(["screenshots/reader-full-03.jpg", "screenshots/reader-full-02.jpg"]);
    expect(packed.kept.map((item) => item.path)).toContain("screenshots/reader-full-01.jpg");
    expect(packed.zip.byteLength).toBe(200);
    expect(packed.overBudget).toBe(false);
  });

  it("says so when even without tiles the zip is too large, keeping everything else", () => {
    const packed = packWithinBudget(entries, 100, sizeZip);
    expect(packed.dropped).toHaveLength(3);
    expect(packed.overBudget).toBe(true);
    expect(packed.kept.map((item) => item.path)).toEqual(["meta.json", "page.html.gz", "screenshots/reader-viewport.png"]);
  });
});
