// The content the original page fills in with JavaScript or a plugin (types.ts Embed), found in the
// snapshot HTML (what the extractor saw), and whether the reader shows something for each one. Pure:
// parses with linkedom, like the app's capture-text does.
import { parseHTML } from "linkedom";
import type { Embed } from "./types";

export const MAX_EMBEDS = 40;
const CONTEXT_CHARS = 160;
/** A custom element with more visible text than this, or with prose blocks inside, is a layout wrapper of server-rendered content, not an embed. */
const WRAPPER_TEXT_CHARS = 300;

/** Hosts (and host/path prefixes) of ads, analytics, tracking pixels and consent tools: never article content. */
const NOISE = [
  "googletagmanager.com", "google-analytics.com", "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com",
  "amazon-adsystem.com", "facebook.com/tr", "connect.facebook.net", "ghostboard.io", "scorecardresearch.com", "quantserve.com", "quantcast.com",
  "cookielaw.org", "onetrust.com", "cookiebot.com", "consensu.org", "hotjar.com", "clarity.ms", "segment.io", "plausible.io",
  "cloudflareinsights.com", "bat.bing.com", "px.ads.linkedin.com", "pixel.wp.com", "stats.wp.com",
];
/** Custom elements that are page chrome or decoration, matched against the dash-separated parts of the tag. */
const CHROME_PART = /(?:^|-)(?:icon|icons|svg|symbol|spinner|loader|progress|tooltip|ripple|search|cookie|consent|header|footer|nav|navbar|toc|menu|sidebar|tabs|breadcrumbs?|banner|language|appearance|user|recommendations|rating|feedback|cite|byline|front-matter|bibliography|appendix|snippet)(?:-|$)/;
/** Attributes that say nothing about what a custom element shows. */
const INERT_ATTRIBUTE = /^(?:class|style|slot|role|hidden|tabindex|title|lang|dir|aria-.*)$/;
const NON_CONTENT_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);

/** Just enough of the DOM that linkedom gives us. */
interface El {
  tagName: string;
  attributes: ArrayLike<{ name: string; value: string }>;
  childNodes: ArrayLike<Node>;
  children: ArrayLike<El>;
  parentElement: El | null;
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): ArrayLike<El>;
  closest(selector: string): El | null;
  contains(other: El): boolean;
}
interface Node { nodeType: number; nodeValue?: string | null; tagName?: string; childNodes: ArrayLike<Node> }

/** The text a reader would see in an element: script, style and template text left out. */
function visibleText(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeType !== 1 || NON_CONTENT_TAGS.has((node.tagName ?? "").toUpperCase())) return "";
  return Array.from(node.childNodes, visibleText).join("");
}
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

function absolute(raw: string | null | undefined, base: string): string {
  const value = raw?.trim();
  if (!value || value.startsWith("data:") || value.startsWith("javascript:") || value === "about:blank") return "";
  try { return new URL(value, base).href; } catch { return ""; }
}
const hostOf = (src: string) => { try { return new URL(src).hostname.toLowerCase(); } catch { return ""; } };

/** An ad, analytics, tracking or consent URL (NOISE entries are a host, matching its subdomains too, optionally with a path prefix). */
export function isNoiseUrl(src: string): boolean {
  let url: URL;
  try { url = new URL(src); } catch { return false; }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return NOISE.some((entry) => {
    const slash = entry.indexOf("/");
    const entryHost = slash < 0 ? entry : entry.slice(0, slash);
    const entryPath = slash < 0 ? "" : entry.slice(slash);
    const hostMatches = host === entryHost || host.endsWith(`.${entryHost}`);
    return hostMatches && (!entryPath || url.pathname === entryPath || url.pathname.startsWith(`${entryPath}/`));
  });
}

