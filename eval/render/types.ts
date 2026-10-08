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
  rendered: RenderedSide & { textPath: string; metrics: RenderMetrics };
  /** The original page from the snapshot: JavaScript off (the extractor never ran it), network on for CSS and images; it can lack styles or images. */
  reference: RenderedSide & { failedRequests: number };
  /** Anything that went wrong but still produced tiles (a timeout waiting for images, a reference that never finished loading). */
  warnings: string[];
}
