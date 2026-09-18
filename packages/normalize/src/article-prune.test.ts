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
