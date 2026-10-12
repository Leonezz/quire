// Turns an app feedback report into an eval case. The input is the one-step report's zip
// (quire-report-<slug>-<id>.zip: report.json, meta.json, page.html.gz or original.pdf, extracted.md,
// reader-document.json, screenshots/*, composite.png; files at the root or under one top-level folder)
// or the bundle directory itself (<userData>/feedback/<id>/, loose files or just the zip).
//   node import-feedback.mjs <bundleDir|bundle.zip> [--slug s]
// - web reports  → eval/corpus/<slug>/{meta.json,page.html.gz,feedback.json} + a corpus.json entry
// - PDF reports (view pdf or text) → eval/pdf/corpus/<slug>.pdf + <slug>.feedback.json + an
//   eval/pdf/sources.json entry { slug, url, kind: "feedback", layout: "unknown" }: the reader never
//   says which kind of PDF it is or how it is laid out, so the entry is marked as a reader report
//   and its layout as unknown until someone looks at it.
// feedback.json keeps where the reader pointed (selection quote/prefix/suffix, note, kinds, reader state).
// Screenshots and composite.png are not corpus material; they go to eval/feedback-screenshots/<slug>/.
// Refuses (nothing written) when report.json is missing, the original was not included, the view
// is not one the eval covers, or the slug (or, for PDFs, the URL) is already taken: pass --slug.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";

const GENERIC_HOST_LABELS = new Set(["www", "blog", "blogs", "docs", "news", "posts", "web", "m", "en", "zh"]);
const SLUG_MAX = 60;
const WEB_VIEWS = new Set(["web"]);
const PDF_VIEWS = new Set(["pdf", "text"]);
const PDF_KIND = "feedback";
const PDF_LAYOUT = "unknown";
const INCLUDE_HINT = 'Ask the reader to report again with "Include the original page" ticked.';

const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * A corpus slug from a URL, in the corpus's own style (`<site>-<page>`): the site's distinctive host
 * label plus the last path segment (`simonwillison.net/2024/Dec/31/llms-in-2024/` → `simonwillison-llms-in-2024`).
 * @param {string} url
 */
export function deriveSlug(url) {
  const parsed = new URL(url);
  const labels = parsed.hostname.split(".").filter(Boolean);
  if (labels.length === 0) throw new Error(`cannot derive a slug from ${url} (no host); pass --slug <name>`);
  const site = labels.length > 2 && GENERIC_HOST_LABELS.has(labels[0]) ? labels[1] : labels[0] === "www" && labels.length > 1 ? labels[1] : labels[0];
  // Strip a file extension, but not the fraction of a numeric id like arxiv's 2609.24983.
  const segments = parsed.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment)).map((segment) => (/^\d+\.\d+(v\d+)?$/i.test(segment) ? segment : segment.replace(/\.[a-z0-9]{1,5}$/i, "")));
  const meaningful = segments.filter((segment) => slugify(segment));
  // The last named segment is the page. Date parts (2024, 07, 21) are dropped; an identifier-like tail
  // (arxiv's 2609.24983, a version like v2) is kept, and a format segment such as "html" is dropped.
  const datePart = (segment) => /^\d{1,4}$/.test(segment) || /^[a-z]{3}$/i.test(segment) && Number.isNaN(Number(segment)) && ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].includes(segment.toLowerCase());
  const identifier = (segment) => /^\d+\.\d+(v\d+)?$/i.test(segment) || /^\d{5,}$/.test(segment) || /^v\d+$/i.test(segment);
  const format = (segment) => ["html", "pdf", "abs"].includes(segment.toLowerCase());
  const kept = meaningful.filter((segment) => !datePart(segment) && !format(segment));
  const named = [...kept].reverse().find((segment) => !identifier(segment));
  const ids = kept.filter(identifier);
  const page = [named, ...ids].filter(Boolean).join("-") || "home";
  const slug = `${slugify(site)}-${slugify(page)}`.slice(0, SLUG_MAX).replace(/-+$/, "");
  if (!slugify(site)) throw new Error(`cannot derive a slug from ${url}; pass --slug <name>`);
  return slug;
}

