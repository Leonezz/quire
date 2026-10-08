// A tiny static server for the built renderer on 127.0.0.1 (random port). `/dev/corpus/*` comes from
// the source public dir, so a fresh `eval export` shows up without rebuilding the renderer.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".wasm": "application/wasm",
  ".pdf": "application/pdf", ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};

export interface Mount { prefix: string; dir: string }

/** The file a URL path maps to under the first matching mount, or undefined when it escapes the mount. */
export function resolveStatic(urlPath: string, mounts: readonly Mount[]): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/"); } catch { return undefined; }
  const mount = mounts.find((m) => decoded === m.prefix || decoded.startsWith(m.prefix.endsWith("/") ? m.prefix : `${m.prefix}/`));
  if (!mount) return undefined;
  const rest = decoded.slice(mount.prefix.length).replace(/^\/+/, "") || "index.html";
  const path = normalize(join(mount.dir, rest));
  return path === mount.dir || path.startsWith(mount.dir.endsWith(sep) ? mount.dir : mount.dir + sep) ? path : undefined;
}

export interface StaticServer { origin: string; close(): Promise<void>; server: Server }

/** Serves the mounts (most specific prefix first) until close(); 404 for anything else. */
export async function startStaticServer(mounts: readonly Mount[]): Promise<StaticServer> {
  const ordered = [...mounts].sort((a, b) => b.prefix.length - a.prefix.length);
  const server = createServer((request, response) => {
    const path = resolveStatic(request.url ?? "/", ordered);
    if (!path || !existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404, { "content-type": "text/plain" }).end(`not found: ${request.url}`);
      return;
    }
    response.writeHead(200, { "content-type": TYPES[extname(path).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(path).on("error", (error) => response.destroy(error)).pipe(response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`, server,
    close: () => new Promise((resolve, reject) => { server.close((error) => (error ? reject(error) : resolve())); server.closeAllConnections(); }),
  };
}
