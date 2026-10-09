// One case's capture: the Quire reader (the renderer's ?render=<id> harness) and the original snapshot page,
// each in a fresh Chromium context, tiled into eval/render/out/<slug>/ with a manifest (types.ts).
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { extractEmbeds, markRepresented } from "./embeds.ts";
import { IMAGE_ENDPOINT, prefetchImages, proxiedSource } from "./image-proxy.ts";
import { buildReferenceImages, buildRenderedImages, linkImages } from "./images.ts";
import { buildManifest } from "./manifest.ts";
import { buildMetrics, buildRenderedCode, buildRenderedTables } from "./metrics.ts";
import { collectPageFacts } from "./page-facts.ts";
import { injectBase } from "./reference.ts";
import { referenceFactsScript } from "./reference-facts.ts";
import { TILE_PATTERN, planTiles, tileAt, tileName } from "./tiles.ts";

export const TILE_HEIGHT = 1600;
const READY_TIMEOUT_MS = 60_000;
const REFERENCE_LOAD_TIMEOUT_MS = 30_000;
const MAX_LISTED_FAILURES = 20;
const SELECTORS = { root: "[data-render-article]", column: ".reader-body" };

/** @typedef {import("playwright").Browser} Browser */
/** @typedef {import("./image-proxy.ts").ImageOutcome} ImageOutcome */
/** @typedef {import("./images.ts").PayloadImage} PayloadImage */
/**
 * @typedef {{
 *   browser: Browser; origin: string; slug: string; id: string; title: string; finalUrl: string; imageUrls: string[]; imageNodes: PayloadImage[];
 *   snapshotGz: Uint8Array; charset: string | undefined; outDir: string; key: string;
 *   width: number; maxTiles: number; maxReferenceTiles: number; fetchImage: (src: string) => Promise<ImageOutcome>;
 * }} CaptureInput
 */

/** Removes what an earlier capture left (tiles, text, manifest), so a failed capture leaves no stale manifest. */
export function clearCase(outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(outDir)) if (TILE_PATTERN.test(name) || name === "rendered.txt" || name === "manifest.json") rmSync(join(outDir, name), { force: true });
}

const DECODE_WAIT_MS = 5_000;
const STATIC_SETTLE_MS = 250;

/**
 * Scrolls the tile into the viewport (viewport height = tile height) and waits for the images there to be
 * decoded and painted; returns where the page actually scrolled to (the last tile can stop short).
 * Clipping the full page without scrolling leaves async-decoded images below the fold blank.
 * A page with JavaScript off never runs timers or animation frames, not even for page.evaluate, so there
 * the scroll is synchronous and the settling wait happens on the Node side.
 * @param {import("playwright").Page} page @param {number} y @param {boolean} scriptable
 */
async function scrollAndSettle(page, y, scriptable) {
  if (!scriptable) {
    const scrolled = await page.evaluate((top) => { window.scrollTo(0, top); return window.scrollY; }, y);
    await page.waitForTimeout(STATIC_SETTLE_MS);
    return scrolled;
  }
  return page.evaluate(async ({ y, wait }) => {
    window.scrollTo(0, y);
    // A broken image rejects decode(); broken images are measured separately, here it only must not block.
    const decoded = Promise.all(Array.from(document.images, (image) => image.decode().catch(() => undefined)));
    await Promise.race([decoded, new Promise((resolve) => { setTimeout(resolve, wait); })]);
    await new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); });
    return window.scrollY;
  }, { y, wait: DECODE_WAIT_MS });
}

/** @param {import("playwright").Page} page @param {{ y: number; height: number }[]} tiles */
async function shoot(page, tiles, side, outDir, x, width, scriptable, warnings) {
  const names = [];
  for (const [index, tile] of tiles.entries()) {
    const name = tileName(side, index);
    const scrolled = await scrollAndSettle(page, tile.y, scriptable);
    const top = tile.y - scrolled;
    // A pixel or two past the bottom is rounding between the measured height and the scroll extent.
    if (top >= 0 && top + tile.height <= TILE_HEIGHT + 2) {
      await page.screenshot({ path: join(outDir, name), clip: { x, y: top, width, height: Math.min(tile.height, TILE_HEIGHT - top) }, animations: "disabled" });
    } else {
      // The window did not scroll that far (the page clips its own overflow, e.g. body { overflow: hidden }):
      // clip from the full page instead, which lays the whole document out at once.
      await page.screenshot({ path: join(outDir, name), clip: { x, y: tile.y, width, height: tile.height }, animations: "disabled", fullPage: true });
      const warning = `${side}-window-does-not-scroll: tiles clipped from the full-page layout`;
      if (!warnings.includes(warning)) warnings.push(warning);
    }
    names.push(name);
  }
  return names;
}

