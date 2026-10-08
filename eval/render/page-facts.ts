// Raw DOM facts about the rendered article, collected in the page (page.evaluate(collectPageFacts)).
// The function is serialized into the browser, so it must stay self-contained: no imports, no
// module-level helpers. Turning the facts into RenderMetrics happens in Node (./metrics), where it is
// unit-tested without a browser.

export interface OverflowCandidate {
  /** Short CSS-ish path from the article root, e.g. `div.reader-document > table.reader-document-table`. */
  path: string;
  /** Index of the nearest ancestor that is also a candidate, or -1. */
  parent: number;
  width: number;
  /** Border box extends past the article column's right edge. */
  exceeds: boolean;
  overflowX: string;
  scrollWidth: number;
  clientWidth: number;
  /** An ancestor inside the article has overflow-x other than visible (it scrolls or clips this box). */
  insideClipper: boolean;
}

export interface HeadingFact {
  text: string;
  level: number;
  /** Inside the document body (.reader-document), not the harness's own title block. */
  inBody: boolean;
  /** Added by the reader itself (the footnotes "Notes" heading). */
  generated: boolean;
  hasMedia: boolean;
}

export interface PageFacts {
  found: boolean;
  /** Article box in page coordinates (scroll offsets added). */
  box: { left: number; top: number; width: number; height: number };
  /** The document scrolls (tiles can be clipped from the page); false when the article sits in an inner scroller. */
  documentScrolls: boolean;
  documentHeight: number;
  text: string;
  /** Visible prose text, grouped by block, without code, math or hidden nodes. */
  prose: string[];
  /** Every <img> and reader image placeholder; a placeholder (`data-reader-image` unresolved/loading) is broken and has no src. */
  images: { src: string; broken: boolean; label: string }[];
  overflow: OverflowCandidate[];
  /** Reader math elements: their status and whether they hold an error node. */
  math: { status: string; error: boolean }[];
  /** KaTeX/Temml/MathML error nodes outside reader math elements. */
  strayMathErrors: number;
  headings: HeadingFact[];
  counts: { codeBlocks: number; tables: number; figures: number; lists: number; footnotes: number };
  /** Every list with items: whether its items draw a marker (list-item display and a list style or image). */
  lists: { marked: boolean; items: number }[];
  /** Every table: its body cells (td) and how many hold no text and no image/icon. */
  tables: { empty: number; cells: number }[];
}

export interface FactSelectors {
  /** The harness's article root: what the tiles cover. */
  root: string;
  /** The reading column inside it: what overflow is measured against and what the text comes from. */
  column: string;
}