/**
 * A PDF corpus slug: the web rule for http(s) URLs, the file name for a PDF opened from disk (file:).
 * @param {string} url
 */
export function derivePdfSlug(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "file:") return deriveSlug(url);
  const name = slugify(basename(decodeURIComponent(parsed.pathname)).replace(/\.pdf$/i, "")).slice(0, SLUG_MAX).replace(/-+$/, "");
  if (!name) throw new Error(`cannot derive a slug from ${url}; pass --slug <name>`);
  return name;
}

/**
 * corpus.json with one more entry; returns the JSON text to write (immutable: the input text is not
 * changed). Throws when the slug is already present. Keeps the file's trailing-newline convention.
 * @param {string} corpusText
 * @param {{ slug: string; url: string; framework: string; tags: readonly string[] }} entry
 */
export function appendCorpusEntry(corpusText, entry) {
  const entries = JSON.parse(corpusText);
  if (!Array.isArray(entries)) throw new Error("corpus.json is not an array");
  if (entries.some((existing) => existing.slug === entry.slug)) throw new Error(`slug ${entry.slug} already exists in corpus.json; pass --slug <other> to import under another name`);
  const next = [...entries, { slug: entry.slug, url: entry.url, framework: entry.framework, tags: [...entry.tags] }];
  return JSON.stringify(next, null, 2) + (corpusText.endsWith("\n") ? "\n" : "");
}

/**
 * eval/pdf/sources.json with one more entry in its own shape ({ slug, url, kind, layout }); returns the
 * JSON text to write. Throws on a duplicate slug, and on a duplicate URL unless `allowSameUrl` (the
 * caller passes it when the user chose the slug with --slug, i.e. wants a second case of the same PDF).
 * @param {string} sourcesText
 * @param {{ slug: string; url: string; kind: string; layout: string }} entry
 * @param {{ allowSameUrl?: boolean }} [options]
 */
export function appendPdfSource(sourcesText, entry, options = {}) {
  const entries = JSON.parse(sourcesText);
  if (!Array.isArray(entries)) throw new Error("eval/pdf/sources.json is not an array");
  if (entries.some((existing) => existing.slug === entry.slug)) throw new Error(`slug ${entry.slug} already exists in eval/pdf/sources.json; pass --slug <other> to import under another name`);
  const sameUrl = entries.find((existing) => existing.url === entry.url);
  if (sameUrl && !options.allowSameUrl) throw new Error(`${entry.url} is already in eval/pdf/sources.json as ${sameUrl.slug}; pass --slug <other> to import this report as a second case of it`);
  const next = [...entries, { slug: entry.slug, url: entry.url, kind: entry.kind, layout: entry.layout }];
  return JSON.stringify(next, null, 2) + (sourcesText.endsWith("\n") ? "\n" : "");
}

// --- zip reading (stored and deflated entries; the app's bundles stay far below the zip64 limits) ---

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** A zip path that stays inside the bundle (no absolute paths, no `..`), with `/` separators. */
function safeEntryName(raw) {
  const name = raw.replace(/\\/g, "/");
  if (name.startsWith("/") || /^[a-z]:/i.test(name) || name.split("/").includes("..")) throw new Error(`zip entry ${raw} points outside the bundle`);
  return name;
}

function findEndOfCentralDirectory(buffer) {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let at = buffer.length - 22; at >= lowest; at -= 1) if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) return at;
  throw new Error("not a zip file (no end of central directory)");
}

