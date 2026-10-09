import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildManifest, cachedManifest, captureCodeId, captureKey, rendererBuildId, summaryLine, type KeyInputs } from "./manifest";
import type { Embed, ReferenceImage, RenderedCode, RenderedImage, RenderedTable, RenderMetrics } from "./types";

const dirs: string[] = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "render-manifest-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const metrics: RenderMetrics = {
  images: { total: 3, broken: 1, brokenSrc: ["https://e.com/a.png"] }, overflow: { count: 2, samples: [] }, rawMarkup: { count: 4, samples: [] },
  mathErrors: 5, collapsedCode: 1, unmarkedLists: 0, emptyCellTables: { count: 0, samples: [] }, emptyHeadings: 0, duplicateTitleHeadings: 0, counts: { codeBlocks: 0, tables: 0, figures: 0, lists: 0, footnotes: 0, headings: 0, words: 10 }, height: 26_107,
};
const viewport = { width: 1280, height: 1600, deviceScaleFactor: 1 };
const renderedImages: RenderedImage[] = [{ id: "r1", tile: 1, src: "https://e.com/a.png", alt: "", caption: "", broken: false }];
const referenceImages: ReferenceImage[] = [
  { id: "o1", tile: 1, src: "https://e.com/a.png", candidates: ["https://e.com/a.png"], alt: "", width: 700, height: 300, matchedBy: "r1", context: "Intro" },
  { id: "o2", tile: 2, src: "https://e.com/b.png", candidates: ["https://e.com/b.png"], alt: "", width: 700, height: 300, matchedBy: null, context: "Related posts" },
];
const tables: RenderedTable[] = [{ id: "t1", tile: 1, rows: 3, cols: 2, cells: 4, emptyCells: 0, head: "a | b" }];
const code: RenderedCode[] = [{ id: "c1", tile: 1, lines: 1, chars: 130, collapsed: true, head: "x".repeat(80) }];
const embeds: Embed[] = [{ kind: "iframe", tag: "iframe", src: "https://www.youtube.com/embed/x", host: "www.youtube.com", context: "", representedInReader: false }];
const manifest = () => buildManifest({
  slug: "lilian-attention", id: "abc", url: "https://e.com/p", key: "k1", capturedAt: new Date("2026-10-08T00:00:00Z"), viewport,
  rendered: { tiles: ["rendered-01.png"], height: 26_107, truncated: true, metrics, images: renderedImages, tables, code },
  reference: { tiles: ["reference-01.png", "reference-02.png"], height: 3000, truncated: false, failedRequests: 2, images: referenceImages },
  embeds,
  warnings: ["images-timeout"],
});

describe("captureKey", () => {
  const base: KeyInputs = { record: "{\"id\":1}", snapshot: new Uint8Array([1, 2, 3]), buildId: "b1", codeId: "c1", viewport, maxTiles: 8, maxReferenceTiles: 6 };
  it("is a stable sha256 that changes with every input", () => {
    const key = captureKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(captureKey({ ...base })).toBe(key);
    const variants: KeyInputs[] = [
      { ...base, record: "{\"id\":2}" }, { ...base, snapshot: new Uint8Array([1, 2, 4]) }, { ...base, buildId: "b2" }, { ...base, codeId: "c2" },
      { ...base, viewport: { ...viewport, width: 1024 } }, { ...base, maxTiles: 4 }, { ...base, maxReferenceTiles: 2 },
    ];
    for (const variant of variants) expect(captureKey(variant)).not.toBe(key);
  });
});

describe("captureCodeId", () => {
  it("changes when a capture source changes, and fails loudly when one is missing", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.ts"), "one");
    const first = captureCodeId(dir, ["a.ts"]);
    writeFileSync(join(dir, "a.ts"), "two");
    expect(captureCodeId(dir, ["a.ts"])).not.toBe(first);
    expect(() => captureCodeId(dir, ["missing.ts"])).toThrow(/ENOENT/);
  });

  it("covers the real capture sources", () => {
    expect(captureCodeId(import.meta.dirname)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("rendererBuildId", () => {
  it("hashes index.html and the asset names, and fails loudly without a build", () => {
    const dir = tempDir();
    expect(() => rendererBuildId(dir)).toThrow(/No renderer build/);
    writeFileSync(join(dir, "index.html"), "<html>");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "index-AAAA.js"), "");
    const first = rendererBuildId(dir);
    expect(rendererBuildId(dir)).toBe(first);
    rmSync(join(dir, "assets", "index-AAAA.js"));
    writeFileSync(join(dir, "assets", "index-BBBB.js"), "");
    expect(rendererBuildId(dir)).not.toBe(first);
  });
});

describe("buildManifest", () => {
  it("has the contract's shape", () => {
    expect(manifest()).toEqual({
      slug: "lilian-attention", id: "abc", url: "https://e.com/p", key: "k1", capturedAt: "2026-10-08T00:00:00.000Z", viewport,
      rendered: { tiles: ["rendered-01.png"], height: 26_107, truncated: true, textPath: "rendered.txt", metrics, images: renderedImages, tables, code },
      reference: { tiles: ["reference-01.png", "reference-02.png"], height: 3000, truncated: false, failedRequests: 2, images: referenceImages },
      embeds,
      warnings: ["images-timeout"],
    });
  });
});

describe("cachedManifest", () => {
  it("returns the manifest only when its key matches", () => {
    const path = join(tempDir(), "manifest.json");
    expect(cachedManifest(path, "k1")).toBeUndefined();
    writeFileSync(path, JSON.stringify(manifest()));
    expect(cachedManifest(path, "k1")?.slug).toBe("lilian-attention");
    expect(cachedManifest(path, "k2")).toBeUndefined();
    writeFileSync(path, "{not json");
    expect(cachedManifest(path, "k1")).toBeUndefined();
  });
});

describe("summaryLine", () => {
  it("prints one line per slug, marking truncated sides with +", () => {
    expect(summaryLine(manifest(), "fresh")).toBe(`${"lilian-attention".padEnd(24)}  fresh   rendered 1+ tiles (26107 px) · reference 2 tiles · broken images 1 · overflow 2 · raw markup 4 · math errors 5 · collapsed code 1 · images 1 shown, 1/2 original matched · embeds 1 (1 not in reader) · warnings: images-timeout`);
  });
});