export function collectPageFacts(selectors: FactSelectors): PageFacts {
  const empty: PageFacts = {
    found: false, box: { left: 0, top: 0, width: 0, height: 0 }, documentScrolls: true, documentHeight: 0, text: "", prose: [],
    images: [], overflow: [], math: [], strayMathErrors: 0, headings: [], counts: { codeBlocks: 0, tables: 0, figures: 0, lists: 0, footnotes: 0 }, lists: [], tables: [],
  };
  const root = document.querySelector<HTMLElement>(selectors.root);
  if (!root) return empty;
  const article = root.querySelector<HTMLElement>(selectors.column) ?? root;
  const rect = root.getBoundingClientRect();
  const columnRight = article.getBoundingClientRect().right;
  const scroller = document.scrollingElement ?? document.documentElement;
  const box = { left: rect.left + window.scrollX, top: rect.top + window.scrollY, width: rect.width, height: Math.max(rect.height, root.scrollHeight) };

  const step = (element: Element) => {
    const tag = element.tagName.toLowerCase();
    if (element.id) return `${tag}#${element.id}`;
    const cls = Array.from(element.classList).find((name) => !name.startsWith("css-"));
    return cls ? `${tag}.${cls}` : tag;
  };
  const pathOf = (element: Element) => {
    const parts: string[] = [];
    for (let node: Element | null = element; node && node !== article && parts.length < 4; node = node.parentElement) parts.unshift(step(node));
    return parts.join(" > ");
  };

  const overflow: OverflowCandidate[] = [];
  const candidateIndex = new Map<Element, number>();
  for (const element of Array.from(article.querySelectorAll("*"))) {
    const bounds = element.getBoundingClientRect();
    if (bounds.width === 0 && bounds.height === 0) continue;
    const style = getComputedStyle(element);
    const exceeds = bounds.right > columnRight + 1;
    // A 1px box is the visually-hidden pattern (KaTeX's MathML copy, sr-only text), not clipped content.
    const visuallyHidden = element.clientWidth <= 1 || element.clientHeight <= 1;
    const contentOverflow = style.overflowX !== "visible" && !visuallyHidden && element.scrollWidth > element.clientWidth + 2;
    if (!exceeds && !contentOverflow) continue;
    let parent = -1;
    let insideClipper = false;
    for (let node = element.parentElement; node && node !== article; node = node.parentElement) {
      if (parent < 0 && candidateIndex.has(node)) parent = candidateIndex.get(node) as number;
      if (getComputedStyle(node).overflowX !== "visible") insideClipper = true;
    }
    candidateIndex.set(element, overflow.length);
    overflow.push({ path: pathOf(element), parent, width: Math.round(bounds.width), exceeds, overflowX: style.overflowX, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, insideClipper });
    if (overflow.length >= 2000) break;
  }

  const skip = "pre, code, kbd, samp, script, style, noscript, textarea, template, svg, math, button, .katex, .reader-math, [data-reader-image], [aria-hidden='true']";
  const blocks = new Map<Element, string[]>();
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !node.nodeValue || !node.nodeValue.trim()) continue;
    if (parent.closest(skip)) continue;
    if (!parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const block = parent.closest("p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, figcaption, dd, dt, caption, div, section, article") ?? article;
    const parts = blocks.get(block) ?? [];
    parts.push(node.nodeValue);
    blocks.set(block, parts);
  }
  const prose = Array.from(blocks.values(), (parts) => parts.join("").replace(/\s+/g, " ").trim()).filter(Boolean);

  const images = Array.from(article.querySelectorAll("img, [data-reader-image]:not(img)"), (element) => {
    if (element instanceof HTMLImageElement) return { src: element.currentSrc || element.src || element.getAttribute("src") || "", broken: !element.complete || element.naturalWidth === 0, label: element.alt || element.title || "" };
    const label = element.getAttribute("title") || element.querySelector("[role='img']")?.getAttribute("aria-label") || "";
    return { src: "", broken: true, label };
  });
  const errorSelector = ".katex-error, merror, .temml-error";
  const mathElements = Array.from(article.querySelectorAll("[data-reader-math]"));
  const math = mathElements.map((element) => ({ status: element.getAttribute("data-reader-math-status") ?? "", error: element.querySelector(errorSelector) !== null }));
  const strayMathErrors = Array.from(article.querySelectorAll(errorSelector)).filter((element) => !element.closest("[data-reader-math]")).length;
  const headings = Array.from(article.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"), (heading) => ({
    text: heading.innerText.replace(/\s+/g, " ").trim(), level: Number(heading.tagName.slice(1)),
    inBody: heading.closest(".reader-document") !== null, generated: heading.closest(".reader-footnotes") !== null, hasMedia: heading.querySelector("img, svg, picture, video") !== null,
  }));
  const count = (query: string) => article.querySelectorAll(query).length;
  const lists = Array.from(article.querySelectorAll<HTMLElement>("ul, ol")).flatMap((list) => {
    const items = Array.from(list.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName === "LI");
    const first = items[0];
    if (!first || list.getBoundingClientRect().height === 0) return [];
    const style = getComputedStyle(first);
    return [{ marked: style.display === "list-item" && (style.listStyleType !== "none" || style.listStyleImage !== "none"), items: items.length }];
  });
  const tables = Array.from(article.querySelectorAll("table"), (table) => {
    const cells = Array.from(table.querySelectorAll("td"));
    const empty = cells.filter((cell) => (cell.textContent ?? "").trim() === "" && cell.querySelector("img, svg, picture, input, [role='img'], [data-reader-image]") === null).length;
    return { empty, cells: cells.length };
  });
  return {
    found: true, box, documentScrolls: scroller.scrollHeight >= box.top + box.height - 1, documentHeight: scroller.scrollHeight,
    text: article.innerText, prose, images, overflow, math, strayMathErrors, headings,
    counts: { codeBlocks: count("pre:not(pre pre)"), tables: count("table"), figures: count("figure"), lists: count("ul, ol:not(.reader-footnotes > ol)"), footnotes: count("[data-reader-footnote-definition]") },
    lists, tables,
  };
}
