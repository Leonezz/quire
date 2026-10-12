import { BrowserWindow, nativeImage, type BrowserWindowConstructorOptions, type NativeImage, type WebContents } from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compositeHtml, compositeLayout, locateTextScript, planTiles, windowCaptureRect, type Rect } from "./engine/feedback-capture";
import type { Capturer, OriginalShots, ReaderTiles } from "./engine/feedback-submit";

// The Electron side of the one-step report's screenshots. The reader's own window is captured as it is; the full
// article, the original page and the composite each load in a hidden offscreen window (it paints, runs timers and
// animation frames like a visible one, at device scale 1) that is destroyed when the step ends, however it ends.

/** Where the app's renderer is served: the dev server in development, the built index.html otherwise. */
export type RendererTarget = { url: string } | { file: string };

export interface CapturerOptions {
  /** The window the report was made from. */
  window: BrowserWindow;
  renderer: RendererTarget;
  /** The preload the render harness needs for `read.getMaterial` and `read.resolveImage`. */
  preload: string;
  appVersion: string;
}

const READY_TIMEOUT_MS = 30_000;
const ORIGINAL_LOAD_TIMEOUT_MS = 30_000;
const POLL_MS = 200;
const SETTLE_MS = 400;
const DECODE_WAIT_MS = 5_000;
const JPEG_QUALITY = 80;
/** The partition of the original page: no "persist:" prefix, so it lives in memory and shares nothing with the app. */
const ORIGINAL_PARTITION = "feedback-original";

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

class TimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(`${what} took longer than ${ms / 1000} s`)), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}

function nonEmpty(image: NativeImage, what: string): NativeImage {
  if (image.isEmpty()) throw new Error(`${what} came back empty (the window may be minimized or not painted yet)`);
  return image;
}

