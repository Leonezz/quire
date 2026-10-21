import { placeInteractivePlaceholders, replaceImageObjects } from "./embedded-media";
import type { ReaderV2CalloutKind } from "./reader-document-v2-contract";

/**
 * Rewrites made to the extractors' working copy of the page before Defuddle
 * and Readability read it: markup they would misread is put into a form they
 * keep. Each pass that changes the document records its rule, so provenance
 * says what was rewritten.
 */
interface PreextractionPass {
  readonly rule: string;
  /** Rewrites the document of the page at `source` in place; true when anything changed. */
  readonly apply: (document: Document, source: string) => boolean;
}

const ICON_FONT_CLASS = /^material-(?:icons|symbols)(?:-[\w-]+)?$/u;
const ICON_LIGATURE_GLYPHS: ReadonlyMap<string, string> = new Map([
  ["check", "✓"],
  ["done", "✓"],
  ["check_circle", "✓"],
  ["close", "✗"],
  ["clear", "✗"],
  ["block", "✗"],
  ["cancel", "✗"],
  ["remove", "–"],
]);
// Tailwind variants that hide only a pseudo-element box ("l:before:hidden"),
// possibly chained with state variants ("after:hover:invisible").
const PSEUDO_ELEMENT_HIDDEN_CLASS =
  /(?:^|:)(?:before|after|placeholder|marker|file|first-letter|first-line|selection|backdrop):(?:[\w-]+:)*(?:hidden|invisible)$/u;

function classTokens(element: Element) {
  return (element.getAttribute("class") ?? "").split(/\s+/u).filter(Boolean);
}

/**
 * Support tables mark their ✓/✗ cells as aria-hidden icon-font ligatures; the
 * extractors drop aria-hidden content and leave the cells empty. The icon
 * becomes the plain character it stands for, so no icon markup is left over.
 */
function iconLigatureCells(document: Document) {
  let changed = false;
  for (const icon of Array.from(document.querySelectorAll("td [aria-hidden='true'], th [aria-hidden='true']"))) {
    if (icon.children.length > 0 || !classTokens(icon).some((token) => ICON_FONT_CLASS.test(token))) continue;
    const glyph = ICON_LIGATURE_GLYPHS.get((icon.textContent ?? "").trim());
    if (!glyph) continue;
    icon.replaceWith(document.createTextNode(glyph));
    changed = true;
  }
  return changed;
}

/** Defuddle reads any "…:hidden" class token as hiding the element itself, so tokens that only hide its ::before or ::after go. */
function pseudoElementHiddenClasses(document: Document) {
  let changed = false;
  for (const element of Array.from(document.querySelectorAll("[class*=':']"))) {
    const tokens = classTokens(element);
    const kept = tokens.filter((token) => !PSEUDO_ELEMENT_HIDDEN_CLASS.test(token));
    if (kept.length === tokens.length) continue;
    if (kept.length > 0) element.setAttribute("class", kept.join(" "));
    else element.removeAttribute("class");
    changed = true;
  }
  return changed;
}

/**
 * Interactive content only script fills gets its link to the original page before the extractors run: they
 * remove a src-less Sandpack preview like any empty iframe, so the link pass would never see it. (They keep
 * an empty Distill figure, which gets the same link here rather than in the link pass.)
 */
function interactivePlaceholders(document: Document, source: string) {
  return placeInteractivePlaceholders(document, source) > 0;
}

/**
 * An <object> of an image type (arXiv's SVG figure panels) becomes an <img> before the extractors run: they
 * remove objects as plugins, so the figure would lose its panels before the reader saw them.
 */
function imageObjects(document: Document, source: string) {
  return replaceImageObjects(document, source) > 0;
}

// A class token, or one hyphenated part of one ("callout-warning"), that names a callout's kind.
const CALLOUT_KIND_TOKENS: ReadonlyMap<string, ReaderV2CalloutKind> = new Map([
  ["note", "note"],
  ["info", "note"],
  ["tip", "tip"],
  ["hint", "tip"],
  ["success", "tip"],
  ["important", "important"],
  ["key-point", "key-point"],
  ["keypoint", "key-point"],
  ["takeaway", "key-point"],
  ["warning", "warning"],
  ["warn", "warning"],
  ["attention", "warning"],
  ["caution", "caution"],
  ["danger", "caution"],
  ["error", "caution"],
]);
/** Class tokens by which the author declares a block a callout, however short or link-heavy (matklad's one-link series note). */
const CALLOUT_CLASSES = new Set(["admonition", "callout", ...CALLOUT_KIND_TOKENS.keys()]);
const CALLOUT_CANDIDATES = "aside, .admonition, .callout, .note, .key-point";
const CALLOUT_TAGS = new Set(["ASIDE", "DIV", "SECTION"]);
// A "note" longer than this is a wrapper, not a callout (eugeneyan.com's div.note holds the whole post).
const MAX_CALLOUT_TEXT = 2500;
// An unlabelled aside shorter than this is a line of chrome ("Discuss this page on Reddit.", fasterthanli.me).
const MIN_ASIDE_TEXT = 80;
const MAX_ASIDE_LINK_DENSITY = 0.5;
// The page furniture asides are also made of: sidebars, widgets, tables of contents, related and shared links, comments.
const CHROME_ASIDE =
  /(?:^|[\s_-])(?:sidebar|widgets?|toc|related|recirc|read-?next|read-?more|share|sharing|social|newsletter|subscribe|promo|advert|sponsor(?:ed)?|comments?|discuss(?:ion)?|nav(?:igation)?|menu|breadcrumbs?|author|bio|tags|search)(?=$|[\s_-])/iu;
