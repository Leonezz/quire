import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeArticleCapture } from "./article";

const prose = (n: number) => `<p>${"Substantive paragraph about the topic at hand, with enough words to read as prose. ".repeat(n)}</p>`;

function normalize(html: string, url: string) {
  const bytes = new TextEncoder().encode(html);
  const result = normalizeArticleCapture({
    budget: { maxBytes: 8e6, maxDepth: 100, maxNodes: 100000, maxOutputBytes: 8e6 },
    capture: { baseLocator: url, bytes, contentIdentity: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, mediaType: "text/html" },
  });
  if (!result.ok) throw new Error(`normalization failed: ${result.problems.map((p) => p.code).join(", ")}`);
  return result.article;
}

describe("article dates", () => {
  it("reads a date written right after the byline in the same header line (PyTorch blog)", () => {
    const article = normalize(
      `<html><head><title>Accelerating Generative AI</title></head><body><article><h1>Accelerating Generative AI</h1><div class="meta"><span class="meta-author"><span class="fn"><span>By</span> <a href="#" rel="author">PyTorch Foundation</a></span></span><span class="meta-date date published">November 30, 2023</span></div>${prose(12)}</article></body></html>`,
      "https://pytorch.org/blog/accelerating-generative-ai-2/",
    );
    expect(article.publishedAt).toBe("2023-11-30T00:00:00.000Z");
  });

  it("reads a date in a block that follows the title block without a space between them (Kent C. Dodds, Josh Comeau)", () => {
    const kent = normalize(
      `<html><head><title>How to use React Context effectively</title></head><body><main><h2>How to use React Context effectively</h2><p>June 5th, 2021 — 11 min read</p>${prose(12)}</main></body></html>`,
      "https://kentcdodds.com/blog/how-to-use-react-context-effectively",
    );
    expect(kent.publishedAt).toBe("2021-06-05T00:00:00.000Z");
    const josh = normalize(
      `<html><head><title>Why React Re-Renders</title></head><body><main><h1>Why React Re-Renders</h1><dl><dt>Filed under</dt><dd><a href="/react/">React</a></dd><dt>on</dt><dd>August 16th, 2022<span>.</span></dd></dl>${prose(12)}</main></body></html>`,
      "https://www.joshwcomeau.com/react/why-react-re-renders/",
    );
    expect(josh.publishedAt).toBe("2022-08-16T00:00:00.000Z");
  });

  it("reads <time dateTime> as React writes it (LessWrong)", () => {
    const article = normalize(
      `<html><head><title>AGI Ruin</title></head><body><main><h1>AGI Ruin</h1><div class="LWPostsPageHeader-date"><time dateTime="2022-06-05T22:05:52.224Z">5th Jun 2022</time></div>${prose(12)}</main></body></html>`,
      "https://www.lesswrong.com/posts/uMQ3cqWDPHhjtiesc/agi-ruin-a-list-of-lethalities",
    );
    expect(article.publishedAt).toBe("2022-06-05T22:05:52.224Z");
  });

  it("prefers the declared date the page also shows over a later republication date (Medium SocialMediaPosting)", () => {
    const jsonLd = JSON.stringify({ "@context": "http://schema.org", "@type": "SocialMediaPosting", datePublished: "2017-11-11T21:37:41.022Z", author: { "@type": "Person", name: "Andrej Karpathy" } });
    const article = normalize(
      `<html><head><title>Software 2.0</title><meta property="article:published_time" content="2021-03-13T18:18:43.264Z"><script type="application/ld+json">${jsonLd}</script></head><body><article><h1>Software 2.0</h1><p><span>Andrej Karpathy</span><span>Nov 11, 2017</span></p>${prose(12)}</article></body></html>`,
      "https://karpathy.medium.com/software-2-0-a64152b37c35",
    );
    expect(article.publishedAt).toBe("2017-11-11T21:37:41.022Z");
  });

  it("reads a month-and-year date at the top of an essay (Paul Graham)", () => {
    const article = normalize(
      `<html><head><title>How to Do Great Work</title></head><body><table><tr><td><font size="2" face="verdana">July 2023<br><br>${"If you collected lists of techniques for doing great work in a lot of different fields, what would the intersection look like? ".repeat(8)}<br><br>${"I decided to find out by making it. ".repeat(10)}</font></td></tr></table></body></html>`,
      "https://paulgraham.com/greatwork.html",
    );
    expect(article.publishedAt).toBe("2023-07-01T00:00:00.000Z");
  });
});

