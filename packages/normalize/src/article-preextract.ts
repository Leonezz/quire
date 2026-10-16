/**
 * Rewrites made to the extractors' working copy of the page before Defuddle
 * and Readability read it: markup they would misread is put into a form they
 * keep. Each pass that changes the document records its rule, so provenance
 * says what was rewritten.
 */
interface PreextractionPass {
  readonly rule: string;
  /** Rewrites the document in place; true when anything changed. */
  readonly apply: (document: Document) => boolean;
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

const PREEXTRACTION_PASSES: readonly PreextractionPass[] = [
  { rule: "article.preextract.icon-cells@1", apply: iconLigatureCells },
  { rule: "article.preextract.pseudo-element-classes@1", apply: pseudoElementHiddenClasses },
];

/** Runs every pass over the extractor's own copy of the page and returns the rules of the passes that changed it. */
export function preextractArticleDocument(document: Document): string[] {
  return PREEXTRACTION_PASSES.flatMap((pass) => (pass.apply(document) ? [pass.rule] : []));
}
