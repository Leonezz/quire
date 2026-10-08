// The capture's answer to the render harness's `GET /__render/image?src=<url>` (renderReadiness.ts in the
// renderer): the browser preview has no engine to fetch remote images, so Node fetches them with the same
// rules as the app's ImageCache (apps/desktop/src/main/engine/images.ts): browser-ish headers with the
// image origin as referer, 15 s, 8 MiB, and the bytes decide the type when the server mislabels it.
// A failure is an answer too (404 + reason): the reader then shows its "Image unavailable" placeholder.
// Like the app (which prefetches a page's images on import and keeps them on disk), the capture prefetches
// a case's images before opening the page and keeps successful downloads under out/.images, so the
// harness's 15 s readiness budget measures rendering, not this machine's network.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const IMAGE_ENDPOINT = "/__render/image";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const IMAGE_TYPES = /^image\/(avif|gif|jpeg|png|webp|svg\+xml)$/;

export type ImageOutcome = { ok: true; mediaType: string; bytes: Uint8Array } | { ok: false; error: string };

export function sniffImageType(bytes: Uint8Array): string | undefined {
  const head = Array.from(bytes.subarray(0, 12));
  const startsWith = (...signature: number[]) => signature.every((byte, index) => head[index] === byte);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (startsWith(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return "image/webp";
  if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return "image/avif";
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) return "image/svg+xml";
  return undefined;
}

/** The `src` of a proxy request URL, or undefined when it is not one. */
export function proxiedSource(requestUrl: string): string | undefined {
  const url = new URL(requestUrl);
  return url.pathname === IMAGE_ENDPOINT ? (url.searchParams.get("src") ?? undefined) : undefined;
}

async function download(raw: string): Promise<ImageOutcome> {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, error: "not a URL" }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: `unsupported scheme ${url.protocol}` };
  try {
    const response = await fetch(url, {
      redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml,*/*;q=0.5", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", referer: `${url.origin}/` },
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const declaredType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (Number(response.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) return { ok: false, error: `larger than ${MAX_IMAGE_BYTES} bytes` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) return { ok: false, error: "empty body" };
    if (bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, error: `larger than ${MAX_IMAGE_BYTES} bytes` };
    const mediaType = IMAGE_TYPES.test(declaredType) ? declaredType : sniffImageType(bytes);
    if (!mediaType) return { ok: false, error: `not an image (${declaredType || "no content-type"})` };
    return { ok: true, mediaType, bytes };
  } catch (error) {
    const name = (error as Error).name;
    if (name === "TimeoutError" || name === "AbortError") return { ok: false, error: "timeout" };
    return { ok: false, error: `network: ${(error as Error).message}` };
  }
}

/** Image URLs in a reader.document payload (the JSON string or its parsed tree): every `{type: "image", url}` node. */
export function imageUrlsOf(payload: unknown): string[] {
  const urls = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.type === "image" && typeof record.url === "string" && record.url) urls.add(record.url);
    Object.values(record).forEach(visit);
  };
  visit(typeof payload === "string" ? JSON.parse(payload) : payload);
  return [...urls];
}

export type ImageFetcher = (src: string) => Promise<ImageOutcome>;

/**
 * One download per source for the whole run (several slugs can share an image). With cacheDir, successful
 * downloads persist across runs (`<sha256>.bin` + `.json`); failures are always retried.
 */
export function createImageFetcher(cacheDir?: string): ImageFetcher {
  const memory = new Map<string, Promise<ImageOutcome>>();
  const paths = (src: string) => {
    const key = createHash("sha256").update(src).digest("hex");
    return { bin: join(cacheDir as string, `${key}.bin`), meta: join(cacheDir as string, `${key}.json`) };
  };
  const load = async (src: string): Promise<ImageOutcome> => {
    if (cacheDir) {
      const { bin, meta } = paths(src);
      if (existsSync(bin) && existsSync(meta)) {
        const { mediaType } = JSON.parse(readFileSync(meta, "utf8")) as { mediaType: string };
        return { ok: true, mediaType, bytes: new Uint8Array(readFileSync(bin)) };
      }
    }
    const outcome = await download(src);
    if (outcome.ok && cacheDir) {
      mkdirSync(cacheDir, { recursive: true });
      const { bin, meta } = paths(src);
      writeFileSync(bin, outcome.bytes);
      writeFileSync(meta, JSON.stringify({ mediaType: outcome.mediaType, url: src, fetchedAt: new Date().toISOString() }));
    }
    return outcome;
  };
  return (src) => {
    const known = memory.get(src);
    if (known) return known;
    const pending = load(src);
    memory.set(src, pending);
    return pending;
  };
}

/** Fetches every url, a few at a time; the outcomes stay in the fetcher's cache for the page's requests. */
export async function prefetchImages(fetchImage: ImageFetcher, urls: readonly string[], concurrency = 6): Promise<void> {
  const queue = [...urls];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) await fetchImage(url);
  }));
}