/** A hidden offscreen window for one step: it never navigates away or opens windows, and it is destroyed afterwards. */
async function withHiddenWindow<T>(options: BrowserWindowConstructorOptions, run: (win: BrowserWindow) => Promise<T>): Promise<T> {
  const win = new BrowserWindow({
    show: false, useContentSize: true, enableLargerThanScreen: true, paintWhenInitiallyHidden: true, backgroundColor: "#ffffff",
    ...options,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false, ...options.webPreferences },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  try {
    return await run(win);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * A temporary HTML file for a page that is too large for a data: URL; removed afterwards. It starts with a UTF-8
 * byte order mark: the text is already decoded, and the BOM outranks the page's own <meta charset> and the
 * file:// default (windows-1252), either of which would garble it.
 */
async function withTempPage<T>(html: string, run: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "quire-feedback-"));
  try {
    const path = join(dir, "page.html");
    await writeFile(path, `\uFEFF${html}`, "utf8");
    return await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface HarnessFlags { ready: boolean; error: string | null; warning: string }
interface ArticleBox { found: boolean; top: number; height: number }

const FLAGS_SCRIPT = `(() => { const d = document.documentElement.dataset; return { ready: d.renderReady === "1", error: d.renderError ?? null, warning: d.renderWarning ?? "" }; })()`;
const BOX_SCRIPT = `(() => { const el = document.querySelector("[data-render-article]"); if (!el) return { found: false, top: 0, height: 0 }; const r = el.getBoundingClientRect(); return { found: true, top: r.top + window.scrollY, height: r.height }; })()`;
/** Scrolls to y, waits for the images there to decode and two frames to paint; answers where the page actually scrolled to. */
const scrollScript = (y: number) => `(async () => {
  window.scrollTo(0, ${Math.round(y)});
  const decoded = Promise.all(Array.from(document.images, (image) => image.decode().catch(() => undefined)));
  await Promise.race([decoded, new Promise((resolve) => setTimeout(resolve, ${DECODE_WAIT_MS}))]);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return window.scrollY;
})()`;

async function waitForHarness(contents: WebContents): Promise<HarnessFlags> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const flags = await contents.executeJavaScript(FLAGS_SCRIPT, true) as HarnessFlags;
    if (flags.ready || flags.error !== null) return flags;
    if (Date.now() >= deadline) throw new Error(`the render harness set neither data-render-ready nor data-render-error within ${READY_TIMEOUT_MS / 1000} s`);
    await sleep(POLL_MS);
  }
}

function harnessQuery(materialId: string, width: number): Record<string, string> {
  return { render: materialId, width: String(width), theme: "light" };
}

async function loadHarness(win: BrowserWindow, renderer: RendererTarget, materialId: string, width: number): Promise<void> {
  const query = harnessQuery(materialId, width);
  if ("url" in renderer) {
    const url = new URL(renderer.url);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    await win.loadURL(url.toString());
  } else {
    await win.loadFile(renderer.file, { query });
  }
}

/**
 * Scrolls the original page to the text and selects it, through the DevTools protocol: the page's own JavaScript
 * is off, but the protocol still evaluates. Resolves with whether the text is on the page.
 */
async function locateText(contents: WebContents, needle: string): Promise<boolean> {
  contents.debugger.attach("1.3");
  try {
    const reply = await contents.debugger.sendCommand("Runtime.evaluate", { expression: locateTextScript(needle), returnByValue: true }) as { result?: { value?: { found?: boolean } }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (reply.exceptionDetails) throw new Error(`the search script failed in the page: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? "unknown error"}`);
    return reply.result?.value?.found === true;
  } finally {
    contents.debugger.detach();
  }
}

export function createElectronCapturer({ window, renderer, preload, appVersion }: CapturerOptions): Capturer {
  return {
    async captureViewport(rect: Rect | undefined): Promise<Uint8Array> {
      if (window.isDestroyed()) throw new Error("the reader's window is closed");
      // The rectangle comes in CSS pixels; capturePage takes window DIPs, which differ once the page is zoomed.
      const [width = 0, height = 0] = window.getContentSize();
      const clip = rect ? windowCaptureRect(rect, window.webContents.getZoomFactor(), { width, height }) : undefined;
      if (rect && !clip) throw new Error(`the region ${JSON.stringify(rect)} lies outside the window (${width}×${height})`);
      const image = await window.webContents.capturePage(clip);
      return nonEmpty(image, "The reader screenshot").toPNG();
    },

    async renderReaderTiles({ materialId, width, tileHeight, maxTiles }): Promise<ReaderTiles> {
      return withHiddenWindow({
        width, height: tileHeight,
        webPreferences: { preload, additionalArguments: [`--quire-version=${appVersion}`] },
      }, async (win) => {
        await withTimeout(loadHarness(win, renderer, materialId, width), READY_TIMEOUT_MS, "loading the render harness");
        const flags = await waitForHarness(win.webContents);
        if (flags.error !== null) throw new Error(`the render harness failed: ${flags.error}`);
        const warnings = flags.warning.split(/\s+/).filter(Boolean);
        const box = await win.webContents.executeJavaScript(BOX_SCRIPT, true) as ArticleBox;
        if (!box.found) throw new Error("the render harness shows no article ([data-render-article])");
        const plan = planTiles(box.top, box.height, tileHeight, maxTiles);
        const tiles: Uint8Array[] = [];
        for (const tile of plan.tiles) {
          const scrolled = await win.webContents.executeJavaScript(scrollScript(tile.y), true) as number;
          const top = tile.y - scrolled;
          if (top < 0 || top + tile.height > tileHeight + 2) throw new Error(`the harness page did not scroll to tile ${tile.index + 1} (asked ${tile.y}, got ${scrolled})`);
          const image = await win.webContents.capturePage({ x: 0, y: top, width, height: Math.min(tile.height, tileHeight - top) });
          tiles.push(nonEmpty(image, `Full-article tile ${tile.index + 1}`).toJPEG(JPEG_QUALITY));
        }
        return { tiles, truncated: plan.truncated, warnings };
      });
    },

    async renderOriginal({ html, width, height, findText: needle }): Promise<OriginalShots> {
      return withTempPage(html, (path) => withHiddenWindow({
        width, height,
        webPreferences: { javascript: false, partition: ORIGINAL_PARTITION },
      }, async (win) => {
        const warnings: string[] = [];
        try {
          await withTimeout(win.loadFile(path), ORIGINAL_LOAD_TIMEOUT_MS, "loading the original page");
        } catch (error) {
          if (!(error instanceof TimeoutError)) throw error;
          warnings.push(`the page did not finish loading in ${ORIGINAL_LOAD_TIMEOUT_MS / 1000} s; the screenshots show what had loaded`);
          win.webContents.stop();
        }
        await sleep(SETTLE_MS);
        const top = nonEmpty(await win.webContents.capturePage({ x: 0, y: 0, width, height }), "The original page screenshot").toPNG();
        if (!needle) return { top, warnings };
        // The top is kept whatever happens next: a failed search only loses the second screenshot.
        try {
          if (!(await locateText(win.webContents, needle))) {
            warnings.push(`the selected text ("${needle}") was not found on the original page`);
            return { top, warnings };
          }
          await sleep(SETTLE_MS);
          const atSelection = nonEmpty(await win.webContents.capturePage({ x: 0, y: 0, width, height }), "The original page screenshot at the selection").toPNG();
          return { top, atSelection, warnings };
        } catch (error) {
          warnings.push(`finding the selected text failed: ${error instanceof Error ? error.message : String(error)}`);
          return { top, warnings };
        }
      }));
    },

    async compose({ left, right, caption, maxBytes }): Promise<Uint8Array> {
      const leftImage = nativeImage.createFromBuffer(Buffer.from(left));
      const rightImage = right ? nativeImage.createFromBuffer(Buffer.from(right)) : undefined;
      const layout = compositeLayout(leftImage.getSize(), rightImage?.getSize());
      const images = [leftImage, ...(rightImage ? [rightImage] : [])].map((image) => image.toDataURL());
      return withTempPage(compositeHtml(layout, images, caption), (path) => withHiddenWindow({
        width: layout.width, height: layout.height,
        webPreferences: { javascript: false, partition: ORIGINAL_PARTITION },
      }, async (win) => {
        await withTimeout(win.loadFile(path), READY_TIMEOUT_MS, "loading the side-by-side page");
        await sleep(SETTLE_MS);
        let image = nonEmpty(await win.webContents.capturePage({ x: 0, y: 0, width: layout.width, height: layout.height }), "The side-by-side screenshot");
        let png = image.toPNG();
        // Scale down until it fits the budget; a quarter of the size always does for these dimensions.
        for (let scale = 0.75; png.byteLength > maxBytes && scale >= 0.25; scale -= 0.25) {
          image = image.resize({ width: Math.round(layout.width * scale), quality: "best" });
          png = image.toPNG();
        }
        if (png.byteLength > maxBytes) throw new Error(`the side-by-side screenshot is ${png.byteLength} bytes even at a quarter size (limit ${maxBytes})`);
        return png;
      }));
    },
  };
}
