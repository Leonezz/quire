import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageCache, figureImageUrl, imageUrl, parseImageUrl } from "./images";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-images-")); });
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

const keyOf = (url: string) => createHash("sha256").update(url).digest("hex");
const cachedUrlOf = (url: string) => `quire-image://cache/${keyOf(url)}`;
/** Bytes read from disk come back as a Buffer; compared as plain bytes. */
const bytesOf = (bytes: Uint8Array | undefined) => (bytes ? Array.from(bytes) : undefined);
/** A cached image as ImageCache writes it: <sha256(url)>.bin and .json under images/. */
async function seedImage(url: string) {
  await mkdir(join(root, "images"), { recursive: true });
  await writeFile(join(root, "images", `${keyOf(url)}.bin`), Buffer.from([137, 80, 78, 71]));
  await writeFile(join(root, "images", `${keyOf(url)}.json`), JSON.stringify({ mediaType: "image/png", url }));
}

describe("image URLs", () => {
  it("name a cache key or a figure crop on the quire-image scheme and read back only a well-formed one", () => {
    const key = keyOf("https://example.test/figure.png");
    expect(imageUrl(key)).toBe(`quire-image://cache/${key}`);
    expect(parseImageUrl(`quire-image://cache/${key}`)).toEqual({ kind: "cache", key });
    // An all-digit id stays in the path, where no host canonicalization reads it as an IPv4 address.
    const ref = { materialId: "1234567890123456", index: 2 };
    expect(figureImageUrl(ref)).toBe("quire-image://figure/1234567890123456/2.png");
    expect(parseImageUrl(figureImageUrl(ref))).toEqual({ kind: "figure", ref });
    for (const url of [
      `quire-image://cache/${key.toUpperCase()}`,
      `quire-image://cache/${key.slice(1)}`,
      `quire-image://cache/${key}/`,
      `quire-image://cache/${key}/../settings.json`,
      `quire-image://cache/../${key}`,
      `quire-image://cache/${key}?x=1`,
      `quire-image://${key}`,
      `quire-image://other/${key}`,
      "quire-image://figure/1234567890123456/0.png",
      "quire-image://figure/123456789012345/2.png",
      "quire-image://figure/1234567890123456/2.json",
      `https://cache/${key}`,
    ]) expect(parseImageUrl(url), url).toBeUndefined();
    expect(() => imageUrl("../settings")).toThrow(/not an image cache key/);
  });
});

describe("ImageCache", () => {
  it("resolves a cached image to its quire-image URL without touching the network, and hands the protocol its bytes", async () => {
    const url = "https://example.test/figure.png";
    await seedImage(url);
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const cache = new ImageCache(root);
    expect(await cache.resolve(url)).toBe(cachedUrlOf(url));
    const stored = await cache.stored(keyOf(url));
    expect(stored?.mediaType).toBe("image/png");
    expect(bytesOf(stored?.bytes)).toEqual([137, 80, 78, 71]);
    expect(network).not.toHaveBeenCalled();
  });

  it("fetches an image not yet cached, stores it with its type and resolves to the stored copy", async () => {
    const url = "https://example.test/new.gif";
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(gif, { headers: { "content-type": "application/octet-stream" } })));
    const cache = new ImageCache(root);
    expect(await cache.resolve(url)).toBe(cachedUrlOf(url));
    expect(bytesOf(await readFile(join(root, "images", `${keyOf(url)}.bin`)))).toEqual(Array.from(gif));
    const stored = await cache.stored(keyOf(url));
    expect(stored?.mediaType).toBe("image/gif");
    expect(bytesOf(stored?.bytes)).toEqual(Array.from(gif));
  });

  it("leaves an image it cannot fetch unresolved and says why", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } })));
    const cache = new ImageCache(root);
    expect(await cache.resolve("https://example.test/page")).toBeUndefined();
    expect(await cache.explain("https://example.test/page")).toBe("not an image (text/html)");
    expect(await readdir(root)).not.toContain("images");
  });

  it("serves nothing for a key it does not hold, and refuses one that is not a key or names no image type", async () => {
    const cache = new ImageCache(root);
    expect(await cache.stored("f".repeat(64))).toBeUndefined();
    await expect(cache.stored("../settings")).rejects.toThrow(/not an image cache key/);
    const url = "https://example.test/tampered.png";
    await seedImage(url);
    await writeFile(join(root, "images", `${keyOf(url)}.json`), JSON.stringify({ mediaType: "text/html", url }));
    await expect(cache.stored(keyOf(url))).rejects.toThrow(/text\/html/);
  });

  it("resolves a text view's figure crop to its quire-image URL while it is on disk, and serves its bytes", async () => {
    await mkdir(join(root, "figures", "8667175ac66aac06"), { recursive: true });
    await writeFile(join(root, "figures", "8667175ac66aac06", "2.png"), Buffer.from([137, 80, 78, 71]));
    const cache = new ImageCache(root);
    expect(await cache.resolve("quire-figure://8667175ac66aac06/2.png")).toBe("quire-image://figure/8667175ac66aac06/2.png");
    expect(bytesOf(await cache.figure({ materialId: "8667175ac66aac06", index: 2 }))).toEqual([137, 80, 78, 71]);
    expect(await cache.resolve("quire-figure://8667175ac66aac06/3.png")).toBeUndefined();
    expect(await cache.figure({ materialId: "8667175ac66aac06", index: 3 })).toBeUndefined();
    expect(await cache.explain("quire-figure://8667175ac66aac06/3.png")).toBe("figure crop is missing on disk");
  });

  it("refuses private hosts and non-http sources instead of fetching them", async () => {
    const cache = new ImageCache(root);
    expect(await cache.resolve("http://10.0.0.5/x.png")).toBeUndefined();
    expect(await cache.resolve("file:///etc/hosts")).toBeUndefined();
    expect(await cache.resolve("javascript:alert(1)")).toBeUndefined();
  });
});

describe("ImageCache.forget", () => {
  it("removes the cached copies of the given sources and counts them, leaving every other image and the figure crops", async () => {
    await seedImage("https://example.test/a.png");
    await seedImage("https://example.test/b.png");
    await mkdir(join(root, "figures", "8667175ac66aac06"), { recursive: true });
    await writeFile(join(root, "figures", "8667175ac66aac06", "2.png"), Buffer.from([137, 80, 78, 71]));
    const cache = new ImageCache(root);

    const removed = await cache.forget(["https://example.test/a.png", "https://example.test/a.png", "https://example.test/never-cached.png", "quire-figure://8667175ac66aac06/2.png", "file:///etc/hosts"]);
    expect(removed).toBe(1);
    expect((await readdir(join(root, "images"))).sort()).toEqual([`${keyOf("https://example.test/b.png")}.bin`, `${keyOf("https://example.test/b.png")}.json`].sort());
    expect(await cache.resolve("https://example.test/b.png")).toBe(cachedUrlOf("https://example.test/b.png"));
    expect(await cache.stored(keyOf("https://example.test/a.png"))).toBeUndefined();
    expect(await cache.resolve("quire-figure://8667175ac66aac06/2.png")).toBe("quire-image://figure/8667175ac66aac06/2.png");
  });

  it("has nothing to remove when nothing was ever cached", async () => {
    const cache = new ImageCache(root);
    expect(await cache.forget(["https://example.test/a.png"])).toBe(0);
    expect(await cache.forget([])).toBe(0);
  });
});
