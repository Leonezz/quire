import { describe, expect, it } from "vitest";
import { arxivIdOfUrl, canonicalLinkOf, canonicalUrlOf, materialIdOf, storedIdsOf } from "./material-identity";

const canonical = (raw: string) => canonicalUrlOf(new URL(raw));

describe("canonicalUrlOf", () => {
  it("drops the tracking parameters and the fragment, keeping every other parameter as written", () => {
    expect(canonical("https://example.test/post?utm_source=rss&utm_medium=feed&utm_campaign=x#comments")).toBe("https://example.test/post");
    expect(canonical("https://example.test/post?page=2&utm_source=rss&q=a%20b+c")).toBe("https://example.test/post?page=2&q=a%20b+c");
    const tracking = ["ref=hn", "ref_src=twsrc", "fbclid=1", "gclid=1", "dclid=1", "msclkid=1", "mc_cid=1", "mc_eid=1", "igshid=1", "_hsenc=1", "_hsmi=1", "mkt_tok=1", "yclid=1", "spm=a.b", "share=twitter", "utm_whatever=1"];
    for (const param of tracking) expect(canonical(`https://example.test/post?${param}&keep=1`)).toBe("https://example.test/post?keep=1");
  });

  it("never drops a parameter that picks the content", () => {
    expect(canonical("https://example.test/item?id=42&utm_source=hn")).toBe("https://example.test/item?id=42");
    expect(canonical("https://blog.example.test/?p=123")).toBe("https://blog.example.test/?p=123");
    expect(canonical("https://www.youtube.com/watch?v=abc123&si=share")).toBe("https://www.youtube.com/watch?v=abc123");
    // A WordPress search, not Twitter's share counter.
    expect(canonical("https://blog.example.test/?s=cache")).toBe("https://blog.example.test/?s=cache");
    expect(canonical("https://example.test/player?si=7")).toBe("https://example.test/player?si=7");
    // A git revision on GitHub's and GitLab's APIs.
    expect(canonical("https://api.github.com/repos/o/r/contents/README.md?ref=main")).toBe("https://api.github.com/repos/o/r/contents/README.md?ref=main");
    expect(canonical("https://gitlab.com/api/v4/projects/1/repository/files/a?ref=dev")).toBe("https://gitlab.com/api/v4/projects/1/repository/files/a?ref=dev");
  });

  it("drops the share parameters only on the sites that add them", () => {
    expect(canonical("https://x.com/someone/status/1?s=20")).toBe("https://x.com/someone/status/1");
    expect(canonical("https://mobile.twitter.com/someone/status/1?s=46&ref_src=a")).toBe("https://mobile.twitter.com/someone/status/1");
    expect(canonical("https://youtu.be/abc123?si=xyz&t=30")).toBe("https://youtu.be/abc123?t=30");
    expect(canonical("https://open.spotify.com/episode/abc?si=xyz")).toBe("https://open.spotify.com/episode/abc");
  });

  it("leaves a URL with nothing to drop exactly as the fetch saw it", () => {
    for (const raw of ["https://example.test/post", "https://example.test/a?b=1&c", "https://example.test/a?", "https://example.test/%7Euser/?q=%C3%A9"]) {
      const page = new URL(raw);
      expect(canonicalUrlOf(page)).toBe(page.toString());
    }
  });
});

describe("canonicalLinkOf", () => {
  const page = "https://www.example.test/post/amp?utm_source=rss";

  it("names another page of the same site, resolved and without tracking", () => {
    expect(canonicalLinkOf("/post?utm_campaign=x#top", page)).toBe("https://www.example.test/post");
    expect(canonicalLinkOf("https://example.test/post", page)).toBe("https://example.test/post");
    expect(canonicalLinkOf("https://amp.example.test/post", "https://example.test/post/amp")).toBe("https://amp.example.test/post");
    expect(canonicalLinkOf("https://blog.example.test/post", "https://example.test/blog/post")).toBe("https://blog.example.test/post");
  });

  it("never counts the site's home page, another site, another scheme, the page itself or a broken href", () => {
    for (const href of ["/", "https://example.test/", "https://www.example.test/?lang=en", "https://other.test/post", "https://example.test.evil.test/post", "ftp://example.test/post", "/post/amp?utm_source=other", "http://[bad", undefined, ""]) {
      expect(canonicalLinkOf(href, page)).toBeUndefined();
    }
    expect(canonicalLinkOf("/post", "not a url")).toBeUndefined();
  });
});

describe("arxivIdOfUrl", () => {
  it("reads the id from arxiv.org links only", () => {
    expect(arxivIdOfUrl(new URL("https://arxiv.org/abs/2409.12345v2"))).toBe("2409.12345");
    expect(arxivIdOfUrl(new URL("https://export.arxiv.org/pdf/hep-th/9901001"))).toBe("hep-th/9901001");
    expect(arxivIdOfUrl(new URL("https://scholar.example.test/?q=arxiv.org/abs/2409.12345"))).toBeUndefined();
    expect(arxivIdOfUrl(new URL("https://notarxiv.org/abs/2409.12345"))).toBeUndefined();
  });
});

describe("material ids", () => {
  it("are the same for every tracking variant, and list the id an older version gave the URL as given", () => {
    const clean = materialIdOf(new URL("https://example.test/post"));
    expect(materialIdOf(new URL("https://example.test/post?utm_source=rss#top"))).toBe(clean);
    expect(storedIdsOf(new URL("https://example.test/post#top"))).toEqual([clean]);
    const [first, legacy, ...rest] = storedIdsOf(new URL("https://example.test/post?utm_source=rss"));
    expect(first).toBe(clean);
    expect(legacy).toMatch(/^[a-f0-9]{16}$/);
    expect(legacy).not.toBe(clean);
    expect(rest).toEqual([]);
  });
});
