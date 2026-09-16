import { afterEach, describe, expect, it } from "vitest";
import { findArticleText, indexArticleText } from "./article-text-search";

function reader(html: string) {
  const root = document.createElement("article");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}
afterEach(() => {
  document.body.replaceChildren();
});

describe("article text search", () => {
  it("matches phrases across inline markup and code tokens without changing nodes or existing ranges", () => {
    const root = reader(
      '<p>Protocol <strong>version</strong> <a href="#section">negotiation</a>.</p><pre><code><span>protocol</span> version\nnegotiation</code></pre>',
    );
    const original = root.innerHTML;
    const textNode = root.querySelector("strong")!.firstChild!;
    const annotation = document.createRange();
    annotation.selectNodeContents(textNode);
    const result = findArticleText(
      indexArticleText(root),
      "PROTOCOL version negotiation",
    );
    expect(result.ranges.map((range) => range.toString())).toEqual([
      "Protocol version negotiation",
      "protocol version\nnegotiation",
    ]);
    expect(root.innerHTML).toBe(original);
    expect(root.querySelector("strong")!.firstChild).toBe(textNode);
    expect(annotation.toString()).toBe("version");
  });

  it("keeps paragraph and table-cell boundaries while accepting line breaks within a paragraph", () => {
    const root = reader(
      "<p>protocol</p><p>version</p><table><tr><td>protocol</td><td>version</td></tr></table><p>protocol<br>version</p>",
    );
    const result = findArticleText(indexArticleText(root), "protocol version");
    expect(result.ranges).toHaveLength(1);
    expect(result.ranges[0].startContainer.parentElement?.tagName).toBe("P");
    expect(
      findArticleText(
        indexArticleText(reader("<p>some thing</p>")),
        "something",
      ).ranges,
    ).toHaveLength(0);
  });

  it("ignores hidden content, formula duplicates and reader controls; closed details expose only their summary", () => {
    const root = reader(
      '<p>Visible token<button>token</button><span hidden>token</span><span aria-hidden="true">token</span><span style="display:none">token</span><span class="sr-only">token</span></p><span data-reader-math-status="rendered"><span>token</span><math><mi>token</mi></math></span><details><summary>token</summary><p>token</p></details>',
    );
    expect(
      findArticleText(indexArticleText(root), "token").ranges,
    ).toHaveLength(2);
    root.querySelector("details")!.open = true;
    expect(
      findArticleText(indexArticleText(root), "token").ranges,
    ).toHaveLength(3);
  });

  it("searches literal punctuation and Unicode with exact native UTF-16 offsets", () => {
    const root = reader("<p>😀 C++26 [a.b] 中文正文 CAFÉ</p>");
    for (const query of ["😀", "C++26", "[a.b]", "中文正文", "café"]) {
      const { ranges } = findArticleText(indexArticleText(root), query);
      expect(ranges).toHaveLength(1);
      expect(ranges[0].toString().toLowerCase()).toBe(query.toLowerCase());
    }
  });

  it("reports an explicit result limit only when additional matches exist", () => {
    const index = indexArticleText(reader("<p>match match match</p>"));
    expect(findArticleText(index, "   ")).toEqual({
      ranges: [],
      limited: false,
    });
    expect(findArticleText(index, "absent").ranges).toHaveLength(0);
    expect(findArticleText(index, "match", 2)).toMatchObject({
      limited: true,
      ranges: [expect.any(Range), expect.any(Range)],
    });
    expect(findArticleText(index, "match", 3).limited).toBe(false);
  });
});
