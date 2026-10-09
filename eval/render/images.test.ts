import { describe, expect, it } from "vitest";
import {
  alignImageSources, buildReferenceImages, buildRenderedImages, imageKeys, imageNodesOf, innermostImageUrl, linkImages, matchImages, parseSrcset,
  referenceCandidates, shortenDataUri, type ReferenceImageFact,
} from "./images";

// Real-looking URLs from the corpus (rendered = the reader payload's url, original = the snapshot's attributes).
const SUBSTACK = (width: number) => `https://substackcdn.com/image/fetch/$s_!C7O6!,w_${width},c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F830ab6f2-146d-46ee-a8c2-a3ba7f9a4d18_677x143.png`;
const MEDIUM_V2 = "https://miro.medium.com/v2/resize:fit:1400/format:webp/1*Ms0ggCGJ2gZqJJlY16wQ4w.png";
const MEDIUM_MAX = "https://miro.medium.com/max/1400/1*Ms0ggCGJ2gZqJJlY16wQ4w.png";

describe("innermostImageUrl", () => {
  it("unwraps proxies that carry the original in the path or a query parameter", () => {
    expect(innermostImageUrl(SUBSTACK(1456))?.href).toBe("https://substack-post-media.s3.amazonaws.com/public/images/830ab6f2-146d-46ee-a8c2-a3ba7f9a4d18_677x143.png");
    expect(innermostImageUrl("https://www.joshwcomeau.com/_next/image/?url=%2Fimages%2Fwhy-react-re-renders%2Fprofiler.png&w=1080&q=75")?.href).toBe("https://www.joshwcomeau.com/images/why-react-re-renders/profiler.png");
    expect(innermostImageUrl("https://www.anthropic.com/_next/image?url=https%3A%2F%2Fwww-cdn.anthropic.com%2Fimages%2F4zrzovbb%2Fwebsite%2F2ff94c62-2200x1660.png&w=3840&q=75")?.href).toBe("https://www-cdn.anthropic.com/images/4zrzovbb/website/2ff94c62-2200x1660.png");
    expect(innermostImageUrl("https://blog.cloudflare.com/_image?href=https%3A%2F%2Fblog.cloudflare.com%2F_emdash%2Fapi%2Fmedia%2Ffile%2F01KW44TZ.png&w=715&h=304")?.href).toBe("https://blog.cloudflare.com/_emdash/api/media/file/01KW44TZ.png");
  });

  it("is undefined for data:, blob: and junk", () => {
    expect(innermostImageUrl("data:image/png;base64,AAAA")).toBeUndefined();
    expect(innermostImageUrl("blob:http://127.0.0.1/1")).toBeUndefined();
    expect(innermostImageUrl("not a url")).toBeUndefined();
  });
});

describe("imageKeys", () => {
  it("reduces size variants of one picture to the same keys", () => {
    expect(imageKeys(SUBSTACK(424))).toEqual(imageKeys(SUBSTACK(1456)));
    expect(imageKeys(MEDIUM_V2)).toEqual(imageKeys(MEDIUM_MAX));
    expect(imageKeys(MEDIUM_V2)).toEqual({ path: "miro.medium.com/1*ms0ggcgj2gzqjjly16wq4w.png", stem: "1*ms0ggcgj2gzqjjly16wq4w" });
    expect(imageKeys("https://kentcdodds.com/media/w_1600/kentcdodds.com/content/blog/ctx/type-error.png").path).toBe(imageKeys("https://kentcdodds.com/media/w_280,bg_e6e9ee/kentcdodds.com/content/blog/ctx/type-error.png").path);
    expect(imageKeys("https://storage.ghost.io/c/eb/content/images/size/w1000/2025/09/mirror-1.jpg").path).toBe(imageKeys("https://storage.ghost.io/c/eb/content/images/2025/09/mirror-1.jpg").path);
  });

  it("strips WordPress, retina and variant suffixes from the stem", () => {
    const stem = (url: string) => imageKeys(url).stem;
    expect(stem("https://i0.wp.com/acoup.blog/wp-content/uploads/2019/05/orc-army-minas-morgul-1.png?resize=926%2C659&ssl=1")).toBe("orc-army-minas-morgul-1");
    expect(stem("https://acoup.blog/wp-content/uploads/2019/05/orc-army-minas-morgul-1-300x213.png")).toBe("orc-army-minas-morgul-1");
    expect(stem("https://e.com/uploads/sunset-scaled.jpg")).toBe("sunset");
    expect(stem("https://e.com/img/chart@2x.png")).toBe("chart");
    expect(stem("https://e.com/img/chart_1x.webp")).toBe("chart");
    expect(stem("https://e.com/img/chart-thumb.jpg")).toBe("chart");
    expect(stem("https://e.com/wp-content/uploads/2020/01/diagram-e1590000000000.png")).toBe("diagram");
    expect(stem("https://lh6.googleusercontent.com/Uu2FEL1uAWCUNtM=w624-h300")).toBe("uu2fel1uawcuntm");
  });

  it("keeps distinct files distinct and leaves generic names to the path", () => {
    expect(imageKeys("https://arxiv.org/html/2609.24983v1/x1.png")).toEqual({ path: "arxiv.org/html/2609.24983v1/x1.png", stem: "x1" });
    expect(imageKeys("https://arxiv.org/html/2609.24983v1/x2.png").stem).toBe("x2");
    expect(imageKeys("https://github.com/user-attachments/assets/a471dfff-00cc-4cb4-8df5-123e195bcc71").stem).toBe("a471dfff-00cc-4cb4-8df5-123e195bcc71");
    expect(imageKeys("https://e.com/a/image.png")).toEqual({ path: "e.com/a/image.png" });
    expect(imageKeys("data:image/png;base64,AAAA")).toEqual({});
  });
});

