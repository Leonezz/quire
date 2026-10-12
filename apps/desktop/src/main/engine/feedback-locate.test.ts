// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { locateTextScript } from "./feedback-capture";

// The script runs in the original page; here in jsdom, where layout is all zeros and scrollTo is a stub.
afterEach(() => { document.body.innerHTML = ""; document.head.innerHTML = ""; vi.restoreAllMocks(); });

function run(needle: string): { found: boolean; y: number } {
  window.scrollTo = vi.fn() as never;
  // jsdom has no layout: the passage sits 900 px down the page.
  Range.prototype.getBoundingClientRect = () => ({ top: 900, left: 0, width: 10, height: 10 }) as DOMRect;
  // eslint-disable-next-line no-eval -- the script is ours, built for evaluation in a page.
  return (0, eval)(locateTextScript(needle)) as { found: boolean; y: number };
}

describe("locateTextScript", () => {
  it("finds the quote across inline elements and whitespace differences, and selects exactly it", () => {
    document.body.innerHTML = "<p>Intro.</p><p>本周，<a href='#'>OpenClaw</a>\n  发布了<a>2.0版</a>。</p><script>var hidden = '本周';</script>";
    expect(run("本周，OpenClaw 发布了").found).toBe(true);
    expect(window.getSelection()?.toString().replace(/\s+/g, "")).toBe("本周，OpenClaw发布了");
    expect(window.scrollTo).toHaveBeenCalledWith(0, 900 - window.innerHeight / 3);
    expect(document.head.querySelector("style")?.textContent).toContain("::selection");
  });

  it("answers not found, without scrolling, for text that is not there or only in scripts", () => {
    document.body.innerHTML = "<p>Something else.</p><script>var x = 'needle here';</script>";
    expect(run("needle here")).toEqual({ found: false, y: 0 });
    expect(run("   ")).toEqual({ found: false, y: 0 });
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("embeds the needle as data, never as code", () => {
    document.body.innerHTML = "<p>a\"); throw new Error(\"x</p>";
    expect(run("a\"); throw new Error(\"x").found).toBe(true);
  });
});
