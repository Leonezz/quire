// The manifest's image inventories (types.ts RenderedImage / ReferenceImage) from the raw facts the two
// pages report, and which original-page image is which reader image. Both sides name the same picture by
// different URLs (a CDN variant, a size suffix, a resize segment, a proxy that wraps the original URL), so
// each URL is reduced to keys that survive those rewrites. Pure: the browser side only collects.
// (One module: Node runs these .ts files directly, and they may import each other only as types.)
import type { ReferenceImage, RenderedImage } from "./types";


/** Query parameters through which an image proxy carries the original URL (Next.js, Astro, Cloudflare…). */
const WRAPPING_PARAMS = ["url", "href", "src", "u", "image"] as const;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|jxl|svg|bmp|tiff?|ico|heic|heif)$/;
/** Size and variant suffixes on a file-name stem, stripped repeatedly: -300x200, @2x, _1x, -scaled, -thumb, WordPress's -e1590000000000, Google's =w624-h300. */
const STEM_SUFFIXES = [/[-_]\d{1,5}x\d{1,5}$/, /@\d(?:\.\d+)?x$/, /[-_]\d(?:\.\d+)?x$/, /-scaled$/, /[-_]thumb(?:nail)?$/, /-e\d{10,13}$/, /=[swh]\d+(?:-[a-z0-9]+)*$/];
/** Stems too generic to identify a picture on their own (they still match by full path). */
const GENERIC_STEMS = new Set(["image", "img", "images", "photo", "picture", "default", "index", "thumbnail", "thumb", "download", "file", "original", "full", "large", "medium", "small", "unnamed", "media", "fetch"]);

/** A path segment that only says how to transform the picture: Cloudinary/Substack/imgix option lists, Medium's resize:/format:, Cloudflare's width=. */
function isTransformSegment(segment: string): boolean {
  if (/^(?:resize|format|fit|crop|quality|q|w|h):/i.test(segment)) return true;
  const parts = segment.split(",");
  return parts.every((part) => /^(?:\$s_![^!]*!|[a-z]{1,4}_[\w.:!%-]+|[a-z]+=[\w.:%-]+)$/i.test(part));
}

const safeDecode = (value: string) => {
  try { return decodeURIComponent(value); } catch { return value; }
};

function parse(raw: string, base?: string): URL | undefined {
  try { return new URL(raw, base); } catch { return undefined; }
}

/**
 * The innermost image URL: a proxy URL that carries the original in its path (Substack's
 * `/image/fetch/<options>/https%3A%2F%2F…`) or in a query parameter (`/_next/image?url=…`) is unwrapped.
 */
