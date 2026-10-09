import { describe, expect, it } from "vitest";
import { renderHtml } from "./html";
import { emptyData, hybridData, legacyData, v6Data, visualData } from "./fixtures";

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

describe("renderHtml (rubric v6)", () => {
  const html = renderHtml(v6Data());

  it("shows the per-layer totals, the invalid count by reason, and three layer badges per case and per opinion", () => {
    expect(html).toContain('<div class="label">rendering layer</div><div class="value"><span class="badge v-pass">1 PASS</span> <span class="badge v-minor">0 MINOR</span> <span class="badge v-major">1 MAJOR</span></div><div class="sub">2 cases judged on this layer</div>');
    expect(html).toContain("Invalid issues, never counted: contradicts-image-facts 1 · evidence-not-verbatim 1.");
    expect(html).toContain('<span class="layers"><span class="badge v-pass" title="content PASS">C PASS</span><span class="badge v-minor" title="metadata MINOR">M MINOR</span><span class="badge v-major" title="rendering MAJOR">R MAJOR</span></span>');
    expect(html).toContain("1 major · 2 invalid (not counted)");
    // the row counts valid issues, with the discarded ones as +n
    expect(html).toContain('<td class="num">2 <span class="small" title="discarded as invalid">+1</span></td>');
    expect(renderHtml(legacyData())).toContain('<td class="opt"><span class="small">–</span></td>');
  });

  it("strikes an invalid issue through and gives the program's reason; valid issues show their layer and refs", () => {
    expect(html).toContain('<li class="invalid" title="not counted"><del><span class="kind major">images</span><span class="layer-tag">content</span> <strong>major</strong> — images is wrong</del><span class="refs">[o1]</span> <span class="reason">invalid: contradicts-image-facts — o1 is in the reader as r1, not broken</span>');
    expect(html).toContain('<li><span class="kind major">images</span><span class="layer-tag">rendering</span> <strong>major</strong> — images is wrong<span class="refs">[r2]</span>');
    expect(html).toContain("invalid: evidence-not-verbatim");
  });

  it("marks where each cross-confirmed issue comes from, and offers merged in the decided-by filter", () => {
    expect(html).toContain('<span class="refs">[r2]</span><span class="origin both" title="both judges reported it">both</span>');
    expect(html).toContain('<span class="origin one-sided" title="one judge reported it">one-sided</span>');
    expect(html).toContain('data-backend="merged"');
    expect(html).toContain('<option value="merged">');
    const downgraded = renderHtml({ ...v6Data(), cases: v6Data().cases.map((row) => ({ ...row, issues: row.issues.map((item) => (item.kind === "metadata" ? { ...item, origin: "one-sided-downgraded" as const, originalSeverity: "major" as const } : item)) })) });
    expect(downgraded).toContain('<span class="origin one-sided-downgraded" title="one judge reported it as major; no measured fact supports it, so it counts as minor">downgraded (was major)</span>');
  });

  it("lists the image and embed inventories in the expanded case, with matches and what is missing", () => {
    expect(html).toContain("<summary>Image, embed, table and code inventories</summary>");
    expect(html).toContain("<h4>Original images (2, 1 not in the reader)</h4>");
    expect(html).toContain("<tr><td><code>o1</code></td><td>1</td><td>640×420</td><td>Figure 1</td><td>↔ <code>r1</code></td></tr>");
    expect(html).toContain('<tr><td><code>o2</code></td><td>2</td><td>800×500</td><td>Figure 3</td><td><span class="missing">not in the reader</span></td></tr>');
    expect(html).toContain("<h4>Reader images (2, 1 broken)</h4>");
    expect(html).toContain('<span class="missing">broken</span>');
    expect(html).toContain("<h4>Embeds (1, 1 not shown in the reader)</h4>");
    expect(html).toContain('<tr><td><code>e1</code></td><td>iframe</td><td>www.youtube.com</td><td>Training setup and the demo video</td><td><span class="missing">not shown</span></td></tr>');
    expect(renderHtml(legacyData())).not.toContain("inventories</summary>");
    const withCode = renderHtml({ ...v6Data(), cases: v6Data().cases.map((row) => (row.render ? { ...row, render: { ...row.render, tables: [{ id: "t1", tile: 4, rows: 5, cols: 4, cells: 20, emptyCells: 13, head: "Metric | LCP" }], code: [{ id: "c1", tile: 3, lines: 1, chars: 212, collapsed: true, head: "def clipped_error(x):" }] } } : row)) });
    expect(withCode).toContain('<tr><td><code>t1</code></td><td>4</td><td>5×4</td><td><span class="missing">13 of 20</span></td><td>Metric | LCP</td></tr>');
    expect(withCode).toContain('<tr><td><code>c1</code></td><td>3</td><td><span class="missing">one line of 212 chars</span></td><td><code>def clipped_error(x):</code></td></tr>');
  });
});