/** Hidden or 1-pixel boxes (tracking pixels, hidden iframes). */
function isHidden(element: El): boolean {
  const style = (element.getAttribute("style") ?? "").replace(/\s+/g, "").toLowerCase();
  if (/display:none|visibility:hidden/.test(style) || element.getAttribute("hidden") !== null) return true;
  const size = (name: string) => { const value = element.getAttribute(name); return value !== null && /^\s*\d+(?:px)?\s*$/.test(value) ? Number.parseInt(value, 10) : undefined; };
  const width = size("width");
  const height = size("height");
  return (width !== undefined && width <= 1) || (height !== undefined && height <= 1);
}

function mediaSrc(element: El, base: string): string {
  return absolute(element.getAttribute("src") ?? element.getAttribute("data-src") ?? element.querySelector("source[src]")?.getAttribute("src"), base);
}

function tweetSrc(element: El, base: string): string {
  const links = Array.from(element.querySelectorAll("a[href]"), (link) => absolute(link.getAttribute("href"), base)).filter((href) => /\/status(?:es)?\/\d+/.test(href));
  return links.at(-1) ?? "";
}

function customElementSrc(element: El, base: string): string {
  const videoId = element.getAttribute("videoid");
  if (videoId) return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  return absolute(element.getAttribute("src") ?? element.getAttribute("data-src") ?? element.querySelector("a[href]")?.getAttribute("href"), base);
}

/** A custom element worth listing: not chrome, not a wrapper of server-rendered prose, and showing or configured with something. */
function isEmbeddableCustomElement(element: El, tag: string): boolean {
  if (CHROME_PART.test(tag)) return false;
  if (element.closest("pre, code, svg, math") !== null) return false;
  const text = flat(visibleText(element as unknown as Node));
  if (text.length > WRAPPER_TEXT_CHARS || element.querySelector("p, h1, h2, h3, h4, h5, h6, li, table, pre, blockquote") !== null) return false;
  const configured = Array.from(element.attributes).some((attribute) => !INERT_ATTRIBUTE.test(attribute.name));
  const contentful = Array.from(element.children).some((child) => !NON_CONTENT_TAGS.has(child.tagName.toUpperCase()));
  return text.length > 0 || contentful || configured;
}

/** The embed an element is, if any (kind and src); null for anything else. */
function classify(element: El, tag: string, base: string): Pick<Embed, "kind" | "src"> | null {
  switch (tag) {
    case "iframe": return { kind: "iframe", src: absolute(element.getAttribute("src") ?? element.getAttribute("data-src") ?? element.getAttribute("data-lazy-src"), base) };
    case "video": case "audio": return { kind: tag, src: mediaSrc(element, base) };
    case "canvas": return { kind: "canvas", src: absolute(element.getAttribute("data-src"), base) };
    case "blockquote": {
      const classes = ` ${(element.getAttribute("class") ?? "").toLowerCase()} `;
      if (classes.includes(" twitter-tweet ")) return { kind: "tweet", src: tweetSrc(element, base) };
      if (classes.includes(" instagram-media ")) return { kind: "instagram", src: absolute(element.getAttribute("data-instgrm-permalink") ?? element.querySelector("a[href]")?.getAttribute("href"), base) };
      return null;
    }
    case "noscript": {
      const inner = element.querySelector("img, iframe, video");
      if (!inner || isHidden(inner)) return null;
      return { kind: "noscript", src: absolute(inner.getAttribute("src") ?? inner.getAttribute("data-src"), base) };
    }
    default:
      return tag.includes("-") && isEmbeddableCustomElement(element, tag) ? { kind: "custom-element", src: customElementSrc(element, base) } : null;
  }
}

/** Up to 160 characters of the nearest heading or paragraph before the element in document order (not one that contains it). */
function contextBefore(all: readonly El[], index: number): string {
  const element = all[index] as El;
  for (let at = index - 1; at >= 0; at -= 1) {
    const candidate = all[at] as El;
    if (!/^(?:H[1-6]|P)$/i.test(candidate.tagName) || candidate.contains(element)) continue;
    const text = flat(visibleText(candidate as unknown as Node));
    if (text) return text.length > CONTEXT_CHARS ? `${text.slice(0, CONTEXT_CHARS - 1)}…` : text;
  }
  return "";
}