export function innermostImageUrl(raw: string): URL | undefined {
  let url = parse(raw);
  for (let depth = 0; url && depth < 4; depth += 1) {
    const segments = url.pathname.split("/");
    const at = segments.findIndex((segment) => /^https?(?::|%3A)/i.test(segment));
    if (at > 0) {
      const inner = parse(safeDecode(segments.slice(at).join("/")));
      if (inner) { url = inner; continue; }
    }
    const current: URL = url;
    const param = WRAPPING_PARAMS.map((name) => current.searchParams.get(name)).find((value) => value && (/^https?:\/\//i.test(value) || (value.startsWith("/") && IMAGE_EXTENSION.test(value.split("?")[0]?.toLowerCase() ?? ""))));
    if (!param) break;
    url = parse(param, current.origin);
  }
  return url && (url.protocol === "http:" || url.protocol === "https:") ? url : undefined;
}

/** The file-name stem: last path segment, lowercased, without extension and size/variant suffixes. */
export function imageStem(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  let stem = safeDecode(segments.at(-1) ?? "").toLowerCase();
  while (IMAGE_EXTENSION.test(stem)) stem = stem.replace(IMAGE_EXTENSION, "");
  for (let changed = true; changed;) {
    changed = false;
    for (const suffix of STEM_SUFFIXES) {
      const next = stem.replace(suffix, "");
      if (next !== stem && next) { stem = next; changed = true; }
    }
  }
  return stem;
}

/** Host (without www.) and path, decoded and lowercased, with transform segments (and Medium's /max/1400, Ghost's /size/w1000) removed; no query. */
export function imagePathKey(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = safeDecode(url.pathname).toLowerCase().replace(/\/max\/\d+(?=\/)/g, "").replace(/\/size\/w\d+(?:h\d+)?(?=\/)/g, "").replace(/\/cdn-cgi\/image\/[^/]+(?=\/)/g, "");
  const segments = path.split("/").filter(Boolean);
  const kept = segments.filter((segment, index) => index === segments.length - 1 || (!isTransformSegment(segment) && !/^v\d$/.test(segment)));
  return `${host}/${kept.join("/")}`;
}

export interface ImageKeys { path?: string; stem?: string }

/** The keys of an image URL; empty for data:/blob: and unparsable URLs. */
export function imageKeys(raw: string): ImageKeys {
  const url = innermostImageUrl(raw);
  if (!url) return {};
  const stem = imageStem(url);
  return { path: imagePathKey(url), ...(stem && !GENERIC_STEMS.has(stem) ? { stem } : {}) };
}

export interface MatchCandidate { id: string; candidates: readonly string[] }
export interface MatchTarget { id: string; src: string }

/**
 * Reference image id → rendered image id. A reference image matches a rendered image when one of its
 * candidate URLs has the rendered src's key: first by full path, then (for what is left) by file-name stem.
 * Reference images claim in document order, each the first unclaimed rendered image with that key, so
 * every rendered image matches at most one reference image.
 */
export function matchImages(reference: readonly MatchCandidate[], rendered: readonly MatchTarget[]): Map<string, string> {
  const renderedKeys = rendered.map((image) => ({ id: image.id, keys: imageKeys(image.src) }));
  const referenceKeys = reference.map((image) => ({ id: image.id, keys: image.candidates.map(imageKeys) }));
  const matches = new Map<string, string>();
  const claimed = new Set<string>();
  for (const kind of ["path", "stem"] as const) {
    for (const ref of referenceKeys) {
      if (matches.has(ref.id)) continue;
      const wanted = new Set(ref.keys.map((keys) => keys[kind]).filter((key): key is string => Boolean(key)));
      const hit = renderedKeys.find((image) => !claimed.has(image.id) && image.keys[kind] !== undefined && wanted.has(image.keys[kind]));
      if (hit) { matches.set(ref.id, hit.id); claimed.add(hit.id); }
    }
  }
  return matches;
}

/**
 * The URLs of a srcset value (descriptors dropped). A URL is a run of non-space characters, so commas
 * inside it (Cloudinary's `w_1456,c_limit`) survive; a trailing comma ends it.
 */
export function parseSrcset(value: string): string[] {
  const urls: string[] = [];
  let at = 0;
  while (at < value.length) {
    while (at < value.length && /[\s,]/.test(value[at] as string)) at += 1;
    if (at >= value.length) break;
    let end = at;
    while (end < value.length && !/\s/.test(value[end] as string)) end += 1;
    let url = value.slice(at, end);
    const endsCandidate = url.endsWith(",");
    url = url.replace(/,+$/, "");
    if (url) urls.push(url);
    at = end;
    if (endsCandidate) continue;
    // Skip the descriptors up to the next comma outside parentheses.
    let depth = 0;
    while (at < value.length) {
      const char = value[at] as string;
      if (char === "(") depth += 1;
      else if (char === ")") depth = Math.max(0, depth - 1);
      else if (char === "," && depth === 0) break;
      at += 1;
    }
  }
  return urls;
}

const CAPTION_CHARS = 160;
/** An image is listed on the original page when it is at least this big on one side (laid out or declared). */
export const MIN_REFERENCE_SIDE = 48;
const DATA_URI_SHOWN = 40;

/** A data: URI shortened to its type and length, so a manifest does not carry the image bytes. */
export function shortenDataUri(src: string): string {
  if (!src.startsWith("data:")) return src;
  const head = src.slice(0, src.indexOf(",") + 1 || DATA_URI_SHOWN);
  return `${head.slice(0, DATA_URI_SHOWN)}…(${src.length} chars)`;
}

const clip = (text: string, chars: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > chars ? `${flat.slice(0, chars - 1)}…` : flat;
};

/** One `{type: "image", url, alt}` node of the reader payload, in document order, duplicates kept. */
export interface PayloadImage { url: string; alt: string }

/** The image nodes of a reader.document payload (the JSON string or its parsed tree), in document order. */
export function imageNodesOf(payload: unknown): PayloadImage[] {
  const nodes: PayloadImage[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.type === "image" && typeof record.url === "string" && record.url) nodes.push({ url: record.url, alt: typeof record.alt === "string" ? record.alt : "" });
    Object.values(record).forEach(visit);
  };
  visit(typeof payload === "string" ? JSON.parse(payload) : payload);
  return nodes;
}

/** What the reader page reports per image element (page-facts `images`). */
export interface RenderedImageFact {
  /** The original URL when the page knows it (the capture's blob → source map, or a real src), else "". */
  original: string;
  broken: boolean;
  alt: string;
  caption: string;
  /** The 1-based rendered tile holding the element's top (tiles.ts tileAt), or null. */
  tile: number | null;
}

/**
 * Original URLs for the reader's image elements. An element whose URL the page knows advances through the
 * payload's image nodes to that URL; one it does not know (a placeholder for an image that failed or never
 * loaded has no src at all) takes the next payload node. Both lists are in document order.
 */
export function alignImageSources(facts: readonly Pick<RenderedImageFact, "original">[], payload: readonly PayloadImage[]): string[] {
  let next = 0;
  return facts.map((fact) => {
    if (fact.original) {
      const at = payload.findIndex((node, index) => index >= next && node.url === fact.original);
      if (at >= 0) next = at + 1;
      return fact.original;
    }
    const node = payload[next];
    if (!node) return "";
    next += 1;
    return node.url;
  });
}

export function buildRenderedImages(facts: readonly RenderedImageFact[], payload: readonly PayloadImage[]): RenderedImage[] {
  const sources = alignImageSources(facts, payload);
  return facts.map((fact, index) => ({
    id: `r${index + 1}`, tile: fact.tile, src: shortenDataUri(sources[index] ?? ""),
    alt: clip(fact.alt, CAPTION_CHARS), caption: clip(fact.caption, CAPTION_CHARS), broken: fact.broken,
  }));
}

/** What the original page reports per <img> (reference-facts). */
export interface ReferenceImageFact {
  /** currentSrc, else the resolved src attribute (may be ""). */
  src: string;
  /** Lazy-load attributes, raw: data-src, data-original, data-lazy-src. */
  lazy: string[];
  /** Raw srcset values: the img's srcset and data-srcset, and those of the <source>s of its <picture>. */
  srcsets: string[];
  alt: string;
  width: number;
  height: number;
  declaredWidth: number;
  declaredHeight: number;
  /** Page y of the image's top, and the 1-based reference tile holding it (tiles.ts tileAt) or null. */
  top: number;
  tile: number | null;
}

const absolute = (raw: string, base: string): string | undefined => {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:")) return undefined;
  try {
    const url = new URL(trimmed, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
};

/** The src and every lazy-load and srcset candidate, absolute and deduplicated (data: placeholders dropped). */
export function referenceCandidates(fact: Pick<ReferenceImageFact, "src" | "lazy" | "srcsets">, base: string): string[] {
  const raw = [fact.src, ...fact.lazy, ...fact.srcsets.flatMap(parseSrcset)];
  return [...new Set(raw.map((value) => absolute(value, base)).filter((value): value is string => value !== undefined))];
}

const isListed = (fact: ReferenceImageFact) => Math.max(fact.width, fact.height) >= MIN_REFERENCE_SIDE || (fact.width * fact.height === 0 && Math.max(fact.declaredWidth, fact.declaredHeight) >= MIN_REFERENCE_SIDE);

const keySet = (candidates: readonly string[]) => new Set(candidates.flatMap((url) => { const keys = imageKeys(url); return [keys.path && `p:${keys.path}`, keys.stem && `s:${keys.stem}`].filter(Boolean) as string[]; }));

const SAME_BOX_PX = 2;
const sameBox = (a: ReferenceImageFact, b: ReferenceImageFact) => Math.abs(a.top - b.top) <= SAME_BOX_PX && Math.abs(a.width - b.width) <= SAME_BOX_PX && Math.abs(a.height - b.height) <= SAME_BOX_PX;

/**
 * The sizeable images of the original page, in document order: laid out at 48 px or more on one side, or
 * left unsized (lazy) with a declared size of 48 px or more. Listed once: an image that is the same picture
 * as the one listed just before it (a lazy <img> followed by its <noscript> copy), and dropped: an image
 * with no URL of its own (a data: blur-up or lazy placeholder) laid over a neighbouring listed image's box.
 */
export function buildReferenceImages(facts: readonly ReferenceImageFact[], base: string): Omit<ReferenceImage, "id" | "matchedBy">[] {
  const listed: { fact: ReferenceImageFact; candidates: string[]; keys: Set<string> }[] = [];
  for (const fact of facts) {
    if (!isListed(fact)) continue;
    const candidates = referenceCandidates(fact, base);
    const keys = keySet(candidates);
    const previous = listed.at(-1);
    if (previous && [...keys].some((key) => previous.keys.has(key))) continue;
    listed.push({ fact, candidates, keys });
  }
  const placeholder = (index: number) => {
    const entry = listed[index] as (typeof listed)[number];
    if (entry.candidates.length > 0) return false;
    return [listed[index - 1], listed[index + 1]].some((neighbour) => neighbour !== undefined && neighbour.candidates.length > 0 && sameBox(entry.fact, neighbour.fact));
  };
  return listed.filter((_, index) => !placeholder(index)).map(({ fact, candidates }) => ({
    tile: fact.tile, src: absolute(fact.src, base) ?? shortenDataUri(fact.src), candidates, alt: clip(fact.alt, CAPTION_CHARS), width: Math.round(fact.width), height: Math.round(fact.height),
  }));
}

/** Ids the reference images and points each at the reader image that is the same picture. */
export function linkImages(reference: readonly Omit<ReferenceImage, "id" | "matchedBy">[], rendered: readonly RenderedImage[]): ReferenceImage[] {
  const withIds = reference.map((image, index) => ({ id: `o${index + 1}`, ...image }));
  const matches = matchImages(withIds, rendered);
  return withIds.map((image) => ({ id: image.id, tile: image.tile, src: image.src, candidates: image.candidates, alt: image.alt, width: image.width, height: image.height, matchedBy: matches.get(image.id) ?? null }));
}
