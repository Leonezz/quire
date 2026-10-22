import { describe, expect, it } from "vitest";
import { pruneArticleChrome } from "./article-prune";

const body = (n: number) => `<p>${"Substantive paragraph about the topic at hand. ".repeat(n)}</p>`;

describe("pruneArticleChrome", () => {
  it("removes an in-page table of contents made of anchor links", () => {
    const html = `<h2>Table of Contents</h2><ul><li><a href="#a">A</a></li><li><a href="#b">B</a></li><li><a href="#c">C</a></li></ul><h2 id="a">A</h2>${body(10)}`;
    const result = pruneArticleChrome(html);
    expect(result.rulesApplied).toEqual(["article.prune.table-of-contents@1"]);
    expect(result.content).not.toContain("Table of Contents");
    expect(result.content).toContain('<h2 id="a">A</h2>');
  });

  it("keeps a contents heading whose list points elsewhere", () => {
    const html = `<h2>Contents</h2><ul><li><a href="https://example.com/x">X</a></li><li><a href="https://example.com/y">Y</a></li></ul>${body(10)}`;
    expect(pruneArticleChrome(html)).toEqual({ content: html, rulesApplied: [] });
  });

  it("removes trailing related / share / newsletter sections but not a mid-article Discussion", () => {
    const html = `${body(10)}<h2>Discussion</h2>${body(10)}<h2>Results</h2>${body(10)}<h2>Related posts</h2><ul><li><a href="/other">Other</a></li></ul><h2>Share</h2><p>Tweet this</p>`;
    const result = pruneArticleChrome(html);
    expect(result.rulesApplied).toEqual(["article.prune.trailing-chrome@1", "article.prune.trailing-chrome@1"]);
    expect(result.content).toContain("<h2>Discussion</h2>");
    expect(result.content).toContain("<h2>Results</h2>");
    expect(result.content).not.toContain("Related posts");
    expect(result.content).not.toContain("Tweet this");
  });

  it("stops a trailing removal at the next heading of the same level", () => {
    const html = `${body(20)}<h3>Related</h3><p>links</p><h2>Appendix</h2><p>Real appendix.</p>`;
    const result = pruneArticleChrome(html);
    expect(result.content).toContain("Real appendix.");
    expect(result.content).not.toContain("<p>links</p>");
  });

  it("returns the input untouched when nothing matches", () => {
    const html = `<h2>Section</h2>${body(5)}`;
    expect(pruneArticleChrome(html)).toEqual({ content: html, rulesApplied: [] });
  });

  it("drops a body heading that repeats the title and demotes any other h1", () => {
    const html = `<p class="meta">June 1, 2023</p><h1>My Approach to Building Large Technical Projects</h1>${body(5)}<h1>Interlude</h1>${body(5)}`;
    const result = pruneArticleChrome(html, { title: "My Approach to Building Large Technical Projects" });
    expect(result.rulesApplied).toEqual(["article.prune.duplicate-title@1", "article.prune.demote-h1@1", "article.prune.leading-meta@1"]);
    expect(result.content).not.toContain("My Approach to Building");
    expect(result.content).not.toContain("June 1, 2023");
    expect(result.content).toContain("<h2>Interlude</h2>");
    expect(result.content).not.toContain("<h1>");
  });

  it("strips permalink anchors and icons from headings and unwraps a heading that is a link", () => {
    const html = `<h2>Attention<a class="anchor" href="#attention">#</a></h2><h3><a href="#garden">Garden-variety takes</a></h3><h2><img src="https://x.test/link.png" alt="">GPS basics</h2>${body(5)}`;
    const result = pruneArticleChrome(html);
    expect(result.rulesApplied).toEqual(["article.prune.heading-anchors@1"]);
    expect(result.content).toContain("<h2>Attention</h2>");
    expect(result.content).toContain("<h3>Garden-variety takes</h3>");
    expect(result.content).toContain("<h2>GPS basics</h2>");
  });

  it("strips a permalink whose text is a label, found by its href pointing at the heading itself (joshwcomeau)", () => {
    const icon = `<svg viewBox="0 0 24 24"><line x1="2" y1="8" x2="22" y2="8"></line></svg>`;
    const html = [
      `<h2 id="the-core-react-loop"><a id="the-core-react-loop-1" href="#the-core-react-loop-1" class="aax5dne"><span>${icon}<span>Link to this heading</span></span></a>The core React loop</h2>`,
      `<h3 id="pure"><a href="#pure" class="q1">Jump here</a>Pure components</h3>`,
      `<h3 id="memo"><a id="memo-2" href="https://x.test/post/#memo-2">Lien vers cette section</a>Memo</h3>`,
      `<h3 id="context"><a class="x9" href="/other">Link to this section</a>Context</h3>`,
      // Not permalinks: another page's section, and the heading's own words linked to it.
      `<h3 id="props"><a href="https://x.test/docs#props">Props</a> and state</h3>`,
      `<h3 id="installation-optional"><a href="#installation-optional">Installation</a> (optional)</h3>`,
    ].join("") + body(5);
    const result = pruneArticleChrome(html);
    expect(result.rulesApplied).toEqual(["article.prune.heading-anchors@1"]);
    expect(result.content).toContain('<h2 id="the-core-react-loop">The core React loop</h2>');
    expect(result.content).toContain('<h3 id="pure">Pure components</h3>');
    expect(result.content).toContain('<h3 id="memo">Memo</h3>');
    expect(result.content).toContain('<h3 id="context">Context</h3>');
    expect(result.content).toContain('<h3 id="props"><a href="https://x.test/docs#props">Props</a> and state</h3>');
    expect(result.content).toContain('<h3 id="installation-optional"><a href="#installation-optional">Installation</a> (optional)</h3>');
  });

  it("unwraps a single-column layout table around an essay but leaves a small data table alone", () => {
    const essay = `<table><tr><td><font size="2">July 2023<br><br>${"Great work needs curiosity. ".repeat(20)}<br><br>${"Second paragraph. ".repeat(20)}</font></td></tr></table>`;
    const data = `<table><tr><td>A</td></tr></table>`;
    const result = pruneArticleChrome(`${essay}${body(3)}${data}`);
    expect(result.rulesApplied).toEqual(["article.prune.unwrap-font@1", "article.prune.layout-table@1"]);
    expect(result.content).not.toContain("<table><tr><td><font");
    expect(result.content).toContain("<table><tr><td>A</td></tr></table>");
  });

  it("trims trailing author cards and link-dense promo blocks but keeps a references list", () => {
    const html = `${body(20)}<h2>References</h2><ol><li><a href="https://a.test">Paper A</a></li><li><a href="https://b.test">Paper B</a></li></ol><div class="bio"><a href="/author"><img src="https://x.test/a.png" alt=""></a><p>Written by Jane Doe, staff engineer.</p></div><div class="cards"><a href="/p1"><img src="https://x.test/1.png" alt="">Explore more from GitHub</a><a href="/p2"><img src="https://x.test/2.png" alt="">Another post</a></div>`;
    const result = pruneArticleChrome(html);
    expect(result.rulesApplied).toEqual(["article.prune.trailing-cards@1"]);
    expect(result.content).not.toContain("Written by Jane Doe");
    expect(result.content).not.toContain("Explore more");
    expect(result.content).toContain("Paper B");
  });

  it("trims inside the single wrapper the extractor kept and drops leading meta lines", () => {
    const html = `<article><p class="meta">30 May 2007 — 3 min read — Comments</p><p>${"Real opening paragraph of the post. ".repeat(6)}</p>${body(10)}<footer><a href="mailto:x@y.z">mail</a><a href="https://t.co/x">twitter</a><a href="https://g.com/x">github</a></footer></article>`;
    const result = pruneArticleChrome(html);
    expect(result.rulesApplied).toEqual(["article.prune.trailing-cards@1", "article.prune.leading-meta@1"]);
    expect(result.content).not.toContain("3 min read");
    expect(result.content).not.toContain("twitter");
    expect(result.content).toContain("Real opening paragraph");
  });

  it("removes a leading masthead heading that names the site", () => {
    const html = `<h1>Mitchell Hashimoto</h1><p>June 1, 2023</p>${body(8)}`;
    const result = pruneArticleChrome(html, { title: "My Approach", siteNames: new Set(["mitchell hashimoto", "mitchellh"]) });
    expect(result.rulesApplied).toContain("article.prune.site-heading@1");
    expect(result.content).not.toContain("Mitchell Hashimoto");
  });

  it("drops leading date and byline lines and a trailing date line", () => {
    const html = `<p>作者： 阮一峰</p><p>日期： 2019年9月5日</p>${body(8)}<p>发表日期： 2019年9月 5日</p>`;
    const result = pruneArticleChrome(html, { byline: "阮一峰" });
    expect(result.content).not.toContain("阮一峰");
    expect(result.content).not.toContain("2019年9月");
    expect(result.rulesApplied).toEqual(["article.prune.trailing-cards@1", "article.prune.leading-meta@1"]);
  });

  it("unwraps <font> so a br-delimited essay keeps its paragraphs", () => {
    const html = `<div><font size="2">July 2023<br><br>${"Great work. ".repeat(30)}<br><br>${"More work. ".repeat(30)}</font></div>`;
    const result = pruneArticleChrome(html);
    expect(result.content).not.toContain("<font");
    expect(result.content).toContain("<br><br>");
  });

  it("unwraps a blockquote that only wraps code and drops footnote back-references", () => {
    const html = `${body(6)}<blockquote><pre><code>curl -b 'foo=bar' https://google.com</code></pre></blockquote><blockquote><p>A real quote.</p></blockquote><section class="footnotes"><ol><li id="fn-1"><p>Note text.</p><p><a href="#fnref-1" class="footnote-backref">↩</a></p></li></ol></section>`;
    const result = pruneArticleChrome(html);
    expect(result.rulesApplied).toEqual(["article.prune.code-blockquote@1", "article.prune.footnote-backrefs@1"]);
    expect(result.content).not.toContain("<blockquote><pre>");
    expect(result.content).toContain("<blockquote><p>A real quote.</p></blockquote>");
    expect(result.content).not.toContain("↩");
    expect(result.content).toContain("<p>Note text.</p>");
  });

  it("keeps a list of points that cite footnotes (ruder-optim)", () => {
    const point = (text: string, n: number) => `<li><p>${text} <sup class="footnote-ref"><a href="https://ruder.io/optimizing-gradient-descent/#fn${n}" id="fnref${n}">[${n}]</a></sup> and the rest of the point.</p></li>`;
    const html = `${body(6)}<p>Mini-batch gradient descent offers a few challenges that need to be addressed:</p><ul>${point("Learning rate schedules try to adjust the learning rate during training", 1)}${point("These schedules have to be defined in advance", 2)}${point("Dauphin et al. argue that the difficulty arises from saddle points", 3)}</ul>${body(6)}`;
    const result = pruneArticleChrome(html, { source: "https://ruder.io/optimizing-gradient-descent/" });
    expect(result.content).toContain("Learning rate schedules");
    expect(result.content).toContain("saddle points");
  });

  it("keeps a list whose links all point into one other page (vickiboykis-gguf)", () => {
    const line = (n: number, text: string) => `<li><p><a href="https://github.com/ggerganov/ggml/blob/b458/examples/gpt-2/convert-ckpt-to-ggml.py#L${n}">${text}</a>, as the script writes it</p></li>`;
    const html = `${body(6)}<p>The resulting GGML file contains:</p><ul>${line(91, "a magic number")}${line(92, "model-specific hyperparameters")}<li><p>an embedded vocabulary</p></li>${line(137, "a list of tensors")}</ul>${body(6)}`;
    const result = pruneArticleChrome(html, { source: "https://vickiboykis.com/2024/02/28/gguf-the-long-way-around/" });
    expect(result.content).toContain("model-specific hyperparameters");
    expect(result.content).toContain("an embedded vocabulary");
  });

  it("keeps footnotes whose only links are back-references, and drops the back-references (waitbutwhy-ai)", () => {
    const note = (n: number) => `<li id="footnote-${n}-3216" class="footnote"><p>Footnote ${n} explains a tangent the main text skipped.<a href="https://waitbutwhy.com/2015/01/artificial-intelligence-revolution-1.html#note-${n}-3216" class="footnote-return">&#8617;</a></p></li>`;
    const html = `${body(10)}<div class="footnotes"><hr><ol>${note(1)}${note(2)}${note(3)}</ol></div>`;
    const result = pruneArticleChrome(html, { source: "https://waitbutwhy.com/2015/01/artificial-intelligence-revolution-1.html" });
    expect(result.content).toContain("Footnote 3 explains");
    expect(result.content).not.toContain("↩");
  });

  it("drops Hugo's [return] footnote back-references (hillelwayne-engineers)", () => {
    const html = `${body(10)}<div class="footnotes"><ol><li id="fn:17">I only interviewed 17 people. <a class="footnote-return" href="#fnref:17"><sup>[return]</sup></a></li><li id="fn:prestige">Sadly, the answer is prestige. <a class="footnote-return" href="#fnref:prestige"><sup>[return]</sup></a></li></ol></div>`;
    const result = pruneArticleChrome(html, { source: "https://www.hillelwayne.com/post/are-we-really-engineers/" });
    expect(result.content).toContain("I only interviewed 17 people.");
    expect(result.content).not.toContain("[return]");
  });

  it("still removes a table of contents whose links the extractor resolved against the page", () => {
    const html = `${body(4)}<ul><li><a href="https://x.test/post#a">Part A</a></li><li><a href="https://x.test/post#b">Part B</a></li><li><a href="https://x.test/post#c">Part C</a></li></ul><h2 id="a">Part A</h2>${body(10)}`;
    const result = pruneArticleChrome(html, { source: "https://x.test/post" });
    expect(result.content).not.toContain("https://x.test/post#b");
    expect(result.rulesApplied).toContain("article.prune.navigation-lists@1");
  });

  it("keeps trailing Further reading and Discussion and Review sections (hf-rlhf, distill-featurevis)", () => {
    const papers = `<ul><li><a href="https://a.test/tamer.pdf">TAMER</a> (Knox and Stone 2008): proposed a learned agent where humans scored its actions.</li><li><a href="https://b.test/coach.pdf">COACH</a> (MacGlashan et al. 2017): an actor-critic algorithm tuned by human feedback.</li></ul>`;
    const html = `${body(20)}<h4>Further reading</h4><p>Here is a list of the most prevalent papers on RLHF to date.</p>${papers}<h3>Discussion and Review</h3><p><a href="https://github.com/distillpub/post/issues/1">Review 1 - Anonymous</a><br><a href="https://github.com/distillpub/post/issues/4">Review 2 - Anonymous</a></p><h3>References</h3><ol><li>Erhan, D. Visualizing higher-layer features of a deep network. 2009.</li></ol>`;
    const result = pruneArticleChrome(html);
    expect(result.content).toContain("Further reading");
    expect(result.content).toContain("COACH");
    expect(result.content).toContain("Discussion and Review");
    expect(result.content).toContain("Review 2 - Anonymous");
  });

  it("keeps a trailing chrome-worded section that holds a reference list", () => {
    const html = `${body(20)}<h2>Notes and sources</h2>${body(1)}<h2>Sponsors</h2><div class="references"><ol><li>Knuth, D. The Art of Computer Programming. 1968.</li><li>Dijkstra, E. A Discipline of Programming. 1976.</li></ol></div>`;
    const result = pruneArticleChrome(html);
    expect(result.content).toContain("A Discipline of Programming");
  });

  it("keeps numbered reference lines whose link text is a bare URL (lilian-agent)", () => {
    const html = `${body(20)}<h2>References</h2><p>[19] Joon Sung Park, et al. <a href="https://arxiv.org/abs/2304.03442">“Generative Agents.”</a> arXiv preprint arXiv:2304.03442 (2023).</p><p>[20] AutoGPT. <a href="https://github.com/Significant-Gravitas/Auto-GPT">https://github.com/Significant-Gravitas/Auto-GPT</a></p><p>[21] GPT-Engineer. <a href="https://github.com/AntonOsika/gpt-engineer">https://github.com/AntonOsika/gpt-engineer</a></p>`;
    const result = pruneArticleChrome(html);
    expect(result.content).toContain("[20] AutoGPT.");
    expect(result.content).toContain("[21] GPT-Engineer.");
  });

  it("keeps a one-item list whose text is a sentence of its own (jvns-firecracker)", () => {
    const html = `${body(20)}<p>software:</p><ul><li><a href="https://github.com/weaveworks/ignite">ignite</a> lets you take a container image and run it as a Firecracker VM</li></ul>`;
    const result = pruneArticleChrome(html);
    expect(result.content).toContain("lets you take a container image");
    expect(result.content).toContain("software:");
  });

  it("keeps a section heading that only starts like the title (oneusefulthing-centaurs)", () => {
    const html = `<h2>Inside the Jagged Frontier</h2>${body(6)}<h2>Outside the Jagged Frontier</h2>${body(6)}<h2>Centaurs and Cyborgs</h2>${body(6)}`;
    const result = pruneArticleChrome(html, { title: "Centaurs and Cyborgs on the Jagged Frontier" });
    expect(result.content).toContain("<h2>Centaurs and Cyborgs</h2>");
  });

  it("removes same-page anchor lists and loading placeholders anywhere, and trailing card lists", () => {
    const html = `${body(6)}<ul><li><a href="https://x.test/p#a">A</a></li><li><a href="https://x.test/p#b">B</a></li></ul><p>正在加载…</p>${body(6)}<hr><p><strong><a href="https://x.test/plus">Plus</a></strong></p><p>Interviews</p><ul><li><h2>An Interview with Someone</h2><p>Thursday, September 17, 2026</p><a href="https://x.test/i1">read</a></li><li><h2>Another Interview</h2><a href="https://x.test/i2">read</a></li></ul><a href="https://x.test/all">View All</a>`;
    const result = pruneArticleChrome(html);
    expect(result.content).not.toContain('href="https://x.test/p#a"');
    expect(result.content).not.toContain("正在加载");
    expect(result.content).not.toContain("An Interview with Someone");
    expect(result.content).not.toContain("View All");
    expect(result.rulesApplied).toContain("article.prune.navigation-lists@1");
    expect(result.rulesApplied).toContain("article.prune.trailing-cards@1");
  });
});
