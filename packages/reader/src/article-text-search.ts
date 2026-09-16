type TextRun = { node: Text; start: number; end: number };
type TextSegment = { text: string; runs: TextRun[] };
export type ArticleTextIndex = readonly TextSegment[];

const BLOCKS = new Set([
  "ARTICLE",
  "SECTION",
  "DIV",
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "DT",
  "DD",
  "PRE",
  "BLOCKQUOTE",
  "TD",
  "TH",
  "TR",
  "FIGCAPTION",
  "DETAILS",
  "SUMMARY",
  "HR",
]);
const EXCLUDED =
  'script, style, noscript, template, svg, math, button, input, textarea, select, [hidden], [aria-hidden="true"], .sr-only, [data-reader-math-status="rendered"], [data-footnote-ref], [data-footnote-backref]';

/** Index visible prose/code, preserving native text offsets and inline boundaries.
 * Separate blocks never concatenate into false phrases. No DOM nodes are changed.
 */
export function indexArticleText(root: HTMLElement): ArticleTextIndex {
  const segments: TextSegment[] = [];
  let current: TextSegment = { text: "", runs: [] };
  const boundary = () => {
    if (current.text.trim()) segments.push(current);
    current = { text: "", runs: [] };
  };
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      const text = node.textContent ?? "";
      current.runs.push({
        node: node as Text,
        start: current.text.length,
        end: current.text.length + text.length,
      });
      current.text += text;
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as HTMLElement;
    if (element.matches(EXCLUDED)) {
      // Invisible controls/footnote markers must not split the surrounding prose.
      if (element.matches('[data-reader-math-status="rendered"], svg, math'))
        boundary();
      return;
    }
    const style = root.ownerDocument.defaultView?.getComputedStyle(element);
    if (style?.display === "none" || style?.visibility === "hidden") return;
    if (element.tagName === "BR") {
      current.text += "\n";
      return;
    }
    const isBlock = BLOCKS.has(element.tagName);
    if (isBlock) boundary();
    if (element.tagName === "DETAILS" && !element.hasAttribute("open")) {
      const summary = element.querySelector(":scope > summary");
      if (summary) visit(summary);
    } else {
      for (const child of element.childNodes) visit(child);
    }
    if (isBlock) boundary();
  };
  for (const child of root.childNodes) visit(child);
  boundary();
  return segments;
}

function runAt(runs: readonly TextRun[], offset: number) {
  let low = 0;
  let high = runs.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const run = runs[mid];
    if (offset < run.start) high = mid - 1;
    else if (offset >= run.end) low = mid + 1;
    else return run;
  }
  return undefined;
}

export function findArticleText(
  index: ArticleTextIndex,
  query: string,
  limit = 2000,
) {
  const ranges: Range[] = [];
  const trimmed = query.trim();
  if (!trimmed) return { ranges, limited: false };
  const pattern = trimmed
    .split(/\s+/u)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const matcher = new RegExp(pattern, "giu");
  for (const segment of index) {
    matcher.lastIndex = 0;
    for (const match of segment.text.matchAll(matcher)) {
      const start = runAt(segment.runs, match.index);
      const endOffset = match.index + match[0].length;
      const end = runAt(segment.runs, endOffset - 1);
      if (!start || !end) continue;
      if (ranges.length >= limit) return { ranges, limited: true };
      const range = start.node.ownerDocument.createRange();
      range.setStart(start.node, match.index - start.start);
      range.setEnd(end.node, endOffset - end.start);
      ranges.push(range);
    }
  }
  return { ranges, limited: false };
}

type HighlightRegistry = {
  set(name: string, value: unknown): unknown;
  delete(name: string): unknown;
};

export function highlightArticleMatches(
  root: HTMLElement,
  name: string,
  ranges: Range[],
  active?: Range,
) {
  const view = root.ownerDocument.defaultView as
    | (Window & {
        CSS?: { highlights?: HighlightRegistry };
        Highlight?: new (...ranges: Range[]) => { priority: number };
      })
    | null;
  const registry = view?.CSS?.highlights;
  const Highlight = view?.Highlight;
  if (!registry || !Highlight) return () => {};
  const matches = new Highlight(...ranges);
  matches.priority = 1;
  registry.set(name, matches);
  if (active) {
    const current = new Highlight(active);
    current.priority = 2;
    registry.set(`${name}-current`, current);
  }
  return () => {
    registry.delete(name);
    registry.delete(`${name}-current`);
  };
}