function entryBytes(buffer, entry) {
  if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) throw new Error(`zip entry ${entry.name} has a broken local header`);
  const start = entry.localOffset + 30 + buffer.readUInt16LE(entry.localOffset + 26) + buffer.readUInt16LE(entry.localOffset + 28);
  const packed = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`zip entry ${entry.name} uses compression method ${entry.method}; only stored and deflated entries are supported`);
  const bytes = entry.method === 0 ? Buffer.from(packed) : inflateRawSync(packed);
  if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) throw new Error(`zip entry ${entry.name} is corrupt (size or CRC mismatch)`);
  return bytes;
}

/**
 * The files of a zip archive, by path (directories, __MACOSX/ and .DS_Store left out).
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>}
 */
export function readZip(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralOffset === 0xffffffff) throw new Error("zip64 archives are not supported");
  const files = new Map();
  let at = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw new Error("zip central directory is corrupt");
    const nameLength = buffer.readUInt16LE(at + 28);
    const raw = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    const entry = { name: raw, flags: buffer.readUInt16LE(at + 8), method: buffer.readUInt16LE(at + 10), crc: buffer.readUInt32LE(at + 16), compressedSize: buffer.readUInt32LE(at + 20), size: buffer.readUInt32LE(at + 24), localOffset: buffer.readUInt32LE(at + 42) };
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    const name = safeEntryName(raw);
    if (name.endsWith("/") || name.startsWith("__MACOSX/") || basename(name) === ".DS_Store") continue;
    if (entry.flags & 1) throw new Error(`zip entry ${raw} is encrypted`);
    files.set(name, entryBytes(buffer, entry));
  }
  return files;
}

// --- the bundle: its files by relative path, from a directory or a zip ---

function readDirectory(dir, prefix = "") {
  const files = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) for (const [name, bytes] of readDirectory(path, `${prefix}${entry.name}/`)) files.set(name, bytes);
    else if (entry.isFile() && !/\.zip$/i.test(entry.name)) files.set(`${prefix}${entry.name}`, readFileSync(path));
  }
  return files;
}

/** The files under the bundle's root: the archive root, or its single top-level folder. */
function rootFiles(files, label) {
  if (files.has("report.json")) return files;
  const tops = new Set([...files.keys()].map((name) => name.split("/")[0]));
  const [top] = tops;
  if (tops.size !== 1 || !files.has(`${top}/report.json`)) throw new Error(`${label} has no report.json (at its root or under one top-level folder); is this a Quire feedback report?`);
  return new Map([...files].filter(([name]) => name.startsWith(`${top}/`)).map(([name, bytes]) => [name.slice(top.length + 1), bytes]));
}

/**
 * @param {string} path
 * @returns {Map<string, Buffer>}
 */
function openBundle(path) {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  if (!statSync(path).isDirectory()) {
    if (!/\.zip$/i.test(path)) throw new Error(`${path} is neither a directory nor a .zip`);
    return rootFiles(readZip(readFileSync(path)), path);
  }
  if (existsSync(join(path, "report.json"))) return readDirectory(path);
  // A bundle directory that holds only the packaged zip.
  const zips = readdirSync(path).filter((name) => /\.zip$/i.test(name));
  if (zips.length === 1) return rootFiles(readZip(readFileSync(join(path, zips[0]))), join(path, zips[0]));
  throw new Error(zips.length > 1 ? `${path} has no report.json and ${zips.length} zips (${zips.join(", ")}); pass the one to import` : `${path} has no report.json; is this a Quire feedback report?`);
}

