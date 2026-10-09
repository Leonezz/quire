import { describe, expect, it } from "vitest";
import { extractEmbeds, isNoiseUrl, markRepresented, MAX_EMBEDS, mediaKey } from "./embeds";

const page = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
const BASE = "https://blog.example.com/post/";

describe("extractEmbeds", () => {
  it("lists iframes, media, tweets and instagram posts in document order with their nearest preceding text", () => {
    const embeds = extractEmbeds(page(`
      <h2>Demo</h2><p>Watch this:</p>
      <iframe src="https://www.youtube.com/embed/k1ILy23t89E?si=x" width="560" height="315"></iframe>
      <p>Listen <audio controls><source src="/media/talk.mp3" type="audio/mp3">Your browser does not support audio.</audio></p>
      <video src="//cdn.example.com/clip.mp4"></video>
      <blockquote class="twitter-tweet"><p>So true</p>— A (@a) <a href="https://twitter.com/a/status/1?ref_src=x">Jan 1</a> <a href="https://twitter.com/a/status/123456?ref_src=twsrc">Jan 2</a></blockquote>
      <blockquote class="instagram-media" data-instgrm-permalink="https://www.instagram.com/p/ABC/"></blockquote>
      <canvas id="chart"></canvas>`), BASE);
    expect(embeds.map(({ kind, tag, src, host, context }) => ({ kind, tag, src, host, context }))).toEqual([
      { kind: "iframe", tag: "iframe", src: "https://www.youtube.com/embed/k1ILy23t89E?si=x", host: "www.youtube.com", context: "Watch this:" },
      { kind: "audio", tag: "audio", src: "https://blog.example.com/media/talk.mp3", host: "blog.example.com", context: "Watch this:" },
      { kind: "video", tag: "video", src: "https://cdn.example.com/clip.mp4", host: "cdn.example.com", context: "Listen Your browser does not support audio." },
      { kind: "tweet", tag: "blockquote", src: "https://twitter.com/a/status/123456?ref_src=twsrc", host: "twitter.com", context: "Listen Your browser does not support audio." },
      { kind: "instagram", tag: "blockquote", src: "https://www.instagram.com/p/ABC/", host: "www.instagram.com", context: "So true" },
      { kind: "canvas", tag: "canvas", src: "", host: "", context: "So true" },
    ]);
    expect(embeds.every((embed) => embed.representedInReader === false)).toBe(true);
  });

  it("keeps srcless iframes (interactive previews) but drops hidden, 1-pixel and ad/analytics ones", () => {
    const embeds = extractEmbeds(page(`
      <iframe class="sp-preview-iframe" title="Sandpack Preview"></iframe>
      <iframe src="https://www.googletagmanager.com/ns.html?id=GTM-X" height="0" width="0"></iframe>
      <iframe src="https://ads.doubleclick.net/x"></iframe>
      <iframe src="https://e.com/widget" style="display: none"></iframe>
      <noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=1&ev=PageView"></noscript>
      <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-Y"></iframe></noscript>
      <noscript><img src="/hero.jpg" alt="Hero"></noscript>
      <noscript>Please enable JavaScript to view the comments powered by Disqus.</noscript>
      <iframe src="https://disqus.com/embed/comments/?base=default"></iframe>`), BASE);
    expect(embeds.map((embed) => `${embed.kind} ${embed.src}`)).toEqual([
      "iframe ",
      "noscript https://blog.example.com/hero.jpg",
      "iframe https://disqus.com/embed/comments/?base=default",
    ]);
  });

  it("lists custom elements that show or are configured with something, not chrome, code highlighting or prose wrappers", () => {
    const embeds = extractEmbeds(page(`
      <x-icon></x-icon><devsite-header><span>Docs</span></devsite-header><search-bar-snippet><input></search-bar-snippet>
      <d-article><p>Intro paragraph.</p>
        <figure><d-figure id="opt-progress"></d-figure></figure>
        <lite-youtube videoid="mpgWH9KulUU" title="Gemini demo"></lite-youtube>
        <callout-info><p>Long callout text that the server rendered.</p></callout-info>
        <pre><code><a-k>let</a-k> <a-v>x</a-v></code></pre>
        <my-chart data-url="/data.json"><my-chart-legend>Legend</my-chart-legend></my-chart>
        <empty-thing></empty-thing>
      </d-article>`), BASE);
    expect(embeds.map((embed) => `${embed.tag} ${embed.src}`)).toEqual([
      "d-figure ",
      "lite-youtube https://www.youtube.com/watch?v=mpgWH9KulUU",
      "my-chart ",
    ]);
    expect(embeds[0]?.context).toBe("Intro paragraph.");
  });

  it("does not list what is inside an embed, ignores the head and caps the count", () => {
    expect(extractEmbeds(`<html><head><iframe src="https://e.com/h"></iframe></head><body><noscript><iframe src="https://e.com/a"></iframe></noscript></body></html>`, BASE).map((e) => e.kind)).toEqual(["noscript"]);
    expect(extractEmbeds(page(`<p>x</p>${"<iframe src='https://codepen.io/anon/embed/abc'></iframe>".repeat(MAX_EMBEDS + 5)}`), BASE)).toHaveLength(MAX_EMBEDS);
  });

  it("resolves srcs against the page's own base", () => {
    expect(extractEmbeds(`<html><head><base href="/sub/"></head><body><iframe src="frame.html"></iframe></body></html>`, BASE)[0]?.src).toBe("https://blog.example.com/sub/frame.html");
  });
});

