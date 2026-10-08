import { describe, expect, it } from "vitest";
import { renderHtml } from "./html";
import { emptyData, hybridData, legacyData, visualData } from "./fixtures";

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("renderHtml", () => {
  it("renders an empty run", () => {
    const html = renderHtml(emptyData());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Extraction quality 2026-09-23</title>");
    expect(html).toContain("No issues reported.");
    expect(html).toContain("0 of 0 cases");
    expect(count(html, '<tbody class="case"')).toBe(0);
  });

  it("is self-contained: no external scripts, styles or fonts", () => {
    const html = renderHtml(legacyData());
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toContain("@import");
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("shows the totals, the charts and one expandable row per legacy case", () => {
    const data = legacyData();
    const html = renderHtml(data);
    expect(html).toContain('<div class="label">PASS</div><div class="value"><span class="dot" style="background:var(--good)"></span>2</div>');
    expect(html).toContain('<div class="label">MAJOR</div><div class="value"><span class="dot" style="background:var(--critical)"></span>2</div>');
    expect(html).toContain('<div class="label">Errors</div><div class="value"><span class="dot" style="background:var(--neutral)"></span>1</div>');
    expect(html).toContain("<title>PASS: 2 (33%)</title>");
    expect(html).toContain("<title>missing_content major: 1</title>");
    expect(count(html, '<tbody class="case"')).toBe(5);
    expect(count(html, 'aria-expanded="false"')).toBe(5);
    expect(html).toContain("5 of 5 cases");
    expect(html).toContain('data-verdict="MAJOR"');
    expect(html).toContain('data-delta="regressed"');
    expect(html).toContain("<code>zeta-post</code> — codex exec exited with 1: boom");
    expect(html).toContain("Regressed (2)");
    expect(html).toContain("Improved (1)");
    expect(html).not.toContain("Screen vs confirm");
    expect(html).toContain('<option value="missing_content">');
    expect(html).toContain("⚠ not found verbatim");
  });

  it("escapes evidence quotes and never leaks raw markup from a page", () => {
    const html = renderHtml(legacyData());
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;");
    expect(count(html, "<script>")).toBe(1);
  });

  it("shows the confusion matrix, the backends and side-by-side opinions for hybrid data", () => {
    const html = renderHtml(hybridData());
    expect(html).toContain("Screen vs confirm");
    expect(html).toContain("3 cases with a second opinion: 1 agree (33%), 2 disagree.");
    expect(html).toContain('<div class="label">claude · claude-haiku-4-5</div>');
    expect(html).toContain("$0.04");
    expect(html).toContain('<div class="label">Disputed</div><div class="value">2</div>');
    expect(count(html, '<div class="opinion"')).toBe(3);
    expect(count(html, '<div class="opinion final"')).toBe(3);
    expect(html).toContain('data-disputed="1"');
    expect(html).toContain('<option value="claude">');
  });

  it("shows a visual case's tiles as lazy thumbnails linked relatively to eval/render/out, marking the tiles issues point at", () => {
    const html = renderHtml(visualData());
    expect(html).toContain('<a class="shot" href="../render/out/alpha-post/rendered-01.png" target="_blank" rel="noopener"');
    expect(html).toContain('<img loading="lazy" decoding="async" src="../render/out/alpha-post/rendered-01.png" alt="rendered tile 1">');
    expect(html).toMatch(/<a class="shot hit" href="\.\.\/render\/out\/alpha-post\/rendered-02\.png"[^>]*title="images \(major\): images is wrong"/);
    expect(html).toContain('<span class="n">2 · 1 issue</span>');
    expect(html).toMatch(/<a class="shot hit" href="\.\.\/render\/out\/alpha-post\/reference-01\.png"/);
    expect(html).toContain('<a class="shot unsent" href="../render/out/alpha-post/reference-02.png"');
    expect(html).toContain("Rendered (Quire reader) — 3 of 3 sent");
    expect(html).toContain("Reference (original, JS off) — 1 of 2 sent");
    expect(html).toContain('<a class="where" href="../render/out/alpha-post/rendered-02.png" target="_blank" rel="noopener">rendered tile 2 ↗</a>');
    // the screener's issue on rendered tile 3 shows in its opinion card
    expect(html).toContain('<a class="where" href="../render/out/alpha-post/rendered-03.png" target="_blank" rel="noopener">rendered tile 3 ↗</a>');
    expect(count(html, '<div class="shots">')).toBe(2);
  });

  it("lists the measured facts with their samples, and totals them in the header", () => {
    const html = renderHtml(visualData());
    expect(html).toContain('<span class="fact bad">1 broken image of 3</span>');
    expect(html).toContain("broken image <code>https://alpha.example/fig2.png</code>");
    expect(html).toContain("overflow <code>article &gt; pre</code> (1500 px)");
    expect(html).toContain("raw <code>$$</code> in “where $$x^2$$ grows”");
    expect(html).toContain('<span class="fact bad">1 img</span><span class="fact bad">1 overflow</span><span class="fact bad">2 raw</span>');
    expect(html).toContain('<div class="label">Broken images</div><div class="value">1</div><div class="sub">in 1 of 2 captured cases</div>');
    expect(html).toContain("4 images");
    expect(renderHtml(legacyData())).not.toContain("Broken images");
    expect(renderHtml(legacyData())).not.toContain('<div class="shots">');
  });
});
