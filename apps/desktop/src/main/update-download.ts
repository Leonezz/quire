import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { SaveDownload } from "./engine/updates";

// The manual update path's download: the release's installer streamed into the downloads folder
// through a `.part` file, so a cut connection never leaves something that looks like a finished
// installer. GitHub answers the asset URL with a redirect to its storage, which fetch follows.

export interface DownloadDeps {
  /** The folder the installer lands in (the user's Downloads). */
  directory: () => string;
  fetch: (url: string, init: { headers: Record<string, string>; redirect: "follow" }) => Promise<Response>;
  userAgent: string;
}

export function createSaveDownload({ directory, fetch, userAgent }: DownloadDeps): SaveDownload {
  return async (url, fileName, onProgress) => {
    const response = await fetch(url, { headers: { "user-agent": userAgent, accept: "application/octet-stream" }, redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(response.status === 404 ? "the release has no installer for this Mac" : `GitHub answered HTTP ${response.status}`);
    const total = Number(response.headers.get("content-length"));
    let received = 0;
    let reported = -1;
    const count = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        // Whole percents only: one state broadcast per percent, not one per chunk.
        const percent = Number.isFinite(total) && total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
        if (percent !== reported) { reported = percent; onProgress(percent); }
        done(null, chunk);
      },
    });
    const target = join(directory(), fileName);
    const partial = `${target}.part`;
    try {
      await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), count, createWriteStream(partial));
      await rename(partial, target);
    } catch (cause: unknown) {
      await rm(partial, { force: true });
      throw cause;
    }
    return target;
  };
}
