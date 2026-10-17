import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { normalizeArticleCapture } from "./article";
import { linkEmbeddedMedia } from "./embedded-media";

const BASE = "https://blog.example.test/post/";
const STREAM = "https://customer-eq7kiuol0tk9chox.cloudflarestream.com/affebd0d7251da155e5307f19069c944";
const STREAM_POSTER = `${STREAM}/thumbnails/thumbnail.jpg?time=&height=600`;

/** How blog.cloudflare.com embeds a muted, looping Stream screencast (issue #36): a ratio box around the player iframe. */
function streamBlock(base = STREAM) {
  const poster = `${base}/thumbnails/thumbnail.jpg?time=&height=600`;
  return `<div class="html-block"><div style="padding-top:61.047027506654835%">
  <iframe src="${base}/iframe?muted=true&amp;preload=true&amp;loop=true&amp;autoplay=true&amp;poster=${encodeURIComponent(poster)}" loading="lazy" style="border:none;position:absolute;top:0;left:0;height:100%;width:100%" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen="true"></iframe>
</div></div>`;
}

describe("linkEmbeddedMedia", () => {
  it("replaces a Cloudflare Stream iframe with its poster frame and a link to the watch page", () => {
    const result = linkEmbeddedMedia(streamBlock(), BASE);
    expect(result).toMatchObject({ linked: 1, removed: 0 });
    expect(result.html).toContain(
      `<figure><img alt="Video poster" src="${STREAM_POSTER}"><figcaption><a href="${STREAM}/watch">▶ Video · Cloudflare Stream</a></figcaption></figure>`,
    );
    expect(result.html).not.toContain("<iframe");
  });

  it("derives the Stream poster when the iframe names none, and keeps legacy player URLs as the link", () => {
    const uid = "affebd0d7251da155e5307f19069c944";
    const result = linkEmbeddedMedia(
      `<iframe src="${STREAM}/iframe"></iframe><iframe src="https://iframe.videodelivery.net/${uid}?autoplay=true"></iframe>`,
      BASE,
    );
    expect(result.linked).toBe(2);
    expect(result.html).toBe(
      `<figure><img alt="Video poster" src="${STREAM}/thumbnails/thumbnail.jpg"><figcaption><a href="${STREAM}/watch">▶ Video · Cloudflare Stream</a></figcaption></figure>` +
        `<figure><img alt="Video poster" src="https://videodelivery.net/${uid}/thumbnails/thumbnail.jpg"><figcaption><a href="https://iframe.videodelivery.net/${uid}">▶ Video · Cloudflare Stream</a></figcaption></figure>`,
    );
  });

  it("links YouTube, Vimeo and CodePen embeds to their own pages, with the YouTube thumbnail and a meaningful title", () => {
    const result = linkEmbeddedMedia(
      [
        `<iframe src="https://www.youtube-nocookie.com/embed/k1ILy23t89E?si=x" title="YouTube video player"></iframe>`,
        `<iframe src="https://www.youtube.com/embed/mpgWH9KulUU" title="Gemini demo"></iframe>`,
        `<iframe src="https://player.vimeo.com/video/76979871?autoplay=1"></iframe>`,
        `<iframe src="https://player.vimeo.com/video/76979872?h=8272103f6e"></iframe>`,
        `<iframe src="https://codepen.io/anon/embed/preview/abcXYZ?height=450&amp;default-tab=result" title="CodePen Embed abcXYZ"></iframe>`,
      ].join(""),
      BASE,
    );
    expect(result.linked).toBe(5);
    expect(result.html).toBe(
      [
        `<figure><img alt="Video poster" src="https://i.ytimg.com/vi/k1ILy23t89E/hqdefault.jpg"><figcaption><a href="https://www.youtube.com/watch?v=k1ILy23t89E">▶ Video · YouTube</a></figcaption></figure>`,
        `<figure><img alt="Gemini demo" src="https://i.ytimg.com/vi/mpgWH9KulUU/hqdefault.jpg"><figcaption><a href="https://www.youtube.com/watch?v=mpgWH9KulUU">▶ Video · YouTube: Gemini demo</a></figcaption></figure>`,
        `<p><a href="https://vimeo.com/76979871">▶ Video · Vimeo</a></p>`,
        // An unlisted video's page needs its hash, which only the player URL carries.
        `<p><a href="https://player.vimeo.com/video/76979872?h=8272103f6e">▶ Video · Vimeo</a></p>`,
        `<p><a href="https://codepen.io/anon/pen/abcXYZ">Demo · CodePen</a></p>`,
      ].join(""),
    );
  });

  it("keeps a meaningful title that merely starts with a media word, and links YouTube's live-channel player as it is", () => {
    const result = linkEmbeddedMedia(
      `<iframe src="https://player.vimeo.com/video/76979871" title="Video walkthrough"></iframe>` +
        `<iframe src="https://www.youtube.com/embed/live_stream?channel=UCabc"></iframe>`,
      BASE,
    );
    expect(result.html).toBe(
      `<p><a href="https://vimeo.com/76979871">▶ Video · Vimeo: Video walkthrough</a></p>` +
        `<p><a href="https://www.youtube.com/embed/live_stream?channel=UCabc">Embedded content · youtube.com</a></p>`,
    );
  });

  it("links every embed of a paragraph that holds only embeds", () => {
    const result = linkEmbeddedMedia(
      `<p><iframe src="https://www.youtube.com/embed/AAAAAAAAAAA"></iframe><br><iframe src="https://www.youtube.com/embed/BBBBBBBBBBB"></iframe></p>` +
        `<p><video src="/a.mp4"></video>\n<video src="/b.mp4"></video></p>`,
      BASE,
    );
    expect(result.linked).toBe(4);
    for (const url of ["https://www.youtube.com/watch?v=AAAAAAAAAAA", "https://www.youtube.com/watch?v=BBBBBBBBBBB", "https://blog.example.test/a.mp4", "https://blog.example.test/b.mp4"]) {
      expect(result.html).toContain(`href="${url}"`);
    }
  });

  it("links any other iframe to its own URL, resolved against the page and read from a lazy loader's data-src", () => {
    const result = linkEmbeddedMedia(
      `<iframe src="/demos/flex.html"></iframe><iframe src="about:blank" data-src="https://codesandbox.io/embed/abc"></iframe>`,
      BASE,
    );
    expect(result.html).toBe(
      `<p><a href="https://blog.example.test/demos/flex.html">Embedded content · blog.example.test</a></p>` +
        `<p><a href="https://codesandbox.io/embed/abc">Embedded content · codesandbox.io</a></p>`,
    );
  });

  it("turns a video into its poster and a link to the file, dropping the fallback text and the player's fragment", () => {
    const result = linkEmbeddedMedia(
      `<video controls poster="/poster.jpg" width="640"><source src="/clip.mp4#t=0.001?_=1" type="video/mp4">Your browser does not support video.</video>`,
      BASE,
    );
    expect(result.html).toBe(
      `<figure><img alt="Video poster" src="https://blog.example.test/poster.jpg"><figcaption><a href="https://blog.example.test/clip.mp4">▶ Video · blog.example.test</a></figcaption></figure>`,
    );
  });

  it("links audio inline when it sits in a paragraph", () => {
    const result = linkEmbeddedMedia(
      `<p>Listen: <audio controls><source src="https://cdn.example.test/talk.mp3" type="audio/mp3">Your browser does not support audio.</audio></p>`,
      BASE,
    );
    expect(result.html).toBe(`<p>Listen: <a href="https://cdn.example.test/talk.mp3">▶ Audio · cdn.example.test</a></p>`);
  });

  it("puts the poster in a figure the page already has and the link at the head of its caption", () => {
    const result = linkEmbeddedMedia(
      `<figure><video src="/clip.mp4" poster="/p.jpg"></video><figcaption>The CLI deploying an app.</figcaption></figure>` +
        `<figure><video src="/other.mp4" poster="/q.jpg"></video></figure>`,
      BASE,
    );
    expect(result.html).toBe(
      `<figure><img alt="Video poster" src="https://blog.example.test/p.jpg"><figcaption><a href="https://blog.example.test/clip.mp4">▶ Video · blog.example.test</a><br>The CLI deploying an app.</figcaption></figure>` +
        `<figure><img alt="Video poster" src="https://blog.example.test/q.jpg"><figcaption><a href="https://blog.example.test/other.mp4">▶ Video · blog.example.test</a></figcaption></figure>`,
    );
  });

  it("removes ad, analytics, comment and newsletter frames and hidden or 1-pixel ones without counting them as content", () => {
    const result = linkEmbeddedMedia(
      [
        `<iframe src="https://www.googletagmanager.com/ns.html?id=GTM-X"></iframe>`,
        `<iframe src="https://disqus.com/embed/comments/?base=default"></iframe>`,
        `<iframe src="https://example.substack.com/embed"></iframe>`,
        `<iframe src="https://e.example.test/widget" style="display: none"></iframe>`,
        `<iframe src="https://e.example.test/pixel" width="1" height="1"></iframe>`,
        `<p>Body.</p>`,
      ].join(""),
      BASE,
    );
    expect(result).toMatchObject({ html: "<p>Body.</p>", linked: 0, removed: 5 });
  });

  it("leaves embeds without a usable URL for the reader to drop and report, even zero-sized placeholders", () => {
    const html = `<iframe title="Live chart"></iframe><iframe src="javascript:void(0)"></iframe><video controls></video><iframe src="" width="0" height="0"></iframe>`;
    expect(linkEmbeddedMedia(html, BASE)).toEqual({ html, linked: 0, removed: 0 });
  });

  it("links a lite-youtube or lite-vimeo facade like the player it loads, and leaves one without a usable video id", () => {
    const result = linkEmbeddedMedia(
      `<lite-youtube videoid="mpgWH9KulUU" title="Gemini 2.0 streaming demo" playlabel="Play: Gemini 2.0 streaming demo">\n</lite-youtube>` +
        `<lite-youtube videoid="k1ILy23t89E" videotitle="Course intro"></lite-youtube>` +
        `<lite-vimeo videoid="364402896"></lite-vimeo>` +
        `<lite-youtube videoid="a b/c"></lite-youtube><lite-youtube></lite-youtube>`,
      BASE,
    );
    expect(result.linked).toBe(3);
    expect(result.html).toBe(
      `<figure><img alt="Gemini 2.0 streaming demo" src="https://i.ytimg.com/vi/mpgWH9KulUU/hqdefault.jpg"><figcaption><a href="https://www.youtube.com/watch?v=mpgWH9KulUU">▶ Video · YouTube: Gemini 2.0 streaming demo</a></figcaption></figure>` +
        `<figure><img alt="Course intro" src="https://i.ytimg.com/vi/k1ILy23t89E/hqdefault.jpg"><figcaption><a href="https://www.youtube.com/watch?v=k1ILy23t89E">▶ Video · YouTube: Course intro</a></figcaption></figure>` +
        `<p><a href="https://vimeo.com/364402896">▶ Video · Vimeo</a></p>` +
        `<lite-youtube videoid="a b/c"></lite-youtube><lite-youtube></lite-youtube>`,
    );
  });

  it("stands a link to its place on the page in for an empty d-figure or a Sandpack preview, which only script fills", () => {
    const result = linkEmbeddedMedia(
      `<figure><figcaption>Starting from random noise, we optimize an image.</figcaption><d-figure id="opt-progress"></d-figure></figure>` +
        `<d-figure>\n</d-figure>` +
        `<div class="sp-preview-container"><iframe class="sp-c-fgviib sp-preview-iframe" title="Sandpack Preview"></iframe></div>` +
        `<d-figure id="static"><img src="/fig.png" alt="Static figure"></d-figure>` +
        `<d-figure id="clip"><video><source src="/clip.mp4"></video></d-figure>`,
      `${BASE}#comments`,
    );
    expect(result).toMatchObject({ linked: 4, removed: 0 });
    expect(result.html).toBe(
      `<figure><figcaption>Starting from random noise, we optimize an image.</figcaption><p><a href="${BASE}#opt-progress">Interactive figure — open in the original</a></p></figure>` +
        `<p><a href="${BASE}">Interactive figure — open in the original</a></p>` +
        `<div class="sp-preview-container"><p><a href="${BASE}">Code playground — open in the original</a></p></div>` +
        // Server-rendered content is the figure itself, and its players are linked like any other.
        `<d-figure id="static"><img src="/fig.png" alt="Static figure"></d-figure>` +
        `<d-figure id="clip"><p><a href="https://blog.example.test/clip.mp4">▶ Video · blog.example.test</a></p></d-figure>`,
    );
  });

  it("leaves interactive content alone when there is no page to link to", () => {
    const html = `<d-figure id="opt-progress"></d-figure><iframe class="sp-preview-iframe" title="Sandpack Preview"></iframe>`;
    expect(linkEmbeddedMedia(html, undefined)).toEqual({ html, linked: 0, removed: 0 });
  });
});

