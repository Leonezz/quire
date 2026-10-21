import { afterEach, describe, expect, it, vi } from "vitest";
import { createImageFetcher, imageUrlsOf, maxImageBytes, proxiedSource, sniffImageType } from "./image-proxy";

afterEach(() => { vi.unstubAllGlobals(); });

describe("imageUrlsOf", () => {
  it("collects every image node's url once, from the payload string or tree", () => {
    const tree = { type: "root", children: [{ type: "figure", media: { type: "image", url: "https://e.com/a.png" } }, { type: "paragraph", children: [{ type: "image", url: "https://e.com/b.png" }, { type: "link", url: "https://e.com/page" }, { type: "image", url: "https://e.com/a.png" }] }] };
    expect(imageUrlsOf(JSON.stringify(tree))).toEqual(["https://e.com/a.png", "https://e.com/b.png"]);
    expect(imageUrlsOf(tree)).toEqual(["https://e.com/a.png", "https://e.com/b.png"]);
  });
});

describe("proxiedSource", () => {
  it("reads src from the harness's image endpoint only", () => {
    expect(proxiedSource(`http://127.0.0.1:1/__render/image?src=${encodeURIComponent("https://e.com/a b.png")}`)).toBe("https://e.com/a b.png");
    expect(proxiedSource("http://127.0.0.1:1/other?src=x")).toBeUndefined();
  });
});

describe("image size caps", () => {
  const MiB = 1024 * 1024;
  const serve = (signature: readonly number[], size: number, type: string, declared = size) => {
    const bytes = new Uint8Array(size);
    bytes.set(signature);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ "content-type": type, "content-length": String(declared) }), arrayBuffer: async () => bytes.buffer })));
  };
  const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
  const PNG = [0x89, 0x50, 0x4e, 0x47];

  it("match the app's: 32 MiB for a GIF, declared or sniffed, 8 MiB for anything else", async () => {
    expect(maxImageBytes("image/gif")).toBe(32 * MiB);
    expect(maxImageBytes("image/png")).toBe(8 * MiB);
    serve(GIF, 20 * MiB, "application/octet-stream");
    expect(await createImageFetcher()("https://e.com/anim.gif")).toMatchObject({ ok: true, mediaType: "image/gif" });
    serve(GIF, 16, "image/gif", 33 * MiB);
    expect(await createImageFetcher()("https://e.com/huge.gif")).toEqual({ ok: false, error: `larger than ${32 * MiB} bytes` });
    serve(PNG, 9 * MiB, "image/png");
    expect(await createImageFetcher()("https://e.com/big.png")).toEqual({ ok: false, error: `larger than ${8 * MiB} bytes` });
  });
});

describe("sniffImageType", () => {
  it("recognises image bytes and refuses others", () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe("image/png");
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(new TextEncoder().encode("  <svg xmlns='x'></svg>"))).toBe("image/svg+xml");
    expect(sniffImageType(new TextEncoder().encode("<!doctype html>"))).toBeUndefined();
  });
});
