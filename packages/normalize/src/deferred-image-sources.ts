import { parseHTML } from "linkedom";

/**
 * Pages that load images with script or through responsive markup leave the
 * <img> itself without a source the reader can show: lazy loaders put a data:
 * placeholder in src and the real URL in data-src, React <picture> markup gives
 * the <img> no src at all, and some sites serve JPEG XL, which Chromium cannot
 * decode. This pass gives such an image the URL the browser would have loaded.
 */
type SrcsetCandidate = { readonly url: string; readonly width?: number; readonly density: number };

const LAZY_SOURCE_ATTRIBUTES = ["data-src", "data-original", "data-lazy-src"] as const;
const SRCSET_ATTRIBUTES = ["data-srcset", "srcset"] as const;
const DISPLAYABLE_SOURCE_TYPE = /^image\/(?:avif|webp|png|jpe?g|gif|svg\+xml)$/u;
const UNDISPLAYABLE_IMAGE = /\.jxl(?:$|[?#])/iu;
const DATA_URL = /^data:/iu;
const ASCII_WHITESPACE = /[\t\n\f\r ]/u;
const WIDTH_DESCRIPTOR = /^([0-9]+)w$/u;
const DENSITY_DESCRIPTOR = /^((?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)x$/u;
const HEIGHT_DESCRIPTOR = /^[0-9]+h$/u;

/** Reads an attribute whatever its case: linkedom keeps React's "srcSet" as written. */
function attribute(element: Element, name: string) {
  return Array.from(element.attributes).find((value) => value.name.toLowerCase() === name)?.value.trim() || undefined;
}

function displayableUrl(url: string | undefined): url is string {
  if (!url) return false;
  return !DATA_URL.test(url) && !UNDISPLAYABLE_IMAGE.test(url);
}

/** The descriptors after a candidate URL, up to the comma that ends the candidate (commas inside parentheses do not). */
function descriptorTokens(value: string, start: number) {
  const descriptors: string[] = [];
  let current = "";
  let inParentheses = false;
  let at = start;
  while (at < value.length) {
    const char = value[at] as string;
    at += 1;
    if (inParentheses) {
      current += char;
      if (char === ")") inParentheses = false;
    } else if (char === ",") {
      break;
    } else if (ASCII_WHITESPACE.test(char)) {
      if (current) descriptors.push(current);
      current = "";
    } else {
      if (char === "(") inParentheses = true;
      current += char;
    }
  }
  if (current) descriptors.push(current);
  return { descriptors, end: at };
}

/** One width or density descriptor (a height only alongside a width); anything else invalidates the candidate. */
function candidateFrom(url: string, descriptors: readonly string[]): SrcsetCandidate | undefined {
  const widths = descriptors.flatMap((descriptor) => WIDTH_DESCRIPTOR.exec(descriptor)?.[1] ?? []).map(Number);
  const densities = descriptors.flatMap((descriptor) => DENSITY_DESCRIPTOR.exec(descriptor)?.[1] ?? []).map(Number);
  const heights = descriptors.filter((descriptor) => HEIGHT_DESCRIPTOR.test(descriptor));
  if (widths.length + densities.length + heights.length !== descriptors.length) return undefined;
  if (widths.length + densities.length > 1 || heights.length > 1 || (heights.length && !widths.length)) return undefined;
  if (widths[0] === 0) return undefined;
  return widths.length ? { density: 1, url, width: widths[0] } : { density: densities[0] ?? 1, url };
}

/** Parses a srcset value by the HTML rules: a URL is a run of non-whitespace, and a comma right after it ends the candidate. */
function srcsetCandidates(value: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let at = 0;
  while (at < value.length) {
    while (at < value.length && (ASCII_WHITESPACE.test(value[at] as string) || value[at] === ",")) at += 1;
    if (at >= value.length) break;
    let end = at;
    while (end < value.length && !ASCII_WHITESPACE.test(value[end] as string)) end += 1;
    const token = value.slice(at, end);
    const url = token.replace(/,+$/u, "");
    const parsed = url === token ? descriptorTokens(value, end) : { descriptors: [], end };
    at = parsed.end;
    const candidate = candidateFrom(url, parsed.descriptors);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

/** The biggest displayable candidate: by width when the srcset gives widths, else by pixel density. */
function largestSrcsetUrl(value: string | undefined) {
  const candidates = srcsetCandidates(value ?? "").filter((candidate) => displayableUrl(candidate.url));
  const sized = candidates.filter((candidate) => candidate.width !== undefined);
  const pool = sized.length ? sized : candidates;
  const size = (candidate: SrcsetCandidate) => candidate.width ?? candidate.density;
  return pool.reduce<SrcsetCandidate | undefined>((best, candidate) => (!best || size(candidate) > size(best) ? candidate : best), undefined)?.url;
}

function lazySource(image: Element) {
  return LAZY_SOURCE_ATTRIBUTES.map((name) => attribute(image, name)).find(displayableUrl);
}

function srcsetSource(element: Element) {
  return SRCSET_ATTRIBUTES.map((name) => largestSrcsetUrl(attribute(element, name))).find(Boolean);
}

/** The <picture> source a browser without JPEG XL would pick at the default viewport: the first displayable one without a media query. */
function pictureSource(image: Element) {
  const picture = image.parentElement;
  if (picture?.tagName.toLowerCase() !== "picture") return undefined;
  const siblings = Array.from(picture.children);
  const usable = siblings.slice(0, siblings.indexOf(image)).flatMap((source) => {
    if (source.tagName.toLowerCase() !== "source") return [];
    const type = attribute(source, "type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== undefined && !DISPLAYABLE_SOURCE_TYPE.test(type)) return [];
    const url = srcsetSource(source);
    return url ? [{ media: attribute(source, "media"), url }] : [];
  });
  return (usable.find((source) => source.media === undefined) ?? usable[0])?.url;
}

/** The node after this one, past whitespace and comments. */
function nextContentSibling(node: Node) {
  let next = node.nextSibling;
  while (next && (next.nodeType === 8 || (next.nodeType === 3 && !next.textContent?.trim()))) next = next.nextSibling;
  return next;
}

/**
 * Lazy loaders follow the placeholder with a <noscript> copy of the image. The
 * reader shows that copy, so giving the placeholder a source would show the
 * image twice.
 */
function hasNoscriptFallback(image: Element) {
  const next = nextContentSibling(image);
  return next?.nodeName.toLowerCase() === "noscript" && (next as Element).querySelector("img") !== null;
}

function deferredImageSource(image: Element) {
  if (displayableUrl(attribute(image, "src")) || hasNoscriptFallback(image)) return undefined;
  return lazySource(image) ?? srcsetSource(image) ?? pictureSource(image);
}

/**
 * Gives each <img> without a displayable src the URL its lazy, srcset or
 * <picture> markup offers; an image with no alternative, or with a <noscript>
 * fallback, keeps its src.
 */
export function resolveDeferredImageSources(html: string) {
  if (!/<img\b/iu.test(html)) return { html, replacements: 0 };
  const document = parseHTML(`<html><body>${html}</body></html>`).document;
  let replacements = 0;

  for (const image of Array.from(document.body.querySelectorAll("img"))) {
    const source = deferredImageSource(image);
    if (!source) continue;
    for (const name of Array.from(image.attributes, (value) => value.name)) {
      if (name.toLowerCase() === "src") image.removeAttribute(name);
    }
    image.setAttribute("src", source);
    replacements += 1;
  }

  return {
    html: replacements > 0 ? document.body.innerHTML : html,
    replacements,
  };
}
