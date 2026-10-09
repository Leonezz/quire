import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { precedingContext, referenceFactsScript } from "./reference-facts";

/** precedingContext for the element matching selector, over the fixture's body in document order. */
function contextOf(body: string, selector: string, maxChars = 400): string {
  const { document } = parseHTML(`<!doctype html><html><head></head><body>${body}</body></html>`);
  const all = Array.from(document.body.querySelectorAll("*")) as unknown as Element[];
  const target = document.querySelector(selector) as unknown as Element;
  return precedingContext(all, all.indexOf(target), maxChars);
}

describe("precedingContext", () => {
  it("takes the nearest heading or paragraph before the image, flattened", () => {
    const body = `<h1>Title</h1><p>First   paragraph\n text.</p><div><figure><img id="a"></figure></div><p>After.</p><h2>Related posts</h2><ul><li><img id="b"></li></ul>`;
    expect(contextOf(body, "#a")).toBe("First paragraph text.");
    expect(contextOf(body, "#b")).toBe("Related posts");
  });

  it("skips a paragraph that contains the image and empty ones", () => {
    expect(contextOf(`<h2>Setup</h2><p></p><p>Look: <img id="a"> here</p>`, "#a")).toBe("Setup");
  });

  it("passes over nav/header/footer/aside text while article text exists further back, else uses it", () => {
    expect(contextOf(`<p>Article text.</p><aside><p>Newsletter</p></aside><img id="a">`, "#a")).toBe("Article text.");
    expect(contextOf(`<header><p>Site tagline</p></header><img id="a">`, "#a")).toBe("Site tagline");
  });

  it("is empty at the top of the page and clips to maxChars", () => {
    expect(contextOf(`<img id="a"><p>Later</p>`, "#a")).toBe("");
    expect(contextOf(`<p>${"x".repeat(50)}</p><img id="a">`, "#a", 10)).toBe("x".repeat(10));
  });
});

describe("referenceFactsScript", () => {
  it("is an evaluable call of the collector with the walker", () => {
    const script = referenceFactsScript();
    expect(script.startsWith("(function collectReferenceImages(")).toBe(true);
    expect(script).toContain("function precedingContext(");
    expect(() => new Function(`return () => ${script}`)).not.toThrow();
  });
});
