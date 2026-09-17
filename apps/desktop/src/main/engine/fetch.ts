import { isIP } from "node:net";

export class FetchError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export const MAX_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const family = isIP(host);
  if (family === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (family === 6) return host === "::1" || host.startsWith("fe80") || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("::ffff:");
  return false;
}

/** Only public http(s) origins, no credentials in the URL. */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new FetchError("URL_INVALID", "That is not a valid URL."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new FetchError("URL_SCHEME", "Only http and https pages can be added.");
  if (url.username || url.password) throw new FetchError("URL_CREDENTIALS", "URLs with credentials are not accepted.");
  if (isPrivateHost(url.hostname)) throw new FetchError("URL_PRIVATE", "Local and private network addresses are not fetched.");
  return url;
}

export interface FetchedPage {
  bytes: Uint8Array;
  mediaType: string;
  finalUrl: string;
}

export async function fetchPage(url: URL): Promise<FetchedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { accept: "text/html,application/xhtml+xml,application/pdf,text/markdown,text/plain;q=0.9,*/*;q=0.5", "user-agent": "Read/0.1 (+reading-workbench)" },
    });
    if (!response.ok) throw new FetchError(`HTTP_${response.status}`, `The page answered ${response.status}.`);
    const finalUrl = response.url || url.toString();
    if (isPrivateHost(new URL(finalUrl).hostname)) throw new FetchError("URL_PRIVATE", "The page redirected to a private address.");
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) throw new FetchError("PAGE_TOO_LARGE", "The page is larger than 32 MB.");
    const mediaType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
    const reader = response.body?.getReader();
    if (!reader) throw new FetchError("EMPTY_BODY", "The page had no body.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { await reader.cancel(); throw new FetchError("PAGE_TOO_LARGE", "The page is larger than 32 MB."); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { bytes, mediaType, finalUrl };
  } catch (error) {
    if (error instanceof FetchError) throw error;
    if ((error as Error).name === "AbortError") throw new FetchError("TIMEOUT", "The page took longer than 20 seconds.");
    throw new FetchError("NETWORK", (error as Error).message);
  } finally {
    clearTimeout(timer);
  }
}
