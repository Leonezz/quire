import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IMAGE_SCHEME } from "../../shared/contracts";
import { FetchError, assertPublicHttpUrl } from "./fetch";
import { FigureStore, parseFigureUrl, type FigureRef } from "./figures";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const IMAGE_TYPES = /^image\/(avif|gif|jpeg|png|webp|svg\+xml)$/;
/** A cache key: the SHA-256 of the source URL, the only file names the protocol serves. */
const IMAGE_KEY = /^[a-f0-9]{64}$/;
// The host is fixed and the name sits in the path, as with quire-artifact://artifact/<id>: a standard
// scheme's host is canonicalized as a domain name, and an all-digit material id would read as an IPv4 address.
const CACHED_IMAGE_URL = /^quire-image:\/\/cache\/([a-f0-9]{64})$/;
const FIGURE_IMAGE_URL = /^quire-image:\/\/figure\/([a-f0-9]{16})\/([1-9]\d{0,3})\.png$/;

/** A cached image as the protocol serves it. */
export interface StoredImage { mediaType: string; bytes: Uint8Array<ArrayBuffer> }

/** What a quire-image URL serves: a cached image by its key, or a text view's figure crop. */
export type ImageTarget = { kind: "cache"; key: string } | { kind: "figure"; ref: FigureRef };

/** `quire-image://cache/<key>`: where main serves the cached copy of a source. */
export function imageUrl(key: string): string {
  if (!IMAGE_KEY.test(key)) throw new Error(`"${key}" is not an image cache key`);
  return `${IMAGE_SCHEME}://cache/${key}`;
}

/** `quire-image://figure/<materialId>/<n>.png`: where main serves a figure crop. */
export function figureImageUrl(ref: FigureRef): string {
  return `${IMAGE_SCHEME}://figure/${ref.materialId}/${ref.index}.png`;
}

/** What a quire-image URL names; undefined for anything else. */
export function parseImageUrl(url: string): ImageTarget | undefined {
  const cached = CACHED_IMAGE_URL.exec(url);
  if (cached) return { kind: "cache", key: cached[1]! };
  const figure = FIGURE_IMAGE_URL.exec(url);
  return figure ? { kind: "figure", ref: { materialId: figure[1]!, index: Number(figure[2]) } } : undefined;
}

/**
 * Images are fetched once, kept on disk under userData/images, and handed to the
 * renderer as quire-image://cache/<key> URLs that main serves from there (image-protocol.ts),
 * so the page's CSP never needs a remote host and the renderer never holds the bytes as
 * a string. A source that cannot be cached (non-public host, not an image, too large)
 * resolves to undefined: the reader then shows its placeholder instead of a broken picture.
 * Figure crops of the text view (quire-figure://<materialId>/<n>.png) resolve to
 * quire-image://figure/… while they are in userData/figures. Images no material shows any
 * more are forgotten when materials are deleted (library.ts).
 */