function articleCapture(body: string) {
  const html = `<!doctype html><html lang="en"><head><title>Deploy a demo app</title></head><body><main><article><h1>Deploy a demo app</h1>${body}</article></main></body></html>`;
  const bytes = new TextEncoder().encode(html);
  return normalizeArticleCapture({
    budget: { maxBytes: 8e6, maxDepth: 200, maxNodes: 100_000, maxOutputBytes: 8e6 },
    capture: {
      baseLocator: BASE,
      bytes,
      contentIdentity: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      mediaType: "text/html",
    },
  });
}

const prose = (topic: string) => `<p>${`A paragraph about ${topic} that is long enough to read as article prose. `.repeat(6)}</p>`;

function representation(outcome: ReturnType<typeof normalizeArticleCapture>, schema: string) {
  if (!outcome.ok) throw new Error(`normalization failed: ${outcome.problems.map((p) => p.code).join(", ")}`);
  return outcome.article.materialization.representations.find((value) => value.schema === schema)?.content ?? "";
}

describe("embedded media in a normalized article", () => {
  it("shows each Stream screencast after its lead-in as a poster and a watch link (issue #36)", () => {
    const uids = ["affebd0d7251da155e5307f19069c944", "b39fd93e9a74d9ae0f954ea765d02da1", "4b9b443ea28f94967ddc3a904ab61b65"];
    const bases = uids.map((uid) => `https://customer-eq7kiuol0tk9chox.cloudflarestream.com/${uid}`);
    const outcome = articleCapture(
      bases.map((base, index) => `${prose(`step ${index + 1}`)}<p>Run this command:</p>${streamBlock(base)}<p></p>`).join("") + prose("the end"),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const reader = JSON.parse(representation(outcome, "reader.document.v2"));
    const figures = reader.children.filter((node: { type: string }) => node.type === "figure");
    expect(figures).toEqual(
      bases.map((base) => ({
        caption: [{ children: [{ type: "text", value: "▶ Video · Cloudflare Stream" }], title: null, type: "link", url: `${base}/watch` }],
        credit: [],
        media: [{ alt: "Video poster", title: null, type: "image", url: `${base}/thumbnails/thumbnail.jpg?time=&height=600` }],
        type: "figure",
      })),
    );
    // Each one right after the sentence that introduces it.
    const leadIns = reader.children.flatMap((node: { type: string }, index: number) =>
      JSON.stringify(node).includes("Run this command:") ? [reader.children[index + 1].type] : []);
    expect(leadIns).toEqual(["figure", "figure", "figure"]);
    expect(reader.losses.filter((loss: { sourceTag: string }) => loss.sourceTag === "iframe")).toEqual([]);

    const agent = representation(outcome, "agent.gfm.v1");
    for (const base of bases) expect(agent).toContain(`(${base}/watch)`);
    expect(outcome.article.materialization.provenance.rulesApplied).toContain("generic.embedded-media-links@1");
    expect(outcome.article.materialization.quality.warnings).toEqual([]);
  });

  it("shows both videos of a Markdown-rendered paragraph", () => {
    const outcome = articleCapture(`${prose("demos")}<p><video src="/a.mp4"></video>\n<video src="/b.mp4"></video></p>${prose("the end")}`);
    const reader = representation(outcome, "reader.document.v2");
    expect(reader).toContain('"url":"https://blog.example.test/a.mp4"');
    expect(reader).toContain('"url":"https://blog.example.test/b.mp4"');
  });

  // (In an article a src-less iframe or source-less video never gets this far: the extractor removes empty elements.)
  it("warns when an embed with no URL to link had to be dropped, and never shows a media element's fallback text", () => {
    const outcome = articleCapture(
      `${prose("previews")}<iframe src="javascript:void(0)" width="600" height="400"></iframe>` +
        `<video controls src="blob:https://blog.example.test/1">Your browser does not support video.</video>${prose("the end")}`,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const omitted = { code: "SOURCE_EMBEDDED_CONTENT_OMITTED", recoverBy: "none", scope: "representation", severity: "warning" };
    expect(outcome.article.materialization.quality.warnings).toEqual([omitted]);
    expect(outcome.problems).toEqual([omitted]);
    expect(representation(outcome, "reader.document.v2")).not.toContain("does not support");
    expect(representation(outcome, "agent.gfm.v1")).not.toContain("does not support");
  });

  /** A Sandpack playground as joshwcomeau.com renders it: a header, the server-rendered code, and a src-less live preview. */
  const sandpack = `<div class="sp-wrapper"><div class="playground"><header><p>Code Playground</p><button title="Reset code">Reset</button></header>
    <div class="sp-editor"><div class="sp-code-editor" role="tabpanel"><div role="textbox" aria-label="Code Editor for App.js">
    <pre class="sp-pre-placeholder"><span class="sp-syntax-keyword">function</span> App() { return &lt;p&gt;Count: 1&lt;/p&gt;; }</pre></div></div></div>
    <div class="sp-preview"><div class="sp-preview-container"><iframe class="sp-c-fgviib sp-preview-iframe" title="Sandpack Preview"></iframe></div></div></div></div>`;

  it("shows a lite-youtube facade as its poster and watch link, and empty interactive content as a link to the original (issue #14)", () => {
    const outcome = articleCapture(
      `${prose("live video")}<lite-youtube videoid="mpgWH9KulUU" title="Gemini 2.0 streaming demo"></lite-youtube>${prose("figures")}` +
        `<figure><figcaption>Starting from random noise, we optimize an image to activate a neuron.</figcaption><d-figure id="opt-progress"></d-figure></figure>` +
        `${prose("playgrounds")}<p>Let's look at an example:</p>${sandpack}${prose("the end")}`,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const reader = JSON.parse(representation(outcome, "reader.document.v2"));
    expect(reader.children.filter((node: { type: string }) => node.type === "figure")).toEqual([{
      caption: [{ children: [{ type: "text", value: "▶ Video · YouTube: Gemini 2.0 streaming demo" }], title: null, type: "link", url: "https://www.youtube.com/watch?v=mpgWH9KulUU" }],
      credit: [],
      media: [{ alt: "Gemini 2.0 streaming demo", title: null, type: "image", url: "https://i.ytimg.com/vi/mpgWH9KulUU/hqdefault.jpg" }],
      type: "figure",
    }]);
    const agent = representation(outcome, "agent.gfm.v1");
    expect(agent).toContain(`[Interactive figure — open in the original](${BASE}#opt-progress)`);
    expect(agent).toContain(`[Code playground — open in the original](${BASE})`);
    expect(agent).toContain("Count: 1");
    expect(outcome.article.materialization.provenance.rulesApplied).toEqual(expect.arrayContaining([
      "article.preextract.interactive-placeholders@1",
      "generic.embedded-media-links@1",
    ]));
    expect(outcome.article.materialization.quality.warnings).toEqual([]);
  });

  it("warns when the extractor dropped an embed that sat inside the article, before the reader could report it", () => {
    const outcome = articleCapture(
      `${prose("charts")}<p>The live chart below updates every second.</p><iframe title="Live chart" width="600" height="400"></iframe>` +
        `<p>As the chart shows, the load stays flat.</p>${prose("the end")}`,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const omitted = { code: "SOURCE_EMBEDDED_CONTENT_OMITTED", recoverBy: "none", scope: "representation", severity: "warning" };
    // The reader never saw it, so it has no loss to report.
    expect(JSON.parse(representation(outcome, "reader.document.v2")).losses).not.toContainEqual(expect.objectContaining({ sourceTag: "iframe" }));
    expect(outcome.article.materialization.quality.warnings).toEqual([omitted]);
    expect(outcome.problems).toEqual([omitted]);
  });

  it("does not warn for widgets the extractor rightly drops: a comment section's frames, a newsletter sign-up", () => {
    const outcome = articleCapture(
      `${prose("widgets")}<iframe src="https://example.substack.com/embed" width="480" height="320"></iframe>${prose("the end")}` +
        `<section class="comments" id="comments"><h3>3 comments</h3><p>Great post, thanks for writing it up!</p>` +
        `<iframe title="Leave a reply" width="600" height="300"></iframe><p>Agreed with all of this, especially the end.</p></section>`,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(representation(outcome, "agent.gfm.v1")).not.toContain("Great post");
    expect(outcome.article.materialization.quality.warnings).toEqual([]);
  });
});
