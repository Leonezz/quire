import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FetchError, assertPublicHttpUrl } from "./fetch";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const IMAGE_TYPES = /^image\/(avif|gif|jpeg|png|webp|svg\+xml)$/;

/**
 * Images are fetched once, kept on disk under userData/images, and handed to the
 * renderer as data: URLs so the page's CSP never needs a remote host. A source
 * that cannot be cached (non-public host, not an image, too large) resolves to
 * undefined: the reader then shows its placeholder instead of a broken picture.
 */
export class ImageCache {
  constructor(private readonly root: string) {}

  private get dir() { return join(this.root, "images"); }

  private key(url: string) { return createHash("sha256").update(url).digest("hex"); }

  async resolve(rawUrl: string): Promise<string | undefined> {
    const cached = await this.read(rawUrl);
    if (cached) return cached;
    let url: URL;
    try { url = assertPublicHttpUrl(rawUrl); } catch (error) { if (error instanceof FetchError) return undefined; throw error; }
    const fetched = await this.download(url);
    if (!fetched) return undefined;
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

  private async download(url: URL): Promise<{ mediaType: string; bytes: Uint8Array } | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, { redirect: "follow", signal: controller.signal, headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml,*/*;q=0.5", "user-agent": "Read/0.1 (+reading-workbench)" } });
      if (!response.ok) return undefined;
      const mediaType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!IMAGE_TYPES.test(mediaType)) return undefined;
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > MAX_IMAGE_BYTES) return undefined;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return undefined;
      return { mediaType, bytes };
    } catch (error) {
      // Network failures leave the image unresolved; the reader shows its placeholder and can retry.
      if ((error as Error).name === "AbortError" || (error as Error).name === "TypeError") return undefined;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function toDataUrl(mediaType: string, bytes: Uint8Array) {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}
