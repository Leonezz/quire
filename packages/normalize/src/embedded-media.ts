import { parseHTML } from "linkedom";

import { DISPLAYABLE_SOURCE_TYPE } from "./deferred-image-sources";

/**
 * Players and widgets (iframe, video, audio) need script or a plugin, so the reader cannot show them
 * and drops them. This pass puts back what they showed as something the reader can show: a link to the
 * video, demo or file, under its poster frame when there is one. A player facade (lite-youtube) links like
 * the player it loads, and interactive content only script fills (an empty Distill figure, a Sandpack
 * preview) becomes a link to its place on the original page. An <object> of an image type is only an
 * image and becomes one. Frames that are not article content (ads, analytics, comment and newsletter
 * widgets, hidden or 1-pixel boxes) are removed. An embed with no URL worth linking is left alone: the
 * reader drops it and the article is flagged for it.
 */
type Kind = "Audio" | "Demo" | "Embedded content" | "Video";
type Embed = { kind: Kind; poster?: string; provider: string; url: string };

/** Facades that show a thumbnail and load the player iframe on click: the player URL for a video id. */
const FACADE_PLAYERS: ReadonlyMap<string, (id: string) => string> = new Map([
  ["lite-youtube", (id: string) => `https://www.youtube.com/embed/${id}`],
  ["lite-vimeo", (id: string) => `https://player.vimeo.com/video/${id}`],
]);
const FACADE_SELECTOR = Array.from(FACADE_PLAYERS.keys()).join(", ");
const FACADE_VIDEO_ID = /^[\w-]{6,}$/u;
/** Distill's lazily drawn figures and Sandpack's live preview: script fills them, and the page is the only way to see them. */
const INTERACTIVE_SELECTOR = "d-figure, iframe.sp-preview-iframe, iframe[title='Sandpack Preview']";
const PLACEHOLDER_SUFFIX = " — open in the original";
/** Content that would make a d-figure the figure itself rather than an empty box for script to fill. */
const SERVER_RENDERED_MEDIA = "img, picture, svg, canvas, video, audio, iframe, object, embed";
const EMBED_SELECTOR = `iframe, video, audio, ${FACADE_SELECTOR}`;
const EMBED_TAG = /<(?:iframe|video|audio|lite-youtube|lite-vimeo|d-figure|object)\b/iu;
/** What an image object keeps on its <img>: what identifies and sizes it (a LaTeXML panel's id and ltx_graphics class). */
const IMAGE_OBJECT_ATTRIBUTES = ["id", "class", "width", "height", "title"];
const MAX_TITLE_CHARS = 120;
/** /embed/ paths that are YouTube player modes, not video ids. */
const YOUTUBE_PLAYER_MODES = new Set(["live_stream", "videoseries"]);
const STREAM_UID = /^\/([0-9a-f]{32})(?:\/|$)/u;
const CUSTOMER_STREAM_HOST = /^customer-[a-z0-9]+\.cloudflarestream\.com$/u;
const LEGACY_STREAM_HOST = /^iframe\.(?:videodelivery\.net|cloudflarestream\.com)$/u;
const YOUTUBE_HOST = /^(?:www\.|m\.)?youtube(?:-nocookie)?\.com$/u;
/** Titles that name the widget, not what it shows ("YouTube video player", "Spotify Embed", "CodePen Embed QwKVaYm"). */
const GENERIC_TITLE = /^(?:(?:[\w.-]+\s+)?(?:(?:video|audio|media)\s+)?(?:player|embed|iframe|embedded content|video|audio)|[\w.-]+\s+embed\s+\S+)$/iu;
/** Frames that are never article content, as a host (matching its subdomains) with an optional path prefix. */
const NOT_CONTENT = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "googletagmanager.com", "google-analytics.com",
  "amazon-adsystem.com", "facebook.com/tr", "facebook.com/plugins/like.php", "facebook.com/plugins/share_button.php",
  "platform.twitter.com/widgets", "cookielaw.org", "onetrust.com", "cookiebot.com", "consensu.org", "hotjar.com", "clarity.ms",
  "disqus.com/embed", "utteranc.es", "giscus.app", "substack.com/embed", "embeds.beehiiv.com", "buttondown.email", "buttondown.com",
  "list-manage.com", "mailchi.mp",
];

function absoluteUrl(raw: string | null | undefined, baseUri: string | undefined) {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value, baseUri);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : undefined;
  } catch {
    return undefined;
  }
}

