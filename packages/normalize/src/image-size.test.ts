import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeArticleCapture } from "./article";

describe("image dimensions", () => {
  it("carries declared pixel width and height into the reader image node, ignoring percentages", () => {
    const html = `<html><head><title>T</title></head><body><article><h1>T</h1><p>${"Body text about diagrams. ".repeat(15)}</p><p><img src="https://x.test/a.png" alt="A" width="800" height="450"><img src="https://x.test/b.png" alt="B" width="100%"></p></article></body></html>`;
    const bytes = new TextEncoder().encode(html);
    const result = normalizeArticleCapture({ budget: { maxBytes: 8e6, maxDepth: 100, maxNodes: 100000, maxOutputBytes: 8e6 }, capture: { baseLocator: "https://x.test/post", bytes, contentIdentity: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, mediaType: "text/html" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const v2 = result.article.materialization.representations.find((r) => r.schema === "reader.document.v2")?.content ?? "";
    expect(v2).toContain('"alt":"A","height":450,"title":null,"type":"image","url":"https://x.test/a.png","width":800');
    expect(v2).toContain('"alt":"B","title":null,"type":"image","url":"https://x.test/b.png"}');
  });
});
