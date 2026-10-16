import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { resolveDeferredImageSources } from "./deferred-image-sources";

const images = (html: string) => Array.from(parseHTML(`<html><body>${html}</body></html>`).document.querySelectorAll("img"));
const imageSources = (html: string) => images(html).map((image) => image.getAttribute("src"));
const PLACEHOLDER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAAZCAIAAACza+nD";

describe("resolveDeferredImageSources", () => {
  it("takes a lazy loader's data-src over a data: blur placeholder", () => {
    const result = resolveDeferredImageSources(`<p><img src="${PLACEHOLDER}" alt="" data-src="https://cdn.example.test/attention.png" class="lazyload"></p>`);

    expect(result.replacements).toBe(1);
    expect(imageSources(result.html)).toEqual(["https://cdn.example.test/attention.png"]);
  });

  it("tries data-src, data-original and data-lazy-src in turn, skipping data: and JPEG XL values", () => {
    const result = resolveDeferredImageSources(
      `<img data-src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-original="https://x.example.test/a.jxl" data-lazy-src="https://x.example.test/lazy.png">` +
        `<img data-original="https://x.example.test/original.png">`,
    );

    expect(result.replacements).toBe(2);
    expect(imageSources(result.html)).toEqual(["https://x.example.test/lazy.png", "https://x.example.test/original.png"]);
  });

  it("uses the largest srcset candidate, data-srcset before srcset", () => {
    const result = resolveDeferredImageSources(
      `<img data-srcset="https://x.example.test/small.png 320w, https://x.example.test/large.png 1280w, https://x.example.test/medium.png 640w" srcset="https://x.example.test/other.png 2000w">` +
        `<img srcset="https://x.example.test/one.png, https://x.example.test/three.png 3x, https://x.example.test/two.png 2x">` +
        `<img srcSet="data:image/gif;base64,R0lGODlhAQABAAAAACw= 4x, https://x.example.test/react.png 2x">`,
    );

    expect(result.replacements).toBe(3);
    expect(imageSources(result.html)).toEqual([
      "https://x.example.test/large.png",
      "https://x.example.test/three.png",
      "https://x.example.test/react.png",
    ]);
  });

  it("parses srcset by the HTML rules: a comma ends a candidate even without a space, but not inside a URL", () => {
    const result = resolveDeferredImageSources(
      `<img srcset="https://x.example.test/w400.png 1x,https://x.example.test/w800.png 2x">` +
        `<img srcset="https://res.example.test/w_400,c_limit/photo.png 400w, https://res.example.test/w_800,c_limit/photo.png 800w">` +
        `<img srcset="https://x.example.test/odd.png 9q, https://x.example.test/valid.png 1x">`,
    );

    expect(imageSources(result.html)).toEqual([
      "https://x.example.test/w800.png",
      "https://res.example.test/w_800,c_limit/photo.png",
      "https://x.example.test/valid.png",
    ]);
  });

  it("takes the first displayable picture source without a media query for a src-less img, React's srcSet included", () => {
    const result = resolveDeferredImageSources(
      `<figure><div role="button"><picture>` +
        `<source srcSet="https://miro.example.test/fit:640/format:webp/fig.png 640w, https://miro.example.test/fit:1400/format:webp/fig.png 1400w, https://miro.example.test/fit:1100/format:webp/fig.png 1100w" sizes="700px" type="image/webp"/>` +
        `<source data-testid="og" srcSet="https://miro.example.test/fit:640/fig.png 640w, https://miro.example.test/fit:1400/fig.png 1400w" sizes="700px"/>` +
        `<img alt="" class="cs np pz c" width="700" height="193" loading="eager" role="presentation"/>` +
        `</picture></div><figcaption>Batch norm</figcaption></figure>`,
    );

    expect(result.replacements).toBe(1);
    expect(imageSources(result.html)).toEqual(["https://miro.example.test/fit:1400/format:webp/fig.png"]);
  });

  it("replaces a JPEG XL src with the picture's media-free AVIF source", () => {
    const base = "https://cdn.example.test/img/coolbear";
    const result = resolveDeferredImageSources(
      `<picture>` +
        `<source type="image/jxl" media="(max-width: 400px)" srcset="${base}.w400.jxl 1x,${base}.w800.jxl 2x">` +
        `<source type="image/jxl" srcset="${base}.jxl 1x,${base}.jxl 2x">` +
        `<source type="image/avif" media="(max-width: 400px)" srcset="${base}.w400.avif 1x,${base}.w800.avif 2x">` +
        `<source type="image/avif" srcset="${base}.avif 1x,${base}.avif 2x">` +
        `<source type="image/webp" srcset="${base}.webp 1x,${base}.webp 2x">` +
        `<img src="${base}.jxl" loading="lazy" width="48" height="48" class="bear" alt="Cool bear">` +
        `</picture>`,
    );

    expect(result.replacements).toBe(1);
    expect(imageSources(result.html)).toEqual([`${base}.avif`]);
  });

  it("skips picture sources it cannot display and falls back to one with a media query", () => {
    const result = resolveDeferredImageSources(
      `<picture>` +
        `<source type="image/jxl" srcset="https://x.example.test/a.jxl">` +
        `<source type="image/heic" srcset="https://x.example.test/a.heic">` +
        `<source srcset="https://x.example.test/untyped.jxl 1x">` +
        `<source media="(min-width: 800px)" srcset="https://x.example.test/wide.png">` +
        `<img alt="Chart">` +
        `</picture>`,
    );

    expect(imageSources(result.html)).toEqual(["https://x.example.test/wide.png"]);
  });

  it("takes an SVG picture source, which the app displays like any other image", () => {
    const result = resolveDeferredImageSources(
      `<picture><source type="image/svg+xml" srcset="https://x.example.test/diagram.svg"><img alt="Pipeline diagram"></picture>`,
    );

    expect(result.replacements).toBe(1);
    expect(imageSources(result.html)).toEqual(["https://x.example.test/diagram.svg"]);
  });

  it("leaves a lazy placeholder alone when the <noscript> fallback right after it already supplies the image", () => {
    const html =
      `<p><img src="${PLACEHOLDER}" data-lazy-src="https://x.example.test/chart.png" alt="Chart"> <!-- lazy --> ` +
      `<noscript><img src="https://x.example.test/chart.png" alt="Chart"></noscript></p>` +
      `<p><img data-src="https://x.example.test/next.png" alt="Next"><noscript>Turn on JavaScript to see this image.</noscript></p>`;

    const result = resolveDeferredImageSources(html);

    expect(result.replacements).toBe(1);
    expect(imageSources(result.html)).toEqual([PLACEHOLDER, "https://x.example.test/chart.png", "https://x.example.test/next.png"]);
  });

  it("leaves real sources and images without an alternative untouched, returning the input as is", () => {
    const html =
      `<img src="https://x.example.test/real.png" data-src="https://x.example.test/other.png" srcset="https://x.example.test/big.png 2x">` +
      `<img src="${PLACEHOLDER}" alt="Inline chart">` +
      `<img src="https://x.example.test/only.jxl" alt="Avatar">` +
      `<picture><source type="image/jxl" srcset="https://x.example.test/b.jxl"><img alt="No displayable source"></picture>`;

    const result = resolveDeferredImageSources(html);

    expect(result.replacements).toBe(0);
    expect(result.html).toBe(html);
  });

  it("writes a single src attribute when the original is spelled in another case", () => {
    const result = resolveDeferredImageSources(`<img SRC="${PLACEHOLDER}" data-src="https://x.example.test/a.png">`);

    const sources = images(result.html).flatMap((image) => Array.from(image.attributes).filter((attribute) => attribute.name.toLowerCase() === "src"));
    expect(sources.map((attribute) => [attribute.name, attribute.value])).toEqual([["src", "https://x.example.test/a.png"]]);
  });
});