function isNotContent(url: URL) {
  const host = url.hostname.toLowerCase();
  return NOT_CONTENT.some((entry) => {
    const slash = entry.indexOf("/");
    const entryHost = slash < 0 ? entry : entry.slice(0, slash);
    const entryPath = slash < 0 ? "" : entry.slice(slash);
    const hostMatches = host === entryHost || host.endsWith(`.${entryHost}`);
    return hostMatches && (!entryPath || url.pathname === entryPath || url.pathname.startsWith(`${entryPath}/`));
  });
}

function isHidden(element: Element) {
  const style = (element.getAttribute("style") ?? "").replace(/\s+/gu, "").toLowerCase();
  if (/display:none|visibility:hidden/u.test(style) || element.hasAttribute("hidden")) return true;
  return ["width", "height"].some((name) => {
    const value = /^\s*(\d+)(?:px)?\s*$/u.exec(element.getAttribute(name) ?? "")?.[1];
    return value !== undefined && Number(value) <= 1;
  });
}

function streamEmbed(url: URL, baseUri: string | undefined): Embed | undefined {
  const customer = CUSTOMER_STREAM_HOST.test(url.hostname);
  if (!customer && !LEGACY_STREAM_HOST.test(url.hostname)) return undefined;
  const uid = STREAM_UID.exec(url.pathname)?.[1];
  if (!uid) return undefined;
  const thumbnailHost = customer ? url.hostname : "videodelivery.net";
  const poster = absoluteUrl(url.searchParams.get("poster"), baseUri)?.href ?? `https://${thumbnailHost}/${uid}/thumbnails/thumbnail.jpg`;
  // The customer subdomain has a share page; the legacy players are only their own page.
  const page = customer ? `https://${url.hostname}/${uid}/watch` : `https://${url.hostname}/${uid}`;
  return { kind: "Video", poster, provider: "Cloudflare Stream", url: page };
}

