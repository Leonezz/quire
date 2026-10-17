import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { droppedEmbedCount, embedSites } from "./article-embed-omissions";

const BASE = "https://blog.example.test/post/";
const bodyOf = (html: string) => (parseHTML(`<!doctype html><html><body>${html}</body></html>`).document as unknown as Document).body;
const placeholder = (id: string) => `<p><a href="${BASE}#${id}">Interactive figure — open in the original</a></p>`;

describe("embedSites", () => {
  it("lists each embed and interactive placeholder with the text blocks on either side", () => {
    const long = "A long paragraph after the figure. ".repeat(10);
    const sites = embedSites(bodyOf(`
      <h2>Demo</h2><p>Watch   this:</p><iframe src="/demo.html"></iframe>
      <figure><video src="/a.mp4"><p>Your browser does not support video.</p></video><figcaption>The clip.</figcaption></figure>
      <p>Listen: <audio controls></audio></p>
      ${placeholder("fig")}
      <p>${long}</p>`), BASE);

    expect(sites).toEqual([
      { after: "The clip.", before: "Watch this:", key: "iframe https://blog.example.test/demo.html" },
      // Fallback text inside a player is not text around it.
      { after: "The clip.", before: "Watch this:", key: "video https://blog.example.test/a.mp4" },
      // Nor is the paragraph the embed sits in.
      { after: "Interactive figure — open in the original", before: "The clip.", key: "audio " },
      { after: long.trim().slice(0, 100), before: "Listen:", key: `a ${BASE}#fig` },
    ]);
  });

  it("leaves out what the link pass removes anyway (ad, comment and newsletter frames, hidden boxes) and embeds inside embeds", () => {
    const sites = embedSites(bodyOf(`<p>Before.</p>
      <iframe src="https://www.googletagmanager.com/ns.html?id=GTM-X"></iframe><iframe src="https://example.substack.com/embed"></iframe>
      <iframe title="Hidden" style="display: none"></iframe><iframe width="1" height="1"></iframe><div hidden><video src="/h.mp4"></video></div>
      <video><source src="/a.mp4"><iframe src="/fallback.html"></iframe></video><p>After.</p>`), BASE);

    expect(sites).toEqual([{ after: "After.", before: "Before.", key: "video https://blog.example.test/a.mp4" }]);
  });

  it("leaves out a lazy loader's noscript copy and template content, which the extractors drop with their wrapper", () => {
    const sites = embedSites(bodyOf(`<p>Before.</p><iframe src="about:blank" data-lazy-src="/x.html"></iframe>
      <noscript><p>Enable JavaScript.</p><iframe src="/x.html"></iframe></noscript><template><video src="/t.mp4"></video></template><p>After.</p>`), BASE);

    expect(sites).toEqual([{ after: "After.", before: "Before.", key: "iframe https://blog.example.test/x.html" }]);
  });

  it("finds nothing on a page without embeds", () => {
    expect(embedSites(bodyOf("<p>Just text.</p><p><a href='/elsewhere'>A link</a></p>"), BASE)).toEqual([]);
  });
});

describe("droppedEmbedCount", () => {
  const sites = embedSites(bodyOf(
    `<p>Before the chart.</p><iframe title="Live chart"></iframe><p>After the chart.</p>` +
      `<p>Before the clip.</p><video src="/a.mp4"></video><p>After the clip.</p>`,
  ), BASE);

  it("counts embeds whose text on both sides was kept while they were not", () => {
    const content = `<p>Before the chart.</p><p>After the chart.</p><p>Before the clip.</p><video src="https://blog.example.test/a.mp4"></video><p>After the clip.</p>`;
    expect(droppedEmbedCount(sites, content, BASE)).toBe(1);
    expect(droppedEmbedCount(sites, `<p>Before the chart.</p><iframe title="Live chart"></iframe><p>After the chart.</p>${content}`, BASE)).toBe(0);
  });

  it("does not count embeds outside the kept text: the extractor left them out with what surrounded them", () => {
    expect(droppedEmbedCount(sites, `<p>Before the chart.</p><iframe title="Live chart"></iframe><p>After the chart.</p><p>Before the clip.</p>`, BASE)).toBe(0);
    expect(droppedEmbedCount([], "<p>Before the chart.</p>", BASE)).toBe(0);
  });

  it("matches each embed of the content to one site, and counts a dropped placeholder", () => {
    const twice = embedSites(bodyOf(`<p>One.</p><iframe></iframe><p>Two.</p><iframe></iframe><p>Three.</p>`), BASE);
    expect(droppedEmbedCount(twice, `<p>One.</p><iframe></iframe><p>Two.</p><p>Three.</p>`, BASE)).toBe(1);

    const figure = embedSites(bodyOf(`<p>One.</p>${placeholder("fig")}<p>Two.</p>`), BASE);
    expect(droppedEmbedCount(figure, `<p>One.</p><p>Two.</p>`, BASE)).toBe(1);
    expect(droppedEmbedCount(figure, `<p>One.</p>${placeholder("fig")}<p>Two.</p>`, BASE)).toBe(0);
  });
});
