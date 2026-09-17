import { describe, expect, it } from "vitest";
import { pruneArticleChrome } from "./article-prune";

const body = (n: number) => `<p>${"Substantive paragraph about the topic at hand. ".repeat(n)}</p>`;

describe("pruneArticleChrome", () => {
  it("removes an in-page table of contents made of anchor links", () => {
    const html = `<h1>Title</h1><h2>Table of Contents</h2><ul><li><a href="#a">A</a></li><li><a href="#b">B</a></li><li><a href="#c">C</a></li></ul><h2 id="a">A</h2>${body(10)}`;
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
    const html = `<h1>Title</h1>${body(10)}<h2>Discussion</h2>${body(10)}<h2>Results</h2>${body(10)}<h2>Related posts</h2><ul><li><a href="/other">Other</a></li></ul><h2>Share</h2><p>Tweet this</p>`;
    const result = pruneArticleChrome(html);
    expect(result.rulesApplied).toEqual(["article.prune.trailing-chrome@1", "article.prune.trailing-chrome@1"]);
    expect(result.content).toContain("<h2>Discussion</h2>");
    expect(result.content).toContain("<h2>Results</h2>");
    expect(result.content).not.toContain("Related posts");
    expect(result.content).not.toContain("Tweet this");
  });

  it("stops a trailing removal at the next heading of the same level", () => {
    const html = `<h1>Title</h1>${body(20)}<h3>Related</h3><p>links</p><h2>Appendix</h2><p>Real appendix.</p>`;
    const result = pruneArticleChrome(html);
    expect(result.content).toContain("Real appendix.");
    expect(result.content).not.toContain("<p>links</p>");
  });

  it("returns the input untouched when nothing matches", () => {
    const html = `<h1>Title</h1>${body(5)}`;
    expect(pruneArticleChrome(html)).toEqual({ content: html, rulesApplied: [] });
  });
});
