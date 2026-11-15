// Where the reader's pictures come from. resolveImage answers with quire-image://cache/<key> (a
// cached image, userData/images/<key>.bin) or quire-image://figure/<materialId>/<n>.png (a text
// view's figure crop, userData/figures), and main serves the bytes here, so the renderer holds a
// short URL per image instead of its bytes as a base64 string. Only a well-formed key or crop
// reference reaches the store; anything else is a 404 without touching the disk. Every answer
// carries the stored type, nosniff, and a policy that runs no script and loads nothing beyond
// inline styles and data: pictures and fonts, so an SVG opened as a document is inert.

import type { FigureRef } from "./engine/figures";
import { parseImageUrl, type StoredImage } from "./engine/images";

export const IMAGE_RESPONSE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

export interface ImageSources {
  /** The cached image under a key; undefined when there is none. */
  image: (key: string) => Promise<StoredImage | undefined>;
  /** A figure crop's PNG; undefined when it is not on disk. */
  figure: (ref: FigureRef) => Promise<Uint8Array<ArrayBuffer> | undefined>;
}

const headers = (contentType: string) => ({
  "content-type": contentType,
  "x-content-type-options": "nosniff",
  "content-security-policy": IMAGE_RESPONSE_CSP,
  // The bytes stay on disk; a copy in the renderer's cache would only outlive the page that shows it.
  "cache-control": "no-store",
});

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: headers("text/plain; charset=utf-8") });

/** The response for a quire-image:// request; a failing store rejects rather than passing for a missing image. */
export async function imageResponse(url: string, sources: ImageSources): Promise<Response> {
  const target = parseImageUrl(url);
  if (target?.kind === "cache") {
    const stored = await sources.image(target.key);
    return stored ? new Response(stored.bytes, { headers: headers(stored.mediaType) }) : NOT_FOUND();
  }
  if (target?.kind === "figure") {
    const png = await sources.figure(target.ref);
    return png ? new Response(png, { headers: headers("image/png") }) : NOT_FOUND();
  }
  return NOT_FOUND();
}
