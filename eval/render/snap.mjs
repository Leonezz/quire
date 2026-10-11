// Side-by-side evidence snapshots: for each spec entry, one composite PNG out/_snaps/<id>.png with a caption
// and two crops, "Quire reader" (the renderer's ?render=<id> harness) and "Original page" (the snapshot with
// JavaScript off), each cut around the first visible occurrence of a needle text.
//   node render/snap.mjs <spec.json>
// Spec: [{ id, slug, caption, reader: { text, before?, after?, nth?, wide?, highlight? } | null, reference: { ... } | null }]
// (before/after in css px around the needle's top, default 250/650; nth picks a later occurrence; wide crops
// the reference at the full 1280 px instead of its article/main column; highlight outlines the elements a CSS
// selector matches, e.g. an embed iframe that stays blank with JavaScript off).
// Uses the already built renderer (apps/desktop/out/renderer; run `pnpm --filter @read/eval render` first)
// and the exported preview corpus. Exits non-zero when any entry failed; the others still complete.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { chromium } from "playwright";
import { createImageFetcher, imageUrlsOf, prefetchImages, proxiedSource } from "./image-proxy.ts";
import { injectBase } from "./reference.ts";
import { startStaticServer } from "./server.ts";
import { QUOTE_MAP, cropWindow, normalizeText, parseSpec } from "./snap-spec.ts";

const here = dirname(fileURLToPath(import.meta.url));
const EVAL = join(here, "..");
const DESKTOP = join(EVAL, "..", "apps", "desktop");
const RENDERER_OUT = join(DESKTOP, "out", "renderer");
const PREVIEW = join(DESKTOP, "src", "renderer", "public", "dev", "corpus");
const CORPUS = join(EVAL, "corpus");
const OUT = join(here, "out");
const SNAPS = join(OUT, "_snaps");

const VIEWPORT = { width: 1280, height: 1600 };
const SCALE = 2;
const COLUMN_CSS_WIDTH = 700;
const MAX_COMPOSITE_BYTES = 1.5 * 1024 * 1024;
const COMPOSITE_SCALES = [2, 1.5, 1.25, 1];
const READY_TIMEOUT_MS = 60_000;
const REFERENCE_LOAD_TIMEOUT_MS = 30_000;
const DECODE_WAIT_MS = 5_000;
const STATIC_SETTLE_MS = 400;
const READER_ROOT = "[data-render-article]";

const fail = (message, code = 1) => { console.error(message); process.exit(code); };

/**
 * Runs in the page: the first (nth) visible occurrence of the normalized needle under root, as page
 * coordinates of its first line plus the column to crop. Text is compared without whitespace and with
 * straight quotes, across element boundaries.
 */
function locateInPage({ needle, nth, quotes, rootSelector, wideColumn }) {
  const root = rootSelector ? document.querySelector(rootSelector) : document.body;
  if (!root) return { error: `no ${rootSelector} on the page` };
  const hidden = new Map();
  const isHidden = (element) => {
    if (!element) return true;
    if (!hidden.has(element)) {
      const tag = element.tagName;
      hidden.set(element, tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE" || !element.checkVisibility({ visibilityProperty: true }) || element.getClientRects().length === 0);
    }
    return hidden.get(element);
  };
  const nodes = [];
  const chars = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (isHidden(node.parentElement)) continue;
    const index = nodes.push(node) - 1;
    const value = node.nodeValue ?? "";
    for (let offset = 0; offset < value.length; offset += 1) {
      const char = value[offset];
      if (/\s/.test(char)) continue;
      chars.push({ char: quotes[char] ?? char, index, offset });
    }
  }
  const haystack = chars.map((c) => c.char).join("");
  let at = -1;
  for (let found = 0; found < nth; found += 1) {
    at = haystack.indexOf(needle, at + 1);
    if (at < 0) return { error: found ? `only ${found} occurrence(s), nth ${nth} asked` : "not found" };
  }
  const first = chars[at];
  const last = chars[at + needle.length - 1];
  const range = document.createRange();
  range.setStart(nodes[first.index], first.offset);
  range.setEnd(nodes[last.index], last.offset + 1);
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
  const anchor = nodes[first.index].parentElement;
  const box = rects[0] ?? anchor.getBoundingClientRect();
  const top = box.top + window.scrollY;
  const pageHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
  let column;
  if (rootSelector) {
    const r = root.getBoundingClientRect();
    column = { x: r.left + window.scrollX, width: r.width };
  } else {
    const main = anchor.closest("article, main, [role=main]");
    const r = main?.getBoundingClientRect();
    if (r && r.width >= 320 && !wideColumn) {
      const pad = 24;
      const x = Math.max(0, r.left + window.scrollX - pad);
      column = { x, width: Math.min(window.innerWidth - x, r.width + 2 * pad) };
    } else column = { x: 0, width: window.innerWidth };
  }
  return { top, pageHeight, column: { x: Math.max(0, Math.floor(column.x)), width: Math.max(1, Math.min(window.innerWidth, Math.ceil(column.width))) } };
}

