import { createHash } from "node:crypto";

import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";

import { normalizeArticleCapture, normalizeFeedCapture } from "./module";
import {
  applyArticleSiteAdapter,
  articleSiteAdapterRule,
} from "./article-site-adapters";
import { readerDocumentSchema } from "./reader-document-contract";
import { readerDocumentV2Schema } from "./reader-document-v2-contract";
import { readerDocumentV2FromHtml } from "./reader-document-v2";
import { parseXmlDocument, rawText } from "./xml";

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function capture(xml: string, baseLocator = "https://example.test/feed.xml") {
  return {
    budget: {
      maxBytes: 1024 * 1024,
      maxDepth: 40,
      maxEntries: 100,
      maxEntryOutputBytes: 512 * 1024,
      maxNodes: 10_000,
      maxTotalOutputBytes: 4 * 1024 * 1024,
    },
    capture: {
      baseLocator,
      bytes: new TextEncoder().encode(xml),
      contentIdentity: sha256(xml),
      mediaType: "application/rss+xml",
    },
  } as const;
}

function articleCapture(
  html: string,
  baseLocator = "https://example.test/research/result",
) {
  return articleByteCapture(
    new TextEncoder().encode(html),
    "text/html",
    baseLocator,
  );
}

function articleByteCapture(
  bytes: Uint8Array,
  mediaType: string,
  baseLocator = "https://example.test/research/result",
) {
  return {
    budget: {
      maxBytes: 1024 * 1024,
      maxDepth: 40,
      maxNodes: 10_000,
      maxOutputBytes: 2 * 1024 * 1024,
    },
    capture: {
      baseLocator,
      bytes,
      contentIdentity: sha256(bytes),
      mediaType,
    },
  } as const;
}

function windows1252Bytes(value: string) {
  return Uint8Array.from(
    Array.from(value, (character) => {
      if (character === "“") return 0x93;
      if (character === "”") return 0x94;
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint > 0x7f)
        throw new Error(
          `Test fixture is not Windows-1252 ASCII-plus-quotes: ${character}`,
        );
      return codePoint;
    }),
  );
}