describe("mediaKey", () => {
  it("makes YouTube, Twitter, Vimeo and CodePen variants equal", () => {
    const youtube = "youtube.com/watch?v=k1ILy23t89E";
    expect(mediaKey("https://www.youtube.com/embed/k1ILy23t89E?si=UEqgMCVxYfMBkEtj")).toBe(youtube);
    expect(mediaKey("https://www.youtube-nocookie.com/embed/k1ILy23t89E")).toBe(youtube);
    expect(mediaKey("https://youtu.be/k1ILy23t89E?t=10")).toBe(youtube);
    expect(mediaKey("http://m.youtube.com/watch?v=k1ILy23t89E&feature=share")).toBe(youtube);
    expect(mediaKey("https://twitter.com/a/status/123456?ref_src=twsrc")).toBe(mediaKey("https://x.com/a/status/123456"));
    expect(mediaKey("https://twitter.com/simonw")).toBe("x.com/simonw");
    expect(mediaKey("https://player.vimeo.com/video/76979871?h=1")).toBe("vimeo.com/76979871");
    expect(mediaKey("https://codepen.io/anon/embed/QwKVaYm?height=450&default-tab=css,result")).toBe(mediaKey("https://codepen.io/team/css-tricks/pen/QwKVaYm"));
  });

  it("drops protocol, www., query, fragment and trailing slash otherwise", () => {
    expect(mediaKey("https://www.example.com/a/b/?x=1#y")).toBe("example.com/a/b");
    expect(mediaKey("http://example.com/a/b")).toBe("example.com/a/b");
    expect(mediaKey("")).toBe("");
    expect(mediaKey("mailto:a@b.c")).toBe("");
  });
});

describe("markRepresented", () => {
  it("marks embeds whose URL the reader shows as a link, image or media source", () => {
    const embeds = extractEmbeds(page(`<iframe src="https://www.youtube.com/embed/k1ILy23t89E"></iframe><video src="https://cdn.e.com/v.mp4"></video><iframe></iframe>`), BASE);
    expect(markRepresented(embeds, ["https://youtu.be/k1ILy23t89E"]).map((e) => e.representedInReader)).toEqual([true, false, false]);
  });
});

describe("isNoiseUrl", () => {
  it("knows ad, analytics and pixel hosts, with subdomains and path prefixes", () => {
    expect(isNoiseUrl("https://www.googletagmanager.com/ns.html?id=1")).toBe(true);
    expect(isNoiseUrl("https://stats.g.doubleclick.net/x")).toBe(true);
    expect(isNoiseUrl("https://www.facebook.com/tr?id=1")).toBe(true);
    expect(isNoiseUrl("https://www.facebook.com/plugins/video.php")).toBe(false);
    expect(isNoiseUrl("https://www.youtube.com/embed/x")).toBe(false);
  });
});
