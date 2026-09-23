import { describe, expect, it } from "vitest";
import { renderHtml } from "./html";
import { emptyData, hybridData, legacyData } from "./fixtures";

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
});