/** Scrolls to y and waits for images to paint (JavaScript-off pages wait on the Node side); returns scrollY. */
async function scrollAndSettle(page, y, scriptable) {
  if (!scriptable) {
    const scrolled = await page.evaluate((top) => { window.scrollTo(0, top); return window.scrollY; }, y);
    await page.waitForTimeout(STATIC_SETTLE_MS);
    return scrolled;
  }
  return page.evaluate(async ({ y, wait }) => {
    window.scrollTo(0, y);
    const decoded = Promise.all(Array.from(document.images, (image) => image.decode().catch(() => undefined)));
    await Promise.race([decoded, new Promise((done) => { setTimeout(done, wait); })]);
    await new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); });
    return window.scrollY;
  }, { y, wait: DECODE_WAIT_MS });
}

/** The crop of one side around its needle, or throws naming the needle. */
async function cropSide(side, page, locator, scriptable) {
  if (locator.highlight) {
    const count = await page.evaluate((selector) => {
      const found = document.querySelectorAll(selector);
      // Drawn inside the box: an ancestor with overflow: hidden would clip an outline outside it.
      for (const element of found) {
        element.style.setProperty("outline", "3px dashed #d4380d", "important");
        element.style.setProperty("outline-offset", "-4px", "important");
      }
      return found.length;
    }, locator.highlight);
    if (!count) throw new Error(`${side} highlight selector ${JSON.stringify(locator.highlight)} matches nothing`);
  }
  const located = await page.evaluate(locateInPage, {
    needle: normalizeText(locator.text), nth: locator.nth, quotes: QUOTE_MAP,
    rootSelector: side === "reader" ? READER_ROOT : null, wideColumn: locator.wide,
  });
  if (located.error) throw new Error(`${side} needle ${JSON.stringify(locator.text)}${locator.nth > 1 ? ` (nth ${locator.nth})` : ""}: ${located.error}`);
  const window = cropWindow(located.top, locator, located.pageHeight);
  const scrolled = await scrollAndSettle(page, window.y, scriptable);
  const top = window.y - scrolled;
  const clip = { x: located.column.x, width: located.column.width, height: window.height };
  const bytes = top >= 0 && top + window.height <= VIEWPORT.height + 2
    ? await page.screenshot({ clip: { ...clip, y: top, height: Math.min(window.height, VIEWPORT.height - top) }, animations: "disabled" })
    : await page.screenshot({ clip: { ...clip, y: window.y }, animations: "disabled", fullPage: true });
  return { bytes, width: clip.width, height: window.height, marker: located.top - window.y, needle: locator.text };
}

