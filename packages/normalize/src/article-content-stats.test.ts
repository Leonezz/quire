import { beforeEach, describe, expect, it, vi } from "vitest";

const linkedom = vi.hoisted(() => ({ parseHTML: vi.fn() }));

vi.mock("linkedom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("linkedom")>();
  linkedom.parseHTML.mockImplementation(actual.parseHTML);
  return { ...actual, parseHTML: linkedom.parseHTML };
});

import { memoizedContentStats } from "./article-content-stats";

const ARTICLE = [
  "<h2>Results</h2>",
  `<p>Read <a href="/a">this</a> and <a href="/b">that</a><sup id="fnref1"><a href="#fn1">1</a></sup>.</p>`,
  "<pre><code>x = 1</code></pre>",
  `<figure><picture><source srcset="/w.webp"><img src="/w.png" alt=""></picture><figcaption>Wide</figcaption></figure>`,
  `<img src="/inline.png" alt="">`,
  "<table><tr><td>1</td></tr></table>",
  "<p>Euler: \\(e^{i\\pi} + 1 = 0\\)</p>",
  "<ul><li>One</li></ul>",
  "<details><summary>More</summary>Hidden</details>",
  "<cite>A book</cite>",
  `<section class="footnotes"><ol><li id="fn1">Note.</li></ol></section>`,
  // Never article content: their text, images, links and tables are not counted.
  `<script>document.write("<img src='/x.png'><a href='/y'>y</a>")</script>`,
  `<noscript><img src="/lazy.png"></noscript>`,
  `<svg><a href="/in-svg"><text>drawn</text></a></svg>`,
  "<template><table><tr><td>t</td></tr></table></template>",
  "<style>p { color: red }</style>",
].join("");

describe("memoizedContentStats", () => {
  beforeEach(() => {
    linkedom.parseHTML.mockClear();
  });

  it("counts the rich structure and text a reader sees, leaving out scripts, styles, templates and embeds", () => {
    const stats = memoizedContentStats()(ARTICLE);

    // pre, figure, picture, image, table, math, noteref, endnotes, link, citation, heading, list, details.
    expect(stats.richUnits).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 3, 1, 1, 2, 1]);
    expect(stats.textCharacters).toBe(
      "ResultsRead this and that1.x = 1Wide1Euler: \\(e^{i\\pi} + 1 = 0\\)OneMoreHiddenA bookNote.".length,
    );
  });

  it("parses each extraction once, however often it is measured", () => {
    const measure = memoizedContentStats();
    const other = "<p>Another candidate.</p>";

    const first = measure(ARTICLE);
    expect(measure(ARTICLE)).toEqual(first);
    measure(other);
    expect(measure(ARTICLE)).toEqual(first);

    expect(linkedom.parseHTML).toHaveBeenCalledTimes(2);
  });

  it("keeps no measurements from one normalization to the next", () => {
    memoizedContentStats()(ARTICLE);
    memoizedContentStats()(ARTICLE);

    expect(linkedom.parseHTML).toHaveBeenCalledTimes(2);
  });
});