const viewportOf = (width) => ({ width, height: TILE_HEIGHT, deviceScaleFactor: 1 });

/**
 * Runs in the harness page before its scripts: records which proxied source each blob: URL holds
 * (window.__renderImageSources), so the page facts can name a loaded image by its original URL. The
 * harness turns every proxy answer into a blob with Response.blob() and URL.createObjectURL().
 */
function recordBlobSources(endpoint) {
  const sources = new Map();
  const blobSource = new WeakMap();
  Object.defineProperty(window, "__renderImageSources", { value: sources });
  const readBlob = Response.prototype.blob;
  Response.prototype.blob = async function blob() {
    const result = await readBlob.call(this);
    const url = new URL(this.url, location.href);
    const src = url.pathname === endpoint ? url.searchParams.get("src") : null;
    if (src) blobSource.set(result, src);
    return result;
  };
  const createObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (object) => {
    const url = createObjectURL(object);
    const src = blobSource.get(object);
    if (src) sources.set(url, src);
    return url;
  };
}

/** @param {CaptureInput} input */
async function captureRendered(input, warnings) {
  await prefetchImages(input.fetchImage, input.imageUrls);
  const context = await input.browser.newContext({ viewport: { width: input.width, height: TILE_HEIGHT }, deviceScaleFactor: 1, colorScheme: "light" });
  try {
    const page = await context.newPage();
    await page.addInitScript(recordBlobSources, IMAGE_ENDPOINT);
    const failures = [];
    let fetches = 0;
    await page.route("**/__render/image?*", async (route) => {
      const src = proxiedSource(route.request().url());
      if (!src) return route.fulfill({ status: 404, contentType: "text/plain", body: "missing src" });
      fetches += 1;
      const outcome = await input.fetchImage(src);
      if (outcome.ok) return route.fulfill({ status: 200, contentType: outcome.mediaType, body: Buffer.from(outcome.bytes) });
      if (!failures.some((f) => f.src === src)) failures.push({ src, error: outcome.error });
      return route.fulfill({ status: 404, contentType: "text/plain", body: outcome.error });
    });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${input.origin}/index.html?render=${encodeURIComponent(input.id)}&theme=light`, { waitUntil: "load", timeout: READY_TIMEOUT_MS });
    try {
      await page.waitForFunction(() => document.documentElement.dataset.renderReady === "1" || document.documentElement.dataset.renderError !== undefined, undefined, { timeout: READY_TIMEOUT_MS });
    } catch (error) {
      throw new Error(`the harness set neither data-render-ready nor data-render-error within ${READY_TIMEOUT_MS / 1000} s${pageErrors.length ? ` (page errors: ${pageErrors.slice(0, 3).join(" | ")})` : ""}`, { cause: error });
    }
    const flags = await page.evaluate(() => ({ ...document.documentElement.dataset }));
    if (flags.renderError !== undefined) throw new Error(`render error: ${flags.renderError}`);
    const harnessWarnings = (flags.renderWarning ?? "").split(/\s+/).filter(Boolean);
    if (harnessWarnings.includes("image-proxy-missing")) throw new Error("the harness reports image-proxy-missing: the /__render/image route did not answer");
    // reader-fallback is itself a rendering defect: listed first so it is the first thing anyone reads.
    warnings.push(...harnessWarnings.filter((w) => w.startsWith("reader-fallback")), ...harnessWarnings.filter((w) => !w.startsWith("reader-fallback")));
    for (const message of pageErrors.slice(0, 5)) warnings.push(`page-error: ${message.slice(0, 200)}`);
    const facts = await page.evaluate(collectPageFacts, SELECTORS);
    // After the facts: a fetch the harness gave up on (images-timeout) can still fail later.
    if (failures.length) {
      warnings.push(`images-failed: ${failures.length} of ${fetches} image requests`);
      for (const failure of failures.slice(0, MAX_LISTED_FAILURES)) warnings.push(`image-failed: ${failure.src} (${failure.error})`);
      if (failures.length > MAX_LISTED_FAILURES) warnings.push(`image-failed: … and ${failures.length - MAX_LISTED_FAILURES} more`);
    }
    if (!facts.found) throw new Error(`no ${SELECTORS.root} on the page after data-render-ready`);
    if (!facts.documentScrolls) warnings.push("article-in-inner-scroller: tiles below the viewport may be blank");
    writeFileSync(join(input.outDir, "rendered.txt"), facts.text);
    const plan = planTiles(facts.box.top, facts.box.height, TILE_HEIGHT, input.maxTiles);
    const x = Math.max(0, Math.floor(facts.box.left));
    const tiles = await shoot(page, plan.tiles, "rendered", input.outDir, x, Math.max(1, Math.min(input.width - x, Math.ceil(facts.box.width))), true, warnings);
    const metrics = buildMetrics(facts, input.title, failures.map((f) => f.src));
    const images = buildRenderedImages(facts.images.map((image) => ({ ...image, tile: tileAt(image.top, plan.tiles) })), input.imageNodes);
    const tables = buildRenderedTables(facts.tables.map(({ top, ...table }) => ({ ...table, tile: tileAt(top, plan.tiles) })));
    const code = buildRenderedCode(facts.code.map((block) => ({ text: block.text, tile: tileAt(block.top, plan.tiles) })));
    // What the reader shows that an embed can be recognised by: its links, media and (original) image URLs.
    const shownUrls = [...facts.links, ...facts.media, ...images.map((image) => image.src).filter(Boolean)];
    return { tiles, height: Math.round(facts.box.height), truncated: plan.truncated, metrics, images, tables, code, shownUrls };
  } finally {
    await context.close();
  }
}

/** @param {Uint8Array} bytes @param {string | undefined} charset */
function decodeSnapshot(bytes, charset, warnings) {
  const label = (charset ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    warnings.push(`reference-charset-unknown: ${label}, decoded as utf-8`);
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** @param {CaptureInput} input @param {string} snapshotHtml */
async function captureReference(input, snapshotHtml, warnings) {
  const context = await input.browser.newContext({ viewport: { width: input.width, height: TILE_HEIGHT }, deviceScaleFactor: 1, colorScheme: "light", javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    let failedRequests = 0;
    page.on("requestfailed", () => { failedRequests += 1; });
    const html = injectBase(snapshotHtml, input.finalUrl);
    try {
      await page.setContent(html, { waitUntil: "load", timeout: REFERENCE_LOAD_TIMEOUT_MS });
    } catch (error) {
      if (!(error instanceof Error && error.name === "TimeoutError")) throw error;
      warnings.push(`reference-load-timeout: the original page did not finish loading in ${REFERENCE_LOAD_TIMEOUT_MS / 1000} s; tiles show what had loaded`);
    }
    const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
    const plan = planTiles(0, height, TILE_HEIGHT, input.maxReferenceTiles);
    // Before the tiles: shooting scrolls the page, and the facts are in page coordinates either way.
    const facts = await page.evaluate(referenceFactsScript());
    const images = buildReferenceImages(facts.images.map((image) => ({ ...image, tile: tileAt(image.top, plan.tiles) })), facts.base);
    const tiles = await shoot(page, plan.tiles, "reference", input.outDir, 0, input.width, false, warnings);
    return { tiles, height: Math.round(height), truncated: plan.truncated, failedRequests, images };
  } finally {
    await context.close();
  }
}

/** Captures one case and writes its manifest; throws (leaving no manifest) when the reader side fails. */
export async function captureCase(input) {
  clearCase(input.outDir);
  const warnings = [];
  const rendered = await captureRendered(input, warnings);
  const snapshotHtml = decodeSnapshot(gunzipSync(input.snapshotGz), input.charset, warnings);
  const reference = await captureReference(input, snapshotHtml, warnings);
  const embeds = markRepresented(extractEmbeds(snapshotHtml, input.finalUrl), rendered.shownUrls);
  const manifest = buildManifest({
    slug: input.slug, id: input.id, url: input.finalUrl, key: input.key, capturedAt: new Date(), viewport: viewportOf(input.width),
    rendered, reference: { ...reference, images: linkImages(reference.images, rendered.images) }, embeds, warnings,
  });
  writeFileSync(join(input.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
