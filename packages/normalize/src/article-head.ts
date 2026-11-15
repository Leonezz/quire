import { parseHTML } from "linkedom";

import { imagePathStem } from "./article-defuddle";

/**
 * The article head the extractors leave behind: Defuddle drops a Ghost header with its excerpt and feature
 * image, removes a Substack subtitle as a duplicate description, and reads only inside the page's one
 * <article> when the hero sits before it. Between the page's title h1 and the article's first paragraph,
 * this finds the dek (the block that says what the page's description says) and the lead image, and puts
 * them back at the top of the content when the content has neither.
 */
export interface ArticleHeadInput {
  /** The source page, with its <base> set. */
  document: Document;
  /** The pruned article content. */
  content: string;
  /** The chosen article title. */
  title: string;
  source: string;
}

export interface ArticleHeadResult {
  content: string;
  rulesApplied: string[];
}

const MIN_DEK_CHARACTERS = 20;
const MAX_DEK_CHARACTERS = 400;
/** The head is the title's neighbourhood; a walk that has gone this far without reaching the body has lost it. */
const MAX_HEAD_ELEMENTS = 120;
/** A paragraph this long that is not the dek is the body's prose: the head is over. */
const BODY_PARAGRAPH_CHARACTERS = 200;
/** The shortest a declared width or height has to be for an image to lead the article. */
const MIN_LEAD_DIMENSION = 300;
/** A hero without any other sign of being the article's (no og:image file, no alt) has to be this wide. */
const HERO_WIDTH = 800;
/** The blocks a dek is written in (Substack's h3.subtitle, Quanta's div, Ghost's p); never an inline link or emphasis. */
const DEK_TAGS = new Set(["p", "div", "h2", "h3", "h4", "h5", "h6"]);
const BLOCK_CHILDREN = "p, div, section, article, header, h1, h2, h3, h4, h5, h6, ul, ol, table, figure, blockquote, pre";
const NOT_THE_ARTICLE = "nav, footer, aside, form, [class*='author'], [class*='avatar'], [class*='logo'], [class*='share'], [class*='social'], [class*='comment']";
const DESCRIPTION_SELECTORS = ["meta[name='description']", "meta[property='og:description']", "meta[name='twitter:description']"];
const LEAD_IMAGE_SELECTORS = ["meta[property='og:image']", "meta[name='twitter:image']", "meta[property='og:image:secure_url']"];

function squeeze(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

/** Lower-case letters and digits only: what two renderings of one sentence share ("OpenAI’s" and "OpenAI's"). */
function comparable(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** The block says what the description says: the same text, the text it truncates, or a long shared opening (GitHub's dek is its description, written out). */
function statesDescription(text: string, description: string) {
  const a = comparable(text);
  const b = comparable(description);
  if (a.length < MIN_DEK_CHARACTERS || b.length < MIN_DEK_CHARACTERS) return false;
  // A block that is only the start of a longer description ("Hacker News discussion") is not saying it.
  if (a === b || a.startsWith(b) || (b.startsWith(a) && a.length >= b.length * 0.8)) return true;
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return shared >= Math.min(60, Math.ceil(Math.min(a.length, b.length) * 0.6));
}

function metaValues(document: Document, selectors: readonly string[]) {
  return selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)).map((meta) => squeeze(meta.getAttribute("content")))).filter(Boolean);
}

/** The page's h1 that is the article title (an h1 padded with UI text still starts with it). */
function titleHeading(document: Document, title: string) {
  const wanted = comparable(title);
  if (!wanted) return undefined;
  return Array.from(document.querySelectorAll("h1")).find((heading) => {
    const text = comparable(heading.textContent ?? "");
    return text.length > 0 && (text === wanted || text.startsWith(wanted) || (wanted.startsWith(text) && text.length >= wanted.length * 0.6));
  });
}

/** The elements after `start` in document order, up to `limit` of them (a plain walk; no TreeWalker in linkedom). */
function elementsAfter(start: Element, limit: number) {
  const found: Element[] = [];
  let passed = false;
  const visit = (node: Element) => {
    if (found.length >= limit) return;
    if (node === start) { passed = true; return; }
    if (passed) found.push(node);
    for (const child of Array.from(node.children)) visit(child);
  };
  const root = start.ownerDocument?.body;
  if (root) visit(root);
  return found;
}

/** Image URLs an <img> may stand for: its src, its srcset and lazy-load candidates, and the original behind an image optimizer (Next.js /_next/image?url=). */
function imageUrls(image: Element, source: string) {
  const raw = [
    image.getAttribute("src"),
    image.getAttribute("data-src"),
    ...["srcset", "srcSet", "data-srcset"].flatMap((name) => (image.getAttribute(name) ?? "").split(",").map((candidate) => candidate.trim().split(/\s+/u)[0])),
  ].filter((value): value is string => !!value && !value.startsWith("data:"));
  return raw.flatMap((value) => {
    try {
      const url = new URL(value, source);
      // An optimizer's own path ("/_next/image") is the same for every image; the image is the URL it wraps.
      const inner = url.searchParams.get("url") ?? url.searchParams.get("href");
      return inner ? [new URL(inner, source).href] : [url.href];
    } catch { return []; }
  });
}

function stemsOf(urls: readonly string[]) {
  return new Set(urls.map((url) => imagePathStem(url)).filter((stem) => stem.length >= 4));
}