describe("article bylines", () => {
  it("reads the name in an author block whose other text is icon links (web.dev)", () => {
    const article = normalize(
      `<html><head><title>Web Vitals | Articles | web.dev</title></head><body><article><h1>Web Vitals</h1><div class="wd-authors"><div class="wd-author"><img alt="Philip Walton" src="https://web.dev/images/authors/philipwalton.jpg"><div><span> Philip Walton </span><div class="wd-author__links"><a href="https://twitter.com/philwalton" aria-label="Philip Walton on X" rel="me"><svg><title>X</title></svg></a><a href="https://github.com/philipwalton" rel="me"><svg><title>GitHub</title></svg></a></div></div></div></div>${prose(12)}</article></body></html>`,
      "https://web.dev/articles/vitals",
    );
    expect(article.byline).toBe("Philip Walton");
  });

  it("reads the authors of an arXiv HTML paper (LaTeXML)", () => {
    const author = (name: string) => `<span class="ltx_creator ltx_role_author"><span class="ltx_personname">${name} </span><span class="ltx_author_notes"><span class="ltx_contact ltx_role_affiliation"><span class="ltx_contact_name">Affiliation: </span>StepFun</span></span></span><span class="ltx_author_before"> </span>`;
    const article = normalize(
      `<html><head><title>onPanda</title></head><body><article class="ltx_document"><h1 class="ltx_title ltx_title_document">onPanda</h1><div class="ltx_authors">${["Lei Yang", "Mengyin Liu", "Jia Wang"].map(author).join("")}</div>${prose(12)}</article></body></html>`,
      "https://arxiv.org/html/2609.24983v1",
    );
    expect(article.byline).toBe("Lei Yang, Mengyin Liu, Jia Wang");
  });
});

describe("article titles", () => {
  it("keeps a short title whose h1 links to the article itself (Bartosz Ciechanowski)", () => {
    const article = normalize(
      `<html><head><title>GPS – Bartosz Ciechanowski</title><meta name="author" content="Bartosz Ciechanowski"></head><body><article><h1><a href="https://ciechanowski.com/gps/">GPS</a></h1><p>January 18, 2022</p>${prose(12)}</article></body></html>`,
      "https://ciechanowski.com/gps/",
    );
    expect(article.title).toBe("GPS");
  });

  it("does not take a section h1 inside the post for the title when the page's own title says otherwise (Embedded in Academia)", () => {
    const article = normalize(
      `<html><head><title>A Guide to Undefined Behavior in C and C++, Part 1 &#8211; Embedded in Academia</title></head><body><header><h1 class="wp-block-site-title"><a href="https://blog.regehr.org" rel="home">Embedded in Academia</a></h1></header><main><h1 class="wp-block-post-title">A Guide to Undefined Behavior in C and C++, Part 1</h1><div class="entry-content">${prose(8)}<h1>A Model for Undefined Behavior</h1>${prose(8)}<h1>Why Is Undefined Behavior Good?</h1>${prose(8)}</div></main></body></html>`,
      "https://blog.regehr.org/archives/213",
    );
    expect(article.title).toBe("A Guide to Undefined Behavior in C and C++, Part 1");
  });

  it("takes a numbered issue title from the page title when the only h1 is a late section (This Week in Rust)", () => {
    const article = normalize(
      `<html><head><title>This Week in Rust 673  · This Week in Rust\n</title></head><body><header class="site-header"><a class="site-title" href="https://this-week-in-rust.org/">This Week in Rust</a></header><div class="post"><header class="post-header"><time datetime="2026-10-14T00:00:00-04:00">14 OCT 2026</time><a href="https://this-week-in-rust.org/blog/2026/10/14/this-week-in-rust-673/">This Week in Rust 673</a></header><article class="post-content">${prose(6)}<h2 id="updates"><a class="toclink" href="#updates">Updates from Rust Community</a></h2>${prose(10)}<h2 id="jobs"><a class="toclink" href="#jobs">Jobs</a></h2>${prose(4)}<h1 id="quote-of-the-week"><a class="toclink" href="#quote-of-the-week">Quote of the Week</a></h1><blockquote><p>A quote.</p></blockquote>${prose(2)}</article></div></body></html>`,
      "https://this-week-in-rust.org/blog/2026/10/14/this-week-in-rust-673/",
    );
    expect(article.title).toBe("This Week in Rust 673");
  });
});
