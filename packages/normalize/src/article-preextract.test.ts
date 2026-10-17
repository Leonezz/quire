import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { preextractArticleDocument } from "./article-preextract";

const documentFor = (body: string) => parseHTML(`<!doctype html><html><body>${body}</body></html>`).document as unknown as Document;
const PAGE = "https://blog.example.test/post/";
const icon = (ligature: string, className = "material-icons") => `<span class="${className}" aria-hidden="true" translate="no">${ligature}</span>`;

describe("preextractArticleDocument", () => {
  it("turns icon-font ligatures in table cells into plain glyph text", () => {
    const ligatures = ["check", "done", "check_circle", "close", "clear", "block", "cancel", "remove"];
    const document = documentFor(`<table><tr><th>${icon("check", "material-symbols-outlined")}</th>${ligatures.map((ligature) => `<td>${icon(ligature)}</td>`).join("")}</tr></table>`);

    expect(preextractArticleDocument(document, PAGE)).toEqual(["article.preextract.icon-cells@1"]);
    expect(Array.from(document.querySelectorAll("th, td"), (cell) => cell.textContent)).toEqual(["✓", "✓", "✓", "✓", "✗", "✗", "✗", "✗", "–"]);
    expect(document.querySelector("span, [aria-hidden]")).toBeNull();
  });

  it("leaves unknown ligatures, other hidden cell content and icons outside tables alone", () => {
    const body = `<table><tr><td>${icon("info")}</td><td><span class="note" aria-hidden="true">check</span></td></tr></table><p>${icon("check")} Done</p>`;
    const document = documentFor(body);

    expect(preextractArticleDocument(document, PAGE)).toEqual([]);
    expect(document.body.innerHTML).toBe(body);
  });

  it("drops class tokens that hide only a pseudo-element and keeps every other hidden token", () => {
    const document = documentFor(`
      <div id="credit" class="attribution before:block l:before:hidden l:text-right">Credit</div>
      <p id="chained" class="after:hover:invisible text-sm placeholder:hidden first-letter:hidden backdrop:invisible">Text</p>
      <p id="only" class="marker:hidden">Item</p>
      <p id="kept" class="hidden sm:hidden first:hidden hover:invisible l:w-half">Gone</p>`);

    expect(preextractArticleDocument(document, PAGE)).toEqual(["article.preextract.pseudo-element-classes@1"]);
    expect(document.getElementById("credit")?.getAttribute("class")).toBe("attribution before:block l:text-right");
    expect(document.getElementById("chained")?.getAttribute("class")).toBe("text-sm");
    expect(document.getElementById("only")?.hasAttribute("class")).toBe(false);
    expect(document.getElementById("kept")?.getAttribute("class")).toBe("hidden sm:hidden first:hidden hover:invisible l:w-half");
  });

  it("puts a link to its place on the original page where an empty d-figure or a Sandpack preview was", () => {
    const document = documentFor(
      `<figure><figcaption>Noise to neuron.</figcaption><d-figure id="opt-progress"></d-figure></figure>` +
        `<div class="sp-preview-container"><iframe class="sp-preview-iframe" title="Sandpack Preview"></iframe></div><iframe title="Live chart"></iframe>`,
    );

    expect(preextractArticleDocument(document, `${PAGE}#top`)).toEqual(["article.preextract.interactive-placeholders@1"]);
    expect(document.body.innerHTML).toBe(
      `<figure><figcaption>Noise to neuron.</figcaption><p><a href="${PAGE}#opt-progress">Interactive figure — open in the original</a></p></figure>` +
        `<div class="sp-preview-container"><p><a href="${PAGE}">Code playground — open in the original</a></p></div><iframe title="Live chart"></iframe>`,
    );
  });

  it("turns an <object> of an image type into an <img> of its URL, as for arXiv's SVG figure panels", () => {
    const document = documentFor(
      `<figure id="A2.F3" class="ltx_figure"><div class="ltx_flex_cell"><object type="image/svg+xml" data="2609.24983v1/fig_strip.svg" id="A2.F3.g1" class="ltx_graphics ltx_figure_panel" style="aspect-ratio:438/240;" width="438" height="240"></object></div>` +
        `<object type="Image/PNG; charset=binary" data="https://cdn.example.test/loss.png" title="Loss curve">Training loss by epoch.</object>` +
        `<object type="image/svg+xml" data="/arch.svg" aria-label="Model architecture"><object type="image/png" data="/arch.png"></object></object>` +
        `<figcaption>Figure 3: Annotation agreement.</figcaption></figure>`,
    );

    expect(preextractArticleDocument(document, "https://arxiv.example.test/html/2609.24983")).toEqual(["article.preextract.image-objects@1"]);
    // (linkedom writes attributes newest first.)
    expect(document.body.innerHTML).toBe(
      `<figure id="A2.F3" class="ltx_figure"><div class="ltx_flex_cell"><img height="240" width="438" class="ltx_graphics ltx_figure_panel" id="A2.F3.g1" alt="" src="https://arxiv.example.test/html/2609.24983v1/fig_strip.svg"></div>` +
        `<img title="Loss curve" alt="Training loss by epoch." src="https://cdn.example.test/loss.png">` +
        `<img alt="Model architecture" src="https://arxiv.example.test/arch.svg">` +
        `<figcaption>Figure 3: Annotation agreement.</figcaption></figure>`,
    );
  });

  it("leaves objects of other types, without an http(s) URL, or hidden alone", () => {
    const body =
      `<object type="application/pdf" data="/paper.pdf"></object><object data="/figure.svg"></object><object type="image/tiff" data="/scan.tiff"></object>` +
      `<object type="image/svg+xml"></object><object type="image/svg+xml" data="data:image/svg+xml,%3Csvg%3E%3C/svg%3E"></object><object type="image/png" data="ftp://files.example.test/plot.png"></object>` +
      `<object type="image/svg+xml" data="/hidden.svg" style="display: none"></object><object type="image/svg+xml" data="/pixel.svg" width="1" height="1"></object>`;
    const document = documentFor(body);

    expect(preextractArticleDocument(document, PAGE)).toEqual([]);
    expect(document.body.innerHTML).toBe(body);
  });
});