describe("matchImages", () => {
  it("matches by path first, then by stem, each rendered image at most once, first come first served", () => {
    const reference = [
      { id: "o1", candidates: ["https://acoup.blog/wp-content/uploads/2019/05/orc-army-300x213.png", "https://acoup.blog/wp-content/uploads/2019/05/orc-army.png"] },
      { id: "o2", candidates: ["https://acoup.blog/wp-content/uploads/2019/05/orc-army-1024x700.png"] },
      { id: "o3", candidates: [MEDIUM_MAX] },
      { id: "o4", candidates: ["https://e.com/unrelated.png"] },
    ];
    const rendered = [
      { id: "r1", src: "https://i0.wp.com/acoup.blog/wp-content/uploads/2019/05/orc-army.png?resize=926%2C659&ssl=1" },
      { id: "r2", src: MEDIUM_V2 },
    ];
    expect(Object.fromEntries(matchImages(reference, rendered))).toEqual({ o1: "r1", o3: "r2" });
  });

  it("prefers an exact path over an earlier stem-only match", () => {
    const reference = [{ id: "o1", candidates: ["https://cdn.e.com/x/fig-1.png"] }, { id: "o2", candidates: ["https://e.com/posts/fig-1.png"] }];
    expect(Object.fromEntries(matchImages(reference, [{ id: "r1", src: "https://e.com/posts/fig-1.png" }]))).toEqual({ o2: "r1" });
  });

  it("matches relative arXiv HTML sources once resolved", () => {
    const fact = { src: "", lazy: ["2609.24983v1/img/fig2_agent-v4.png"], srcsets: [] };
    const candidates = referenceCandidates(fact, "https://arxiv.org/html/2609.24983v1");
    expect(candidates).toEqual(["https://arxiv.org/html/2609.24983v1/img/fig2_agent-v4.png"]);
    expect(matchImages([{ id: "o1", candidates }], [{ id: "r1", src: "https://arxiv.org/html/2609.24983v1/img/fig2_agent-v4.png" }]).get("o1")).toBe("r1");
  });
});

describe("parseSrcset", () => {
  it("keeps commas inside URLs and drops descriptors", () => {
    expect(parseSrcset(`${SUBSTACK(424)} 424w, ${SUBSTACK(848)} 848w`)).toEqual([SUBSTACK(424), SUBSTACK(848)]);
    expect(parseSrcset("a.png 1x,b.png 2x")).toEqual(["a.png", "b.png"]);
    // As in the HTML spec, a comma inside a run of non-spaces is part of the URL.
    expect(parseSrcset("a.png,b.png")).toEqual(["a.png,b.png"]);
    expect(parseSrcset("  ")).toEqual([]);
  });
});

describe("imageNodesOf and alignImageSources", () => {
  it("lists image nodes in document order with duplicates", () => {
    const payload = JSON.stringify({ type: "root", children: [{ type: "image", url: "https://e.com/a.png", alt: "A" }, { type: "paragraph", children: [{ type: "image", url: "https://e.com/b.png" }] }, { type: "image", url: "https://e.com/a.png", alt: "" }] });
    expect(imageNodesOf(payload)).toEqual([{ url: "https://e.com/a.png", alt: "A" }, { url: "https://e.com/b.png", alt: "" }, { url: "https://e.com/a.png", alt: "" }]);
  });

  it("names placeholders by the next payload node after the last known source", () => {
    const payload = [{ url: "https://e.com/a.png", alt: "" }, { url: "https://e.com/b.png", alt: "" }, { url: "https://e.com/c.png", alt: "" }, { url: "https://e.com/d.png", alt: "" }];
    expect(alignImageSources([{ original: "" }, { original: "https://e.com/c.png" }, { original: "" }, { original: "" }], payload)).toEqual(["https://e.com/a.png", "https://e.com/c.png", "https://e.com/d.png", ""]);
  });
});

