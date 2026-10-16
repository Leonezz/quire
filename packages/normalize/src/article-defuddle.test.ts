import { DefuddleClass } from "defuddle/node";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";

import { imagePathStem, QuireDefuddle } from "./article-defuddle";

type Extractor = new (
  ...args: ConstructorParameters<typeof DefuddleClass>
) => Pick<DefuddleClass, "parse">;

const prose =
  "Field notes on what the work looked like from the inside, written down while the details were still fresh. ".repeat(6);

function page(head: string, body: string) {
  return `<!doctype html><html lang="en"><head><title>Notes from the inside</title>${head}</head><body><article>
    <h1>Notes from the inside</h1>
    <p>${prose}</p>
    ${body}
    <p>${prose}</p>
  </article></body></html>`;
}

function extractedImageSources(extractor: Extractor, html: string) {
  const { document } = parseHTML(html);
  const result = new extractor(document as unknown as Document, {
    markdown: false,
    standardize: false,
    url: "https://example.test/notes/inside",
    useAsync: false,
  }).parse();
  const { document: content } = parseHTML(`<!doctype html><html><body>${result.content}</body></html>`);
  return Array.from(content.querySelectorAll("img")).map((image) => image.getAttribute("src"));
}

describe("QuireDefuddle", () => {
  it("still finds the private Defuddle image clean-ups it overrides", () => {
    // Defuddle is pinned; an upgrade that renames these would silently bring the image losses back.
    const prototype = DefuddleClass.prototype as unknown as Record<string, unknown>;
    expect(typeof prototype._removeCoverImage, "Defuddle._removeCoverImage is gone").toBe("function");
    expect(typeof prototype._keepBestImage, "Defuddle._keepBestImage is gone").toBe("function");
  });

  it("keeps a mid-article image that is also the page's og:image", () => {
    const html = page(
      `<meta property="og:image" content="https://example.test/notes/typical-day.webp">`,
      `<p><img src="https://example.test/notes/typical-day.webp" alt="My typical day"></p><p>${prose}</p>`,
    );

    expect(extractedImageSources(DefuddleClass, html)).toEqual([]);
    expect(extractedImageSources(QuireDefuddle, html)).toEqual(["https://example.test/notes/typical-day.webp"]);
  });

  it("keeps every distinct empty-alt image of a multi-panel figure", () => {
    const html = page(
      "",
      `<figure>
        <div class="images"><img src="https://example.test/notes/panels/neuron.png" alt=""><img src="https://example.test/notes/panels/channel.png" alt=""></div>
        <figcaption>One objective per panel.</figcaption>
      </figure>`,
    );

    expect(extractedImageSources(DefuddleClass, html)).toHaveLength(1);
    expect(extractedImageSources(QuireDefuddle, html)).toEqual([
      "https://example.test/notes/panels/neuron.png",
      "https://example.test/notes/panels/channel.png",
    ]);
  });

  it("still collapses two copies of one image in a figure to the best one", () => {
    const html = page(
      "",
      `<figure>
        <img src="https://example.test/notes/panels/chart-400x300.png" alt="">
        <img src="https://example.test/notes/panels/chart.png" srcset="https://example.test/notes/panels/chart.png 1x, https://example.test/notes/panels/chart@2x.png 2x" alt="">
        <img src="https://example.test/notes/panels/legend.png" alt="">
        <figcaption>The chart and its legend.</figcaption>
      </figure>`,
    );

    expect(extractedImageSources(QuireDefuddle, html)).toEqual([
      "https://example.test/notes/panels/chart.png",
      "https://example.test/notes/panels/legend.png",
    ]);
  });

  it("leaves Defuddle's adjacent lazy-load copies outside figures to the stock clean-up, whatever their stems", () => {
    const html = page(
      "",
      `<p><img src="https://example.test/notes/harbour-small.jpg" alt="Harbour at dawn"><img src="https://example.test/notes/harbour.jpg" srcset="https://example.test/notes/harbour.jpg 1x, https://example.test/notes/harbour-large.jpg 2x" alt="Harbour at dawn"></p><p>${prose}</p>`,
    );

    expect(extractedImageSources(DefuddleClass, html)).toEqual(["https://example.test/notes/harbour.jpg"]);
    expect(extractedImageSources(QuireDefuddle, html)).toEqual(["https://example.test/notes/harbour.jpg"]);
  });
});

describe("imagePathStem", () => {
  it.each([
    ["https://example.test/notes/panels/neuron.png", "neuron"],
    ["https://example.test/uploads/Chart-1024x768.JPG", "chart"],
    ["https://example.test/img/chart@2x.png", "chart"],
    ["https://example.test/posts/cover_hu_3f9a2b7c1d0e4f56.webp", "cover"],
    ["https://example.test/img/chart.w800.jpg", "chart"],
    ["https://cdn.example.test/v2/resize:fit:1400/1*Xy7Q.png?q=80#top", "1*xy7q"],
    ["https://example.test/figures/fig.2.png", "fig.2"],
  ])("%s -> %s", (src, stem) => {
    expect(imagePathStem(src)).toBe(stem);
  });
});