const parseJson = (files, name) => {
  try { return JSON.parse(files.get(name).toString("utf8")); }
  catch (error) { throw new Error(`${name} in the report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
};

/** What the reader pointed at, kept next to the case so the judge or a person can find the reported spot. */
function feedbackRecord(report, slug) {
  const selection = report.selection && typeof report.selection.quote === "string" && report.selection.quote
    ? { quote: report.selection.quote, prefix: String(report.selection.prefix ?? ""), suffix: String(report.selection.suffix ?? "") }
    : undefined;
  return {
    slug, id: report.id, createdAt: report.createdAt, url: report.url, title: report.title, view: report.view,
    kinds: Array.isArray(report.kinds) ? report.kinds : [], note: typeof report.note === "string" ? report.note : "",
    ...(selection ? { selection } : {}),
    ...(report.readerState ? { readerState: report.readerState } : {}),
    ...(report.app ? { app: report.app } : {}),
  };
}

/** The bundle's screenshots and composite, which are for people, not the corpus. */
const screenshotFiles = (files) => [...files.keys()].filter((name) => (name.startsWith("screenshots/") && /\.(png|jpe?g)$/i.test(name)) || name === "composite.png").sort();

function screenshotsTarget(evalRoot, slug, names) {
  const dir = join(evalRoot, "feedback-screenshots", slug);
  if (names.length > 0 && existsSync(dir)) throw new Error(`eval/feedback-screenshots/${slug} already exists (left over from an earlier import?); remove it or pass --slug <other>`);
  return dir;
}

function writeScreenshots(files, dir, names) {
  for (const name of names) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, files.get(name));
  }
  return names.map((name) => join(dir, name));
}

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

function importWeb(files, report, { evalRoot, slugOverride }) {
  if (!files.has("page.html.gz")) throw new Error(`The report has no page.html.gz: the original page was not included, so there is nothing to evaluate. ${INCLUDE_HINT}`);
  if (!files.has("meta.json")) throw new Error("The report has no meta.json");
  const bundleMeta = parseJson(files, "meta.json");
  const slug = slugOverride ?? deriveSlug(report.url);
  const target = join(evalRoot, "corpus", slug);
  if (existsSync(target)) throw new Error(`eval/corpus/${slug} already exists; pass --slug <other> to import under another name`);
  const corpusPath = join(evalRoot, "corpus.json");
  const tags = [...new Set([...(Array.isArray(report.kinds) ? report.kinds : []), "feedback"])];
  const framework = typeof bundleMeta.framework === "string" && bundleMeta.framework ? bundleMeta.framework : "unknown";
  const corpusText = appendCorpusEntry(readFileSync(corpusPath, "utf8"), { slug, url: report.url, framework, tags });
  const shots = screenshotFiles(files);
  const shotsDir = screenshotsTarget(evalRoot, slug, shots);
  const feedback = feedbackRecord(report, slug);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "page.html.gz"), files.get("page.html.gz"));
  writeJson(join(target, "meta.json"), { ...bundleMeta, slug, url: report.url, framework, tags });
  writeJson(join(target, "feedback.json"), feedback);
  writeFileSync(corpusPath, corpusText);
  const screenshots = writeScreenshots(files, shotsDir, shots);
  return { type: "web", slug, url: report.url, tags, framework, target, feedbackPath: join(target, "feedback.json"), feedback, screenshotsDir: shots.length ? shotsDir : undefined, screenshots };
}

function importPdf(files, report, { evalRoot, slugOverride }) {
  if (!files.has("original.pdf")) throw new Error(`The report has no original.pdf: the PDF was not included, so there is nothing to evaluate. ${INCLUDE_HINT}`);
  const pdf = files.get("original.pdf");
  if (pdf.subarray(0, 4).toString("latin1") !== "%PDF") throw new Error("original.pdf in the report is not a PDF");
  const slug = slugOverride ?? derivePdfSlug(report.url);
  const pdfRoot = join(evalRoot, "pdf");
  const target = join(pdfRoot, "corpus", `${slug}.pdf`);
  if (existsSync(target)) throw new Error(`eval/pdf/corpus/${slug}.pdf already exists; pass --slug <other> to import under another name`);
  const sourcesPath = join(pdfRoot, "sources.json");
  const entry = { slug, url: report.url, kind: PDF_KIND, layout: PDF_LAYOUT };
  const sourcesText = appendPdfSource(readFileSync(sourcesPath, "utf8"), entry, { allowSameUrl: slugOverride !== undefined });
  const shots = screenshotFiles(files);
  const shotsDir = screenshotsTarget(evalRoot, slug, shots);
  const feedback = feedbackRecord(report, slug);
  const feedbackPath = join(pdfRoot, "corpus", `${slug}.feedback.json`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, pdf);
  writeJson(feedbackPath, feedback);
  writeFileSync(sourcesPath, sourcesText);
  const screenshots = writeScreenshots(files, shotsDir, shots);
  return { type: "pdf", slug, url: report.url, tags: [PDF_KIND], kind: PDF_KIND, layout: PDF_LAYOUT, target, feedbackPath, feedback, screenshotsDir: shots.length ? shotsDir : undefined, screenshots };
}

/**
 * The import itself, against any eval root (tests use a temp one). Every check runs before anything is written.
 * @param {{ bundlePath: string; evalRoot: string; slugOverride?: string }} options
 */
export function importFeedback({ bundlePath, evalRoot, slugOverride }) {
  const files = openBundle(bundlePath);
  const report = parseJson(files, "report.json");
  if (typeof report.url !== "string" || !report.url) throw new Error("report.json has no url");
  if (WEB_VIEWS.has(report.view)) return importWeb(files, report, { evalRoot, slugOverride });
  if (PDF_VIEWS.has(report.view)) return importPdf(files, report, { evalRoot, slugOverride });
  throw new Error(`report.json is about the ${JSON.stringify(report.view ?? null)} view; only web (eval/corpus) and pdf/text (eval/pdf) reports can be imported`);
}

const clip = (text, length, fromEnd) => (text.length <= length ? text : fromEnd ? `…${text.slice(-length)}` : `${text.slice(0, length)}…`);

/** The reported spot and note as printable lines. */
export function describeFeedback(feedback) {
  const lines = [];
  if (feedback.kinds.length) lines.push(`Reported: ${feedback.kinds.join(", ")}`);
  if (feedback.selection) {
    const { quote, prefix, suffix } = feedback.selection;
    lines.push(`Selection: ${clip(prefix, 60, true)}[[${quote}]]${clip(suffix, 60, false)}`.replace(/\s+/g, " "));
  }
  if (feedback.note) lines.push(`Note: ${feedback.note}`);
  return lines;
}

function nextSteps(imported) {
  if (imported.type === "pdf") return [
    `  node eval/pdf/run.mjs --rules-only ${imported.slug}      # rules judge on the reported PDF`,
    `  node eval/pdf/run.mjs ${imported.slug}                   # with Jev (needs the TypeSafe key)`,
  ];
  return [
    `  cd eval && GOLDEN=1 npx vitest run -t ${imported.slug}      # write the golden for the new case`,
    `  pnpm --filter @read/eval judge ${imported.slug}             # judge it`,
  ];
}

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--slug");
  const slugOverride = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && (!slugOverride || slugOverride.startsWith("--"))) { console.error("--slug needs a value."); process.exit(2); }
  const positional = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--slug");
  if (positional.length !== 1) { console.error("Usage: import-feedback <bundleDir|quire-report-….zip> [--slug s]"); process.exit(2); }
  const evalRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const imported = importFeedback({ bundlePath: positional[0], evalRoot, slugOverride });
    const what = imported.type === "pdf" ? `PDF (kind ${imported.kind}, layout ${imported.layout}; edit eval/pdf/sources.json once you know them)` : `${imported.framework}; tags ${imported.tags.join(", ")}`;
    process.stdout.write([
      `Imported ${imported.url} as ${imported.slug} (${what}) → ${imported.target}`,
      ...describeFeedback(imported.feedback),
      `Reported spot: ${imported.feedbackPath}`,
      ...(imported.screenshotsDir ? [`Screenshots (${imported.screenshots.length}): ${imported.screenshotsDir}`] : []),
      "Next:",
      ...nextSteps(imported),
      "",
    ].join("\n"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