describe("ContentNormalizationModule", () => {
  it("decodes XML character references in feed metadata exactly once", () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <title>C&#43;&#43; &amp; systems</title>
          <item>
            <guid isPermaLink="false">entity-entry</guid>
            <title>C&#x2b;&#43;26 &amp;#43;</title>
            <description><![CDATA[<p>Readable body.</p>]]></description>
          </item>
        </channel>
      </rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.title).toBe("C++ & systems");
    expect(result.feed.entries[0].title).toBe("C++26 &#43;");
  });

  it("accepts large valid feeds with more than 1024 predefined XML references", () => {
    const repeated = "Research &amp; evidence. ".repeat(1_100);
    const xml = `<rss version="2.0"><channel><title>Large feed</title><item><guid>large-entry</guid><title>Large entry</title><description>${repeated}</description></item></channel></rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.feed.entries[0].materialization.representations.find(
        (value) => value.schema === "selection.text.v1",
      )?.content,
    ).toContain("Research & evidence.");
  });

  it("keeps CDATA character references literal at the XML layer", () => {
    const root = parseXmlDocument(
      "<root><![CDATA[C&#43; &amp;]]></root>",
      { maxDepth: 10, maxNodes: 10 },
    );

    expect(rawText(root)).toBe("C&#43; &amp;");
  });

  it("decodes character references in Atom link attributes before resolving them", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <title>Feed</title><id>https://example.test/feed</id><updated>2026-08-29T00:00:00Z</updated>
      <author><name>Researcher</name></author>
      <entry><title>Entry</title><id>https://example.test/entry</id><updated>2026-08-29T00:00:00Z</updated>
        <link href="posts&#47;x?x=1&amp;y=2"/><summary>Readable body.</summary>
      </entry>
    </feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].link).toBe(
      "https://example.test/posts/x?x=1&y=2",
    );
  });

  it.each([
    [
      "an undeclared named entity",
      "<root>&bogus;</root>",
      "SOURCE_XML_ENTITY_INVALID",
    ],
    [
      "a null character reference",
      "<root>&#0;</root>",
      "SOURCE_XML_ENTITY_INVALID",
    ],
    [
      "a surrogate character reference",
      "<root>&#xD800;</root>",
      "SOURCE_XML_ENTITY_INVALID",
    ],
    [
      "a literal null in text",
      "<root>\u0000</root>",
      "SOURCE_XML_CHARACTER_INVALID",
    ],
    [
      "a literal control in CDATA",
      "<root><![CDATA[\u0001]]></root>",
      "SOURCE_XML_CHARACTER_INVALID",
    ],
  ])("rejects %s", (_label, xml, code) => {
    expect(() =>
      parseXmlDocument(xml, { maxDepth: 10, maxNodes: 10 }),
    ).toThrow(code);
  });

  it("preserves mixed prose while extracting TeX environments and conservative dollar math", () => {
    const result = readerDocumentV2FromHtml({
      baseUri: "https://example.test/article",
      html: `<p>模型如下：<br />
        \\begin{equation}\\begin{aligned}<br />
        M_t &amp;= \\beta M_{t-1} \\\\[4pt]<br />
        W_t &amp;= \\phi(W_{t-1}, M_t)<br />
        \\end{aligned}\\end{equation}<br />
        更新函数$\\phi$与$x^2$需要保留；价格 $20 and $30 不是公式。</p>`,
      maxDepth: 40,
      maxNodes: 10_000,
      maxOutputBytes: 2 * 1024 * 1024,
      outputBudgetErrorCode: "SOURCE_ARTICLE_OUTPUT_BUDGET_EXCEEDED",
    });

    expect(result.document.children).toEqual([
      {
        children: [{ type: "text", value: "模型如下：" }],
        type: "paragraph",
      },
      expect.objectContaining({
        display: true,
        format: "tex",
        type: "math",
        value: expect.stringContaining("\\begin{equation}"),
      }),
      expect.objectContaining({
        children: expect.arrayContaining([
          expect.objectContaining({
            display: false,
            format: "tex",
            type: "math",
            value: "\\phi",
          }),
          expect.objectContaining({
            display: false,
            format: "tex",
            type: "math",
            value: "x^2",
          }),
          expect.objectContaining({
            type: "text",
            value: expect.stringContaining("价格 $20 and $30 不是公式。"),
          }),
        ]),
        type: "paragraph",
      }),
    ]);
    const displayMath = result.document.children[1];
    expect(displayMath?.type === "math" ? displayMath.value : "").toContain(
      "\\end{aligned}\\end{equation}",
    );
    expect(displayMath?.type === "math" ? displayMath.value : "").toContain(
      "\n",
    );
  });

  it("preserves canonical section and heading anchors for structured specifications", () => {
    const result = readerDocumentV2FromHtml({
      baseUri: "https://www.rfc-editor.org/rfc/rfc9110.html",
      html: `<section id="section-7.1">
        <h2 id="section-7.1-1">7.1. Field Lines</h2>
        <p id="section-7.1-2">See <a href="#section-7.1-1">the definition</a>
          or <a href="https://www.rfc-editor.org/rfc/rfc9110.html#section-7.1-1">the canonical target</a>.</p>
      </section>`,
      maxDepth: 40,
      maxNodes: 10_000,
      maxOutputBytes: 2 * 1024 * 1024,
      outputBudgetErrorCode: "SOURCE_ARTICLE_OUTPUT_BUDGET_EXCEEDED",
    });

    expect(result.document.children).toContainEqual({
      anchor: "section-7.1",
      children: expect.arrayContaining([
        expect.objectContaining({
          anchor: "section-7.1-1",
          depth: 2,
          type: "heading",
        }),
        expect.objectContaining({
          children: expect.arrayContaining([
            expect.objectContaining({
              targetAnchor: "section-7.1-1",
              type: "link",
            }),
          ]),
          type: "paragraph",
        }),
      ]),
      type: "section",
    });
    expect(
      JSON.stringify(result.document).match(
        /"targetAnchor":"section-7\.1-1"/gu,
      ),
    ).toHaveLength(2);
  });

  it("extracts TeX environments from generic flow containers", () => {
    const result = readerDocumentV2FromHtml({
      html: `<div>Before<br>\\begin{align*}x &amp;= y<br>z &amp;= 1\\end{align*}<br>After</div>`,
      maxDepth: 40,
      maxNodes: 10_000,
      maxOutputBytes: 2 * 1024 * 1024,
      outputBudgetErrorCode: "SOURCE_ARTICLE_OUTPUT_BUDGET_EXCEEDED",
    });

    expect(result.document.children).toEqual([
      { children: [{ type: "text", value: "Before" }], type: "paragraph" },
      expect.objectContaining({
        display: true,
        type: "math",
        value: "\\begin{align*}x &= y\nz &= 1\\end{align*}",
      }),
      { children: [{ type: "text", value: "After" }], type: "paragraph" },
    ]);
  });

  it("does not mistake currency, malformed delimiters, or escaped TeX environments for math", () => {
    const result = readerDocumentV2FromHtml({
      html: `<p>Math $x^2$ and $x + \\$5$. Currency $20 and $30, $20$, $20/$year, shell $PATH/$HOME, $ x$, $x $, $x$2, and inline $$x$$ stay prose.</p>
        <p>\\\\begin{equation}literal\\\\end{equation}</p>`,
      maxDepth: 40,
      maxNodes: 10_000,
      maxOutputBytes: 2 * 1024 * 1024,
      outputBudgetErrorCode: "SOURCE_ARTICLE_OUTPUT_BUDGET_EXCEEDED",
    });

    const firstParagraph = result.document.children[0];
    expect(firstParagraph).toMatchObject({ type: "paragraph" });
    expect(
      firstParagraph?.type === "paragraph"
        ? firstParagraph.children.filter((node) => node.type === "math")
        : [],
    ).toEqual([
      expect.objectContaining({ type: "math", value: "x^2" }),
      expect.objectContaining({ type: "math", value: "x + \\$5" }),
    ]);
    expect(result.document.children).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ display: true, type: "math" }),
      ]),
    );
    expect(JSON.stringify(result.document)).toContain("Currency $20 and $30");
    expect(JSON.stringify(result.document)).toContain("$20/$year, shell $PATH/$HOME");
    expect(JSON.stringify(result.document)).toContain("\\\\begin{equation}literal");
  });

  it("scans a large stream of unmatched TeX tokens without repeating bounded searches", () => {
    const unmatchedTokens = [
      "\\(".repeat(8_000),
      "\\[".repeat(8_000),
      "\\begin{equation}".repeat(2_000),
    ].join(" ");
    const html = `<article><h1>Bounded math scan</h1><p>${unmatchedTokens}${"x".repeat(4_000)} \\(x^2\\)</p></article>`;

    const result = normalizeArticleCapture(articleCapture(html));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const readerV2 = result.article.materialization.representations.find(
      (value) => value.schema === "reader.document.v2",
    );
    expect(readerV2).toBeDefined();
    expect(JSON.parse(readerV2?.content ?? "{}")).toEqual(
      expect.objectContaining({ children: expect.any(Array) }),
    );
  }, 10_000);

  it("keeps figure body content as adjacent flow when it is not media or caption", () => {
    const result = readerDocumentV2FromHtml({
      baseUri: "https://example.test/article",
      html: `<figure><img src="/plot.png" alt="Latency plot"><p>Method detail stays readable.</p><figcaption>Latency by batch.</figcaption></figure>`,
      maxDepth: 40,
      maxNodes: 10_000,
      maxOutputBytes: 2 * 1024 * 1024,
      outputBudgetErrorCode: "SOURCE_ARTICLE_OUTPUT_BUDGET_EXCEEDED",
    });

    expect(result.document.children).toEqual([
      expect.objectContaining({
        caption: [{ type: "text", value: "Latency by batch." }],
        type: "figure",
      }),
      {
        children: [{ type: "text", value: "Method detail stays readable." }],
        type: "paragraph",
      },
    ]);
    expect(result.document.losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "FIGURE_CONTENT_FLATTENED",
          fallback: "children",
          sourceTag: "figure",
        }),
      ]),
    );
  });

  it("keeps the alt fallback for a rejected image beside supported figure media", () => {
    const result = readerDocumentV2FromHtml({
      baseUri: "https://example.test/article",
      html: `<figure><img src="/plot.png" alt="Latency plot"><img src="javascript:alert(1)" alt="Unavailable appendix plot"><figcaption>Latency by batch.</figcaption></figure>`,
      maxDepth: 40,
      maxNodes: 10_000,
      maxOutputBytes: 2 * 1024 * 1024,
      outputBudgetErrorCode: "SOURCE_ARTICLE_OUTPUT_BUDGET_EXCEEDED",
    });

    expect(result.document.children).toEqual([
      expect.objectContaining({
        caption: [{ type: "text", value: "Latency by batch." }],
        media: [expect.objectContaining({ alt: "Latency plot", type: "image" })],
        type: "figure",
      }),
      {
        children: [{ type: "text", value: "Unavailable appendix plot" }],
        type: "paragraph",
      },
    ]);
    expect(result.document.losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNSAFE_IMAGE_DROPPED",
          fallback: "text",
        }),
      ]),
    );
  });

  it("preserves MathML multiscript structure instead of flattening prescripts", () => {
    const result = readerDocumentV2FromHtml({
      html: `<math display="block"><mmultiscripts><mi>A</mi><mi>i</mi><none></none><mprescripts><mi>j</mi><none></none></mprescripts></mmultiscripts></math>`,
      maxDepth: 40,
      maxNodes: 10_000,
      maxOutputBytes: 2 * 1024 * 1024,
      outputBudgetErrorCode: "SOURCE_ARTICLE_OUTPUT_BUDGET_EXCEEDED",
    });

    const math = result.document.children.find((node) => node.type === "math");
    expect(math).toMatchObject({
      display: true,
      format: "mathml",
      type: "math",
    });
    expect(math?.type === "math" ? math.value : "").toContain(
      "<mmultiscripts>",
    );
    expect(math?.type === "math" ? math.value : "").toContain("<mprescripts>");
    expect(math?.type === "math" ? math.value : "").toContain("<none>");
  });

  it("maps a direct doc-noteref anchor to a navigable footnote reference", () => {
    const result = readerDocumentV2FromHtml({
      html: `<p>Prior work<a role="doc-noteref" href="#fn1">1</a>.</p><section role="doc-endnotes"><ol><li id="fn1"><p>Prior work details.</p></li></ol></section>`,
      maxDepth: 40,
      maxNodes: 10_000,
      maxOutputBytes: 2 * 1024 * 1024,
      outputBudgetErrorCode: "SOURCE_ARTICLE_OUTPUT_BUDGET_EXCEEDED",
    });

    expect(result.document.children).toEqual([
      {
        children: [
          { type: "text", value: "Prior work" },
          { identifier: "1", label: "1", type: "footnoteReference" },
          { type: "text", value: "." },
        ],
        type: "paragraph",
      },
      {
        children: [
          {
            children: [{ type: "text", value: "Prior work details." }],
            type: "paragraph",
          },
        ],
        identifier: "1",
        label: "1",
        type: "footnoteDefinition",
      },
    ]);
  });

  it("accepts a bounded article when a malformed TOC leaves a stray list item", () => {
    const body =
      "The article records an implementation detail and keeps the evidence available for review. ".repeat(
        8,
      );
    const html = `<!doctype html><html><body>
      <aside><div class="post-toc"><ol>
        <li><a href="#atomic">atomic</a></li>
        <li><a href="#memory-order">memory order</a></li>
      </ol></li><li><a href="#references">References</a></div></aside>
      <main><article><h1>Atomic operations</h1><p>${body}</p><h2 id="atomic">atomic</h2><p>${body}</p></article></main>
    </body></html>`;

    const result = normalizeArticleCapture(articleCapture(html));

    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it("extracts a cluttered rich webpage with Defuddle and normalizes the candidate through Reader v2", () => {
    const substantialBody =
      "The experiment compares deterministic schedulers under bursty load and records every input, runtime parameter, and observed latency. ".repeat(
        8,
      );
    const html = `<!doctype html>
      <html lang="en" dir="ltr">
        <head>
          <title>Navigation title</title>
          <meta name="author" content="Ada Researcher" />
          <meta property="article:published_time" content="2026-08-20T09:30:00Z" />
        </head>
        <body>
          <nav>Products Pricing Subscribe Sign in</nav>
          <main>
            <article>
              <h1>Deterministic scheduling under bursty load</h1>
              <p>${substantialBody}</p>
              <h2>Method</h2>
              <figure><img src="/latency.png" alt="Latency curve" /><figcaption>Latency across batches.</figcaption></figure>
              <pre><code class="language-rust">fn sample() -&gt; usize { 32 }</code></pre>
              <p>We optimize <span class="math inline">\\(L = p99(x)\\)</span>.</p>
              <table><caption>Results</caption><thead><tr><th scope="col">Batch</th><th scope="col">Latency</th></tr></thead><tbody><tr><td>32</td><td>18 ms</td></tr></tbody></table>
              <p>Hardware details<sup id="fnref-1"><a href="#fn-1" role="doc-noteref">1</a></sup>.</p>
              <section class="footnotes" role="doc-endnotes"><ol><li id="fn-1"><p>A100, CUDA 13.</p></li></ol></section>
            </article>
          </main>
          <aside>Related products and newsletter signup</aside>
          <script>globalThis.compromised = true</script>
        </body>
      </html>`;

    const result = normalizeArticleCapture(articleCapture(html));

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.article).toMatchObject({
      byline: "Ada Researcher",
      dir: "ltr",
      lang: "en",
      publishedAt: "2026-08-20T09:30:00.000Z",
      source: "https://example.test/research/result",
      sourceFingerprint: sha256(html),
      title: "Deterministic scheduling under bursty load",
    });
    expect(
      result.article.materialization.provenance.selectedCandidate,
    ).toMatchObject({
      mediaType: "text/html",
      role: "full",
      sourcePath: "article.extractor.defuddle",
    });
    const readerV2 = result.article.materialization.representations.find(
      (value) => value.schema === "reader.document.v2",
    );
    expect(readerV2).toBeDefined();
    const document = JSON.parse(readerV2?.content ?? "{}");
    const serializedDocument = JSON.stringify(document);
    expect(serializedDocument).toContain("Latency across batches.");
    expect(serializedDocument).toContain('\"type\":\"figure\"');
    expect(serializedDocument).toContain('\"type\":\"math\"');
    expect(serializedDocument).toContain('\"type\":\"table\"');
    expect(serializedDocument).toContain('\"type\":\"footnoteReference\"');
    expect(serializedDocument).toContain('\"type\":\"footnoteDefinition\"');
    expect(serializedDocument).toContain("https://example.test/latency.png");
    expect(document.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lang: "rust", type: "code" }),
        expect.objectContaining({
          children: [{ type: "text", value: "Method" }],
          depth: 2,
          type: "heading",
        }),
      ]),
    );
    expect(document.children).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          children: [
            {
              type: "text",
              value: "Deterministic scheduling under bursty load",
            },
          ],
          type: "heading",
        }),
      ]),
    );
    expect(document.losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DUPLICATE_PAGE_TITLE_REMOVED",
          sourceTag: "h1",
        }),
      ]),
    );
    expect(readerDocumentV2Schema.safeParse(document).success).toBe(true);
    expect(result.article.materialization.provenance.rulesApplied).toContain(
      "generic.remove-duplicate-page-title",
    );
    expect(readerV2?.content).not.toContain("newsletter signup");
    expect(readerV2?.content).not.toContain("compromised");
  });

  it("normalizes syntax highlighter tables into fenced code without consuming line-number gutters", () => {
    const substantialBody =
      "The article explains the synchronization contract, the ownership invariant, and the observable behavior under contention. ".repeat(
        8,
      );
    const html = `<!doctype html><html lang="zh-CN"><body><main><article>
      <h1>Condition variable and synchronization</h1>
      <p>${substantialBody}</p>
      <figure class="highlight cpp"><table><tbody><tr>
        <td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span></pre></td>
        <td class="code"><pre><span class="line"><span class="keyword">template</span> &lt;<span class="keyword">class</span> T&gt;</span><br><span class="line"><span class="keyword">class</span> SharedQueue {</span><br><span class="line">&nbsp; <span class="keyword">void</span> push();</span><br><span class="line">};</span></pre></td>
      </tr></tbody></table></figure>
      <table><caption>Measurements</caption><thead><tr><th>Workers</th><th>Latency</th></tr></thead><tbody><tr><td>4</td><td>12 ms</td></tr></tbody></table>
      <p>${substantialBody}</p>
    </article></main></body></html>`;

    const result = normalizeArticleCapture(
      articleCapture(
        html,
        "https://blog.example.test/condition-variable-and-synchronization/",
      ),
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const readerV2 = result.article.materialization.representations.find(
      (value) => value.schema === "reader.document.v2",
    );
    const readerV1 = result.article.materialization.representations.find(
      (value) => value.schema === "reader.document.v1",
    );
    const agent = result.article.materialization.representations.find(
      (value) => value.schema === "agent.gfm.v1",
    );
    const document = JSON.parse(readerV2?.content ?? "{}");
    const compatibilityDocument = JSON.parse(readerV1?.content ?? "{}");
    const expectedCode =
      "template <class T>\nclass SharedQueue {\n  void push();\n};";

    expect(document.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lang: "cpp",
          type: "code",
          value: expectedCode,
        }),
        expect.objectContaining({ type: "table" }),
      ]),
    );
    expect(
      document.children.filter(
        (node: { type: string }) => node.type === "table",
      ),
    ).toHaveLength(1);
    expect(readerV2?.content).not.toContain("1234");
    expect(compatibilityDocument.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lang: "cpp",
          type: "code",
          value: expectedCode,
        }),
      ]),
    );
    expect(JSON.stringify(compatibilityDocument)).not.toContain("1234");
    expect(agent?.content).toContain(`\`\`\`cpp\n${expectedCode}\n\`\`\``);
    expect(agent?.content).not.toContain("1234");
    expect(result.article.materialization.provenance.rulesApplied).toContain(
      "generic.syntax-highlight-table-to-code@1",
    );
  });

  it("keeps Typecho article content and math while excluding page chrome from every representation", () => {
    const substantialBody =
      "The study compares momentum updates at the feature level and preserves the derivation as reviewable research evidence. ".repeat(
        8,
      );
    const html = String.raw`<!doctype html>
      <html lang="zh-CN">
        <head>
          <title>动量的新理解：逼近特征层面的梯度下降</title>
          <meta name="generator" content="Typecho 1.1/17.10.30" />
        </head>
        <body>
          <div id="MobileSideBar">
            <nav><a href="/search">SEARCH</a><a href="/menu">MENU</a></nav>
          </div>
          <main>
            <div id="PostContent" class="PostContent">
              <h1>动量的新理解：逼近特征层面的梯度下降</h1>
              <p>${substantialBody}</p>
              <h2>问题回顾</h2>
              <p>一个以动量为状态变量的优化器，基本形式如下：</p>
              <div class="equation">
                \begin{equation}\begin{aligned}<br />
                M_t &amp;= \beta M_{t-1} + (1 - \beta)G_t \\[4pt]<br />
                W_t &amp;= \phi(W_{t-1}, M_t, G_t, t)<br />
                \end{aligned}\end{equation}
              </div>
              <p>该公式必须与正文一起保留下来，供后续阅读、摘录和引用。</p>
            </div>
          </main>
          <aside>COMMENTS USERLOGIN unrelated malformed delimiter \]</aside>
        </body>
      </html>`;

    const result = normalizeArticleCapture(
      articleCapture(html, "https://kexue.test/archives/11875"),
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.article.title).toBe("动量的新理解：逼近特征层面的梯度下降");
    const readerV2 = result.article.materialization.representations.find(
      (value) => value.schema === "reader.document.v2",
    );
    expect(readerV2).toBeDefined();
    const document = JSON.parse(readerV2?.content ?? "{}");
    expect(JSON.stringify(document.children)).toContain(
      "The study compares momentum updates at the feature level",
    );
    expect(document.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          display: true,
          type: "math",
          value: expect.stringContaining("\\begin{equation}"),
        }),
      ]),
    );
    for (const representation of result.article.materialization
      .representations) {
      expect(representation.content).not.toMatch(/MobileSideBar|SEARCH|MENU/u);
    }
  });

  describe("Kexue Typecho article site adapter", () => {
    const typechoHtml = String.raw`<!doctype html>
      <html>
        <head><meta name="generator" content="Typecho 1.2.1" /></head>
        <body>
          <main>
            <div id="PostContent">
              <h1>Adapter boundary</h1>
              <div id="content_tips">Reader chrome</div>
              <p>Article evidence remains available for later research.</p>
              <pre><code>const retained = true;</code></pre>
              <div class="equation">\[x^2 + y^2 = z^2\]</div>
              <img src="/evidence.png" alt="Evidence" />
              <aside id="pay">Payment prompt</aside>
              <section id="how_to_cite">Cite this article as Kexue (2026).</section>
            </div>
          </main>
        </body>
      </html>`;

    function siteDocument(html = typechoHtml) {
      return parseHTML(html).document;
    }

    it("returns a deterministic, versioned cleanup without mutating the captured document", () => {
      const document = siteDocument();
      const before = document.toString();
      const first = applyArticleSiteAdapter({
        document,
        source: new URL("https://kexue.fm/archives/11875"),
      });
      const second = applyArticleSiteAdapter({
        document,
        source: new URL("https://kexue.fm/archives/11875"),
      });

      expect(first).toMatchObject({
        key: "typecho-kexue",
        version: "1",
      });
      expect(Object.keys(first ?? {}).sort()).toEqual([
        "content",
        "key",
        "version",
      ]);
      expect(first ? articleSiteAdapterRule(first) : "").toBe(
        "article.site-adapter.typecho-kexue@1",
      );
      expect(first).toEqual(second);
      expect(first?.content).toContain("Article evidence remains");
      expect(first?.content).toContain("const retained = true;");
      expect(first?.content).toContain("x^2 + y^2 = z^2");
      expect(first?.content).toContain("/evidence.png");
      expect(first?.content).toContain("Cite this article as Kexue");
      expect(first?.content).not.toMatch(
        /content_tips|Payment prompt|id="pay"/u,
      );
      expect(document.toString()).toBe(before);
      expect(sha256(JSON.stringify(first))).toBe(
        sha256(JSON.stringify(second)),
      );
    });

    it("does not match a lookalike host", () => {
      expect(
        applyArticleSiteAdapter({
          document: siteDocument(),
          source: new URL("https://kexue.fm.example.test/archives/11875"),
        }),
      ).toBeUndefined();
    });

    it("fails closed when PostContent is ambiguous", () => {
      const document = siteDocument(
        typechoHtml.replace(
          "</main>",
          '<div id="PostContent"><p>Injected duplicate.</p></div></main>',
        ),
      );
      const before = document.toString();

      expect(
        applyArticleSiteAdapter({
          document,
          source: new URL("https://www.kexue.fm/archives/11875"),
        }),
      ).toBeUndefined();
      expect(document.toString()).toBe(before);
    });

    it("records the adapter rule when the normalized article uses the cleanup", () => {
      const result = normalizeArticleCapture(
        articleCapture(typechoHtml, "https://kexue.fm/archives/11875"),
      );

      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.article.materialization.provenance.rulesApplied).toContain(
        "article.site-adapter.typecho-kexue@1",
      );
      for (const representation of result.article.materialization
        .representations) {
        expect(representation.content).not.toMatch(
          /content_tips|Payment prompt/u,
        );
      }
    });
  });

  describe("RFC Editor xml2rfc article site adapter", () => {
    const officialRfcHtml = `<!doctype html><html lang="en"><head>
      <meta name="generator" content="xml2rfc 3.12.10">
      <meta name="rfc.number" content="9110">
      <title>RFC 9110: HTTP Semantics</title></head><body>
      <table class="ears"><tr><td>RFC 9110</td></tr></table>
      <div id="internal-metadata">Build metadata</div>
      <h1 id="rfcnum">RFC 9110</h1><h1 id="title">HTTP Semantics</h1>
      <div id="toc"><a href="#section-1">1. Introduction</a></div>
      <section id="section-1"><h2 id="name-introduction">1. Introduction</h2>
        <p>See <a href="https://www.rfc-editor.org/rfc/rfc9110.html#section-2">Section 2</a>.</p>
        <a class="pilcrow" href="#section-1">¶</a></section>
      <section id="section-2"><h2>2. Requirements</h2><p>${"Normative protocol text. ".repeat(12)}</p></section>
      <div class="docInfo">Generated by xml2rfc</div></body></html>`;

    it("selects the complete specification body while removing page chrome", () => {
      const document = parseHTML(officialRfcHtml).document;
      const application = applyArticleSiteAdapter({
        document,
        source: new URL("https://www.rfc-editor.org/rfc/rfc9110.html"),
      });

      expect(application?.key).toBe("rfc-editor-xml2rfc");
      expect(application ? articleSiteAdapterRule(application) : "").toBe(
        "article.site-adapter.rfc-editor-xml2rfc@1",
      );
      expect(application?.content).toContain("HTTP Semantics");
      expect(application?.content).toContain("Normative protocol text");
      expect(application?.content).not.toContain("Build metadata");
      expect(application?.content).not.toContain("1. Introduction</a></div>");
      expect(application?.content).not.toContain("class=\"pilcrow\"");
    });

    it("normalizes structural anchors and same-document references", () => {
      const result = normalizeArticleCapture(
        articleCapture(
          officialRfcHtml,
          "https://www.rfc-editor.org/rfc/rfc9110.html",
        ),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.article.materialization.provenance.rulesApplied).toContain(
        "article.site-adapter.rfc-editor-xml2rfc@1",
      );
      const reader = result.article.materialization.representations.find(
        (value) => value.schema === "reader.document.v2",
      );
      expect(reader?.content).toContain('"anchor":"section-1"');
      expect(reader?.content).toContain('"targetAnchor":"section-2"');
      expect(reader?.content).not.toContain("Generated by xml2rfc");
    });

    it("does not match an RFC-looking page without matching xml2rfc evidence", () => {
      const document = parseHTML(
        officialRfcHtml.replace("xml2rfc 3.12.10", "Example Generator"),
      ).document;
      expect(
        applyArticleSiteAdapter({
          document,
          source: new URL("https://www.rfc-editor.org/rfc/rfc9110.html"),
        }),
      ).toBeUndefined();
    });
  });

  it("falls back to Readability when the deterministic Defuddle quality gate rejects a short candidate", () => {
    const body =
      "A bounded comparison explains how immutable revisions preserve citations while a source changes. ".repeat(
        4,
      );
    const html = `<!doctype html><html lang="en"><head><title>Revision-aware evidence</title></head><body><header>Site navigation</header><article><h1>Revision-aware evidence</h1><h2>Context</h2><p>${body}</p><h3>Implications</h3></article><footer>Subscribe</footer></body></html>`;

    const result = normalizeArticleCapture(articleCapture(html));

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(
      result.article.materialization.provenance.selectedCandidate.sourcePath,
    ).toBe("article.extractor.readability");
    expect(result.article.materialization.provenance.rulesApplied).toContain(
      "article.extractor.semantic-boundary.v1",
    );
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_ARTICLE_DEFUDDLE_QUALITY_LOW",
        }),
      ]),
    );
    expect(
      result.article.materialization.representations.find(
        (value) => value.schema === "selection.text.v1",
      )?.content,
    ).toContain("immutable revisions preserve citations");
  });

  it("uses a bounded semantic article root when generic extractors drop rich content", () => {
    const html = `<!doctype html><html><body><nav>GLOBAL_NAV_CHROME Subscribe Sign in</nav><aside>OUTER_SIDEBAR_CHROME Related posts</aside><main><article><h1>T</h1><p>${"Main content evidence ".repeat(15)}</p><details><summary>Data</summary><table><tr><td>A</td></tr></table></details></article></main><footer>OUTER_FOOTER_CHROME Newsletter</footer></body></html>`;

    const result = normalizeArticleCapture(articleCapture(html));

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(
      result.article.materialization.provenance.selectedCandidate.sourcePath,
    ).toBe("article.extractor.semantic-root");
    expect(result.article.materialization.provenance.rulesApplied).toContain(
      "article.extractor.structure-retention.v2",
    );
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_ARTICLE_READABILITY_QUALITY_LOW",
        }),
      ]),
    );
    const readerV2 = result.article.materialization.representations.find(
      (value) => value.schema === "reader.document.v2",
    );
    expect(readerV2).toBeDefined();
    expect(JSON.stringify(JSON.parse(readerV2?.content ?? "{}"))).toContain(
      '"type":"table"',
    );
    for (const representation of result.article.materialization
      .representations) {
      expect(representation.content).not.toMatch(
        /GLOBAL_NAV_CHROME|OUTER_SIDEBAR_CHROME|OUTER_FOOTER_CHROME/u,
      );
    }
  });

  it("uses a unique main boundary when related cards create multiple article elements", () => {
    const html = `<!doctype html><html><body>
      <main><article><h1>Primary research article</h1><p>${"The primary article records reproducible evidence and preserves its implementation details. ".repeat(18)}</p><pre><code>const retained = true;</code></pre></article><section><h2>MAIN_NON_ARTICLE_SIBLING</h2><p>Unrelated discussion.</p></section></main>
      <aside id="related-posts"><nav>
        <article><h2>RELATED_CARD_ONE</h2><p>Recommendation preview.</p></article>
        <article><h2>RELATED_CARD_TWO</h2><p>Another recommendation preview.</p></article>
        <article><h2>RELATED_CARD_THREE</h2><p>Third recommendation preview.</p></article>
      </nav></aside>
    </body></html>`;

    const result = normalizeArticleCapture(articleCapture(html));

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.article.materialization.provenance.rulesApplied).toContain(
      "article.extractor.semantic-boundary.v1",
    );
    const serializedRepresentations = result.article.materialization.representations
      .map((representation) => representation.content)
      .join("\n");
    expect(serializedRepresentations).toContain("reproducible evidence");
    expect(serializedRepresentations).toContain("const retained = true;");
    expect(serializedRepresentations).not.toMatch(
      /MAIN_NON_ARTICLE_SIBLING|RELATED_CARD_(?:ONE|TWO|THREE)/u,
    );
  });

  it("fails closed when a unique main landmark still contains multiple articles", () => {
    const html = `<!doctype html><html><body><main>
      <article><h1>First article</h1><p>${"Independent first article content. ".repeat(20)}</p></article>
      <article><h1>Second article</h1><p>${"Independent second article content. ".repeat(20)}</p></article>
    </main></body></html>`;

    const result = normalizeArticleCapture(articleCapture(html));

    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_ARTICLE_CONTENT_LOW_QUALITY",
          severity: "fatal",
        }),
      ]),
    );
  });

  it("uses a bounded semantic root to preserve table and code structure without substantive outer siblings", () => {
    const codeBlocks = Array.from(
      { length: 5 },
      (_, index) => `<pre><code>const sample${index} = ${index};</code></pre>`,
    ).join("");
    const html = `<!doctype html><html><body><main><article><h1>T</h1><p>${"Main content evidence ".repeat(15)}</p>${codeBlocks}<details><summary>Data</summary><table><tr><td>A</td></tr></table></details></article></main></body></html>`;

    const result = normalizeArticleCapture(articleCapture(html));

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(
      result.article.materialization.provenance.selectedCandidate.sourcePath,
    ).toBe("article.extractor.semantic-root");
    expect(
      result.article.materialization.provenance.rulesApplied,
    ).not.toContain("article.extractor.body-fallback.v1");
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_ARTICLE_READABILITY_QUALITY_LOW",
        }),
      ]),
    );
    const readerV2 = result.article.materialization.representations.find(
      (value) => value.schema === "reader.document.v2",
    );
    const document = JSON.parse(readerV2?.content ?? "{}");
    expect(document.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "code",
          value: "const sample0 = 0;",
        }),
        expect.objectContaining({ type: "table" }),
      ]),
    );
  });

  it("rejects generic candidates that lose article media, links, citations, headings, lists, or disclosure content", () => {
    const html = `<!doctype html><html><body><article>
      <h1>Structural evidence</h1>
      <p>${"The experiment records a bounded result for later review and independent reproduction. ".repeat(18)}</p>
      <aside class="supplementary sidebar">
        <h2>Materials</h2>
        <p><a href="/primary-source">Primary source</a></p>
        <picture><source srcset="/plot.webp" type="image/webp" /><img src="/plot.png" alt="Latency plot" /></picture>
        <img src="/apparatus.png" alt="Experimental apparatus" />
        <ul><li>Calibrated sample</li><li>Control sample</li></ul>
        <section role="doc-bibliography"><h2>References</h2><ol><li><cite>Doe et al. 2026</cite> <a href="/paper">Replication paper</a></li></ol></section>
        <details><summary>Appendix protocol</summary><p>Hidden protocol details remain part of the article.</p></details>
      </aside>
    </article></body></html>`;

    const result = normalizeArticleCapture(articleCapture(html));

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(
      result.article.materialization.provenance.selectedCandidate.sourcePath,
    ).toBe("article.extractor.semantic-root");
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_ARTICLE_DEFUDDLE_QUALITY_LOW",
        }),
        expect.objectContaining({
          code: "SOURCE_ARTICLE_READABILITY_QUALITY_LOW",
        }),
      ]),
    );
    const readerV2 = result.article.materialization.representations.find(
      (value) => value.schema === "reader.document.v2",
    );
    const document = JSON.parse(readerV2?.content ?? "{}");
    const serialized = JSON.stringify(document.children);
    expect(serialized).toContain('"type":"heading"');
    expect(serialized).toContain('"type":"link"');
    expect(serialized).toContain('"type":"image"');
    expect(serialized).toContain('"type":"cite"');
    expect(serialized).toContain('"type":"list"');
    expect(serialized).toContain(
      "Hidden protocol details remain part of the article.",
    );
  });

  it("removes a duplicate page title even when Readability demotes the source h1", () => {
    const html = `<!doctype html><html><body><article><h1>T</h1><p>${"Main content evidence ".repeat(12)}</p><figure><img src="/x.png"><figcaption>C</figcaption></figure><section class="footnotes"><ol><li id="fn-1">N</li></ol></section></article></body></html>`;

    const result = normalizeArticleCapture(articleCapture(html));

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(
      result.article.materialization.provenance.selectedCandidate.sourcePath,
    ).toBe("article.extractor.readability");
    const readerV2 = result.article.materialization.representations.find(
      (value) => value.schema === "reader.document.v2",
    );
    expect(readerV2).toBeDefined();
    const document = JSON.parse(readerV2?.content ?? "{}");
    expect(JSON.stringify(document.children)).not.toContain('"value":"T"');
    expect(document.losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DUPLICATE_PAGE_TITLE_REMOVED",
          sourceTag: "h2",
        }),
      ]),
    );
  });

  it("returns a bounded sanitized plain-text fallback when malformed HTML exceeds structural limits", () => {
    const html = `<!doctype html><html><head><title>Malformed research note</title><style>.secret { content: "style must not leak"; }</style></head>
      <body><main><article><h1>Malformed research note<p>The captured result remains readable even when the source never closes its elements.
      <script>globalThis.scriptMustNotLeak = true</script>`;
    const input = articleCapture(html);

    const result = normalizeArticleCapture({
      ...input,
      budget: { ...input.budget, maxDepth: 2, maxOutputBytes: 2_048 },
    });

    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (result.ok) return;
    expect(result.fallbackText).toContain("Malformed research note");
    expect(result.fallbackText).toContain("captured result remains readable");
    expect(result.fallbackText).not.toContain("scriptMustNotLeak");
    expect(result.fallbackText).not.toContain("style must not leak");
    expect(result.fallbackText).not.toMatch(
      /<\/?(?:article|h1|p|script|style)\b/iu,
    );
    expect(
      Buffer.byteLength(JSON.stringify(result), "utf8"),
    ).toBeLessThanOrEqual(2_048);
  });

  it("fails closed instead of accepting an ambiguous raw body as a full article", () => {
    const html = `<!doctype html><html><head><title>Ambiguous research page</title></head><body><header>Research digest account settings</header><nav>Home Archive Topics Subscribe Sign in</nav><div class="content"><h1>Loose research note</h1><p>${"A short observation records a potentially useful result without establishing a unique article boundary. ".repeat(20)}</p></div><aside>Site statistics: 42 weekly visitors</aside><footer>Privacy Terms Contact</footer></body></html>`;

    const result = normalizeArticleCapture(articleCapture(html));

    if (result.ok) {
      expect(
        result.article.materialization.provenance.selectedCandidate.sourcePath,
      ).not.toBe("article.extractor.body");
    }
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_ARTICLE_CONTENT_LOW_QUALITY",
          recoverBy: "plain-text-fallback",
          severity: "fatal",
        }),
      ]),
    );
    expect(result.fallbackText).toContain("Loose research note");
    expect(result.fallbackText).toContain(
      "potentially useful result without establishing a unique article boundary",
    );
    expect(
      Buffer.byteLength(result.fallbackText ?? "", "utf8"),
    ).toBeLessThanOrEqual(64 * 1024);
  });

  it("rejects a low-quality body-only capture with a safe readable fallback", () => {
    const html = `<!doctype html><html><head><title>Research inbox</title><style>body { display: none }</style></head><body>
      <nav>Sign in Subscribe</nav><script>stealCredentials()</script></body></html>`;

    const result = normalizeArticleCapture(articleCapture(html));

    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_ARTICLE_CONTENT_LOW_QUALITY",
          recoverBy: "plain-text-fallback",
        }),
      ]),
    );
    expect(result.fallbackText).toBe("Research inbox Sign in Subscribe");
    expect(result.fallbackText).not.toContain("stealCredentials");
    expect(result.fallbackText).not.toContain("display: none");
  });

  it("does not count active-content text toward the fallback body quality gate", () => {
    const html = `<!doctype html><html><head><title>Fallback page</title><style>.hidden{display:none}</style></head><body><nav>Weekly navigation</nav><main><p>Short but meaningful saved finding.</p></main><script>${"globalThis.fallbackPromptInjection = true;".repeat(6)}</script></body></html>`;

    const result = normalizeArticleCapture(articleCapture(html));

    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_ARTICLE_CONTENT_LOW_QUALITY",
          recoverBy: "plain-text-fallback",
        }),
      ]),
    );
    expect(result.fallbackText).toBe(
      "Fallback page Weekly navigation Short but meaningful saved finding.",
    );
    expect(result.fallbackText).not.toContain("fallbackPromptInjection");
  });

  it.each([
    {
      head: "",
      mediaType: "text/html; charset=windows-1252",
      rule: "article.decode.http.windows-1252",
    },
    {
      head: '<meta charset="windows-1252">',
      mediaType: "text/html",
      rule: "article.decode.meta.windows-1252",
    },
  ])(
    "decodes Windows-1252 HTML from $rule evidence",
    ({ head, mediaType, rule }) => {
      const body =
        "The bounded extractor preserves technical evidence and source identity across deterministic materializations. ".repeat(
          8,
        );
      const html = `<!doctype html><html><head>${head}</head><body><article><h1>“Bounded” extraction</h1><p>${body}</p></article></body></html>`;

      const result = normalizeArticleCapture(
        articleByteCapture(windows1252Bytes(html), mediaType),
      );

      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.article.title).toBe("“Bounded” extraction");
      expect(result.article.materialization.provenance.rulesApplied).toContain(
        rule,
      );
    },
  );

  it("lets an UTF-8 BOM override a conflicting HTTP charset", () => {
    const body =
      "A byte-order mark is stronger transport evidence than a conflicting HTTP declaration. ".repeat(
        9,
      );
    const encoded = new TextEncoder().encode(
      `<!doctype html><html><body><article><h1>研究编码</h1><p>${body}</p></article></body></html>`,
    );
    const bytes = new Uint8Array(encoded.length + 3);
    bytes.set([0xef, 0xbb, 0xbf]);
    bytes.set(encoded, 3);

    const result = normalizeArticleCapture(
      articleByteCapture(bytes, "text/html; charset=windows-1252"),
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.article.title).toBe("研究编码");
    expect(result.article.materialization.provenance.rulesApplied).toContain(
      "article.decode.bom.utf-8",
    );
  });

  it("records an unknown HTML charset and deterministically falls back to valid UTF-8", () => {
    const body =
      "An unsupported label must not bypass sanitization or discard a valid UTF-8 capture. ".repeat(
        9,
      );
    const html = `<!doctype html><html><body><article><h1>Charset fallback ✓</h1><p>${body}</p></article></body></html>`;

    const result = normalizeArticleCapture(
      articleByteCapture(
        new TextEncoder().encode(html),
        "text/html; charset=unknown-legacy",
      ),
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.article.title).toBe("Charset fallback ✓");
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_ARTICLE_CHARSET_UNSUPPORTED",
          severity: "warning",
        }),
      ]),
    );
    expect(result.article.materialization.provenance.rulesApplied).toContain(
      "article.decode.fallback.utf-8",
    );
  });

  it("records replacement decoding when declared UTF-8 contains an invalid byte", () => {
    const before = new TextEncoder().encode(
      "<!doctype html><html><body><article><h1>Invalid ",
    );
    const after = new TextEncoder().encode(
      " byte</h1><p>" +
        "The remainder remains readable and passes through the normal sanitizer. ".repeat(
          10,
        ) +
        "</p></article></body></html>",
    );
    const bytes = new Uint8Array(before.length + 1 + after.length);
    bytes.set(before);
    bytes[before.length] = 0x80;
    bytes.set(after, before.length + 1);

    const result = normalizeArticleCapture(
      articleByteCapture(bytes, "text/html; charset=utf-8"),
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.article.title).toBe("Invalid � byte");
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_ARTICLE_DECODING_REPLACED",
          severity: "warning",
        }),
      ]),
    );
    expect(result.article.materialization.provenance.rulesApplied).toContain(
      "article.decode.http.utf-8.replacement",
    );
  });

  it("rejects an oversized low-node article before DOM extraction", () => {
    const html = `<article><h1>Oversized</h1><p>${"x".repeat(3_000)}</p></article>`;
    const input = articleCapture(html);

    const result = normalizeArticleCapture({
      ...input,
      budget: { ...input.budget, maxDepth: 1, maxOutputBytes: 1_024 },
    });

    expect(result).toEqual({
      ok: false,
      problems: [
        {
          code: "SOURCE_ARTICLE_OUTPUT_BUDGET_EXCEEDED",
          recoverBy: "none",
          scope: "capture",
          severity: "fatal",
        },
      ],
    });
  });

  it("preserves rich article semantics in Reader Document v2 without replacing compatibility projections", () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
        <channel>
          <title>Systems research</title>
          <item>
            <guid isPermaLink="false">rich-entry</guid>
            <title>Rich systems result</title>
            <link>https://example.test/posts/rich</link>
            <content:encoded><![CDATA[
              <section>
                <h1> Rich systems result </h1>
                <h2>Results</h2>
                <p>Use <mark>evidence</mark>, <code>alpha()</code>,
                  <span>\\(E=mc^2\\)</span>, and
                  <sup id="fnref-1"><a href="#fn-1" role="doc-noteref">1</a></sup>.
                </p>
                <figure>
                  <img src="/plot.png" alt="Latency plot" title="Experiment output" />
                  <figcaption>Latency by batch.</figcaption>
                </figure>
                <pre><code class="language-typescript">const samples = 32;</code></pre>
                <div class="math display">\\[\\sum_i x_i\\]</div>
                <table>
                  <caption>Latency measurements</caption>
                  <thead><tr><th scope="col">Batch</th><th scope="col" align="right">Time</th></tr></thead>
                  <tbody><tr><th scope="row">32</th><td align="right">18 ms</td></tr></tbody>
                </table>
                <div id="footnotes">
                  <ol><li id="fn-1"><p>Measured on A100. <a href="#fnref-1" role="doc-backlink">Back</a></p></li></ol>
                </div>
                <custom-safe><p>Fallback survives.</p></custom-safe>
                <iframe src="https://attacker.test/embed">active fallback must not survive</iframe>
              </section>
            ]]></content:encoded>
          </item>
        </channel>
      </rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const representations =
      result.feed.entries[0].materialization.representations;
    const readerV2 = representations.find(
      (value) => value.schema === "reader.document.v2",
    );
    const readerV1 = representations.find(
      (value) => value.schema === "reader.document.v1",
    );
    const agent = representations.find(
      (value) => value.schema === "agent.gfm.v1",
    );
    const selection = representations.find(
      (value) => value.schema === "selection.text.v1",
    );

    expect(readerV1).toBeDefined();
    expect(agent).toBeDefined();
    expect(selection).toBeDefined();
    expect(readerV2).toBeDefined();
    const document = JSON.parse(readerV2?.content ?? "{}");
    expect(readerDocumentV2Schema.safeParse(document).success).toBe(true);
    expect(document).toMatchObject({
      children: [
        {
          children: expect.arrayContaining([
            {
              children: [{ type: "text", value: "Results" }],
              depth: 2,
              type: "heading",
            },
            expect.objectContaining({
              caption: [{ type: "text", value: "Latency by batch." }],
              media: [
                {
                  alt: "Latency plot",
                  title: "Experiment output",
                  type: "image",
                  url: "https://example.test/plot.png",
                },
              ],
              type: "figure",
            }),
            {
              lang: "typescript",
              meta: null,
              type: "code",
              value: "const samples = 32;",
            },
            {
              display: true,
              format: "tex",
              label: null,
              type: "math",
              value: "\\sum_i x_i",
            },
            expect.objectContaining({
              caption: [{ type: "text", value: "Latency measurements" }],
              head: expect.objectContaining({ type: "tableSection" }),
              bodies: [expect.objectContaining({ type: "tableSection" })],
              type: "table",
            }),
            expect.objectContaining({
              identifier: "1",
              label: "1",
              type: "footnoteDefinition",
            }),
          ]),
          type: "section",
        },
      ],
      losses: expect.arrayContaining([
        expect.objectContaining({
          code: "DUPLICATE_PAGE_TITLE_REMOVED",
          fallback: "omitted",
          sourceTag: "h1",
        }),
        expect.objectContaining({
          fallback: "children",
          sourceTag: "custom-safe",
        }),
        expect.objectContaining({ fallback: "omitted", sourceTag: "iframe" }),
      ]),
      type: "root",
    });
    const section = document.children[0];
    const paragraph = section.children.find(
      (node: { type: string }) => node.type === "paragraph",
    );
    expect(paragraph.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          children: [{ type: "text", value: "evidence" }],
          type: "mark",
        }),
        { type: "inlineCode", value: "alpha()" },
        {
          display: false,
          format: "tex",
          label: null,
          type: "math",
          value: "E=mc^2",
        },
        { identifier: "1", label: "1", type: "footnoteReference" },
      ]),
    );
    const table = section.children.find(
      (node: { type: string }) => node.type === "table",
    );
    expect(table.head.children[0].children[1]).toMatchObject({
      align: "right",
      header: true,
      scope: "col",
    });
    expect(table.bodies[0].children[0].children[0]).toMatchObject({
      header: true,
      scope: "row",
    });
    expect(readerV2?.content).not.toContain("attacker.test");
    expect(readerV2?.content).not.toContain("active fallback must not survive");
    expect(
      result.feed.entries[0].materialization.provenance.rulesApplied,
    ).toContain("generic.remove-duplicate-page-title");
  });

  it("preserves unsafe-image alt text and normalizes GitHub footnotes without repeating figure credits", () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
        <channel><title>Reader compatibility</title><item>
          <guid isPermaLink="false">reader-edge-cases</guid>
          <title>Reader edge cases</title>
          <link>https://example.test/posts/reader-edge-cases</link>
          <content:encoded><![CDATA[
            <article>
              <p>See <img src="javascript:alert(1)" alt="Critical diagram" />
                and evidence<sup><a data-footnote-ref href="#user-content-fn-1">1</a></sup>.</p>
              <figure>
                <img src="/plot.png" alt="Latency plot" />
                <figcaption>Latency by batch. <span class="credit">Source: NASA</span></figcaption>
              </figure>
              <section class="footnotes"><ol><li id="user-content-fn-1"><p>
                Saved evidence. <a data-footnote-backref href="#user-content-fnref-1">Back</a>
              </p></li></ol></section>
            </article>
          ]]></content:encoded>
        </item></channel>
      </rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const reader = result.feed.entries[0].materialization.representations.find(
      (representation) => representation.schema === "reader.document.v2",
    );
    const document = JSON.parse(reader?.content ?? "{}");
    const serialized = JSON.stringify(document);
    const paragraph = document.children.find(
      (node: { type: string }) => node.type === "paragraph",
    );
    const figure = document.children.find(
      (node: { type: string }) => node.type === "figure",
    );
    const definition = document.children.find(
      (node: { type: string }) => node.type === "footnoteDefinition",
    );

    expect(JSON.stringify(paragraph)).toContain("Critical diagram");
    expect(paragraph.children).toEqual(
      expect.arrayContaining([
        { identifier: "1", label: "1", type: "footnoteReference" },
      ]),
    );
    expect(figure).toMatchObject({
      caption: [{ type: "text", value: "Latency by batch." }],
      credit: [{ type: "text", value: "Source: NASA" }],
      type: "figure",
    });
    expect(definition).toMatchObject({
      identifier: "1",
      type: "footnoteDefinition",
    });
    expect(serialized.match(/Source: NASA/gu)).toHaveLength(1);
    expect(serialized).not.toContain("javascript:");
    expect(serialized).not.toContain("Back");
    expect(document.losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNSAFE_IMAGE_DROPPED",
          fallback: "text",
        }),
      ]),
    );
  });

  it("normalizes an RSS full-content candidate into deterministic safe representations", () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0"
        xmlns:content="http://purl.org/rss/1.0/modules/content/"
        xmlns:foo="https://example.test/not-content">
        <channel>
          <title>Example feed</title>
          <item>
            <guid isPermaLink="false">opaque-entry-1</guid>
            <title>Safe entry</title>
            <link>https://example.test/posts/1</link>
            <description><![CDATA[Short summary]]></description>
            <foo:encoded><![CDATA[This must not win]]></foo:encoded>
            <content:encoded><![CDATA[
              <p>Hello <a href="/paper">paper</a>.</p>
              <script>alert("never")</script>
              <p><a href="javascript:alert(1)">unsafe destination</a></p>
            ]]></content:encoded>
          </item>
        </channel>
      </rss>`;

    const first = normalizeFeedCapture(capture(xml));
    const second = normalizeFeedCapture(capture(xml));

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(first.feed.title).toBe("Example feed");
    expect(first.feed.producer).toMatchObject({ key: "generic", evidence: [] });
    expect(first.feed.entries).toHaveLength(1);

    const entry = first.feed.entries[0];
    expect(entry.title).toBe("Safe entry");
    expect(entry.sourceIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(entry.materialization.quality).toMatchObject({
      completeness: "declared_full",
      identityConfidence: "strong",
      safety: "safe",
    });
    expect(entry.materialization.provenance.selectedCandidate).toMatchObject({
      role: "full",
      sourcePath: "rss.channel.item.content:encoded",
    });

    const agent = entry.materialization.representations.find(
      (value) => value.purpose === "agent",
    );
    const reader = entry.materialization.representations.find(
      (value) => value.purpose === "reader",
    );
    const selection = entry.materialization.representations.find(
      (value) => value.purpose === "selection",
    );

    expect(agent).toMatchObject({ schema: "agent.gfm.v1" });
    expect(agent?.content).toContain("[paper](https://example.test/paper)");
    expect(agent?.content).toContain("unsafe destination");
    expect(agent?.content).not.toContain("javascript:");
    expect(agent?.content).not.toContain("alert");
    expect(reader).toMatchObject({ schema: "reader.document.v1" });
    expect(() => JSON.parse(reader?.content ?? "")).not.toThrow();
    expect(
      readerDocumentSchema.safeParse(JSON.parse(reader?.content ?? "")).success,
    ).toBe(true);
    expect(selection).toMatchObject({ schema: "selection.text.v1" });
    expect(selection?.content).toContain("Hello paper");
    expect(entry.materialization.identity).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("falls back to a readable summary when the higher-ranked full candidate sanitizes to empty", () => {
    const xml = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Feed</title><link>https://example.test/</link><description>Updates</description><item><guid isPermaLink="false">entry</guid><title>Entry</title><content:encoded><![CDATA[<script>only unsafe content</script>]]></content:encoded><description>Readable summary</description></item></channel></rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const materialization = result.feed.entries[0].materialization;
    expect(materialization.provenance.selectedCandidate).toMatchObject({
      role: "ambiguous",
      sourcePath: "rss.channel.item.description",
    });
    expect(
      materialization.representations.find(
        (value) => value.purpose === "selection",
      )?.content,
    ).toBe("Readable summary");
    expect(materialization.quality.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SOURCE_CONTENT_CANDIDATE_EMPTY" }),
      ]),
    );
  });

  it("falls through to a healthy summary when a full candidate exceeds the representation budget", () => {
    const oversizedFull = Array.from(
      { length: 25 },
      (_, index) => `<p>Paragraph ${index}</p>`,
    ).join("");
    const xml = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Feed</title><link>https://example.test/</link><description>Updates</description><item><guid isPermaLink="false">entry</guid><title>Entry</title><content:encoded><![CDATA[${oversizedFull}]]></content:encoded><description>Healthy summary</description></item></channel></rss>`;
    const input = capture(xml);

    const result = normalizeFeedCapture({
      ...input,
      budget: { ...input.budget, maxNodes: 20 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const materialization = result.feed.entries[0].materialization;
    expect(materialization.provenance.selectedCandidate).toMatchObject({
      role: "ambiguous",
      sourcePath: "rss.channel.item.description",
    });
    expect(
      materialization.representations.find(
        (value) => value.purpose === "selection",
      )?.content,
    ).toBe("Healthy summary");
  });

  it("bounds every malicious candidate before falling back to the entry title", () => {
    const oversized = `<p>${"adversarial ".repeat(900)}</p>`;
    const xml = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Feed</title><item>
      <guid isPermaLink="false">multi-candidate</guid><title>Bounded title fallback</title>
      <content:encoded><![CDATA[${oversized}]]></content:encoded><description><![CDATA[${oversized}]]></description>
    </item></channel></rss>`;
    const input = capture(xml);

    const result = normalizeFeedCapture({
      ...input,
      budget: { ...input.budget, maxEntryOutputBytes: 4_096 },
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const materialization = result.feed.entries[0].materialization;
    expect(materialization.provenance.selectedCandidate.sourcePath).toBe(
      "fallback.title",
    );
    expect(
      materialization.representations.find(
        (value) => value.purpose === "selection",
      )?.content,
    ).toBe("Bounded title fallback");
    expect(
      materialization.quality.warnings.filter(
        (warning) => warning.code === "SOURCE_CONTENT_CANDIDATE_REJECTED",
      ),
    ).toHaveLength(2);
    expect(
      Buffer.byteLength(JSON.stringify(result.feed.entries[0]), "utf8"),
    ).toBeLessThanOrEqual(4_096);
  });

  it("keeps an entry fingerprint and materialization stable when only a sibling changes", () => {
    const first = `<item><guid>stable-entry</guid><title>Stable</title><description>Same body</description></item>`;
    const beforeXml = `<rss version="2.0"><channel><title>Feed</title>${first}<item><guid>other</guid><title>Other</title><description>Before</description></item></channel></rss>`;
    const afterXml = `<rss version="2.0"><channel><title>Feed</title>${first}<item><guid>other</guid><title>Other</title><description>After</description></item></channel></rss>`;

    const before = normalizeFeedCapture(capture(beforeXml));
    const after = normalizeFeedCapture(capture(afterXml));

    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(before.feed.entries[0].sourceFingerprint).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(after.feed.entries[0].sourceFingerprint).toBe(
      before.feed.entries[0].sourceFingerprint,
    );
    expect(after.feed.entries[0].materialization.identity).toBe(
      before.feed.entries[0].materialization.identity,
    );
    expect(
      after.feed.entries[0].materialization.provenance.captureIdentity,
    ).not.toBe(
      before.feed.entries[0].materialization.provenance.captureIdentity,
    );
    expect(after.feed.entries[1].sourceFingerprint).not.toBe(
      before.feed.entries[1].sourceFingerprint,
    );
  });

  it("rejects a capture whose entry count exceeds the public budget before materialization", () => {
    const xml = `<rss version="2.0"><channel><title>Feed</title><item><guid>one</guid><title>One</title></item><item><guid>two</guid><title>Two</title></item></channel></rss>`;
    const input = capture(xml);

    const result = normalizeFeedCapture({
      ...input,
      budget: { ...input.budget, maxEntries: 1 },
    });

    expect(result).toEqual({
      ok: false,
      problems: [
        {
          code: "SOURCE_TOO_MANY_ENTRIES",
          recoverBy: "none",
          scope: "capture",
          severity: "fatal",
        },
      ],
    });
  });

  it("falls back from one over-budget entry without discarding its healthy sibling", () => {
    const oversizedBody = `<p>${"Evidence ".repeat(200)}</p>`;
    const xml = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Feed</title>
      <item><guid>oversized</guid><title>Oversized</title><content:encoded><![CDATA[${oversizedBody}]]></content:encoded></item>
      <item><guid>healthy</guid><title>Healthy</title><description>Readable evidence</description></item>
    </channel></rss>`;
    const input = capture(xml);

    const result = normalizeFeedCapture({
      ...input,
      budget: { ...input.budget, maxEntryOutputBytes: 4_096 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries).toHaveLength(2);
    const degraded = result.feed.entries.find(
      (entry) => entry.title === "Oversized",
    );
    const healthy = result.feed.entries.find(
      (entry) => entry.title === "Healthy",
    );
    expect(degraded?.materialization.quality).toMatchObject({
      completeness: "external",
      safety: "safe",
    });
    expect(degraded?.materialization.quality.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_CONTENT_CANDIDATE_REJECTED",
          severity: "warning",
        }),
      ]),
    );
    expect(degraded?.materialization.provenance.selectedCandidate.role).toBe(
      "external",
    );
    expect(healthy?.materialization.quality.safety).toBe("safe");
    expect(
      healthy?.materialization.representations.find(
        (value) => value.purpose === "selection",
      )?.content,
    ).toBe("Readable evidence");
  });

  it("uses a valid Atom summary instead of invalid out-of-line or empty content", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry>
      <id>tag:example.test,2026:entry</id><title>Candidate constraints</title><updated>2026-08-28T00:00:00Z</updated>
      <content type="html" src="javascript:alert(1)">&lt;p&gt;Must not win&lt;/p&gt;</content>
      <content type="html"></content><summary type="text">Usable summary</summary>
    </entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const materialization = result.feed.entries[0].materialization;
    expect(materialization.provenance.selectedCandidate).toMatchObject({
      role: "summary",
      sourcePath: "atom.feed.entry.summary",
    });
    expect(
      materialization.representations.find(
        (value) => value.purpose === "selection",
      )?.content,
    ).toBe("Usable summary");
    expect(materialization.quality.conformance).toBe("nonconformant");
    expect(
      materialization.quality.warnings.map((value) => value.code),
    ).toContain("SOURCE_ATOM_CONTENT_INVALID");
  });

  it("enforces Atom out-of-line content and summary requirements", () => {
    const missingSummary = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry>
      <id>tag:example.test,2026:entry</id><title>Remote body</title><updated>2026-08-28T00:00:00Z</updated>
      <content type="text/plain" src="https://example.test/body.txt" />
    </entry></feed>`;
    const keywordType = missingSummary
      .replace('type="text/plain"', 'type="text"')
      .replace("</entry>", "<summary>Remote body</summary></entry>");

    const withoutSummary = normalizeFeedCapture(capture(missingSummary));
    const withInvalidType = normalizeFeedCapture(capture(keywordType));

    expect(withoutSummary.ok).toBe(true);
    expect(withInvalidType.ok).toBe(true);
    if (!withoutSummary.ok || !withInvalidType.ok) return;
    expect(
      withoutSummary.feed.entries[0].materialization.quality.conformance,
    ).toBe("nonconformant");
    expect(
      withoutSummary.feed.entries[0].materialization.quality.warnings.map(
        (value) => value.code,
      ),
    ).toContain("SOURCE_ATOM_ENTRY_NONCONFORMANT");
    expect(
      withInvalidType.feed.entries[0].materialization.quality.conformance,
    ).toBe("nonconformant");
    expect(
      withInvalidType.feed.entries[0].materialization.quality.warnings.map(
        (value) => value.code,
      ),
    ).toContain("SOURCE_ATOM_CONTENT_INVALID");
  });

  it("requires an Atom alternate link when an entry has no content", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry>
      <id>tag:example.test,2026:entry</id><title>Metadata only</title><updated>2026-08-28T00:00:00Z</updated><summary>Summary is not an alternate link.</summary>
    </entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it("requires Atom feed metadata to appear before every entry", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content type="text">Evidence</content></entry><subtitle>Late metadata</subtitle></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it.each([
    ["feed", "unexpected feed text", ""],
    ["entry", "", "unexpected entry text"],
    ["feed with a non-breaking space", "\u00a0", ""],
  ])(
    "rejects non-whitespace character data directly inside an Atom %s",
    (_container, feedText, entryText) => {
      const xml = `<feed xmlns="http://www.w3.org/2005/Atom">${feedText}<title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry>${entryText}<id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content type="text">Evidence</content></entry></feed>`;

      const result = normalizeFeedCapture(capture(xml));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.feed.entries[0].materialization.quality.conformance).toBe(
        "nonconformant",
      );
    },
  );

  it.each([
    ["surrounding whitespace", " 2026-08-28T00:00:00Z "],
    ["an impossible calendar date", "2026-02-30T00:00:00Z"],
  ])("does not normalize an Atom date with %s", (_label, updated) => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>${updated}</updated><author><name>Researcher</name></author><entry>
      <id>tag:example.test,2026:entry</id><title>Invalid date</title><updated>${updated}</updated><content type="text">Evidence</content>
    </entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].publishedAt).toBeUndefined();
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it("treats an RSS 2.0 item without guid as conformant when its required fields are present", () => {
    const xml = `<rss version="2.0"><channel><title>RSS feed</title><link>https://example.test/</link><description>Research updates</description><item><title>Item</title><link>https://example.test/item</link><description>Evidence</description></item></channel></rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality).toMatchObject({
      conformance: "conformant",
      identityConfidence: "medium",
    });
  });

  it("does not call an Atom entry conformant merely because it has an id", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Missing updated</title><content type="text">Evidence</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
    expect(
      result.feed.entries[0].materialization.quality.warnings.map(
        (value) => value.code,
      ),
    ).toContain("SOURCE_ATOM_ENTRY_NONCONFORMANT");
  });

  it("requires a valid Atom author construct when the entry inherits feed authorship", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content type="text">Evidence</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it.each([
    [
      "an invalid author IRI",
      "<author><name>Researcher</name><uri>http://[</uri></author>",
    ],
    [
      "an invalid author email",
      "<author><name>Researcher</name><email>not an addr-spec</email></author>",
    ],
    [
      "an author email with an unclosed comment",
      "<author><name>Researcher</name><email>user(unclosed@example.com</email></author>",
    ],
    [
      "an author email with CFWS inside a dot-atom",
      "<author><name>Researcher</name><email>us(comment)er@example.com</email></author>",
    ],
    [
      "markup inside the author name",
      '<author xmlns:x="https://example.test/ext"><name><x:b>Researcher</x:b></name></author>',
    ],
  ])("rejects an Atom person construct with %s", (_label, author) => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated>${author}<entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content type="text">Evidence</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it.each([
    ["a trailing local-part comment", "user(comment)@example.com"],
    [
      "comments and folding whitespace around both parts",
      "(local) user \n\t@ (domain) example.com",
    ],
    [
      "a nested comment and domain literal",
      "user(outer(inner))@(domain)[127.0.0.1]",
    ],
  ])("accepts an Atom author email with RFC 2822 CFWS: %s", (_label, email) => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name><email>${email}</email></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content type="text">Evidence</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "conformant",
    );
  });

  it("rejects invalid Base64 in non-text, non-XML inline Atom content", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Binary</title><updated>2026-08-28T00:00:00Z</updated><content type="application/pdf">not base64!</content><summary>Download the paper</summary></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
    expect(
      result.feed.entries[0].materialization.quality.warnings.map(
        (value) => value.code,
      ),
    ).toContain("SOURCE_ATOM_CONTENT_INVALID");
  });

  it("preserves inline XML Atom content as safe readable text", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>XML payload</title><updated>2026-08-28T00:00:00Z</updated><content type="application/xml"><payload xmlns="urn:example">Readable XML body</payload></content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.feed.entries[0];
    expect(entry.materialization.quality.conformance).toBe("conformant");
    expect(
      entry.materialization.representations.find(
        (value) => value.purpose === "selection",
      )?.content,
    ).toContain("Readable XML body");
  });

  it("preserves attribute and empty-element semantics from inline XML as safe structured text", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>XML payload</title><updated>2026-08-28T00:00:00Z</updated><content type="application/xml"><payload xmlns="urn:example" kind="diagram"><empty/></payload></content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.feed.entries[0];
    const selection = entry.materialization.representations.find(
      (value) => value.purpose === "selection",
    )?.content;
    expect(selection).toContain("{urn:example}payload");
    expect(selection).toContain('kind="diagram"');
    expect(selection).toContain("{urn:example}empty");
    expect(entry.materialization.quality.completeness).toBe("declared_full");
  });

  it.each([
    ["spaces between encoded characters", "T W F u"],
    ["a carriage-return character reference inside the payload", "TW&#13;Fu"],
    ["multiple line feeds at one boundary", "TW\n\nFu"],
  ])("rejects Base64 with %s", (_label, payload) => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Binary</title><updated>2026-08-28T00:00:00Z</updated><content type="image/png">${payload}</content><summary>Image payload</summary></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it("rejects duplicate Atom alternate links with the same type and hreflang", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><link rel="alternate" type="text/html" hreflang="en" href="https://example.test/a"/><link rel="alternate" type="TEXT/HTML" hreflang="EN" href="https://example.test/b"/><content type="text">Evidence</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it("does not apply feed and entry alternate-link uniqueness to Atom source metadata", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><source><link rel="alternate" href="https://example.test/source-a"/><link rel="alternate" href="https://example.test/source-b"/></source><content type="text">Evidence</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "conformant",
    );
  });

  it("does not treat an explicitly empty Atom link relation as the default alternate relation", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><link rel="" href="https://example.test/entry"/><content>Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it("rejects a composite MIME type on out-of-line Atom content", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content src="https://example.test/mixed" type="multipart/mixed"/><summary>Summary</summary></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it("allows ignored text payload inside an otherwise valid Atom link", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><link rel="alternate" href="https://example.test/e">ignored</link><summary>Evidence</summary></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "conformant",
    );
  });

  it.each([
    ["an empty relative href", '<link rel="related" href=""/>'],
    [
      "an IPvFuture absolute IRI",
      '<link rel="related" href="foo://[v1.a]/x"/>',
    ],
    [
      "an IPvFuture absolute IRI with an uppercase version marker",
      '<link rel="related" href="foo://[V1.a]/x"/>',
    ],
    [
      "a composite MIME advisory type",
      '<link rel="related" type="multipart/mixed" href="https://example.test/mixed"/>',
    ],
  ])("accepts %s on an Atom link", (_label, link) => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated>${link}<content>Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "conformant",
    );
  });

  it("accepts an IPvFuture absolute Atom id as a strong identity", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>foo://[v1.a]/x</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content>Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "conformant",
    );
    expect(
      result.feed.entries[0].materialization.quality.identityConfidence,
    ).toBe("strong");
  });

  it("accepts empty Atom IRI references and resolves actionable ones against the capture locator", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name><uri></uri></author><generator uri="">Generator</generator><icon></icon><logo></logo><entry xml:lang=""><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><link rel="alternate" href=""/><content src="" type="text/plain"/><summary>Summary</summary></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].link).toBe("https://example.test/feed.xml");
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "conformant",
    );
  });

  it.each([
    [
      "an extension child",
      '<link href="https://example.test/" xmlns:x="urn:example"><x:child/></link>',
    ],
    [
      "an unconstrained advisory length",
      '<link href="https://example.test/" length="unknown"/>',
    ],
    [
      "a negative advisory length",
      '<link href="https://example.test/" length="-1"/>',
    ],
  ])(
    "accepts the undefined Atom link content/length form: %s",
    (_label, link) => {
      const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated>${link}<content>Body</content></entry></feed>`;

      const result = normalizeFeedCapture(capture(xml));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.feed.entries[0].materialization.quality.conformance).toBe(
        "conformant",
      );
    },
  );

  it.each([
    ["a feed-local undefined attribute", ' bogus="x"', "", ""],
    ["an entry-local undefined attribute", "", ' bogus="x"', ""],
    ["a content-local undefined attribute", "", "", ' bogus="x"'],
    ["an invalid xml:lang", "", ' xml:lang="not_a_tag"', ""],
  ])(
    "marks Atom with %s as nonconformant",
    (_label, feedAttributes, entryAttributes, contentAttributes) => {
      const xml = `<feed xmlns="http://www.w3.org/2005/Atom"${feedAttributes}><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry${entryAttributes}><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content${contentAttributes}>Body</content></entry></feed>`;

      const result = normalizeFeedCapture(capture(xml));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.feed.entries[0].materialization.quality.conformance).toBe(
        "nonconformant",
      );
    },
  );

  it("accepts foreign namespaced attributes and undefined content on Atom metadata", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:x="urn:example" x:feed="ok"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry x:entry="ok"><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><category term="research" x:category="ok"><x:detail/></category><content x:content="ok">Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "conformant",
    );
  });

  it("requires an Atom category scheme to be an absolute IRI", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><category term="research" scheme="relative"/><content>Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it.each([
    ["a relative relation containing a slash", 'rel="a/b"'],
    ["an invalid language tag", 'hreflang="not_a_tag"'],
  ])("rejects an Atom link with %s", (_label, attributeText) => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><link ${attributeText} href="https://example.test/e"/><content>Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it.each([
    ["a non-IRI entry id", "not an IRI"],
    ["surrounding whitespace in an entry id", " tag:example.test,2026:entry "],
    [
      "child markup in an entry id",
      '<x:value xmlns:x="urn:example">tag:example.test,2026:entry</x:value>',
    ],
    ["invalid percent encoding in an entry id", "https://example.test/%zz"],
  ])("does not grant strong Atom identity to %s", (_label, idContent) => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>${idContent}</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content>Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
    expect(
      result.feed.entries[0].materialization.quality.identityConfidence,
    ).not.toBe("strong");
  });

  it.each(["|", "^", "\\", "{", "}"])(
    "rejects the RFC 3987-forbidden ASCII character %s in an Atom IRI",
    (character) => {
      const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>https://example.test/a${character}b</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content>Body</content></entry></feed>`;

      const result = normalizeFeedCapture(capture(xml));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.feed.entries[0].materialization.quality.conformance).toBe(
        "nonconformant",
      );
      expect(
        result.feed.entries[0].materialization.quality.identityConfidence,
      ).not.toBe("strong");
    },
  );

  it.each([
    ["a second fragment delimiter", "https://example.test/#a#b"],
    ["an unmatched IP-literal bracket in a path", "https://example.test/a[b"],
    ["an iprivate code point in a fragment", `https://example.test/#a?\uE000`],
  ])("rejects an Atom IRI containing %s", (_label, id) => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>${id}</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content>Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it("rejects lowercase t and z because Atom requires uppercase date-time separators", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28t00:00:00z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28t00:00:00z</updated><content>Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it("preserves a fragment-bearing Atom IRI as a strong character-for-character identity", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>https://example.test/entry#fragment</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content>Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "conformant",
    );
    expect(
      result.feed.entries[0].materialization.quality.identityConfidence,
    ).toBe("strong");
  });

  it("rejects invalid percent encoding in an Atom IRI reference", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><link rel="related" href="https://example.test/%zz"/><content>Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it.each([
    ["duplicate source constructs", "<source/><source/>"],
    ["duplicate rights constructs", "<rights>One</rights><rights>Two</rights>"],
  ])("rejects an Atom entry containing %s", (_label, extra) => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated>${extra}<content>Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it.each([
    [
      "duplicate feed generators",
      "<generator>one</generator><generator>two</generator>",
    ],
    [
      "invalid feed rights markup",
      '<rights><x:v xmlns:x="urn:example">Bad</x:v></rights>',
    ],
  ])("rejects an Atom feed containing %s", (_label, extra) => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author>${extra}<entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content>Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it.each([
    [
      "duplicate source ids",
      "<id>tag:example.test,2026:s1</id><id>tag:example.test,2026:s2</id>",
    ],
    [
      "invalid source rights markup",
      '<rights><x:v xmlns:x="urn:example">Bad</x:v></rights>',
    ],
  ])("rejects an Atom source containing %s", (_label, sourceBody) => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Feed author</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><source><author><name>Source author</name></author>${sourceBody}</source><content>Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it("accepts a percent-encoded Atom link relation token", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><link rel="foo%20bar" href="https://example.test/e"/><content>Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "conformant",
    );
  });

  it("accepts an Atom link relation containing an RFC 3987 ucschar", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><link rel="foo·bar" href="https://example.test/e"/><content>Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "conformant",
    );
  });

  it.each([
    [
      "an Atom entry child",
      "<entry><id>tag:example.test,2026:nested</id><title>Nested</title><updated>2026-08-28T00:00:00Z</updated></entry>",
    ],
    ["a category without term", "<category/>"],
    ["a contributor without name", "<contributor/>"],
  ])("rejects an Atom source containing %s", (_label, sourceBody) => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Feed author</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><source>${sourceBody}</source><content>Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it("requires out-of-line Atom content to be lexically empty", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content type="text/plain" src="https://example.test/body"> </content><summary>Body</summary></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it("sanitizes inline Atom text/html MIME content as HTML", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content type="text/html">&lt;p&gt;Hello &lt;strong&gt;world&lt;/strong&gt;&lt;/p&gt;</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.feed.entries[0];
    expect(entry.materialization.quality.conformance).toBe("conformant");
    expect(
      entry.materialization.representations.find(
        (value) => value.purpose === "selection",
      )?.content,
    ).toBe("Hello world");
  });

  it.each([
    [
      "Atom",
      `<feed xmlns="http://www.w3.org/2005/Atom"><title>Empty Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author></feed>`,
    ],
    [
      "RSS",
      `<rss version="2.0"><channel><title>Empty RSS</title><link>https://example.test/</link><description>No entries yet</description></channel></rss>`,
    ],
  ])("accepts a standards-conformant empty %s feed", (_dialect, xml) => {
    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries).toEqual([]);
  });

  it("accepts empty Atom title text constructs while using a display fallback", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title/><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title/><updated>2026-08-28T00:00:00Z</updated><content>Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problems).toEqual([]);
    expect(result.feed.entries[0].title).toBe("Untitled entry");
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "conformant",
    );
  });

  it("rejects an invalid xml:base instead of silently inheriting the parent base", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry xml:base="http://["><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content>Body</content></entry></feed>`;

    expect(normalizeFeedCapture(capture(xml))).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({
          code: "SOURCE_XML_BASE_INVALID",
          severity: "fatal",
        }),
      ],
    });
  });

  it("rejects XML with more than one document element", () => {
    const xml = `<rss version="2.0"><channel><title>Feed</title><link>https://example.test/</link><description>Updates</description></channel></rss><extra/>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({
          code: "SOURCE_XML_MULTIPLE_ROOTS",
          severity: "fatal",
        }),
      ],
    });
  });

  it("rejects an RSS document containing more than one channel", () => {
    const channel = `<channel><title>Feed</title><link>https://example.test/</link><description>Updates</description></channel>`;
    const result = normalizeFeedCapture(
      capture(`<rss version="2.0">${channel}${channel}</rss>`),
    );

    expect(result).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({
          code: "SOURCE_RSS_CHANNEL_MULTIPLE",
          severity: "fatal",
        }),
      ],
    });
  });

  it.each([
    [
      "Atom",
      `<feed xmlns="http://www.w3.org/2005/Atom"/>`,
      "SOURCE_ATOM_FEED_NONCONFORMANT",
    ],
    [
      "RSS",
      `<rss version="2.0"><channel/></rss>`,
      "SOURCE_RSS_FEED_NONCONFORMANT",
    ],
  ])(
    "reports a nonconformant empty %s feed instead of presenting it as healthy",
    (_dialect, xml, expectedCode) => {
      const result = normalizeFeedCapture(capture(xml));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.feed.entries).toEqual([]);
      expect(result.problems).toContainEqual(
        expect.objectContaining({ code: expectedCode, severity: "warning" }),
      );
    },
  );

  it("allows an HTML doctype example inside RSS CDATA while still forbidding an XML DTD", () => {
    const xml = `<rss version="2.0"><channel><title>Feed</title><link>https://example.test/</link><description>Updates</description><item><guid>one</guid><title>Example</title><description><![CDATA[Example code: <!DOCTYPE html>]]></description></item></channel></rss>`;
    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.feed.entries[0].materialization.representations.find(
        (value) => value.purpose === "selection",
      )?.content,
    ).toContain("Example code");

    const dtdResult = normalizeFeedCapture(
      capture(
        `<!DOCTYPE rss><rss version="2.0"><channel><title>Feed</title><link>https://example.test/</link><description>Updates</description></channel></rss>`,
      ),
    );
    expect(dtdResult).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({
          code: "SOURCE_XML_DTD_FORBIDDEN",
          severity: "fatal",
        }),
      ],
    });
  });

  it.each([
    ["an uppercase reserved target", '<?XML version="1.0"?>'],
    ["a mixed-case reserved processing instruction", "<?xMl whatever?>"],
    ["an unsupported XML version", '<?xml version="2.0"?>'],
    ["a missing version declaration", "<?xml?>"],
    [
      "an invalid standalone declaration",
      '<?xml version="1.0" standalone="maybe"?>',
    ],
    [
      "declaration attributes in the wrong order",
      '<?xml version="1.0" standalone="yes" encoding="UTF-8"?>',
    ],
    ["leading whitespace before the declaration", ' <?xml version="1.0"?>'],
  ])("rejects %s", (_label, declaration) => {
    const xml = `${declaration}<rss version="2.0"><channel><title>Feed</title><link>https://example.test/</link><description>Updates</description></channel></rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({
          code: "SOURCE_XML_DECLARATION_INVALID",
          severity: "fatal",
        }),
      ],
    });
  });

  it("allows a non-reserved processing instruction and a complete XML declaration", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes'?><?xml-stylesheet href="feed.xsl"?><rss version="2.0"><channel><title>Feed</title><link>https://example.test/</link><description>Updates</description></channel></rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
  });

  it.each([
    [
      "an explicitly empty out-of-line type",
      '<content src="https://example.test/body" type=""/><summary>Evidence</summary>',
    ],
    ["an uppercase text keyword", '<content type="TEXT">Evidence</content>'],
    [
      "an uppercase summary keyword",
      '<content type="text">Body</content><summary type="HTML">Evidence</summary>',
    ],
  ])("does not collapse Atom type semantics for %s", (_label, content) => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated>${content}</entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it("does not use source authors to satisfy the feed-level author requirement", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><source><author><name>Source author</name></author></source><content type="text">Evidence</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it.each([
    [
      "child markup",
      '<updated xmlns:x="https://example.test/ext"><x:v>2026-08-28T00:00:00Z</x:v></updated>',
    ],
    [
      "a leap second away from a leap-second boundary",
      "<updated>2026-01-01T12:00:60Z</updated>",
    ],
  ])("rejects an Atom date construct containing %s", (_label, updated) => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id>${updated}<author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title>${updated}<content type="text">Evidence</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].publishedAt).toBeUndefined();
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it("accepts an Atom leap second at the end of June", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-06-30T23:59:60Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-06-30T23:59:60Z</updated><content type="text">Evidence</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "conformant",
    );
  });

  it("allows an empty XHTML div as valid inline Atom content", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Empty body</title><updated>2026-08-28T00:00:00Z</updated><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"/></content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "conformant",
    );
  });

  it("does not label a non-2.0 RSS document conformant", () => {
    const xml = `<rss version="1.0"><channel><title>RSS feed</title><link>https://example.test/</link><description>Updates</description><item><title>Entry</title><description>Evidence</description></item></channel></rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it("requires an RSS channel link URI and RFC 822 item publication date", () => {
    const xml = `<rss version="2.0"><channel><title>RSS feed</title><link>not a URI</link><description>Updates</description><item><title>Entry</title><description>Evidence</description><pubDate>2026-08-28T00:00:00Z</pubDate></item></channel></rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].publishedAt).toBeUndefined();
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
    expect(
      result.feed.entries[0].materialization.quality.warnings.map(
        (value) => value.code,
      ),
    ).toContain("SOURCE_RSS_ITEM_NONCONFORMANT");
  });

  it("does not treat a non-web RSS channel link as conformant", () => {
    const xml = `<rss version="2.0"><channel><title>RSS feed</title><link>javascript:alert(1)</link><description>Updates</description><item><title>Entry</title><description>Evidence</description></item></channel></rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it("accepts the two-digit year form allowed by RFC 822 RSS dates", () => {
    const xml = `<rss version="2.0"><channel><title>RSS feed</title><link>https://example.test/</link><description>Updates</description><item><title>Entry</title><description>Evidence</description><pubDate>28 Aug 26 00:00:00 GMT</pubDate></item></channel></rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].publishedAt).toBe("2026-08-28T00:00:00.000Z");
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "conformant",
    );
  });

  it("normalizes an RFC 822 military timezone in an RSS date", () => {
    const xml = `<rss version="2.0"><channel><title>RSS feed</title><link>https://example.test/</link><description>Updates</description><item><title>Entry</title><description>Evidence</description><pubDate>28 Aug 2026 10:00:00 A</pubDate></item></channel></rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].publishedAt).toBe("2026-08-28T09:00:00.000Z");
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "conformant",
    );
  });

  it.each([
    ["an invalid item link", "<link>http://[</link>"],
    ["a non-web item link", "<link>javascript:alert(1)</link>"],
    ["an invalid default-permalink guid", "<guid>http://[</guid>"],
    ["a non-web default-permalink guid", "<guid>javascript:alert(1)</guid>"],
    [
      "an invalid explicit permalink guid",
      '<guid isPermaLink="true">http://[</guid>',
    ],
    [
      "a non-web explicit permalink guid",
      '<guid isPermaLink="true">javascript:alert(1)</guid>',
    ],
  ])("rejects an RSS item with %s", (_label, itemField) => {
    const xml = `<rss version="2.0"><channel><title>RSS feed</title><link>https://example.test/</link><description>Updates</description><item><title>Entry</title><description>Evidence</description>${itemField}</item></channel></rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it("accepts an XML 1.0 UTF-16LE feed and verifies identity over the original bytes", () => {
    const xml = `<?xml version="1.0" encoding="UTF-16"?><rss version="2.0"><channel><title>UTF-16 feed</title><link>https://example.test/</link><description>Updates</description><item><title>Entry</title><description>Evidence</description></item></channel></rss>`;
    const encoded = Buffer.from(`\ufeff${xml}`, "utf16le");
    const input = capture("<unused />");

    const result = normalizeFeedCapture({
      ...input,
      capture: {
        ...input.capture,
        bytes: encoded,
        contentIdentity: sha256(encoded),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.title).toBe("UTF-16 feed");
  });

  it.each(
    (
      [
        "maxBytes",
        "maxDepth",
        "maxEntries",
        "maxEntryOutputBytes",
        "maxNodes",
        "maxTotalOutputBytes",
      ] as const
    ).flatMap((field) =>
      [Number.NaN, Number.POSITIVE_INFINITY].map((value) => ({ field, value })),
    ),
  )("rejects a non-finite $field normalization budget", ({ field, value }) => {
    const xml = `<rss version="2.0"><channel><title>Feed</title><link>https://example.test/</link><description>Updates</description></channel></rss>`;
    const input = capture(xml);

    const result = normalizeFeedCapture({
      ...input,
      budget: { ...input.budget, [field]: value },
    });

    expect(result).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({
          code: "SOURCE_BUDGET_INVALID",
          severity: "fatal",
        }),
      ],
    });
  });

  it("bounds the aggregate materialization output for a feed", () => {
    const body = "Bounded evidence ".repeat(40);
    const xml = `<rss version="2.0"><channel><title>Feed</title><item><guid>one</guid><title>One</title><description>${body}</description></item><item><guid>two</guid><title>Two</title><description>${body}</description></item></channel></rss>`;
    const input = capture(xml);

    const unrestricted = normalizeFeedCapture(input);
    expect(unrestricted.ok).toBe(true);
    if (!unrestricted.ok) return;
    const oneEntryOutcome = {
      ...unrestricted,
      feed: {
        ...unrestricted.feed,
        entries: unrestricted.feed.entries.slice(0, 1),
      },
      problems: [
        {
          code: "SOURCE_FEED_OUTPUT_BUDGET_EXCEEDED",
          recoverBy: "acquire-linked-source",
          scope: "representation",
          severity: "warning",
        },
      ],
    };
    const oneEntryBudget = Buffer.byteLength(
      JSON.stringify(oneEntryOutcome),
      "utf8",
    );

    const result = normalizeFeedCapture({
      ...input,
      budget: { ...input.budget, maxTotalOutputBytes: oneEntryBudget },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries).toHaveLength(1);
    expect(result.problems.map((value) => value.code)).toContain(
      "SOURCE_FEED_OUTPUT_BUDGET_EXCEEDED",
    );
    expect(
      Buffer.byteLength(JSON.stringify(result), "utf8"),
    ).toBeLessThanOrEqual(oneEntryBudget);
  });

  it("applies the entry budget to the complete serialized normalized entry", () => {
    const xml = `<rss version="2.0"><channel><title>Feed</title><item><guid>one</guid><title>One</title><description>Small body</description></item></channel></rss>`;
    const input = capture(xml);

    const result = normalizeFeedCapture({
      ...input,
      budget: { ...input.budget, maxEntryOutputBytes: 1_000 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((value) => value.code)).toEqual(
      expect.arrayContaining([
        "SOURCE_ENTRY_REJECTED",
        "SOURCE_NO_USABLE_ENTRIES",
      ]),
    );
  });

  it("preserves Atom XHTML mixed-content order and resolves the nearest xml:base", () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://example.test/">
        <title>Atom feed</title>
        <entry xml:base="posts/">
          <id>tag:example.test,2026:entry-1</id>
          <title>Ordered inline content</title>
          <updated>2026-08-28T00:00:00Z</updated>
          <link rel="alternate" href="entry-1" />
          <content type="xhtml">
            <div xmlns="http://www.w3.org/1999/xhtml"><p>Hello <a xml:base="../assets/" href="paper">paper</a> after.</p></div>
          </content>
        </entry>
      </feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.feed.entries[0];
    const agent = entry.materialization.representations.find(
      (value) => value.purpose === "agent",
    );
    const selection = entry.materialization.representations.find(
      (value) => value.purpose === "selection",
    );
    expect(entry.link).toBe("https://example.test/posts/entry-1");
    expect(agent?.content).toContain(
      "Hello [paper](https://example.test/assets/paper) after.",
    );
    expect(selection?.content).toContain("Hello paper after.");
  });

  it("rejects malformed feed XML instead of silently repairing it", () => {
    const xml = `<rss version="2.0"><channel><title>Broken</title><item><guid>1</guid><title>Entry</title></channel></rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result).toEqual({
      ok: false,
      problems: [
        {
          code: "SOURCE_FEED_INVALID",
          recoverBy: "none",
          scope: "capture",
          severity: "fatal",
        },
      ],
    });
  });

  it("rejects an unbound namespace prefix instead of treating it as RSS core", () => {
    const xml = `<rss version="2.0"><channel><title>Broken namespace</title><item><guid>1</guid><title>Entry</title><foo:description>not core</foo:description></item></channel></rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.code).toBe("SOURCE_XML_NAMESPACE_UNBOUND");
  });

  it("does not treat declaration-looking text inside an ordinary processing instruction as an XML declaration", () => {
    const xml = `<?foo <?xml fake?><rss version="2.0"><channel><title>PI feed</title><link>https://example.test/</link><description>Feed</description><item><guid isPermaLink="false">1</guid><title>Entry</title></item></channel></rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
  });

  it.each([
    ["a rebound xml prefix", 'xmlns:xml="urn:evil"'],
    ["a declared xmlns prefix", 'xmlns:xmlns="urn:evil"'],
    [
      "a namespace name that is not an IRI reference",
      'xmlns:a="bad space" a:x="1"',
    ],
    [
      "duplicate expanded attribute names",
      'xmlns:a="urn:a" xmlns:b="urn:a" a:x="1" b:x="2"',
    ],
    ["an attribute QName with two colons", 'xmlns:a="urn:a" a:x:y="1"'],
  ])("rejects namespace-invalid XML with %s", (_label, attributes) => {
    const xml = `<rss version="2.0" ${attributes}><channel><title>Broken namespace</title><link>https://example.test/</link><description>Feed</description><item><guid isPermaLink="false">1</guid><title>Entry</title></item></channel></rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.code).toBe("SOURCE_XML_NAMESPACE_INVALID");
  });

  it("keeps encoded angle brackets as text inside Atom XHTML", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <title>Atom feed</title>
      <entry>
        <id>tag:example.test,2026:literal</id>
        <title>Literal markup</title>
        <updated>2026-08-28T00:00:00Z</updated>
        <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">&lt;script&gt;literal&lt;/script&gt;<p>After</p></div></content>
      </entry>
    </feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const selection =
      result.feed.entries[0].materialization.representations.find(
        (value) => value.purpose === "selection",
      );
    expect(selection?.content).toContain("<script>literal</script>");
    expect(selection?.content).toContain("After");
  });

  it("marks Atom XHTML containing a foreign-namespace descendant as nonconformant", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>tag:example.test,2026:feed</id><updated>2026-08-28T00:00:00Z</updated><author><name>Researcher</name></author><entry><id>tag:example.test,2026:entry</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><svg xmlns="http://www.w3.org/2000/svg"><circle/></svg></div></content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.entries[0].materialization.quality.conformance).toBe(
      "nonconformant",
    );
  });

  it.each([
    {
      candidate: `<content type="text"># Not a heading and [label](https://example.test/not-a-link)</content>`,
      sourcePath: "atom.feed.entry.content",
    },
    {
      candidate: `<summary type="text"># Not a heading and [label](https://example.test/not-a-link)</summary>`,
      sourcePath: "atom.feed.entry.summary",
    },
  ])(
    "treats Atom $sourcePath type=text as literal text",
    ({ candidate, sourcePath }) => {
      const literal =
        "# Not a heading and [label](https://example.test/not-a-link)";
      const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <title>Atom feed</title>
      <entry>
        <id>tag:example.test,2026:literal-text</id>
        <title>Literal text</title>
        <updated>2026-08-28T00:00:00Z</updated>
        ${candidate}
      </entry>
    </feed>`;

      const result = normalizeFeedCapture(capture(xml));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const entry = result.feed.entries[0];
      expect(
        entry.materialization.provenance.selectedCandidate.sourcePath,
      ).toBe(sourcePath);
      const reader = entry.materialization.representations.find(
        (value) => value.purpose === "reader",
      );
      const agent = entry.materialization.representations.find(
        (value) => value.purpose === "agent",
      );
      const selection = entry.materialization.representations.find(
        (value) => value.purpose === "selection",
      );
      expect(JSON.parse(reader?.content ?? "")).toMatchObject({
        children: [
          { children: [{ type: "text", value: literal }], type: "paragraph" },
        ],
        type: "root",
      });
      expect(agent?.content).toContain("\\# Not a heading and \\[label]");
      expect(agent?.content).not.toContain(
        "[label](https://example.test/not-a-link)",
      );
      expect(selection?.content).toBe(literal);
    },
  );

  it("applies a bounded Medium profile only when the feed declares strong evidence", () => {
    const mediumXml = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
      <channel><title>Medium publication</title><generator>Medium</generator><item>
        <guid isPermaLink="false">https://medium.com/p/abc123</guid><title>Profiled</title>
        <link>https://medium.com/p/abc123?source=rss-test</link>
        <content:encoded><![CDATA[<p>Kept body</p><img src="https://medium.com/_/stat?event=post.clientViewed&referrerSource=full_rss&postId=abc123" width="1" height="1"><img alt="near miss" src="https://medium.com/_/stat?event=other&referrerSource=full_rss&postId=abc123" width="1" height="1">]]></content:encoded>
      </item></channel>
    </rss>`;
    const weakSignalXml = mediumXml.replace(
      "<generator>Medium</generator>",
      "",
    );

    const profiled = normalizeFeedCapture(
      capture(mediumXml, "https://medium.com/feed/publication"),
    );
    const generic = normalizeFeedCapture(
      capture(weakSignalXml, "https://medium.com/feed/publication"),
    );

    expect(profiled.ok).toBe(true);
    expect(generic.ok).toBe(true);
    if (!profiled.ok || !generic.ok) return;
    expect(profiled.feed.entries[0].sourceFingerprint).toBe(
      generic.feed.entries[0].sourceFingerprint,
    );
    expect(profiled.feed.entries[0].materialization.identity).not.toBe(
      generic.feed.entries[0].materialization.identity,
    );
    expect(profiled.feed.producer).toMatchObject({
      key: "medium",
      evidence: [
        { field: "feed.generator", strength: "strong", value: "Medium" },
      ],
    });
    const profiledMaterialization = profiled.feed.entries[0].materialization;
    expect(profiledMaterialization.provenance.rulesApplied).toContain(
      "medium.remove-tracking-pixel",
    );
    expect(new Set(profiledMaterialization.provenance.rulesApplied).size).toBe(
      profiledMaterialization.provenance.rulesApplied.length,
    );
    const agent = profiledMaterialization.representations.find(
      (value) => value.purpose === "agent",
    )?.content;
    const readerV2 = profiledMaterialization.representations.find(
      (value) => value.schema === "reader.document.v2",
    )?.content;
    expect(agent).not.toContain("event=post.clientViewed");
    expect(agent).toContain("event=other");
    expect(readerV2).not.toContain("event=post.clientViewed");
    expect(readerV2).toContain("event=other");
    expect(generic.feed.producer).toEqual({
      evidence: [],
      key: "generic",
      version: "1",
    });
  });

  it("drops an unlabeled explicit 1x1 tracking pixel from every rendered projection", () => {
    const xml = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Generic</title><item>
      <guid>pixel-entry</guid><title>Pixel policy</title><link>https://example.test/pixel-entry</link>
      <content:encoded><![CDATA[<p>Kept evidence.</p><img src="https://tracker.test/pixel.gif?event=open" width="1" height="1"><img src="/small-result.png" width="1" height="1" alt="Measured one-pixel result">]]></content:encoded>
    </item></channel></rss>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const materialization = result.feed.entries[0].materialization;
    const rendered = materialization.representations
      .map((representation) => representation.content)
      .join("\n");
    expect(rendered).not.toContain("tracker.test/pixel.gif");
    expect(rendered).toContain("small-result.png");
    expect(materialization.provenance.rulesApplied).toContain(
      "generic.remove-tracking-pixel",
    );
    const readerV2 = JSON.parse(
      materialization.representations.find(
        (representation) => representation.schema === "reader.document.v2",
      )?.content ?? "{}",
    );
    expect(readerV2.losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TRACKING_PIXEL_DROPPED",
          fallback: "omitted",
          sourceTag: "img",
        }),
      ]),
    );
  });

  it.each([
    {
      dialect: "rss",
      expectedKey: "wordpress",
      generator: "<generator>https://wordpress.org/?v=6.6.1</generator>",
      label: "WordPress",
    },
    {
      dialect: "rss",
      expectedKey: "ghost",
      generator: "<generator>Ghost 5.87.1</generator>",
      label: "Ghost",
    },
    {
      dialect: "rss",
      expectedKey: "substack",
      generator: "<generator>Substack</generator>",
      label: "Substack",
    },
    {
      dialect: "rss",
      expectedKey: "hugo",
      generator: "<generator>Hugo 0.128.0</generator>",
      label: "Hugo",
    },
    {
      dialect: "atom",
      expectedKey: "jekyll-feed",
      generator:
        '<generator uri="https://jekyllrb.com/" version="0.17.0">Jekyll</generator>',
      label: "Jekyll-feed",
    },
    {
      dialect: "atom",
      expectedKey: "hexo",
      generator: '<generator uri="https://hexo.io/">Hexo</generator>',
      label: "Hexo",
    },
    {
      dialect: "rss",
      expectedKey: "generic",
      generator: "<generator>WordPress</generator>",
      label: "unverified WordPress claim",
    },
  ] as const)(
    "detects the $label producer profile from declared generator evidence",
    ({ dialect, expectedKey, generator }) => {
      const xml =
        dialect === "rss"
          ? `<rss version="2.0"><channel><title>Profile feed</title>${generator}<item><guid>entry-1</guid><title>Entry</title><description>Body</description></item></channel></rss>`
          : `<feed xmlns="http://www.w3.org/2005/Atom"><title>Profile feed</title>${generator}<entry><id>tag:example.test,2026:entry-1</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content type="text">Body</content></entry></feed>`;

      const result = normalizeFeedCapture(capture(xml));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.feed.producer.key).toBe(expectedKey);
      expect(result.feed.producer.version).toBe("1");
      if (expectedKey === "generic") {
        expect(result.feed.producer.evidence).toEqual([]);
      } else {
        expect(result.feed.producer.evidence.length).toBeGreaterThan(0);
        expect(
          result.feed.producer.evidence.every(
            (value) => value.strength === "strong",
          ),
        ).toBe(true);
      }
    },
  );

  it.each([
    {
      dialect: "atom",
      generator: "<generator>Medium</generator>",
      label: "Medium in Atom",
    },
    {
      dialect: "atom",
      generator: "<generator>Ghost 5.87.1</generator>",
      label: "Ghost in Atom",
    },
    {
      dialect: "rss",
      generator: "<generator>Jekyll</generator>",
      label: "Jekyll in RSS",
    },
    {
      dialect: "rss",
      generator: "<generator>Ghost</generator>",
      label: "bare Ghost",
    },
    {
      dialect: "atom",
      generator: "<generator>Hexo</generator>",
      label: "Hexo Atom without URI",
    },
  ] as const)(
    "does not activate a producer profile from unsupported evidence: $label",
    ({ dialect, generator }) => {
      const xml =
        dialect === "rss"
          ? `<rss version="2.0"><channel><title>Profile feed</title>${generator}<item><guid>entry-1</guid><title>Entry</title><description>Body</description></item></channel></rss>`
          : `<feed xmlns="http://www.w3.org/2005/Atom"><title>Profile feed</title>${generator}<entry><id>tag:example.test,2026:entry-1</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content type="text">Body</content></entry></feed>`;

      const result = normalizeFeedCapture(capture(xml));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.feed.producer).toEqual({
        evidence: [],
        key: "generic",
        version: "1",
      });
    },
  );

  it("recognizes the official WordPress Atom generator tuple", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>WordPress Atom</title><generator uri="https://wordpress.org/" version="6.6.1">WordPress</generator><entry><id>tag:example.test,2026:entry-1</id><title>Entry</title><updated>2026-08-28T00:00:00Z</updated><content type="text">Body</content></entry></feed>`;

    const result = normalizeFeedCapture(capture(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feed.producer.key).toBe("wordpress");
    expect(result.feed.producer.evidence.map((value) => value.field)).toEqual([
      "feed.generator.text",
      "feed.generator.uri",
      "feed.generator.version",
    ]);
  });
});