async function openReader(browser, origin, id, fetchImage) {
  const record = JSON.parse(readFileSync(join(PREVIEW, `${id}.json`), "utf8"));
  await prefetchImages(fetchImage, record.reader?.payload ? imageUrlsOf(record.reader.payload) : []);
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE, colorScheme: "light" });
  const page = await context.newPage();
  await page.route("**/__render/image?*", async (route) => {
    const src = proxiedSource(route.request().url());
    if (!src) return route.fulfill({ status: 404, contentType: "text/plain", body: "missing src" });
    const outcome = await fetchImage(src);
    if (outcome.ok) return route.fulfill({ status: 200, contentType: outcome.mediaType, body: Buffer.from(outcome.bytes) });
    return route.fulfill({ status: 404, contentType: "text/plain", body: outcome.error });
  });
  await page.goto(`${origin}/index.html?render=${encodeURIComponent(id)}&theme=light`, { waitUntil: "load", timeout: READY_TIMEOUT_MS });
  await page.waitForFunction(() => document.documentElement.dataset.renderReady === "1" || document.documentElement.dataset.renderError !== undefined, undefined, { timeout: READY_TIMEOUT_MS });
  const renderError = await page.evaluate(() => document.documentElement.dataset.renderError);
  if (renderError !== undefined) throw new Error(`reader render error: ${renderError}`);
  return { page, close: () => context.close() };
}

async function openReference(browser, slug) {
  const meta = JSON.parse(readFileSync(join(CORPUS, slug, "meta.json"), "utf8"));
  const charset = (/charset=([^;\s]+)/i.exec(meta.contentType ?? "")?.[1] ?? "utf-8").toLowerCase();
  const bytes = gunzipSync(readFileSync(join(CORPUS, slug, "page.html.gz")));
  let html;
  try { html = new TextDecoder(charset).decode(bytes); } catch { html = new TextDecoder("utf-8").decode(bytes); }
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE, colorScheme: "light", javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.setContent(injectBase(html, meta.finalUrl), { waitUntil: "load", timeout: REFERENCE_LOAD_TIMEOUT_MS });
  } catch (error) {
    if (!(error instanceof Error && error.name === "TimeoutError")) throw error;
    console.warn(`${slug}: the original page did not finish loading in ${REFERENCE_LOAD_TIMEOUT_MS / 1000} s; cropping what had loaded`);
  }
  return { page, close: () => context.close() };
}