function declaredDimension(image: Element, name: "width" | "height") {
  const value = Number(image.getAttribute(name));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** An image that leads the article: the og:image file, an alt that is the title, or a declared full-width hero; never an avatar, a logo or an icon. */
function isLeadImage(image: Element, input: { title: string; leadStems: ReadonlySet<string>; source: string }) {
  if (insideChrome(image)) return false;
  const width = declaredDimension(image, "width");
  const height = declaredDimension(image, "height");
  if ((width !== undefined && width < MIN_LEAD_DIMENSION) || (height !== undefined && height < MIN_LEAD_DIMENSION / 2)) return false;
  const stems = stemsOf(imageUrls(image, input.source));
  if (stems.size === 0) return false;
  if ([...stems].some((stem) => input.leadStems.has(stem))) return true;
  const alt = comparable(image.getAttribute("alt") ?? "");
  if (alt.length >= 8 && alt === comparable(input.title)) return true;
  return width !== undefined && width >= HERO_WIDTH;
}

/** The content's own head: whether an image comes before its first paragraph of prose, the stems of every image it shows, and its opening text. */
function contentHead(content: string) {
  const { document } = parseHTML(`<!doctype html><html><body>${content}</body></html>`);
  const body = document.body as unknown as Element;
  let imageFirst = false;
  let decided = false;
  for (const element of Array.from(body.querySelectorAll("img, picture, p"))) {
    if (decided) break;
    if (element.tagName.toLowerCase() !== "p") { imageFirst = true; decided = true; }
    else if (squeeze(element.textContent).length >= 60) decided = true;
  }
  const stems = new Set(Array.from(body.querySelectorAll("img")).flatMap((image) => [...stemsOf(imageUrls(image, "https://invalid.test/"))]));
  return { imageFirst, stems, opening: comparable((body.textContent ?? "").slice(0, 2000)) };
}

function escapeHtml(value: string) {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

/** A copy of the image with only what the reader uses: its sources, alt and declared size, without the page's classes and styles. */
function leadImageHtml(image: Element) {
  const document = image.ownerDocument!;
  const copy = document.createElement("img");
  for (const name of ["src", "srcset", "srcSet", "sizes", "data-src", "data-srcset", "alt", "width", "height"]) {
    const value = image.getAttribute(name);
    if (value !== null) copy.setAttribute(name, value);
  }
  const caption = squeeze(image.closest("figure")?.querySelector("figcaption")?.textContent);
  return `<figure>${copy.outerHTML}${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure>`;
}

/** Inside the page's chrome, looking no higher than <body>: themes put words like "logo" in the body's own classes (Ghost's "is-head-left-logo"). */
function insideChrome(element: Element) {
  for (let node: Element | null = element; node && !/^(body|html)$/iu.test(node.tagName); node = node.parentElement) {
    if (node.matches(NOT_THE_ARTICLE)) return true;
  }
  return false;
}

/** "[Hacker News discussion, LinkedIn discussion, Twitter thread]" is what huyenchip.com's description says, but it is a row of links, not a dek. */
function isMostlyLinks(element: Element) {
  const text = squeeze(element.textContent).length;
  const linked = Array.from(element.querySelectorAll("a")).reduce((sum, link) => sum + squeeze(link.textContent).length, 0);
  return text > 0 && linked / text >= 0.5;
}

function isLeafBlock(element: Element) {
  return element.querySelector(BLOCK_CHILDREN) === null;
}

/** Puts the dek and the lead image back at the top of `content` when the extractor left them out. */
export function withArticleHead(input: ArticleHeadInput): ArticleHeadResult {
  const heading = titleHeading(input.document, input.title);
  if (!heading) return { content: input.content, rulesApplied: [] };
  const own = contentHead(input.content);
  const descriptions = metaValues(input.document, DESCRIPTION_SELECTORS);
  const leadStems = stemsOf(metaValues(input.document, LEAD_IMAGE_SELECTORS).flatMap((value) => { try { return [new URL(value, input.source).href]; } catch { return []; } }));
  let dek: string | undefined;
  let image: Element | undefined;
  for (const element of elementsAfter(heading, MAX_HEAD_ELEMENTS)) {
    const tag = element.tagName.toLowerCase();
    if (tag === "img") {
      if (!image && !own.imageFirst && isLeadImage(element, { title: input.title, leadStems, source: input.source })) image = element;
      continue;
    }
    if (!isLeafBlock(element) || insideChrome(element)) continue;
    const text = squeeze(element.textContent);
    if (!dek && DEK_TAGS.has(tag) && text.length >= MIN_DEK_CHARACTERS && text.length <= MAX_DEK_CHARACTERS && !isMostlyLinks(element) && descriptions.some((description) => statesDescription(text, description))) { dek = text; continue; }
    if (tag === "p" && text.length >= BODY_PARAGRAPH_CHARACTERS) break;
  }
  const keepDek = dek !== undefined && !own.opening.includes(comparable(dek).slice(0, 120));
  const keepImage = image !== undefined && ![...stemsOf(imageUrls(image, input.source))].some((stem) => own.stems.has(stem));
  if (!keepDek && !keepImage) return { content: input.content, rulesApplied: [] };
  return {
    content: `${keepDek ? `<p>${escapeHtml(dek!)}</p>` : ""}${keepImage ? leadImageHtml(image!) : ""}${input.content}`,
    rulesApplied: [...(keepDek ? ["article.head.dek@1"] : []), ...(keepImage ? ["article.head.lead-image@1"] : [])],
  };
}
