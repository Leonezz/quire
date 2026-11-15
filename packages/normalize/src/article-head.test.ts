import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeArticleCapture } from "./article";

const prose = (n: number, topic = "the topic at hand") => `<p>${`Substantive paragraph about ${topic}, with enough words to read as prose. `.repeat(n)}</p>`;

function normalize(html: string, url: string) {
  const bytes = new TextEncoder().encode(html);
  const result = normalizeArticleCapture({
    budget: { maxBytes: 8e6, maxDepth: 100, maxNodes: 100000, maxOutputBytes: 8e6 },
    capture: { baseLocator: url, bytes, contentIdentity: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, mediaType: "text/html" },
  });
  if (!result.ok) throw new Error(`normalization failed: ${result.problems.map((p) => p.code).join(", ")}`);
  const markdown = result.article.materialization.representations.find((r) => r.schema === "agent.gfm.v1")?.content ?? "";
  const v2 = result.article.materialization.representations.find((r) => r.schema === "reader.document.v2")?.content ?? "";
  return { article: result.article, markdown, v2, rules: result.article.materialization.provenance.rulesApplied };
}

/** The text of the reader document's flow, in order, as one string. */
function flowText(v2: string) {
  return JSON.stringify(JSON.parse(v2)).replace(/\\"/gu, "'");
}

const ghostExcerpt = "Gradient descent is the preferred way to optimize neural networks but is often used as a black box.";
// Body figures as the real post has them, so the extractor's image-retention gate passes and Defuddle (which drops the header) wins.
const figures = [1, 2, 3, 4].map((n) => `<figure><img src="https://ruder.io/content/images/2016/09/figure_${n}.png" alt="Figure ${n}"><figcaption>Figure ${n}</figcaption></figure>`).join("");
const ghostPage = `<html><head><title>An overview of gradient descent optimization algorithms</title>
  <meta name="description" content="${ghostExcerpt}">
  <meta property="og:image" content="https://ruder.io/content/images/2016/09/loss_function_image_tumblr.png"></head><body>
  <main><article class="article">
    <header class="article-header gh-canvas"><h1 class="article-title">An overview of gradient descent optimization algorithms</h1>
      <p class="article-excerpt">${ghostExcerpt}</p>
      <div class="article-byline"><a class="author-avatar" href="/author/sebastian/"><img class="author-profile-image" src="https://ruder.io/content/images/size/w100/2023/01/profile.jpg" alt="Sebastian Ruder" width="100" height="100"></a><h4 class="author-name">Sebastian Ruder</h4></div>
      <figure class="article-image"><img class="gh-feature-image" srcset="https://ruder.io/content/images/size/w600/2016/09/loss_function_image_tumblr.png 600w, https://ruder.io/content/images/size/w1000/2016/09/loss_function_image_tumblr.png 1000w" src="https://ruder.io/content/images/size/w2000/2016/09/loss_function_image_tumblr.png" alt="" width="2000" height="1200"></figure>
    </header>
    <section class="gh-content gh-canvas">${prose(6, "gradient descent")}${figures}<h2>Gradient descent variants</h2>${prose(10, "batch gradient descent")}</section>
  </article></main></body></html>`;

describe("article head", () => {
  it("keeps the excerpt under the title and the feature image the page header holds (Ghost, ruder-optim)", () => {
    const { v2, markdown, rules } = normalize(ghostPage, "https://ruder.io/optimizing-gradient-descent/");
    const text = flowText(v2);
    expect(text).toContain(ghostExcerpt);
    expect(text).toContain("loss_function_image_tumblr");
    expect(text).not.toContain("profile.jpg");
    expect(text.indexOf(ghostExcerpt)).toBeLessThan(text.indexOf("loss_function_image_tumblr"));
    expect(text.indexOf("loss_function_image_tumblr")).toBeLessThan(text.indexOf("Substantive paragraph about gradient descent"));
    expect(markdown).toContain(ghostExcerpt);
    expect(rules).toContain("article.head.dek@1");
    expect(rules).toContain("article.head.lead-image@1");
  });

  it("keeps a Substack subtitle once, however many meta tags repeat it (acx-sleeper, oneusefulthing-centaurs)", () => {
    const subtitle = "I think we have an answer on whether AIs will reshape work....";
    const { v2 } = normalize(
      `<html><head><title>Centaurs and Cyborgs on the Jagged Frontier</title><meta name="description" content="${subtitle}"><meta property="og:description" content="${subtitle}"></head><body><article><div class="post-header"><h1 class="post-title published">Centaurs and Cyborgs on the Jagged Frontier</h1><h3 class="subtitle">${subtitle}</h3></div><div class="available-content"><div class="body markup">${prose(6)}<h1 class="header-anchor-post">Inside the Jagged Frontier</h1>${prose(8)}</div></div></article></body></html>`,
      "https://www.oneusefulthing.org/p/centaurs-and-cyborgs-on-the-jagged",
    );
    expect(flowText(v2).split("I think we have an answer").length - 1).toBe(1);
  });

  it("finds a dek that sits after the byline (Quanta) and one longer than the description it shortens (GitHub blog)", () => {
    const quantaDek = "It’s simple enough for AI to seem to comprehend data, but devising a true test of a machine’s knowledge has proved difficult.";
    const quanta = normalize(
      `<html><head><title>What Does It Mean for AI to Understand? | Quanta Magazine</title><meta name="description" content="${quantaDek}"></head><body><div class="post__title"><h1 class="post__title__title">What Does It Mean for AI to Understand?</h1><div class="byline"><em>By </em><a href="/authors/melanie-mitchell/">Melanie Mitchell</a></div><p><em>December 16, 2021</em></p><div class="post__title__meta"><div class="post__title__excerpt wysiwyg p italic"> ${quantaDek} </div></div></div><div class="post__content"><div class="post__content__section">${prose(12, "understanding")}</div></div></body></html>`,
      "https://www.quantamagazine.org/what-does-it-mean-for-ai-to-understand-20211216/",
    );
    expect(flowText(quanta.v2)).toContain("devising a true test of a machine’s knowledge");
    const githubDek = "GitHub Copilot is evolving to bring chat and voice interfaces, support pull requests, answer questions on docs, and adopt OpenAI’s GPT-4 for a more personalized developer experience.";
    const github = normalize(
      `<html><head><title>GitHub Copilot X: The AI-powered developer experience - The GitHub Blog</title><meta name="description" content="GitHub Copilot is evolving to bring chat and voice interfaces, support pull requests, answer questions, and adopt OpenAI's GPT-4."></head><body><main><header><h1 class="h2-mktg">GitHub Copilot X: The AI-powered developer experience</h1><div class="f4-mktg"> ${githubDek} </div></header><div class="post-content">${prose(12, "Copilot")}</div></main></body></html>`,
      "https://github.blog/2023-03-22-github-copilot-x-the-ai-powered-developer-experience/",
    );
    expect(flowText(github.v2)).toContain("for a more personalized developer experience");
  });

  it("keeps a hero image whose alt is the title, before the page's only <article> (anthropic-mapping)", () => {
    const title = "Mapping the mind of a large language model";
    const { v2 } = normalize(
      `<html><head><title>${title} \\ Anthropic</title><meta property="og:image" content="https://cdn.sanity.io/images/website/6ba0c700-1200x630.jpg"></head><body><div class="hero"><h1>${title}</h1><a href="https://transformer-circuits.pub/2024/scaling-monosemanticity/index.html">Read the paper</a></div><div class="illustrationHeroWrapper"><img alt="${title}" width="2000" height="1125" srcSet="/_next/image?url=https%3A%2F%2Fwww-cdn.anthropic.com%2Fimages%2F7cb91c3d-2000x1125.png&amp;w=2048&amp;q=75 1x" src="/_next/image?url=https%3A%2F%2Fwww-cdn.anthropic.com%2Fimages%2F7cb91c3d-2000x1125.png&amp;w=3840&amp;q=75"></div><div class="page-wrapper"><article>${prose(12, "interpretability")}</article></div></body></html>`,
      "https://www.anthropic.com/research/mapping-mind-language-model",
    );
    expect(flowText(v2)).toContain("7cb91c3d-2000x1125.png");
  });

  it("keeps a full-width cover image right under the post header (cloudflare-deploy-with-void)", () => {
    const { v2 } = normalize(
      `<html><head><title>Deploy with Void</title><meta property="og:image" content="https://blog.cloudflare.com/_emdash/api/media/file/01M4XWFPM5.png"></head><body><article><div class="post-content"><header><h1>Deploy with Void</h1><p>2026-10-02 · 6 min read</p></header><div class="mt-8 overflow-hidden rounded-md"><div class="pt-image-placeholder-frame pt-image-placeholder-frame--cover"><img src="https://blog.cloudflare.com/_image?href=https%3A%2F%2Fblog.cloudflare.com%2F_emdash%2Fapi%2Fmedia%2Ffile%2F01M4XW9N9B.png&amp;w=2400&amp;h=1350" class="pt-image-placeholder-media" width="2400" height="1350" alt=""></div></div><div class="post-body">${prose(12, "deploying")}</div></div></article></body></html>`,
      "https://blog.cloudflare.com/deploy-with-void/",
    );
    expect(flowText(v2)).toContain("01M4XW9N9B.png");
  });

  it("adds nothing when the head has no description match, only an avatar, or an image the body already shows", () => {
    const { v2, rules } = normalize(
      `<html><head><title>Notes</title><meta name="description" content="A blog about systems."><meta property="og:image" content="https://x.test/images/cover.png"></head><body><header class="post-header"><h1>Notes</h1><p class="tagline">Thoughts on compilers and other things I like</p><div class="author"><img src="https://x.test/avatar.png" alt="Jane Doe" width="64" height="64"> Jane Doe</div></header><article><p><img src="https://x.test/images/cover.png" alt="Cover"></p>${prose(12)}</article></body></html>`,
      "https://x.test/notes",
    );
    const text = flowText(v2);
    expect(text).not.toContain("Thoughts on compilers");
    expect(text).not.toContain("avatar.png");
    expect(text.split("cover.png").length - 1).toBe(1);
    expect(rules).not.toContain("article.head.dek@1");
    expect(rules).not.toContain("article.head.lead-image@1");
  });
});