/** A known player or demo host's own page (and thumbnail), or a link to the frame itself. */
function frameEmbed(url: URL, baseUri: string | undefined): Embed {
  const stream = streamEmbed(url, baseUri);
  if (stream) return stream;
  const youtubeId = YOUTUBE_HOST.test(url.hostname) ? /^\/embed\/([\w-]{6,})\/?$/u.exec(url.pathname)?.[1] : undefined;
  if (youtubeId && !YOUTUBE_PLAYER_MODES.has(youtubeId)) {
    return { kind: "Video", poster: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`, provider: "YouTube", url: `https://www.youtube.com/watch?v=${youtubeId}` };
  }
  const vimeoId = url.hostname === "player.vimeo.com" ? /^\/video\/(\d+)\/?$/u.exec(url.pathname)?.[1] : undefined;
  if (vimeoId) {
    // An unlisted video's page needs its hash, which only the player URL carries.
    return { kind: "Video", provider: "Vimeo", url: url.searchParams.has("h") ? url.href : `https://vimeo.com/${vimeoId}` };
  }
  const pen = /^(?:www\.)?codepen\.io$/u.test(url.hostname) ? /^(\/.+?)\/embed\/(?:preview\/)?([^/]+)\/?$/u.exec(url.pathname) : null;
  if (pen) return { kind: "Demo", provider: "CodePen", url: `https://codepen.io${pen[1]}/pen/${pen[2]}` };
  return { kind: "Embedded content", provider: url.hostname.replace(/^www\./u, ""), url: url.href };
}

/** The player a facade loads, or undefined without a video id that could be one. */
function facadePlayerUrl(element: Element) {
  const player = FACADE_PLAYERS.get(element.tagName.toLowerCase());
  const id = element.getAttribute("videoid")?.trim();
  return player && id && FACADE_VIDEO_ID.test(id) ? new URL(player(id)) : undefined;
}

function frameUrl(element: Element, baseUri: string | undefined) {
  return ["src", "data-src", "data-lazy-src"]
    .map((name) => absoluteUrl(element.getAttribute(name), baseUri))
    .find((url) => url !== undefined);
}

function mediaUrl(element: Element, baseUri: string | undefined) {
  const sources = Array.from(element.querySelectorAll("source"));
  return [element, ...sources]
    .flatMap((candidate) => ["src", "data-src"].map((name) => candidate.getAttribute(name)))
    .map((value) => absoluteUrl(value, baseUri))
    .find((url) => url !== undefined);
}

/** The http(s) URL an embed loads: an iframe's frame, a facade's player, a media element's file. */
export function embedSourceUrl(element: Element, baseUri: string | undefined) {
  const tag = element.tagName.toLowerCase();
  if (FACADE_PLAYERS.has(tag)) return facadePlayerUrl(element);
  return tag === "iframe" ? frameUrl(element, baseUri) : mediaUrl(element, baseUri);
}

function titleOf(element: Element) {
  const title = (element.getAttribute("title") || element.getAttribute("aria-label") || element.getAttribute("videotitle") || "").replace(/\s+/gu, " ").trim();
  if (!title || GENERIC_TITLE.test(title)) return undefined;
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title;
}

function labelOf(embed: Embed, title: string | undefined) {
  const play = embed.kind === "Video" || embed.kind === "Audio" ? "▶ " : "";
  return `${play}${embed.kind} · ${embed.provider}${title ? `: ${title}` : ""}`;
}

/**
 * The embed an element shows, "noise" for one that is not content, or undefined when it has no URL to link
 * (then the reader drops it and reports it: a placeholder a script would have filled is not known to be noise).
 */
function classify(element: Element, baseUri: string | undefined): Embed | "noise" | undefined {
  const tag = element.tagName.toLowerCase();
  const url = embedSourceUrl(element, baseUri);
  if (!url) return undefined;
  if (isNotContent(url) || isHidden(element)) return "noise";
  if (tag === "iframe" || FACADE_PLAYERS.has(tag)) return frameEmbed(url, baseUri);
  const poster = tag === "video"
    ? ["poster", "data-poster"].map((name) => absoluteUrl(element.getAttribute(name), baseUri)).find((value) => value !== undefined)?.href
    : undefined;
  // A fragment on a media file is a player hint (WordPress's "#t=0.001" first-frame trick), not part of the link.
  const file = new URL(url.href);
  file.hash = "";
  return { kind: tag === "video" ? "Video" : "Audio", ...(poster ? { poster } : {}), provider: url.hostname.replace(/^www\./u, ""), url: file.href };
}

/** Whether an embed is not article content: an ad, analytics, comment or newsletter frame, or a hidden or 1-pixel box. */
export function isNoiseEmbed(element: Element, baseUri: string | undefined) {
  const url = embedSourceUrl(element, baseUri);
  return (url !== undefined && isNotContent(url)) || isHidden(element);
}

/** What the reader calls interactive content only script fills, or undefined for anything else (a d-figure with content is a figure). */
function interactiveLabel(element: Element) {
  if (!element.matches(INTERACTIVE_SELECTOR)) return undefined;
  if (element.tagName.toLowerCase() !== "d-figure") return "Code playground";
  const blank = !element.textContent?.trim() && element.querySelector(SERVER_RENDERED_MEDIA) === null;
  return blank ? "Interactive figure" : undefined;
}

/**
 * A link to where interactive content sits on the original page (its id as the fragment), inline in a paragraph and
 * a paragraph of its own otherwise; undefined for other elements or without a page to link to.
 */
function interactivePlaceholder(document: Document, element: Element, baseUri: string | undefined) {
  const label = interactiveLabel(element);
  const page = label ? absoluteUrl(baseUri, undefined) : undefined;
  if (!label || !page) return undefined;
  page.hash = element.id;
  const link = document.createElement("a");
  link.setAttribute("href", page.href);
  link.textContent = `${label}${PLACEHOLDER_SUFFIX}`;
  return element.parentElement?.closest("p") ? link : wrapped(document, "p", link);
}

/** Puts a link to the original page where each piece of interactive content was; returns how many it replaced. */
export function placeInteractivePlaceholders(document: Document, baseUri: string | undefined) {
  let placed = 0;
  for (const element of Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))) {
    const placeholder = interactivePlaceholder(document, element, baseUri);
    if (!placeholder) continue;
    element.replaceWith(placeholder);
    placed += 1;
  }
  return placed;
}

/** The URL of the image an <object> shows: one of an image type an <img> can show, visible, with an http(s) URL; else undefined. */
function objectImageUrl(element: Element, baseUri: string | undefined) {
  const type = element.getAttribute("type")?.split(";")[0]?.trim().toLowerCase();
  if (type === undefined || !DISPLAYABLE_SOURCE_TYPE.test(type) || isHidden(element)) return undefined;
  return absoluteUrl(element.getAttribute("data"), baseUri);
}

/**
 * An <object> of an image type is only an image (arXiv's LaTeXML HTML renders SVG figure panels this way), but
 * the extractors and the reader drop every object as a plugin. Each one with an image URL becomes an <img> of it
 * with its id, class, size and title; the alt is its fallback text, else its aria-label or title. Objects of any
 * other type are left alone. Returns how many it replaced.
 */
