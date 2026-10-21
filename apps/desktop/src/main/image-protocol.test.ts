import { describe, expect, it, vi } from "vitest";
import { IMAGE_RESPONSE_CSP, imageResponse, type ImageSources } from "./image-protocol";

const KEY = "a".repeat(64);
const PNG = new Uint8Array([137, 80, 78, 71]);
const SVG = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");

function sources() {
  return {
    image: vi.fn(async (key: string) => (key === KEY ? { mediaType: "image/svg+xml", bytes: SVG } : undefined)),
    figure: vi.fn(async (ref: { materialId: string; index: number }) => (ref.materialId === "8667175ac66aac06" && ref.index === 2 ? PNG : undefined)),
  } satisfies ImageSources;
}

describe("image protocol", () => {
  it("serves a cached image with its stored type and a policy under which it runs and loads nothing", async () => {
    const response = await imageResponse(`quire-image://cache/${KEY}`, sources());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(IMAGE_RESPONSE_CSP);
    expect(IMAGE_RESPONSE_CSP).toMatch(/^default-src 'none'/);
    expect(IMAGE_RESPONSE_CSP).not.toMatch(/script-src|https?:|\*/);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(SVG);
  });

  it("serves a text view's figure crop as a PNG under the same policy", async () => {
    const response = await imageResponse("quire-image://figure/8667175ac66aac06/2.png", sources());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-security-policy")).toBe(IMAGE_RESPONSE_CSP);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect((await imageResponse("quire-image://figure/8667175ac66aac06/3.png", sources())).status).toBe(404);
  });

  it("404s an unknown key, and never asks the store about anything that is not a well-formed key", async () => {
    const store = sources();
    expect((await imageResponse(`quire-image://cache/${"b".repeat(64)}`, store)).status).toBe(404);
    expect(store.image).toHaveBeenCalledWith("b".repeat(64));
    store.image.mockClear();
    for (const url of [
      `quire-image://cache/${KEY.slice(1)}`,
      `quire-image://cache/${KEY.toUpperCase()}`,
      `quire-image://cache/${KEY}/../../settings.json`,
      "quire-image://cache/..%2Fsettings.json",
      `quire-image://cache/${KEY}.json`,
      `quire-image://cache/${KEY}?download=1`,
      `quire-image://${KEY}`,
      "quire-image://figure/../2.png",
      "quire-image://figure/8667175ac66aac06/2.json",
      "quire-figure://8667175ac66aac06/2.png",
      `https://example.test/${KEY}`,
      "not a url",
    ]) {
      const response = await imageResponse(url, store);
      expect(response.status, url).toBe(404);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(store.image).not.toHaveBeenCalled();
    expect(store.figure).not.toHaveBeenCalled();
  });

  it("lets a store failure reach the caller instead of answering as if the image were missing", async () => {
    const failing: ImageSources = { image: async () => { throw new Error("EACCES: images/aaaa.bin"); }, figure: async () => undefined };
    await expect(imageResponse(`quire-image://cache/${KEY}`, failing)).rejects.toThrow(/EACCES/);
  });
});