/** The snapshot's own <base href> resolved against the final URL, else the final URL. */
function baseOf(document: { querySelector(selector: string): El | null }, finalUrl: string): string {
  const href = document.querySelector("base[href]")?.getAttribute("href");
  return absolute(href, finalUrl) || finalUrl;
}

/**
 * The embeds of a snapshot page, in document order within <body>, at most MAX_EMBEDS; representedInReader
 * is false until markRepresented. Content inside a listed iframe, video, audio, tweet, instagram post or
 * noscript block is part of it; a custom element inside a listed custom element is part of that one.
 * Ads, analytics and consent iframes and hidden or 1-pixel boxes are left out.
 */
export function extractEmbeds(html: string, finalUrl: string): Embed[] {
  const { document } = parseHTML(html) as unknown as { document: { body: El | null; querySelector(selector: string): El | null } };
  const body = document.body;
  if (!body) return [];
  const base = baseOf(document, finalUrl);
  const all = Array.from(body.querySelectorAll("*"));
  const listed: El[] = [];
  const embeds: Embed[] = [];
  for (const [index, element] of all.entries()) {
    if (embeds.length >= MAX_EMBEDS) break;
    const tag = element.tagName.toLowerCase();
    const inside = listed.find((outer) => outer.contains(element));
    // Inside a listed iframe/video/noscript… everything is part of it; inside a listed custom element only other custom elements are.
    if (inside && (!inside.tagName.includes("-") || tag.includes("-"))) continue;
    const found = classify(element, tag, base);
    if (!found || isHidden(element) || (found.src && isNoiseUrl(found.src))) continue;
    listed.push(element);
    embeds.push({ kind: found.kind, tag, src: found.src, host: hostOf(found.src), context: contextBefore(all, index), representedInReader: false });
  }
  return embeds;
}

const YOUTUBE_HOSTS = /^(?:youtube\.com|youtube-nocookie\.com|youtu\.be)$/;
const TWITTER_HOSTS = /^(?:twitter\.com|x\.com)$/;

/**
 * A comparable form of a media URL: no protocol, www./m./mobile., query or fragment, no trailing slash;
 * YouTube embed/watch/youtu.be/shorts → youtube.com/watch?v=ID, twitter.com → x.com (status links by
 * id), Vimeo player → vimeo.com/ID, CodePen embed → pen. "" for what is not an http(s) URL.
 */
export function mediaKey(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { return ""; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, "");
  const path = url.pathname.replace(/\/+$/, "");
  if (YOUTUBE_HOSTS.test(host)) {
    const id = host === "youtu.be" ? path.slice(1) : url.searchParams.get("v") ?? /^\/(?:embed|shorts|v|live)\/([^/]+)/.exec(path)?.[1];
    if (id) return `youtube.com/watch?v=${id}`;
  }
  if (TWITTER_HOSTS.test(host)) {
    const status = /\/status(?:es)?\/(\d+)/.exec(path)?.[1];
    return status ? `x.com/status/${status}` : `x.com${path.toLowerCase()}`;
  }
  if (host === "player.vimeo.com") {
    const id = /^\/video\/(\d+)/.exec(path)?.[1];
    if (id) return `vimeo.com/${id}`;
  }
  if (host === "codepen.io") {
    const hash = /\/(?:embed|pen|full|details)\/(?:preview\/)?([^/]+)/.exec(path)?.[1];
    if (hash) return `codepen.io/pen/${hash}`;
  }
  return `${host}${path}`;
}

/** Sets representedInReader: the embed's URL (as mediaKey) is among the reader's links, image srcs or media srcs. */
export function markRepresented(embeds: readonly Embed[], readerUrls: readonly string[]): Embed[] {
  const shown = new Set(readerUrls.map(mediaKey).filter(Boolean));
  return embeds.map((embed) => {
    const key = embed.src ? mediaKey(embed.src) : "";
    return { ...embed, representedInReader: key !== "" && shown.has(key) };
  });
}
