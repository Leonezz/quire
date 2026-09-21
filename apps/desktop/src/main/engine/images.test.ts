import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImageCache } from "./images";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-images-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("ImageCache", () => {
  it("serves a cached image as a data URL without touching the network", async () => {
    const url = "https://example.test/figure.png";
    const key = createHash("sha256").update(url).digest("hex");
    await mkdir(join(root, "images"), { recursive: true });
    await writeFile(join(root, "images", `${key}.bin`), Buffer.from([137, 80, 78, 71]));
    await writeFile(join(root, "images", `${key}.json`), JSON.stringify({ mediaType: "image/png" }));
    const cache = new ImageCache(root);
    expect(await cache.resolve(url)).toBe("data:image/png;base64,iVBORw==");
  });

  it("serves a text view's figure crop from userData/figures and nothing for a crop that is not there", async () => {
    await mkdir(join(root, "figures", "8667175ac66aac06"), { recursive: true });
    await writeFile(join(root, "figures", "8667175ac66aac06", "2.png"), Buffer.from([137, 80, 78, 71]));
    const cache = new ImageCache(root);
    expect(await cache.resolve("quire-figure://8667175ac66aac06/2.png")).toBe("data:image/png;base64,iVBORw==");
    expect(await cache.resolve("quire-figure://8667175ac66aac06/3.png")).toBeUndefined();
    expect(await cache.explain("quire-figure://8667175ac66aac06/3.png")).toBe("figure crop is missing on disk");
  });

  it("refuses private hosts and non-http sources instead of fetching them", async () => {
    const cache = new ImageCache(root);
    expect(await cache.resolve("http://10.0.0.5/x.png")).toBeUndefined();
    expect(await cache.resolve("file:///etc/hosts")).toBeUndefined();
    expect(await cache.resolve("javascript:alert(1)")).toBeUndefined();
  });
});