export function replaceImageObjects(document: Document, baseUri: string | undefined) {
  const replaced: Element[] = [];
  for (const element of Array.from(document.querySelectorAll("object"))) {
    // One in a replaced object's fallback content went with it. (Not isConnected: linkedom's is false
    // throughout a cloned document, and the extractors read clones.)
    if (replaced.some((object) => object.contains(element))) continue;
    const url = objectImageUrl(element, baseUri);
    if (!url) continue;
    const image = document.createElement("img");
    image.setAttribute("src", url.href);
    const fallback = (element.textContent ?? "").replace(/\s+/gu, " ").trim();
    image.setAttribute("alt", fallback || element.getAttribute("aria-label")?.trim() || element.getAttribute("title")?.trim() || "");
    for (const name of IMAGE_OBJECT_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value !== null) image.setAttribute(name, value);
    }
    element.replaceWith(image);
    replaced.push(element);
  }
  return replaced.length;
}

/** Whether an element is a link placeInteractivePlaceholders made. */
export function isInteractivePlaceholder(element: Element) {
  return element.tagName.toLowerCase() === "a" && (element.textContent ?? "").trim().endsWith(PLACEHOLDER_SUFFIX);
}

/** Whether a paragraph says something besides its embeds (their fallback content does not count). */
function hasProse(paragraph: Element) {
  const rest = paragraph.cloneNode(true) as Element;
  for (const embed of Array.from(rest.querySelectorAll(EMBED_SELECTOR))) embed.remove();
  return Boolean(rest.textContent?.trim()) || rest.querySelector("img") !== null;
}

function wrapped(document: Document, tag: string, ...children: Node[]) {
  const element = document.createElement(tag);
  element.append(...children);
  return element;
}

/**
 * Inline in a paragraph that says something besides it; otherwise a poster figure (or the poster inside the
 * page's own figure, the link heading its caption), or a paragraph with the link when there is no poster.
 * The embed's paragraph goes with it only when the embed is all the paragraph holds.
 */
function replaceEmbed(document: Document, element: Element, embed: Embed, title: string | undefined) {
  const link = document.createElement("a");
  link.setAttribute("href", embed.url);
  link.textContent = labelOf(embed, title);
  const paragraph = element.closest("p");
  if (paragraph && hasProse(paragraph)) {
    element.replaceWith(link);
    return;
  }
  const target = paragraph && paragraph.querySelectorAll(EMBED_SELECTOR).length === 1 ? paragraph : element;
  if (!embed.poster) {
    target.replaceWith(wrapped(document, "p", link));
    return;
  }
  const poster = document.createElement("img");
  poster.setAttribute("src", embed.poster);
  poster.setAttribute("alt", title ?? `${embed.kind} poster`);
  const pageFigure = target.parentElement?.closest("figure");
  if (!pageFigure) {
    target.replaceWith(wrapped(document, "figure", poster, wrapped(document, "figcaption", link)));
    return;
  }
  target.replaceWith(poster);
  const caption = Array.from(pageFigure.children).find((child) => child.tagName.toLowerCase() === "figcaption");
  if (caption) caption.prepend(link, document.createElement("br"));
  else pageFigure.append(wrapped(document, "figcaption", link));
}

export function linkEmbeddedMedia(html: string, baseUri: string | undefined) {
  if (!EMBED_TAG.test(html)) return { html, images: 0, linked: 0, removed: 0 };
  const document = parseHTML(`<html><body>${html}</body></html>`).document;
  const images = replaceImageObjects(document, baseUri);
  // A d-figure that got no placeholder holds server-rendered content: it is the figure, and its players are linked below.
  let linked = placeInteractivePlaceholders(document, baseUri);
  let removed = 0;
  for (const element of Array.from(document.body.querySelectorAll(EMBED_SELECTOR))) {
    // Only an embed inside another one's fallback content (never shown by a browser) goes with that one.
    if (!element.isConnected) continue;
    const embed = classify(element, baseUri);
    if (embed === undefined) continue;
    if (embed === "noise") {
      element.remove();
      removed += 1;
      continue;
    }
    replaceEmbed(document, element, embed, titleOf(element));
    linked += 1;
  }
  return {
    html: images + linked + removed > 0 ? document.body.innerHTML : html,
    images,
    linked,
    removed,
  };
}
