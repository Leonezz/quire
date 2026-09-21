import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FetchError, assertPublicHttpUrl } from "./fetch";
import { FigureStore, parseFigureUrl } from "./figures";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const IMAGE_TYPES = /^image\/(avif|gif|jpeg|png|webp|svg\+xml)$/;

/**
 * Images are fetched once, kept on disk under userData/images, and handed to the
 * renderer as data: URLs so the page's CSP never needs a remote host. A source
 * that cannot be cached (non-public host, not an image, too large) resolves to
 * undefined: the reader then shows its placeholder instead of a broken picture. Figure crops
 * of the text view (quire-figure://<materialId>/<n>.png) are served from userData/figures.
 */
export class ImageCache {
  private readonly figures: FigureStore;

  constructor(private readonly root: string) { this.figures = new FigureStore(root); }

  private get dir() { return join(this.root, "images"); }

  private key(url: string) { return createHash("sha256").update(url).digest("hex"); }

  async resolve(rawUrl: string): Promise<string | undefined> {
    if (parseFigureUrl(rawUrl)) return this.figures.read(rawUrl);
    const cached = await this.read(rawUrl);
    if (cached) return cached;
    let url: URL;
    try { url = assertPublicHttpUrl(rawUrl); } catch (error) { if (error instanceof FetchError) return undefined; throw error; }
    const fetched = await this.download(url);
    if ("error" in fetched) return undefined;
    await this.write(rawUrl, fetched.mediaType, fetched.bytes);
    return toDataUrl(fetched.mediaType, fetched.bytes);
  }

  private async read(rawUrl: string): Promise<string | undefined> {
    const key = this.key(rawUrl);
    try {
      const meta = JSON.parse(await readFile(join(this.dir, `${key}.json`), "utf8")) as { mediaType: string };
      const bytes = await readFile(join(this.dir, `${key}.bin`));
      return toDataUrl(meta.mediaType, bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async write(rawUrl: string, mediaType: string, bytes: Uint8Array) {
    await mkdir(this.dir, { recursive: true });
    const key = this.key(rawUrl);
    await writeFile(join(this.dir, `${key}.bin`), bytes);
    await writeFile(join(this.dir, `${key}.json`), JSON.stringify({ mediaType, url: rawUrl, fetchedAt: new Date().toISOString() }));
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
    if (parseFigureUrl(rawUrl)) return (await this.figures.read(rawUrl)) ? undefined : "figure crop is missing on disk";
    if (await this.read(rawUrl)) return undefined;
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

function toDataUrl(mediaType: string, bytes: Uint8Array) {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}
