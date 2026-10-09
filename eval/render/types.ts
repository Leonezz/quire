// The contract between the render capture (eval/render) and the judge (eval/judge): what the judge
// may read for one case. Written by `pnpm --filter @read/eval render`, read by `judge` in visual mode.
//
//   eval/render/out/<slug>/manifest.json   this RenderManifest
//   eval/render/out/<slug>/rendered-01.png  the Quire reader as a reader sees it, top to bottom
//   eval/render/out/<slug>/reference-01.png the original snapshot page in a browser, top to bottom
//   eval/render/out/<slug>/rendered.txt     the reader's visible text (innerText of the article)
//
// Everything under eval/render/out/ is local (gitignored): it holds third-party page content.

/** Facts measured in the rendered reader page; the judge treats them as ground truth, not as opinions. */
export interface RenderMetrics {
  /** Images in the article and how many failed to load (naturalWidth 0 after load or error), with their src. */
  images: { total: number; broken: number; brokenSrc: string[] };
  /** Elements wider than the reading column (horizontal overflow), as short CSS-ish paths with their width. */
  overflow: { count: number; samples: { path: string; width: number }[] };
  /** Markup that should have been rendered but shows as text (`\<`, `](http`, `$$`, `\frac`, `<table`, `&lt;`), with a short visible-text sample each. */
  rawMarkup: { count: number; samples: { pattern: string; text: string }[] };
  /** Math that failed to render (KaTeX/Temml error nodes or `$…$` left as text). */
  mathErrors: number;
  /** Code blocks shown as a single line of 100+ characters (see RenderedCode.collapsed). */
  collapsedCode: number;
  /** Visible lists whose items show no bullet or number (the list style resolved to none). */
  unmarkedLists: number;
  /** Tables where at least a quarter of the body cells are empty (no text, no image or icon) — content such as ✓/✗ icons that did not survive; table is the 1-based index among the article's tables. */
  emptyCellTables: { count: number; samples: { table: number; empty: number; cells: number }[] };
  /** Headings with no text, and headings whose text repeats the title. */
  emptyHeadings: number;
  duplicateTitleHeadings: number;
  /** Code blocks, tables, figures, lists and footnotes the reader shows (counts, for comparison with the source). */
  counts: { codeBlocks: number; tables: number; figures: number; lists: number; footnotes: number; headings: number; words: number };
  /** Total rendered height of the article in CSS pixels. */
  height: number;
}

/** One image the reader shows, in document order; `id` is how the judge refers to it ("r1", "r2", …). */
export interface RenderedImage {
  id: string;
  /** The 1-based rendered tile the image's top falls in; null when it lies beyond the captured tiles. */
  tile: number | null;
  /** The original image URL (before the capture's proxy), alt text and figure caption, each possibly "". */
  src: string;
  alt: string;
  caption: string;
  broken: boolean;
}

/** One sizeable image on the original page (JavaScript off), in document order; `id` is "o1", "o2", …. */
export interface ReferenceImage {
  id: string;
  tile: number | null;
  /** The src and every lazy-load candidate (data-src, data-original, srcset entries…), absolute. */
  src: string;
  candidates: string[];
  alt: string;
  /** Laid-out size in CSS px (0 when the page left it unsized); images under 48 px on both sides are not listed. */
  width: number;
  height: number;
  /** The reader image ("r…") judged to be the same picture by URL (file name stem, size suffixes and query stripped), or null. */
  matchedBy: string | null;
}

/** Content the original page fills in with JavaScript or a plugin; found in the snapshot HTML, in document order. */
export interface Embed {
  kind: "iframe" | "video" | "audio" | "canvas" | "tweet" | "instagram" | "custom-element" | "noscript";
  /** The tag name (lowercase), the src or data URL when there is one, and its host. */
  tag: string;
  src: string;
  host: string;
  /** Up to 160 characters of the nearest preceding heading or paragraph, so the judge can find where it belonged. */
  context: string;
  /** Whether the reader shows something for it: the embed's URL (or its host + path) appears as a link, image or media source in the reader. */
  representedInReader: boolean;
}

/** One table the reader shows, in document order; `id` is "t1", "t2", …. */
export interface RenderedTable {
  id: string;
  tile: number | null;
  rows: number;
  cols: number;
  /** Body cells (td) and how many hold no text and no image/icon. */
  cells: number;
  emptyCells: number;
  /** Up to 80 characters of the first row's text, so the judge can tell tables apart. */
  head: string;
}

/** One code block the reader shows, in document order; `id` is "c1", "c2", …. */
export interface RenderedCode {
  id: string;
  tile: number | null;
  /** Lines and characters of the block's visible text. */
  lines: number;
  chars: number;
  /** A block shown as a single line of 100 characters or more: almost always several lines run together. */
  collapsed: boolean;
  /** The first 80 characters of its text, verbatim, for locating it in EXTRACTED. */
  head: string;
}

export interface RenderedSide {
  /** Tile files, relative to the case directory, top to bottom. */
  tiles: string[];
  /** Full height in CSS pixels, and whether tiles stop before the end (capped by --max-tiles). */
  height: number;
  truncated: boolean;
}

export interface RenderManifest {
  slug: string;
  /** The preview corpus id the reader rendered (eval export), and the page's final URL. */
  id: string;
  url: string;
  /** sha256 over the reader payload, the snapshot bytes, the renderer build id, the viewport and the tile cap; a capture is redone when it changes. */
  key: string;
  capturedAt: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  rendered: RenderedSide & { textPath: string; metrics: RenderMetrics; images: RenderedImage[]; tables: RenderedTable[]; code: RenderedCode[] };
  /** The original page from the snapshot: JavaScript off (the extractor never ran it), network on for CSS and images; it can lack styles or images. */
  reference: RenderedSide & { failedRequests: number; images: ReferenceImage[] };
  /** JavaScript or plugin content in the snapshot (iframes, videos, tweets, custom elements…); the standard (docs/design/eval-rubric.md §2) requires the reader to show each one that belongs to the article, or a link to it. */
  embeds: Embed[];
  /** Anything that went wrong but still produced tiles (a timeout waiting for images, a reference that never finished loading). */
  warnings: string[];
}
