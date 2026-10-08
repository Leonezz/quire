import { describe, expect, it } from "vitest";
import { imageUrlsOf, proxiedSource, sniffImageType } from "./image-proxy";

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

describe("sniffImageType", () => {
  it("recognises image bytes and refuses others", () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe("image/png");
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(new TextEncoder().encode("  <svg xmlns='x'></svg>"))).toBe("image/svg+xml");
    expect(sniffImageType(new TextEncoder().encode("<!doctype html>"))).toBeUndefined();
  });
});