const HIDDEN_CLASS = /^(?:hidden|invisible|d-none|sr-only|visually-hidden|screen-reader-(?:only|text)|hide-on-print|hide-for-print|hide-print|hidden-print|no-?print|print-none|print:hidden)$/iu;
const HIDDEN_STYLE = /(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu;
const PULL_QUOTE_CLASS = /pull-?quote/iu;
const SCREEN_READER_LABEL = ".screen-reader-only, .screen-reader-text, .sr-only, .visually-hidden";

const normalizedText = (node: Node) => (node.textContent ?? "").replace(/\s+/gu, " ").trim();

function calloutKind(element: Element): ReaderV2CalloutKind | undefined {
  for (const token of classTokens(element).map((value) => value.toLowerCase())) {
    const kind = CALLOUT_KIND_TOKENS.get(token) ?? token.split(/[-_]+/u).map((part) => CALLOUT_KIND_TOKENS.get(part)).find(Boolean);
    if (kind) return kind;
  }
  return undefined;
}

function linkDensity(element: Element, text: string) {
  const linkText = Array.from(element.querySelectorAll("a"), (link) => normalizedText(link).length).reduce((sum, length) => sum + length, 0);
  return text.length === 0 ? 0 : linkText / text.length;
}

/** Hidden, print-hidden (Quanta's pull quotes and column boxes), page chrome by class, or a pull quote: not the article's own text. */
function isFurniture(element: Element) {
  if (classTokens(element).some((token) => HIDDEN_CLASS.test(token)) || HIDDEN_STYLE.test(element.getAttribute("style") ?? "")) return true;
  if (CHROME_ASIDE.test(`${element.getAttribute("class") ?? ""} ${element.id}`)) return true;
  return [element, ...Array.from(element.querySelectorAll("[class]"))].some((candidate) => PULL_QUOTE_CLASS.test(candidate.getAttribute("class") ?? ""));
}

/**
 * Whether a candidate block is a callout the reader should keep. A declared callout (class note,
 * admonition, callout, key-point…) is the author's; an unlabelled <aside> must also read as prose:
 * long enough, not mostly links, and not a pull quote repeating text the page already shows.
 */
function isCallout(element: Element, pageText: string) {
  if (!CALLOUT_TAGS.has(element.tagName.toUpperCase())) return false;
  if (element.closest("noscript, nav, header, footer, pre, code, table, [hidden], [aria-hidden='true']")) return false;
  if (isFurniture(element) || element.querySelector("h1, article, main, nav, form, aside")) return false;
  const text = normalizedText(element);
  if (text.length === 0 || text.length > MAX_CALLOUT_TEXT) return false;
  if (classTokens(element).some((token) => CALLOUT_CLASSES.has(token.toLowerCase()))) return true;
  return text.length >= MIN_ASIDE_TEXT && linkDensity(element, text) <= MAX_ASIDE_LINK_DENSITY && pageText.indexOf(text) === pageText.lastIndexOf(text);
}

/**
 * Defuddle removes every <aside> but `aside[class*=callout]`, Readability every <aside>, and neither keeps
 * `.admonition` or `.note` boxes reliably, so a page's callouts (web.dev's "Key point", matklad's closing
 * note, gwern's "Read The Samples") would go as page chrome. Each becomes a blockquote both keep, marked with
 * its kind; a screen-reader label that only names the kind (Quarto's "Warning") goes, since the reader shows it.
 */
function callouts(document: Document) {
  const pageText = normalizedText(document.body ?? document.documentElement);
  let changed = false;
  for (const element of Array.from(document.querySelectorAll(CALLOUT_CANDIDATES))) {
    if (element.parentElement?.closest("blockquote[data-callout]") || !isCallout(element, pageText)) continue;
    const kind = calloutKind(element) ?? "note";
    for (const label of Array.from(element.querySelectorAll(SCREEN_READER_LABEL))) {
      if (CALLOUT_KIND_TOKENS.has(normalizedText(label).toLowerCase())) label.remove();
    }
    const quote = document.createElement("blockquote");
    if (element.id) quote.setAttribute("id", element.id);
    quote.setAttribute("data-callout", kind);
    quote.append(...Array.from(element.childNodes));
    element.replaceWith(quote);
    changed = true;
  }
  return changed;
}

const PREEXTRACTION_PASSES: readonly PreextractionPass[] = [
  { rule: "article.preextract.icon-cells@1", apply: iconLigatureCells },
  { rule: "article.preextract.pseudo-element-classes@1", apply: pseudoElementHiddenClasses },
  { rule: "article.preextract.interactive-placeholders@1", apply: interactivePlaceholders },
  { rule: "article.preextract.image-objects@1", apply: imageObjects },
  { rule: "article.preextract.callouts@1", apply: callouts },
];

/** Runs every pass over the extractor's own copy of the page at `source` and returns the rules of the passes that changed it. */
export function preextractArticleDocument(document: Document, source: string): string[] {
  return PREEXTRACTION_PASSES.flatMap((pass) => (pass.apply(document, source) ? [pass.rule] : []));
}
