import { parseHTML } from "linkedom";

/**
 * Generic chrome that survives extraction inside the article region:
 * an in-page table of contents (redundant with the reader's own contents
 * rail) and trailing "related / share / newsletter" blocks. Each removal is
 * recorded as a rule so provenance says what was taken out.
 */
export interface PrunedArticle {
  content: string;
  rulesApplied: string[];
}

const TOC_HEADING = /^(table of )?contents?$|^(目录|目次)$|^in this (article|post)$|^on this page$/iu;
const TRAILING_CHROME_HEADING =
  /^(related( (posts?|articles?|content|reading|stories))?:?|share( this)?( (post|article))?:?|newsletter|subscribe( to .*)?|comments?|comment on this (article|post)|discussion( and review)?|leave a (comment|reply)|(read|you might) (next|also like)|more (from|like this).*|recommended.*|further reading|sponsored.*|tags?|footer|about the author)$/iu;
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const MAX_HTML_BYTES = 8 * 1024 * 1024;

type El = Element & { parentElement: Element | null; nextElementSibling: Element | null; previousElementSibling: Element | null; textContent: string | null };

function headingLevel(element: Element) {
  return HEADING_TAGS.has(element.tagName.toLowerCase()) ? Number(element.tagName.slice(1)) : undefined;
}

function headingText(element: Element) {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** A list where nearly every item is an internal anchor link is a table of contents. */
function isAnchorList(element: Element | null) {
  if (!element) return false;
  const tag = element.tagName.toLowerCase();
  if (tag !== "ul" && tag !== "ol" && tag !== "nav") return false;
  const hrefs = Array.from(element.querySelectorAll("a[href]")).map((link) => link.getAttribute("href") ?? "");
  if (hrefs.length < 2) return false;
  // Extractors resolve "#section" to the page's absolute URL, so same-page links
  // share one prefix before the fragment; that prefix is the page itself.
  const bases = new Map<string, number>();
  for (const href of hrefs) {
    const hash = href.indexOf("#");
    if (hash < 0 || hash === href.length - 1) continue;
    const base = href.slice(0, hash);
    bases.set(base, (bases.get(base) ?? 0) + 1);
  }
  const internal = Math.max(0, ...bases.values());
  return internal / hrefs.length >= 0.8;
}

/** Siblings that belong to a table of contents: anchor lists, bare anchor links, rules and empty paragraphs. */
function isTocPart(element: Element | null) {
  if (!element) return false;
  const tag = element.tagName.toLowerCase();
  if (tag === "hr") return true;
  if (tag === "p" && !(element.textContent ?? "").trim() && !element.querySelector("a[href]")) return true;
  if (tag === "a") return (element.getAttribute("href") ?? "").includes("#");
  if (isAnchorList(element)) return true;
  if (tag === "div" || tag === "nav" || tag === "section" || tag === "aside" || tag === "details") {
    const list = element.querySelector("ul, ol");
    return isAnchorList(list) && (element.textContent ?? "").trim().length <= (list?.textContent ?? "").trim().length + 40;
  }
  return false;
}

function removeFollowingParts(start: Element | null, isPart: (element: Element | null) => boolean) {
  let removed = 0;
  let cursor: Element | null = start;
  while (cursor && isPart(cursor)) {
    const next: Element | null = (cursor as El).nextElementSibling;
    cursor.remove();
    cursor = next;
    removed += 1;
  }
  return removed;
}

function removeTableOfContents(document: Document, rules: string[]) {
  for (const heading of Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")) as El[]) {
    if (!TOC_HEADING.test(headingText(heading))) continue;
    const removed = removeFollowingParts(heading.nextElementSibling, isTocPart);
    if (removed === 0) continue;
    heading.remove();
    rules.push("article.prune.table-of-contents@1");
    return;
  }
  // A bare ToC container without a heading.
  for (const nav of Array.from(document.querySelectorAll("nav.toc, nav#toc, [role='doc-toc'], .table-of-contents, #table-of-contents, #TableOfContents, .toc")) as El[]) {
    if (!isAnchorList(nav) && !isAnchorList(nav.querySelector("ul, ol"))) continue;
    const previous = nav.previousElementSibling;
    if (previous && TOC_HEADING.test(headingText(previous))) previous.remove();
    nav.remove();
    rules.push("article.prune.table-of-contents@1");
    return;
  }
}

/** Removes a chrome heading and everything after it up to the next heading of the same or higher level. */
function removeTrailingChrome(document: Document, rules: string[]) {
  const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")) as El[];
  const bodyText = (document.body?.textContent ?? "").length;
  for (const heading of headings) {
    if (!TRAILING_CHROME_HEADING.test(headingText(heading))) continue;
    // Only in the tail of the article: a section called "Discussion" in the middle
    // is content. A heading followed by nothing but a list of links is chrome anywhere.
    const before = textBefore(document, heading);
    const followedByLinkList = isLinkListOnly(heading.nextElementSibling);
    if (!followedByLinkList && bodyText > 0 && before / bodyText < 0.6) continue;
    const level = headingLevel(heading) ?? 6;
    let cursor: Element | null = heading.nextElementSibling;
    heading.remove();
    while (cursor) {
      const next: Element | null = cursor.nextElementSibling;
      const cursorLevel = headingLevel(cursor);
      if (cursorLevel !== undefined && cursorLevel <= level) break;
      cursor.remove();
      cursor = next;
    }
    rules.push("article.prune.trailing-chrome@1");
  }
}

/** An hr and/or a list whose items are all links (a "related posts" block), nothing else. */
function isLinkListOnly(element: Element | null) {
  let cursor: Element | null = element;
  while (cursor && cursor.tagName.toLowerCase() === "hr") cursor = (cursor as El).nextElementSibling;
  if (!cursor) return false;
  const tag = cursor.tagName.toLowerCase();
  if (tag !== "ul" && tag !== "ol") return false;
  const items = Array.from(cursor.querySelectorAll("li"));
  return items.length >= 1 && items.every((item) => item.querySelector("a[href]") !== null);
}

/** Characters of text that precede the element in document order (a plain walk; no TreeWalker in linkedom). */
function textBefore(document: Document, element: Element) {
  let count = 0;
  let reached = false;
  const visit = (node: Node) => {
    if (reached) return;
    if (node === element) { reached = true; return; }
    if (node.nodeType === 3) { count += (node.textContent ?? "").length; return; }
    for (const child of Array.from(node.childNodes)) { visit(child); if (reached) return; }
  };
  if (document.body) visit(document.body);
  return count;
}

export function pruneArticleChrome(html: string): PrunedArticle {
  if (html.length > MAX_HTML_BYTES) return { content: html, rulesApplied: [] };
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const rules: string[] = [];
  removeTableOfContents(document as unknown as Document, rules);
  removeTrailingChrome(document as unknown as Document, rules);
  if (rules.length === 0) return { content: html, rulesApplied: [] };
  return { content: (document.body as unknown as Element).innerHTML, rulesApplied: rules };
}
