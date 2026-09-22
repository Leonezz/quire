import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ReleaseFeedError, htmlToPlainText, parseReleaseFeed } from "./release-feed";
import { pickLatestRelease } from "./updates";

const fixture = readFileSync(fileURLToPath(new URL("./__fixtures__/github-releases.atom", import.meta.url)), "utf8");
const RELEASES_URL = "https://github.com/Leonezz/quire/releases";

describe("parseReleaseFeed", () => {
  it("reads every entry of GitHub's releases feed: the tag from the id, the page, the time, the notes as plain text", () => {
    const releases = parseReleaseFeed(fixture);
    expect(releases).toEqual([
      { tag_name: "v0.2.0-alpha.1", html_url: `${RELEASES_URL}/tag/v0.2.0-alpha.1`, published_at: "2026-09-20T09:00:00Z", body: 'Alpha of the 0.2 line.\n- Reader: faster scroll & search\n- Fix "stuck" sync' },
      { tag_name: "nightly", html_url: `${RELEASES_URL}/tag/nightly`, published_at: "2026-09-19T02:00:00Z", body: "Rolling build." },
      { tag_name: "v0.1.0", html_url: `${RELEASES_URL}/tag/v0.1.0`, published_at: "2026-09-01T12:30:00Z", body: "First release." },
    ]);
    // The same choice as over the API: the newest semver tag, prereleases included, the non-semver tag ignored.
    expect(pickLatestRelease(releases)?.release.tag_name).toBe("v0.2.0-alpha.1");
  });

  it("accepts an empty feed, a CDATA body and a link without rel, and falls back to the title when the id has no tag", () => {
    const head = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Releases</title>';
    expect(parseReleaseFeed(`${head}</feed>`)).toEqual([]);
    const entry = `<entry><id>urn:uuid:1</id><title>v1.0.0</title><link href="${RELEASES_URL}/tag/v1.0.0"/><content type="html"><![CDATA[<p>Done &amp; dusted</p>]]></content></entry>`;
    expect(parseReleaseFeed(`${head}${entry}</feed>`)).toEqual([{ tag_name: "v1.0.0", html_url: `${RELEASES_URL}/tag/v1.0.0`, body: "Done & dusted" }]);
    expect(parseReleaseFeed(`${head}<entry><id>tag:x/v2.0.0</id><link href="${RELEASES_URL}/tag/v2.0.0"/></entry></feed>`)).toEqual([{ tag_name: "v2.0.0", html_url: `${RELEASES_URL}/tag/v2.0.0`, body: null }]);
  });

  it("refuses what is not a feed of releases, so the caller can fall back to the API", () => {
    expect(() => parseReleaseFeed("<!doctype html><html><body>Rate limited</body></html>")).toThrow(ReleaseFeedError);
    expect(() => parseReleaseFeed("")).toThrow(/not an Atom document/);
    expect(() => parseReleaseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>no id, no link</title></entry></feed>')).toThrow(/none names a release tag and page/);
  });
});

describe("htmlToPlainText", () => {
  it("turns block ends into line breaks, list items into dashes, drops tags and scripts, and decodes entities", () => {
    expect(htmlToPlainText("<h2>What&#39;s new</h2>\n<p>A &lt;b&gt; that is\n  text.<br>Second line.</p><script>alert(1)</script>\n<ol>\n<li>One</li>\n<li>Two &#x2014; dash</li>\n</ol>\n\n\n<p>Tail</p>"))
      .toBe("What's new\nA <b> that is text.\nSecond line.\n- One\n- Two — dash\n\nTail");
    expect(htmlToPlainText("<pre><code>a = 1\nb = 2</code></pre>")).toBe("a = 1\nb = 2");
    expect(htmlToPlainText("")).toBe("");
  });
});
