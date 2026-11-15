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

  it("turns callouts and content asides into blockquotes that carry the callout's kind", () => {
    const document = documentFor(
      `<aside class="note"> <b>Note:</b> Tools like Lighthouse cannot measure <a href="/inp">INP</a>. </aside>` +
        `<aside class="key-point"><b>Key point:</b> Stable metrics aren't necessarily permanent.</aside>` +
        `<div class="admonition note"><div class="admonition-title"><p>Read The Samples</p></div><p>On GPT-3, compare the poems.</p></div>` +
        `<div class="callout callout-style-default callout-warning callout-titled"><div class="callout-header"><span class="screen-reader-only">Warning</span>Important Note</div><div class="callout-body"><p>Measure precision and recall.</p></div></div>` +
        `<aside class="admn note"><div><p>This post is a part of <a href="/rust100k">“One Hundred Thousand Lines of Rust”</a>.</p></div></aside>` +
        `<aside id="memo" class="i6el1g6 b1btlj5u"><strong>This could change in the future!</strong><div><p>The React team is investigating whether it's possible to auto-memoize code.</p><div class="note">Nested.</div></div></aside>`,
    );

    expect(preextractArticleDocument(document, PAGE)).toEqual(["article.preextract.callouts@1"]);
    expect(document.body.innerHTML).toBe(
      `<blockquote data-callout="note"> <b>Note:</b> Tools like Lighthouse cannot measure <a href="/inp">INP</a>. </blockquote>` +
        `<blockquote data-callout="key-point"><b>Key point:</b> Stable metrics aren't necessarily permanent.</blockquote>` +
        `<blockquote data-callout="note"><div class="admonition-title"><p>Read The Samples</p></div><p>On GPT-3, compare the poems.</p></blockquote>` +
        `<blockquote data-callout="warning"><div class="callout-header">Important Note</div><div class="callout-body"><p>Measure precision and recall.</p></div></blockquote>` +
        `<blockquote data-callout="note"><div><p>This post is a part of <a href="/rust100k">“One Hundred Thousand Lines of Rust”</a>.</p></div></blockquote>` +
        `<blockquote data-callout="note" id="memo"><strong>This could change in the future!</strong><div><p>The React team is investigating whether it's possible to auto-memoize code.</p><div class="note">Nested.</div></div></blockquote>`,
    );
  });

  it("leaves pull quotes, print-only boxes, page chrome, link lists and page-wide wrappers alone", () => {
    const quote = "Understanding language requires understanding the world, and a machine exposed only to language cannot.";
    const body =
      `<p>${quote}</p><aside class="post__aside"><div class="mb1"><p>${quote}</p></div></aside>` +
      `<aside class="post__aside hide-on-print"><h2>Quantized Columns</h2><p>A regular column in which top researchers explore the process of discovery.</p></aside>` +
      `<aside class="post__aside"><div class="pullquote"><p>Neural network language models have achieved about 97% accuracy on Winograd schemas.</p></div></aside>` +
      `<aside class="widget widget_text" id="text-3"><p>Your host. I’m Joel Spolsky, a software developer in New York City, and I write about software.</p></aside>` +
      `<aside class="post-toc"><p>On this page</p></aside>` +
      `<aside><p><a href="/related/1">Machines Beat Humans on a Reading Test. But Do They Understand?</a> More: <a href="/related/2">Why AlphaZero has trouble</a></p></aside>` +
      `<aside> Discuss this page on <a href="/comments">Reddit</a>. </aside>` +
      `<aside class="note" hidden><p>Hidden note.</p></aside>` +
      `<nav><aside class="note"><p>A note in the navigation.</p></aside></nav>` +
      `<div class="note single"><h1>Patterns for Building LLM-based Systems</h1><p>The whole post.</p></div>` +
      `<span class="note">An inline note.</span>`;
    const document = documentFor(body);

    expect(preextractArticleDocument(document, PAGE)).toEqual([]);
    expect(document.body.innerHTML).toBe(body);
  });

  it("leaves a callout that only scripts-off visitors see alone", () => {
    const body = `<noscript><div class="admonition error"><div class="admonition-title"><p><strong>Error:</strong> JavaScript disabled.</p></div><p>Backlinks require JS.</p></div></noscript>`;
    const document = documentFor(body);

    expect(preextractArticleDocument(document, PAGE)).toEqual([]);
    expect(document.body.innerHTML).toBe(body);
  });

  it("lifts a heading out of the permalink wrapped around it, giving it the link's id", () => {
    const document = documentFor(
      `<a id="simple-is-a-lie" href="#simple-is-a-lie" class="anchor"><h2>Simple is a lie</h2></a>` +
        `<blockquote><a id="monotonic" href="#monotonic" class="anchor"> <h3>Transparent Monotonic Time support</h3> </a></blockquote>` +
        `<a href="#parting-words" class="anchor"><h2 id="parting-words">Parting words</h2></a>`,
    );

    expect(preextractArticleDocument(document, PAGE)).toEqual(["article.preextract.anchor-headings@1"]);
    expect(document.body.innerHTML).toBe(
      `<h2 id="simple-is-a-lie">Simple is a lie</h2><blockquote><h3 id="monotonic">Transparent Monotonic Time support</h3></blockquote><h2 id="parting-words">Parting words</h2>`,
    );
  });

  it("leaves headings in navigation and links holding more than a heading alone", () => {
    const body = `<nav><a class="toc-entry" href="#top"><h2 class="toc-header">Contents</h2></a></nav><a href="#more">Read on: <h4>The next part</h4></a><a href="/elsewhere"><h3>Another post</h3></a>`;
    const document = documentFor(body);

    expect(preextractArticleDocument(document, PAGE)).toEqual([]);
    expect(document.body.innerHTML).toBe(body);
  });

  it("marks footnote references so the permalink removal keeps them, each in a <sup>", () => {
    const document = documentFor(
      `<p>following work.<a href="#fn1" class="footnoteRef" id="fnref1"><sup>1</sup></a></p>` +
        `<p>least cringe)<span><a data-component-name="FootnoteAnchorToDOM" id="footnote-anchor-1" href="#footnote-1" class="footnote-anchor">1</a></span></p>` +
        `<p>scaling<a href="#fn2" class="footnote-ref" id="fnref2" role="doc-noteref"><sup>2</sup></a> works<sup class="footnote-ref"><a href="#fn3" id="fnref3">[3]</a></sup>.</p>` +
        `<p>soon<a href="#footnote2-4-3216" id="note2-4-3216" rel="footnote2">4</a></p>` +
        `<ol><li id="fn1">One.</li><li id="footnote-1">Substack.</li><li id="fn2">Two.</li><li id="fn3">Three.</li><li id="footnote2-4-3216">Four.</li></ol>`,
    );

    expect(preextractArticleDocument(document, PAGE)).toEqual(["article.preextract.footnote-references@1"]);
    const references = Array.from(document.querySelectorAll("a[data-footnote-ref]"));
    expect(references.map((reference) => reference.getAttribute("href"))).toEqual(["#fn1", "#footnote-1", "#fn2", "#fn3", "#footnote2-4-3216"]);
    expect(references.map((reference) => reference.parentElement?.tagName)).toEqual(["SUP", "SUP", "SUP", "SUP", "SUP"]);
    expect(references.map((reference) => reference.parentElement?.textContent)).toEqual(["1", "1", "2", "[3]", "4"]);
    expect(references.filter((reference) => /anchor|ref/iu.test(reference.getAttribute("class") ?? ""))).toEqual([]);
    expect(references.map((reference) => reference.id)).toEqual(["fnref1", "footnote-anchor-1", "fnref2", "fnref3", "note2-4-3216"]);
    expect(document.querySelector("sup sup, sup > sup")).toBeNull();
  });

  it("leaves references to a note the page does not hold, back-references and links elsewhere alone", () => {
    const body =
      `<p><span role="doc-noteref" id="fnrefzq" class="footnote-reference"><sup><span><a href="#fnzq">[1]</a></span></sup></span></p>` +
      `<ol><li id="fn1">Note. <a href="#fnref1" rel="footnote-backref">↩</a></li></ol><p id="fnref1">See <a href="https://example.test/other#fn1" class="footnote-ref">1</a></p>`;
    const document = documentFor(body);

    expect(preextractArticleDocument(document, PAGE)).toEqual([]);
    expect(document.body.innerHTML).toBe(body);
  });

  it("folds a run of Substack footnote blocks into one footnote list", () => {
    const document = documentFor(
      `<p>The end.</p>` +
        `<div data-component-name="FootnoteToDOM" class="footnote"><a id="footnote-1" href="#footnote-anchor-1" contenteditable="false" target="_self" class="footnote-number">1</a><div class="footnote-content"><p><span>Alternatives considered.</span></p></div></div>\n` +
        `<div data-component-name="FootnoteToDOM" class="footnote"><a id="footnote-2" href="#footnote-anchor-2" class="footnote-number">2</a><div class="footnote-content"><p>Second.</p><p>More.</p></div></div>` +
        `<div class="footnote">Not Substack's.</div>`,
    );

    expect(preextractArticleDocument(document, PAGE)).toEqual(["article.preextract.substack-footnotes@1"]);
    expect(document.body.innerHTML).toBe(
      `<p>The end.</p><section class="footnotes"><ol><li id="footnote-1"><p><span>Alternatives considered.</span></p></li><li id="footnote-2"><p>Second.</p><p>More.</p></li></ol></section><div class="footnote">Not Substack's.</div>`,
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
