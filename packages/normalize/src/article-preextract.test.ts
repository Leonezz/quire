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
});