const escapeHtml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function compositeHtml(entry, columns) {
  const cells = columns.map(({ label, crop }) => {
    const scale = COLUMN_CSS_WIDTH / crop.width;
    return `<figure><figcaption><b>${escapeHtml(label)}</b><span>at “${escapeHtml(crop.needle.length > 70 ? `${crop.needle.slice(0, 70)}…` : crop.needle)}”</span></figcaption>`
      + `<div class="crop"><img src="data:image/png;base64,${crop.bytes.toString("base64")}" style="height:${(crop.height * scale).toFixed(1)}px">`
      + `<i style="top:${(crop.marker * scale).toFixed(1)}px"></i></div></figure>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    body { background: #f4f4f2; font: 14px/1.4 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1d1d1b; padding: 16px 20px 20px; width: max-content; }
    h1 { font-size: 17px; font-weight: 600; max-width: ${columns.length * COLUMN_CSS_WIDTH + (columns.length - 1) * 24}px; }
    .slug { color: #6b6b66; font-size: 12px; margin: 2px 0 12px; }
    .grid { display: grid; grid-template-columns: repeat(${columns.length}, ${COLUMN_CSS_WIDTH}px); gap: 24px; align-items: start; }
    figcaption { display: flex; gap: 8px; align-items: baseline; margin-bottom: 6px; font-size: 13px; }
    figcaption span { color: #6b6b66; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .crop { position: relative; border: 1px solid #c9c9c4; background: #fff; }
    .crop img { display: block; width: ${COLUMN_CSS_WIDTH}px; }
    .crop i { position: absolute; left: -9px; width: 7px; height: 3px; background: #d4380d; }
  </style></head><body><h1>${escapeHtml(entry.caption || entry.id)}</h1><div class="slug">${escapeHtml(entry.id)} · ${escapeHtml(entry.slug)}</div><div class="grid">${cells}</div></body></html>`;
}

async function compose(browser, entry, columns) {
  for (const deviceScaleFactor of COMPOSITE_SCALES) {
    const context = await browser.newContext({ viewport: { width: columns.length * (COLUMN_CSS_WIDTH + 24) + 40, height: 800 }, deviceScaleFactor, colorScheme: "light" });
    try {
      const page = await context.newPage();
      await page.setContent(compositeHtml(entry, columns), { waitUntil: "load" });
      const png = await page.locator("body").screenshot({ animations: "disabled" });
      if (png.byteLength <= MAX_COMPOSITE_BYTES || deviceScaleFactor === COMPOSITE_SCALES.at(-1)) return { png, deviceScaleFactor };
    } finally {
      await context.close();
    }
  }
  throw new Error("unreachable");
}

const specPath = process.argv[2];
if (!specPath || process.argv.length > 3) fail("Usage: node render/snap.mjs <spec.json>", 2);
let entries;
try { entries = parseSpec(JSON.parse(readFileSync(resolve(specPath), "utf8"))); } catch (error) { fail(`${specPath}: ${error instanceof Error ? error.message : String(error)}`, 2); }
if (!existsSync(join(RENDERER_OUT, "index.html"))) fail(`No built renderer at ${RENDERER_OUT}; run \`pnpm --filter @read/eval render\` (it builds) first.`);
const index = new Map(JSON.parse(readFileSync(join(PREVIEW, "index.json"), "utf8")).map((entry) => [entry.slug, entry]));
mkdirSync(SNAPS, { recursive: true });

const bySlug = new Map();
for (const entry of entries) bySlug.set(entry.slug, [...(bySlug.get(entry.slug) ?? []), entry]);

const server = await startStaticServer([{ prefix: "/", dir: RENDERER_OUT }, { prefix: "/dev/corpus", dir: PREVIEW }]);
const browser = await chromium.launch();
const fetchImage = createImageFetcher(join(OUT, ".images"));
const failures = [];
try {
  for (const [slug, group] of bySlug) {
    const sides = {};
    const open = async (side) => {
      if (!sides[side]) {
        if (side === "reader") {
          const id = index.get(slug)?.id;
          if (!id) throw new Error(`${slug} is not in the preview corpus index (run \`pnpm --filter @read/eval render ${slug}\`)`);
          sides[side] = openReader(browser, server.origin, id, fetchImage);
        } else {
          if (!existsSync(join(CORPUS, slug, "page.html.gz"))) throw new Error(`no snapshot eval/corpus/${slug}/page.html.gz`);
          sides[side] = openReference(browser, slug);
        }
      }
      return (await sides[side]).page;
    };
    for (const entry of group) {
      try {
        const columns = [];
        if (entry.reader) columns.push({ label: "Quire reader", crop: await cropSide("reader", await open("reader"), entry.reader, true) });
        if (entry.reference) columns.push({ label: "Original page", crop: await cropSide("reference", await open("reference"), entry.reference, false) });
        const { png, deviceScaleFactor } = await compose(browser, entry, columns);
        const path = join(SNAPS, `${entry.id}.png`);
        writeFileSync(path, png);
        console.log(`${entry.id.padEnd(28)} ok  ${(png.byteLength / 1024).toFixed(0).padStart(5)} KiB  @${deviceScaleFactor}x  ${path}`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(entry.id);
        console.error(`${entry.id.padEnd(28)} FAILED  ${slug}: ${reason}`);
      }
    }
    for (const pending of Object.values(sides)) await pending.then((side) => side.close(), () => undefined);
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(`\n${entries.length} entries · ${entries.length - failures.length} written · ${failures.length} failed · out: ${SNAPS}`);
if (failures.length) {
  console.error(`Failed: ${failures.join(", ")}`);
  process.exit(1);
}