describe("buildRenderedImages", () => {
  it("ids, clips captions and shortens data URIs", () => {
    const facts = [
      { original: "https://e.com/a.png", broken: false, alt: "  A  cat ", caption: "x".repeat(200), tile: 1 },
      { original: "", broken: true, alt: "", caption: "", tile: null },
      { original: `data:image/png;base64,${"A".repeat(500)}`, broken: false, alt: "", caption: "", tile: 2 },
    ];
    const images = buildRenderedImages(facts, [{ url: "https://e.com/a.png", alt: "" }, { url: "https://e.com/b.png", alt: "" }]);
    expect(images.map((image) => [image.id, image.src.slice(0, 40), image.tile, image.broken])).toEqual([["r1", "https://e.com/a.png", 1, false], ["r2", "https://e.com/b.png", null, true], ["r3", "data:image/png;base64,…(522 chars)", 2, false]]);
    expect(images[0]?.alt).toBe("A cat");
    expect(images[0]?.caption).toHaveLength(160);
  });
});

describe("shortenDataUri", () => {
  it("leaves URLs alone", () => {
    expect(shortenDataUri("https://e.com/a.png")).toBe("https://e.com/a.png");
  });
});

const fact = (over: Partial<ReferenceImageFact>): ReferenceImageFact => ({ src: "", lazy: [], srcsets: [], alt: "", width: 0, height: 0, declaredWidth: 0, declaredHeight: 0, context: "", top: 0, tile: 1, ...over });

describe("buildReferenceImages", () => {
  it("lists images 48 px or more on one side, or unsized with such a declared size", () => {
    const images = buildReferenceImages([
      fact({ src: "https://e.com/icon.png", width: 32, height: 32 }),
      fact({ src: "https://e.com/wide.png", width: 700, height: 20 }),
      fact({ src: "https://e.com/lazy.png", declaredWidth: 700, declaredHeight: 193 }),
      fact({ src: "https://e.com/small-declared.png", width: 40, height: 40, declaredWidth: 700 }),
    ], "https://e.com/p");
    expect(images.map((image) => image.src)).toEqual(["https://e.com/wide.png", "https://e.com/lazy.png"]);
  });

  it("resolves picture sources and lazy attributes, drops data: placeholders, and lists a lazy image and its noscript copy once", () => {
    const images = buildReferenceImages([
      fact({ src: "data:image/gif;base64,R0lGOD", lazy: ["/max/700/1*abc.png"], srcsets: ["https://miro.medium.com/v2/resize:fit:640/1*abc.png 640w, https://miro.medium.com/v2/resize:fit:1400/1*abc.png 1400w"], width: 700, height: 193 }),
      fact({ src: "https://miro.medium.com/max/1400/1*abc.png", width: 700, height: 193 }),
      fact({ src: "https://miro.medium.com/max/1400/1*def.png", width: 700, height: 193, tile: 3 }),
    ], "https://miro.medium.com/p/1");
    expect(images).toHaveLength(2);
    expect(images[0]?.src).toBe("data:image/gif;base64,…(28 chars)");
    expect(images[0]?.candidates).toEqual(["https://miro.medium.com/max/700/1*abc.png", "https://miro.medium.com/v2/resize:fit:640/1*abc.png", "https://miro.medium.com/v2/resize:fit:1400/1*abc.png"]);
    expect(images[1]).toMatchObject({ src: "https://miro.medium.com/max/1400/1*def.png", tile: 3, width: 700, height: 193, context: "" });
  });

  it("clips the context to 160 characters and carries it to the linked image", () => {
    const [image] = linkImages(buildReferenceImages([fact({ src: "https://e.com/a.png", width: 600, height: 400, context: "word ".repeat(80) })], "https://e.com/"), []);
    expect(image?.context).toHaveLength(160);
    expect(image?.context.endsWith("…")).toBe(true);
  });
});

describe("buildReferenceImages placeholders", () => {
  it("drops a data: placeholder laid over a neighbouring image's box, but keeps a data: image of its own", () => {
    const images = buildReferenceImages([
      fact({ src: "data:image/webp;base64,UklGR", width: 849, height: 566, top: 300 }),
      fact({ src: "https://kentcdodds.com/media/w_1100,bg_e6e9ee/unsplash/photo-1534870439272", width: 849, height: 566, top: 300 }),
      fact({ src: "https://blog.cloudflare.com/a.png", width: 715, height: 303, top: 2000 }),
      fact({ src: "data:image/svg+xml,%3Csvg", width: 715, height: 304, top: 2001 }),
      fact({ src: "data:image/png;base64,iVBOR", width: 567, height: 191, top: 4000 }),
    ], "https://e.com/");
    expect(images.map((image) => image.src.slice(0, 30))).toEqual(["https://kentcdodds.com/media/w", "https://blog.cloudflare.com/a.", "data:image/png;base64,…(27 cha"]);
  });
});

describe("linkImages", () => {
  it("ids the reference images and records the matching reader image", () => {
    const reference = buildReferenceImages([fact({ src: MEDIUM_MAX, width: 700, height: 200 }), fact({ src: "https://e.com/missing.png", width: 700, height: 200 })], "https://e.com/");
    const rendered = buildRenderedImages([{ original: MEDIUM_V2, broken: false, alt: "", caption: "", tile: 1 }], []);
    expect(linkImages(reference, rendered).map((image) => [image.id, image.matchedBy])).toEqual([["o1", "r1"], ["o2", null]]);
  });
});
