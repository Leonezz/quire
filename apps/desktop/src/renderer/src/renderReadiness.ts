import type { ImageResolver } from "./ReaderArticle";

// The render harness (?render=<id>, RenderHarness.tsx) for the eval capture (eval/render): its query, its image
// source, and the rule for "the article is fully painted". The capture script reads the result off <html>:
//   data-render-ready="1"        the article can be measured and screenshotted
//   data-render-warning="a b"    space-separated: images-timeout, math-timeout, image-proxy-missing, reader-fallback:<reason>
//   data-render-error="<msg>"    nothing usable was rendered (the message is on the page too)

export type RenderTheme = "light" | "dark";
export interface RenderQuery { id: string; width?: number | undefined; theme: RenderTheme }

export const RENDER_TIMEOUT_MS = 15_000;
const MIN_WIDTH = 320;
const MAX_WIDTH = 4_000;

/** `?render=<id>[&width=<px>][&theme=light|dark]`: undefined when there is no `render`, an error for a malformed query (never a silent default). */
export function parseRenderQuery(search: string): RenderQuery | { error: string } | undefined {
  const params = new URLSearchParams(search);
  const id = params.get("render");
  if (id === null) return undefined;
  if (!id.trim()) return { error: "render: the query names no material (use ?render=<id>)." };
  const theme = params.get("theme") ?? "light";
  if (theme !== "light" && theme !== "dark") return { error: `render: unknown theme "${theme}" (use light or dark).` };
  const rawWidth = params.get("width");
  if (rawWidth === null) return { id, theme };
  const width = Number(rawWidth);
  if (!Number.isInteger(width) || width < MIN_WIDTH || width > MAX_WIDTH) return { error: `render: width "${rawWidth}" is not a whole number of pixels between ${MIN_WIDTH} and ${MAX_WIDTH}.` };
  return { id, width, theme };
}

/**
 * Images for the browser harness. The preview has no engine to fetch and cache remote images (and the page CSP
 * blocks remote hosts), so the harness asks its own origin: `GET /__render/image?src=<url>`, which the capture
 * script answers with `page.route` (fetching the image from Node). The answer becomes a blob: URL, which the
 * surface accepts like the engine's data: URLs. A non-image answer means the image failed (shown as unavailable,
 * counted by the capture); an HTML answer is the dev server's SPA fallback, i.e. no route is installed at all.
 */
export const RENDER_IMAGE_ENDPOINT = "/__render/image";
export function proxyImageResolver(onProxyMissing: () => void): ImageResolver {
  return async (url, signal) => {
    if (url.startsWith("data:") || url.startsWith("blob:")) return url;
    const response = await fetch(`${RENDER_IMAGE_ENDPOINT}?src=${encodeURIComponent(url)}`, { signal });
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("text/html")) { onProxyMissing(); return undefined; }
    if (!response.ok || !type.startsWith("image/")) return undefined;
    // Not revoked: the harness page lives for one capture.
    return URL.createObjectURL(await response.blob());
  };
}

interface Pending { surface: boolean; images: number; math: number }

function pendingIn(root: HTMLElement): Pending {
  const images = [...root.querySelectorAll("img")];
  // The reader lazy-loads images; a capture needs every one painted, wherever it sits on the page.
  for (const image of images) if (image.loading === "lazy") image.loading = "eager";
  return {
    surface: root.querySelector("[data-reader-schema], [data-reader-fallback]") === null,
    images: root.querySelectorAll('[data-reader-image="loading"]').length + images.filter((image) => !image.complete).length,
    math: root.querySelectorAll('[data-reader-math-enhancement="pending"]').length,
  };
}

const settled = (pending: Pending) => !pending.surface && pending.images === 0 && pending.math === 0;
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
const nextFrame = () => new Promise<void>((resolve) => { if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve()); else setTimeout(resolve, 0); });

export interface ReadinessOptions { timeoutMs?: number | undefined; pollMs?: number | undefined; signal?: AbortSignal | undefined }

/**
 * Resolves once the article is fully painted: the document surface rendered its body, every image settled (an
 * `<img>` complete — loaded or errored — and no resolver still loading), every TeX formula settled, and
 * `document.fonts.ready`. After `timeoutMs` it resolves anyway with a warning for what was still pending; a
 * surface that never rendered is an error. Rejects with an AbortError when `signal` aborts.
 */
export async function waitForArticleReady(root: HTMLElement, { timeoutMs = RENDER_TIMEOUT_MS, pollMs = 50, signal }: ReadinessOptions = {}): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  const aborted = () => { if (signal?.aborted) throw new DOMException("The render wait was cancelled.", "AbortError"); };
  for (;;) {
    aborted();
    const pending = pendingIn(root);
    if (settled(pending)) {
      // Fonts load as the body uses them (KaTeX's among them), so they are awaited once everything else is in.
      await Promise.race([document.fonts?.ready, sleep(Math.max(0, deadline - Date.now()))]);
      await nextFrame(); await nextFrame();
      aborted();
      if (settled(pendingIn(root))) return [];
    } else if (Date.now() >= deadline) {
      if (pending.surface) throw new Error(`The document surface did not render within ${timeoutMs} ms.`);
      return [...(pending.images ? ["images-timeout"] : []), ...(pending.math ? ["math-timeout"] : [])];
    }
    await sleep(pollMs);
  }
}
