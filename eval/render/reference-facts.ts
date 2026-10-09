// Raw facts about the images of the original page (JavaScript off), collected in the page with
// page.evaluate(collectReferenceImages). Serialized into the browser, so self-contained and synchronous
// (a page with JavaScript off runs no timers, not even for page.evaluate). ./images turns the facts
// into the manifest's ReferenceImage list.
import type { ReferenceImageFact } from "./images";

export interface ReferenceFacts {
  /** The document's base URL (the injected <base>), against which the raw attributes resolve. */
  base: string;
  /** Every <img> in document order (the tile is assigned in Node, from `top`). */
  images: Omit<ReferenceImageFact, "tile">[];
}

/**
 * The nearest heading or paragraph before all[index] in document order (not one containing it), as
 * flattened text clipped to maxChars, "" when there is none. Candidates inside nav/header/footer/aside
 * are passed over while a candidate outside them exists further back. Self-contained: it runs in the
 * page, handed to collectReferenceImages (see referenceFactsScript).
 */
export function precedingContext(all: readonly Element[], index: number, maxChars: number): string {
  const target = all[index];
  if (!target) return "";
  let fallback = "";
  for (let at = index - 1; at >= 0; at -= 1) {
    const candidate = all[at] as Element;
    if (!/^(?:H[1-6]|P)$/i.test(candidate.tagName) || candidate.contains(target)) continue;
    const text = (candidate.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, maxChars);
    if (!text) continue;
    if (candidate.closest("nav, header, footer, aside") === null) return text;
    if (!fallback) fallback = text;
  }
  return fallback;
}

/** Collects the facts in the page; contextOf is precedingContext, passed in because the page has no imports. */
export function collectReferenceImages(contextOf: typeof precedingContext): ReferenceFacts {
  const CONTEXT_CHARS = 400;
  const all = Array.from(document.body?.querySelectorAll("*") ?? []);
  const position = new Map(all.map((element, index) => [element, index]));
  const LAZY = ["data-src", "data-original", "data-lazy-src"];
  const declared = (value: string | null) => (value && /^\s*\d+(?:\.\d+)?(?:px)?\s*$/.test(value) ? Number.parseFloat(value) : 0);
  const images = Array.from(document.images, (image) => {
    const rect = image.getBoundingClientRect();
    const srcsets = [image.getAttribute("srcset"), image.getAttribute("data-srcset")];
    const picture = image.parentElement?.tagName === "PICTURE" ? image.parentElement : null;
    if (picture) for (const source of Array.from(picture.querySelectorAll("source"))) srcsets.push(source.getAttribute("srcset"), source.getAttribute("data-srcset"));
    return {
      src: image.currentSrc || image.src || "",
      lazy: LAZY.map((name) => image.getAttribute(name) ?? "").filter(Boolean),
      srcsets: srcsets.filter((value): value is string => Boolean(value)),
      alt: image.alt || image.title || "",
      width: rect.width, height: rect.height,
      declaredWidth: declared(image.getAttribute("width")), declaredHeight: declared(image.getAttribute("height")),
      top: rect.top + window.scrollY,
      context: position.has(image) ? contextOf(all, position.get(image) as number, CONTEXT_CHARS) : "",
    };
  });
  return { base: document.baseURI, images };
}

/** The page.evaluate source that runs collectReferenceImages with precedingContext (functions cannot be passed as arguments). */
export const referenceFactsScript = (): string => `(${collectReferenceImages.toString()})(${precedingContext.toString()})`;
