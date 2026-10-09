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

export function collectReferenceImages(): ReferenceFacts {
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
    };
  });
  return { base: document.baseURI, images };
}