export class ImageCache {
  private readonly figures: FigureStore;
  /** Writes and removals run one at a time, so a removal never interleaves with a half-written pair. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) { this.figures = new FigureStore(root); }

  private get dir() { return join(this.root, "images"); }

  private key(url: string) { return createHash("sha256").update(url).digest("hex"); }

  async resolve(rawUrl: string): Promise<string | undefined> {
    const figure = parseFigureUrl(rawUrl);
    if (figure) return (await this.figures.has(figure)) ? figureImageUrl(figure) : undefined;
    const key = this.key(rawUrl);
    if (await this.has(key)) return imageUrl(key);
    let url: URL;
    try { url = assertPublicHttpUrl(rawUrl); } catch (error) { if (error instanceof FetchError) return undefined; throw error; }
    const fetched = await this.download(url);
    if ("error" in fetched) return undefined;
    await this.write(rawUrl, fetched.mediaType, fetched.bytes);
    return imageUrl(key);
  }

  /** Whether both halves of the pair are on disk (a write interrupted between them is not a cached image). */
  private async has(key: string): Promise<boolean> {
    try {
      await access(join(this.dir, `${key}.json`));
      await access(join(this.dir, `${key}.bin`));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  /** The cached copy under a key, for the protocol; undefined when it is not on disk. */
  async stored(key: string): Promise<StoredImage | undefined> {
    if (!IMAGE_KEY.test(key)) throw new Error(`"${key}" is not an image cache key`);
    let meta: { mediaType?: unknown };
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      meta = JSON.parse(await readFile(join(this.dir, `${key}.json`), "utf8")) as { mediaType?: unknown };
      bytes = await readFile(join(this.dir, `${key}.bin`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    // Only an image type is ever written; anything else means the pair was changed on disk.
    if (typeof meta.mediaType !== "string" || !IMAGE_TYPES.test(meta.mediaType)) throw new Error(`The cached image ${key} records the media type ${JSON.stringify(meta.mediaType)}, which is not an image type.`);
    return { mediaType: meta.mediaType, bytes };
  }

  /** A text view's figure crop, for the protocol; undefined when it is not on disk. */
  figure(ref: FigureRef): Promise<Uint8Array<ArrayBuffer> | undefined> {
    return this.figures.bytes(ref);
  }

  private write(rawUrl: string, mediaType: string, bytes: Uint8Array): Promise<void> {
    return this.serialized(async () => {
      await mkdir(this.dir, { recursive: true });
      const key = this.key(rawUrl);
      await writeFile(join(this.dir, `${key}.bin`), bytes);
      await writeFile(join(this.dir, `${key}.json`), JSON.stringify({ mediaType, url: rawUrl, fetchedAt: new Date().toISOString() }));
    });
  }

  /**
   * Removes the cached copies of these sources; returns how many were on disk. Only http(s) sources
   * are cached here: figure crops (quire-figure://) and anything else are skipped. A source viewed
   * again is fetched again.
   */
  forget(urls: Iterable<string>): Promise<number> {
    const keys = [...new Set(urls)].filter((url) => /^https?:/i.test(url)).map((url) => this.key(url));
    return this.serialized(async () => {
      let removed = 0;
      for (const key of keys) {
        if (await removeFile(join(this.dir, `${key}.bin`))) removed += 1;
        await rm(join(this.dir, `${key}.json`), { force: true });
      }
      return removed;
    });
  }

  /** Runs the task after every write or removal queued before it; its own failure reaches its caller, never the next task. */
  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Caches every source in the background, a few at a time; unresolvable ones are simply skipped. */
  async prefetch(urls: readonly string[], concurrency = 3): Promise<{ cached: number; skipped: number }> {
    const queue = [...urls];
    let cached = 0; let skipped = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
        if (await this.resolve(url)) cached += 1; else skipped += 1;
      }
    }));
    return { cached, skipped };
  }

  /** Why a source could not be cached; for diagnostics and the placeholder's tooltip. */
  async explain(rawUrl: string): Promise<string | undefined> {
    const figure = parseFigureUrl(rawUrl);
    if (figure) return (await this.figures.has(figure)) ? undefined : "figure crop is missing on disk";
    if (await this.has(this.key(rawUrl))) return undefined;
    let url: URL;
    try { url = assertPublicHttpUrl(rawUrl); } catch (error) { return error instanceof FetchError ? error.message : String(error); }
    const outcome = await this.download(url);
    return "error" in outcome ? outcome.error : undefined;
  }

  private async download(url: URL): Promise<{ mediaType: string; bytes: Uint8Array } | { error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        // Many hosts refuse hotlinks without a same-site referer; the page's own origin is the honest one.
        headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml,*/*;q=0.5", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", referer: `${url.origin}/` },
      });
      if (!response.ok) return { error: `HTTP ${response.status}` };
      const declaredType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > MAX_IMAGE_BYTES) return { error: `larger than ${MAX_IMAGE_BYTES} bytes` };
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) return { error: "empty body" };
      if (bytes.byteLength > MAX_IMAGE_BYTES) return { error: `larger than ${MAX_IMAGE_BYTES} bytes` };
      // Servers mislabel images (text/plain, octet-stream); the bytes decide.
      const mediaType = IMAGE_TYPES.test(declaredType) ? declaredType : sniffImageType(bytes);
      if (!mediaType) return { error: `not an image (${declaredType || "no content-type"})` };
      return { mediaType, bytes };
    } catch (error) {
      // Network failures leave the image unresolved; the reader shows its placeholder and can retry.
      if ((error as Error).name === "AbortError") return { error: "timeout" };
      if ((error as Error).name === "TypeError") return { error: `network: ${(error as Error).message}` };
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function sniffImageType(bytes: Uint8Array): string | undefined {
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

/** Whether the file was there to remove. */
async function removeFile(path: string): Promise<boolean> {
  try { await rm(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
