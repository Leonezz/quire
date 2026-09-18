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

export interface PruneOptions {
  /** The article title already chosen; a body h1 repeating it is dropped. */
  title?: string | undefined;
  /** Names the site uses for itself (lower-case); a leading heading equal to one is site chrome. */
  siteNames?: ReadonlySet<string> | undefined;
  /** The byline already extracted; a leading line that only repeats it is dropped. */
  byline?: string | undefined;
}

const TOC_HEADING = /^(table of )?contents?$|^(目录|目次)$|^in this (article|post)$|^on this page$/iu;
const TRAILING_CHROME_HEADING =
  /^(related( (posts?|articles?|content|reading|stories))?:?|share( this)?( (post|article))?:?|newsletter|subscribe( to .*)?|comments?|comment on this (article|post)|discussion( and review)?|leave a (comment|reply)|(read|you might) (next|also like)|you may also like|more (from|like this|by) .*|more (from|like this)|recommended.*|further reading|sponsored.*|tags?|footer|about the author|written by.*|explore more.*|also in .*|next (article|post|up)|year in review|all (articles|content|posts)|discuss( on| this)?.*|read my book|my book|buy (my|the) book|support (me|this|my work).*|sponsors?)$/iu;
const PROMO_TEXT = /^(written by|about the author|share( this)?|subscribe|related|explore more|more from|more by|next article|also in|read next|you may also like|sign up|get (the newsletter|highlights|the latest)|join \d|view all|here'?s another|if you (liked|enjoyed)|thanks for reading|enjoyed this|liked this|follow (me|us))|delivered to your inbox|newsletter|^©|^copyright\b|all rights reserved/iu;
const DATE_LINE = /^(?:\S+,\s*)?(?:(?:19|20)\d{2}[-/.年]\s*\d{1,2}[-/.月]\s*\d{1,2}\s*日?|\d{1,2}(?:st|nd|rd|th)?\s+[A-Z][a-z]+\.?,?\s+(?:19|20)\d{2}|[A-Z][a-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(?:19|20)\d{2})(?:\s*[·•|—–-].{0,40})?$/u;
const CHROME_CLASS = /\b(tags?|categories|post-tags|post-meta|entry-meta|share|social|author-box|author-card|bio|related|promo|newsletter|subscribe|cta|breadcrumbs?|kicker|eyebrow)\b|aside|recirc|teaser|sidebar|widget|read-next|more-stories|recommend/iu;
const META_LINE = /(\b\d+ min(ute)? read\b|\bcomments?\b|\bshare\b|\bposted (on|in|by)\b|\bpublished\b|\bupdated\b|\bestimated reading time\b|\btweet\b)/iu;
const PERMALINK_CLASS = /anchor|permalink|headerlink|heading-link|hash-link|zola-anchor|header-link|section-link/iu;
const PERMALINK_TEXT = /^[\s#¶§🔗∞︎⚓]*$/u;
const MAX_TAIL_TRIM_RATIO = 0.4;
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

function normalizedTitle(value: string) {
  return value.replace(/[\s¶#🔗]+$/u, "").replace(/\s+/gu, " ").trim().toLowerCase();
}

function linksWithin(element: Element): Element[] {
  const inner = Array.from(element.querySelectorAll("a"));
  return element.tagName.toLowerCase() === "a" ? [element, ...inner] : inner;
}

function linkDensity(element: Element) {
  const text = (element.textContent ?? "").trim().length;
  if (text === 0) return 0;
  if (element.tagName.toLowerCase() === "a") return 1;
  const linked = linksWithin(element).reduce((sum, link) => sum + (link.textContent ?? "").trim().length, 0);
  return Math.min(1, linked / text);
}

/** Every item is a link plus at most a date or a short blurb: a list of cards, not a list the author wrote. */
function isLinkCardList(element: Element) {
  const tag = element.tagName.toLowerCase();
  if (tag !== "ul" && tag !== "ol") return false;
  const items = Array.from(element.children).filter((child) => child.tagName.toLowerCase() === "li");
  if (items.length === 0) return false;
  return items.every((item) => {
    const link = item.querySelector("a[href]");
    if (!link) return false;
    const text = (item.textContent ?? "").replace(/\s+/gu, " ").trim();
    const rest = text.replace(link.textContent ?? "", "").trim();
    const cardLike = item.querySelector("h1, h2, h3, h4, img, picture, time") !== null || /(?:19|20)\d{2}/u.test(rest);
    const prose = /[.!?。！？]\s/u.test(rest) && rest.length > 120;
    return !prose && (rest.length <= 80 || (cardLike && text.length <= 240));
  });
}

/** Structural content never counts as chrome, wherever it sits. */
const STRUCTURAL_TAGS = /^(table|pre|figure|blockquote|dl|details|ul|ol|code|math)$/iu;
function isStructural(element: Element) {
  if (isLinkCardList(element)) return false;
  return STRUCTURAL_TAGS.test(element.tagName) || element.getAttribute("role") === "doc-endnotes" || /\b(footnotes?|footnote-list|references|bibliography)\b/iu.test(element.getAttribute("class") ?? "") || /^(footnotes?|references|bibliography)$/iu.test(element.id);
}

const PLACEHOLDER_TEXT = /^(loading|正在加载|加载中|please wait)[.…]*$/iu;

/** Same-page anchor lists anywhere are navigation (an in-page ToC without a heading, a tab strip); loading placeholders are app residue. */
function removeNavigationLists(document: Document, rules: string[]) {
  let changed = false;
  for (const list of Array.from(document.querySelectorAll("ul, ol"))) {
    if (!list.isConnected || !isAnchorList(list)) continue;
    const previous = (list as El).previousElementSibling;
    if (previous && /^h[1-6]$/iu.test(previous.tagName) && /references|bibliography|notes|footnotes|links|resources|参考|链接|引用|注释|脚注|文献/iu.test(previous.textContent ?? "")) continue;
    list.remove();
    changed = true;
  }
  for (const element of Array.from(document.querySelectorAll("p, div, span"))) {
    if (element.children.length === 0 && PLACEHOLDER_TEXT.test((element.textContent ?? "").trim())) { element.remove(); changed = true; }
  }
  if (changed) rules.push("article.prune.navigation-lists@1");
}

/** Permalink anchors ("#", "¶", icon-only links) are removed; a heading that is itself a link is unwrapped. */
function cleanHeadings(document: Document, rules: string[]) {
  let changed = false;
  for (const heading of Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
    const headingText = (heading.textContent ?? "").trim();
    for (const link of Array.from(heading.querySelectorAll("a"))) {
      const text = (link.textContent ?? "").trim();
      const isPermalink = PERMALINK_TEXT.test(text) || PERMALINK_CLASS.test(link.getAttribute("class") ?? "") || link.getAttribute("aria-hidden") === "true";
      const id = link.getAttribute("id") ?? link.getAttribute("name");
      if (id && !heading.id) heading.setAttribute("id", id);
      if (isPermalink && text !== headingText) { link.remove(); changed = true; continue; }
      if (text === headingText || text.length >= headingText.length * 0.9) {
        // The heading is the link: keep the words, drop the link.
        link.replaceWith(...Array.from(link.childNodes));
        changed = true;
      }
    }
    for (const icon of Array.from(heading.querySelectorAll("img, svg"))) {
      if ((heading.textContent ?? "").trim().length > 0) { icon.remove(); changed = true; }
    }
  }
  if (changed) rules.push("article.prune.heading-anchors@1");
}

/** The reader shows the title itself; a leading body h1 (or h2) saying the same thing is dropped, and any other h1 becomes an h2. */
function normalizeTitleHeadings(document: Document, title: string | undefined, siteNames: ReadonlySet<string> | undefined, rules: string[]) {
  const wanted = title ? normalizedTitle(title) : "";
  const headings = Array.from(document.querySelectorAll("h1, h2"));
  const leading = headings.slice(0, 3);
  let removedTitle = false;
  for (const heading of leading) {
    const text = normalizedTitle(heading.textContent ?? "");
    if (!text) continue;
    if (!removedTitle && wanted && (text === wanted || wanted.startsWith(text + " ") || text.startsWith(wanted + " "))) {
      heading.remove();
      rules.push("article.prune.duplicate-title@1");
      removedTitle = true;
      continue;
    }
    // "Mitchell Hashimoto" / "The Go Blog" as a heading above the post is the site's masthead.
    if (siteNames && (siteNames.has(text) || [...siteNames].some((name) => name.length >= 6 && text.replace(/[^\p{L}\p{N}]+/gu, "").includes(name.replace(/[^\p{L}\p{N}]+/gu, ""))))) {
      heading.remove();
      rules.push("article.prune.site-heading@1");
    }
  }
  let demoted = false;
  for (const h1 of Array.from(document.querySelectorAll("h1"))) {
    const h2 = document.createElement("h2");
    for (const attribute of Array.from(h1.attributes)) h2.setAttribute(attribute.name, attribute.value);
    h2.append(...Array.from(h1.childNodes));
    h1.replaceWith(h2);
    demoted = true;
  }
  if (demoted) rules.push("article.prune.demote-h1@1");
}

/** Old hand-made pages lay the essay out in a single-column table; the cells become the flow. */
function unwrapLayoutTables(document: Document, rules: string[]) {
  for (let pass = 0; pass < 5; pass += 1) {
    const tables = Array.from(document.querySelectorAll("table")).filter((table) => {
      if (table.querySelector("th, caption")) return false;
      const rows = Array.from(table.querySelectorAll(":scope > tbody > tr, :scope > tr"));
      if (rows.length === 0 || !rows.every((row) => row.children.length === 1 && row.children[0]?.tagName.toLowerCase() === "td")) return false;
      // A one-column table is layout only when it holds prose: long text or block content, not a one-cell data table.
      const text = (table.textContent ?? "").trim();
      return text.length >= 300 || table.querySelector("p, div, h1, h2, h3, h4, br, ul, ol, table, pre, blockquote") !== null;
    });
    if (tables.length === 0) return;
    for (const table of tables) {
      const wrapper = document.createElement("div");
      for (const cell of Array.from(table.querySelectorAll("td"))) wrapper.append(...Array.from(cell.childNodes));
      table.replaceWith(wrapper);
    }
    rules.push("article.prune.layout-table@1");
  }
}

/** Trailing cards, bios and promos: link-dense or promo-worded blocks after the last substantive paragraph. */
/** The element whose children are the article's flow: the body, or the single wrapper (article/div) the extractor kept around it. */
function ownText(element: Element) {
  return Array.from(element.childNodes).filter((node) => node.nodeType === 3).map((node) => node.textContent ?? "").join("").trim();
}

function flowContainer(document: Document): Element | null {
  let container: Element | null = document.body;
  while (container && container.children.length === 1 && ownText(container).length === 0 && /^(article|div|section|main)$/iu.test(container.children[0]!.tagName)) container = container.children[0]!;
  return container;
}

const SEMANTIC_CLASS = /footnote|reference|bibliograph|toc|figure|code|highlight|table|math|katex|caption|gallery|embed|callout|admonition|note|warning|tip/iu;
const MEDIA_TAGS = /^(br|img|picture|figure|svg|video|audio|iframe|canvas|hr|math)$/iu;

/** Presentational wrappers around the flow are unwrapped so leading and trailing chrome becomes visible as plain siblings. */
function flattenWrappers(container: Element) {
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    for (const child of Array.from(container.children)) {
      const tag = child.tagName.toLowerCase();
      if (!/^(div|section|article|header|footer|main)$/u.test(tag)) continue;
      // Only presentational wrappers: anything with a role, an id or a semantic class is meaningful to later steps.
      if (isChromeClass(child) || child.getAttribute("role") || child.id || SEMANTIC_CLASS.test(child.getAttribute("class") ?? "")) continue;
      if (child.children.length === 0 || ownText(child).length > 0) continue;
      const blocks = Array.from(child.children).filter((grandchild) => !MEDIA_TAGS.test(grandchild.tagName));
      if (blocks.length === 0) continue;
      child.replaceWith(...Array.from(child.childNodes));
      changed = true;
    }
    if (!changed) return;
  }
}

/** Nothing but a byline, a date, a read time and separators; a lone short word is not meta. */
function isMetaOnly(text: string, byline: string | undefined) {
  const signal = /(?:19|20)\d{2}|\d+\s*min|\b(?:by|author|published|updated|posted|share|comments?|作者|发表日期|日期)\b/iu.test(text) || (!!byline && text.toLowerCase().includes(byline.toLowerCase()));
  if (!signal) return false;
  let rest = text;
  if (byline) rest = rest.replace(new RegExp(byline.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"), " ");
  rest = rest
    .replace(/(?:19|20)\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/gu, " ")
    .replace(/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/gu, " ")
    .replace(/\b(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\s*/giu, " ")
    .replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(?:19|20)\d{2}/giu, " ")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+(?:19|20)\d{2}/giu, " ")
    .replace(/\b\d+\s*min(?:ute)?s?(?:\s+read)?\b/giu, " ")
    .replace(/\b(?:by|author|written by|posted by|published|updated|posted|on|in|read|share|comments?|作者|发表日期|日期|阅读)\b/giu, " ")
    .replace(/[·•|—–\-:：,.()\s]+/gu, " ")
    .trim();
  return rest.length < 6;
}

/** Meta lines before the first real paragraph: "30 May 2007 — 3 min read — Comments", share rows, link-only crumbs. */
function isChromeClass(element: Element) {
  if (!CHROME_CLASS.test(`${element.getAttribute("class") ?? ""} ${element.id}`)) return false;
  // A "sidebar" or "aside" that carries headings, code or figures is content the author placed there.
  return element.querySelector("h1, h2, h3, pre, table, figure, blockquote") === null;
}

function trimPromoHead(document: Document, byline: string | undefined, rules: string[]) {
  const container = flowContainer(document);
  if (!container) return;
  flattenWrappers(container);
  const bylineText = byline?.replace(/\s+/gu, " ").trim().toLowerCase();
  let removed = 0;
  while (container.firstElementChild) {
    const element = container.firstElementChild;
    const text = (element.textContent ?? "").replace(/\s+/gu, " ").trim();
    const tag = element.tagName.toLowerCase();
    if (MEDIA_TAGS.test(tag) && tag !== "hr") break;
    if (tag === "hr" || (text.length === 0 && !element.querySelector("img, picture, svg, video, iframe"))) { element.remove(); continue; }
    if (/^h[1-6]$/u.test(tag) && !TOC_HEADING.test(text)) break;
    if (tag === "details" && TOC_HEADING.test((element.querySelector("summary")?.textContent ?? "").trim())) { element.remove(); removed += 1; continue; }
    if (isStructural(element)) break;
    const lower = text.toLowerCase();
    const repeatsByline = !!bylineText && (lower === bylineText || lower === `by ${bylineText}` || lower.replace(/^(作者|by|author)[\s:：]*/u, "") === bylineText);
    const toc = TOC_HEADING.test(text) && isTocPart((element as El).nextElementSibling);
    const chrome =
      (text.length < 160 && (linkDensity(element) >= 0.5 || META_LINE.test(text) || /^(home|menu|blog|articles)\b/iu.test(text))) ||
      (text.length < 60 && DATE_LINE.test(stripDateLabel(text))) ||
      repeatsByline ||
      (text.length < 200 && isMetaOnly(text, byline)) ||
      (text.length < 300 && isChromeClass(element)) ||
      toc;
    if (!chrome) break;
    element.remove();
    if (toc) removeFollowingParts(container.firstElementChild, isTocPart);
    removed += 1;
  }
  if (removed > 0) rules.push("article.prune.leading-meta@1");
}

/** `<a name>` without an href is a target, not a link; later steps treat a bare anchor as a broken link and split around it. */
function anchorsToTargets(document: Document, rules: string[]) {
  let changed = false;
  for (const anchor of Array.from(document.querySelectorAll("a:not([href])"))) {
    const span = document.createElement("span");
    const id = anchor.getAttribute("id") ?? anchor.getAttribute("name");
    if (id) span.setAttribute("id", id);
    while (anchor.firstChild) span.append(anchor.firstChild);
    anchor.replaceWith(span);
    changed = true;
  }
  if (changed) rules.push("article.prune.anchor-targets@1");
}

/** A blockquote that only wraps code is a styling habit (Movable Type, some Markdown themes): the code stands on its own. */
function unwrapCodeBlockquotes(document: Document, rules: string[]) {
  let changed = false;
  for (const quote of Array.from(document.querySelectorAll("blockquote"))) {
    const children = Array.from(quote.children);
    if (children.length === 0 || !children.every((child) => child.tagName.toLowerCase() === "pre")) continue;
    if ((quote.textContent ?? "").trim() !== children.map((child) => (child.textContent ?? "").trim()).join("").trim()) continue;
    quote.replaceWith(...children);
    changed = true;
  }
  if (changed) rules.push("article.prune.code-blockquote@1");
}

/** Footnote back-references (↩) are navigation the reader provides itself; left in, they become one-line paragraphs. */
function removeFootnoteBackrefs(document: Document, rules: string[]) {
  let changed = false;
  for (const link of Array.from(document.querySelectorAll("a[href*='#fnref'], a.footnote-backref, a.reversefootnote, a[role='doc-backlink'], a[rel='footnote-backref']"))) {
    if (!/^[\s↩↵⤴^↑]*︎?$/u.test((link.textContent ?? "").trim())) continue;
    const parent = link.parentElement;
    link.remove();
    if (parent && (parent.textContent ?? "").trim().length === 0 && parent.querySelector("img, pre, table") === null) parent.remove();
    changed = true;
  }
  if (changed) rules.push("article.prune.footnote-backrefs@1");
}

/** Obsolete presentational wrappers hide paragraph structure from every later step. */
function unwrapFontTags(document: Document, rules: string[]) {
  const fonts = Array.from(document.querySelectorAll("font, center"));
  for (const font of fonts) {
    // Moved one node at a time: linkedom's replaceWith drops the children of an attribute-less <font> inside a link.
    const parent = font.parentNode;
    if (!parent) continue;
    while (font.firstChild) parent.insertBefore(font.firstChild, font);
    font.remove();
  }
  if (fonts.length) rules.push("article.prune.unwrap-font@1");
}

function stripDateLabel(text: string) {
  return text.replace(/^(发表日期|发布日期|日期|date|published( on)?|updated( on)?|posted( on)?)[\s:：]*/iu, "");
}

function trimPromoTail(document: Document, rules: string[]) {
  const body = flowContainer(document);
  if (!body) return;
  flattenWrappers(body);
  const total = (body.textContent ?? "").trim().length;
  let removedText = 0;
  let removed = 0;
  while (body.lastElementChild) {
    const element = body.lastElementChild;
    const text = (element.textContent ?? "").replace(/\s+/gu, " ").trim();
    const tag = element.tagName.toLowerCase();
    if (MEDIA_TAGS.test(tag) && tag !== "hr") break;
    if (tag === "hr" || (text.length === 0 && !element.querySelector("img, picture, svg, video, iframe"))) { element.remove(); continue; }
    // "Here's another article just for you:" — a lead-in whose cards were already removed.
    const leadIn = removed > 0 && text.length < 120 && (/[:：]$/u.test(text) || (text.length < 40 && !/[.!?。！？]/u.test(text) && linksWithin(element).length === 0 && !/^h[1-6]$/u.test(tag)));
    // A link list under "References" / "Notes" is content, and so is everything before it.
    const previous = (element as El).previousElementSibling;
    if ((tag === "ul" || tag === "ol") && previous && /^h[1-6]$/u.test(previous.tagName.toLowerCase()) && /references|bibliography|notes|footnotes|sources|citations|acknowledg|links|resources|参考|链接|引用|注释|脚注|文献/iu.test(previous.textContent ?? "")) break;
    if (isStructural(element)) break;
    const cards = linksWithin(element).filter((link) => link.querySelector("img, picture, svg")).length;
    const chrome =
      leadIn ||
      isLinkCardList(element) ||
      (linkDensity(element) >= 0.5 && text.length < 600) ||
      (cards >= 2 && text.length < 400) ||
      (PROMO_TEXT.test(text) && text.length < 600) ||
      (text.length < 60 && DATE_LINE.test(stripDateLabel(text))) ||
      (text.length < 200 && isMetaOnly(text, undefined)) ||
      (text.length < 300 && isChromeClass(element)) ||
      (/^h[1-6]$/u.test(tag) && TRAILING_CHROME_HEADING.test(text));
    if (!chrome) break;
    if (total > 0 && (removedText + text.length) / total > MAX_TAIL_TRIM_RATIO) break;
    removedText += text.length;
    element.remove();
    removed += 1;
  }
  // A heading whose section was just removed has nothing left to head.
  const last = body.lastElementChild;
  if (removed > 0 && last && /^h[1-6]$/iu.test(last.tagName)) { last.remove(); }
  if (removed > 0) rules.push("article.prune.trailing-cards@1");
}

export function pruneArticleChrome(html: string, options: PruneOptions = {}): PrunedArticle {
  if (html.length > MAX_HTML_BYTES) return { content: html, rulesApplied: [] };
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const rules: string[] = [];
  const doc = document as unknown as Document;
  unwrapFontTags(doc, rules);
  anchorsToTargets(doc, rules);
  unwrapCodeBlockquotes(doc, rules);
  removeFootnoteBackrefs(doc, rules);
  unwrapLayoutTables(doc, rules);
  cleanHeadings(doc, rules);
  normalizeTitleHeadings(doc, options.title, options.siteNames, rules);
  removeTableOfContents(doc, rules);
  removeNavigationLists(doc, rules);
  removeTrailingChrome(doc, rules);
  trimPromoTail(doc, rules);
  trimPromoHead(doc, options.byline, rules);
  if (rules.length === 0) return { content: html, rulesApplied: [] };
  return { content: (document.body as unknown as Element).innerHTML, rulesApplied: rules };
}
