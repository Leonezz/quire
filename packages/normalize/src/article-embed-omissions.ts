import { parseHTML } from "linkedom";

import { embedSourceUrl, isInteractivePlaceholder, isNoiseEmbed } from "./embedded-media";

/**
 * Embeds the extractor dropped. The reader reports the players and widgets it has to drop itself, but
 * Defuddle and Readability remove empty and unknown ones (a src-less iframe, a source-less audio) before it
 * sees them. An embed of the extractor's input whose text on both sides reached the extracted content sat
 * inside the article; when the content has nothing like it (same tag and URL), it was lost there. Embeds
 * outside the kept text (sidebars, comment sections, a newsletter box after the post) are not counted:
 * leaving those out is the extractor's job.
 */
export type EmbedSite = Readonly<{
  /** The tag and the URL the embed loads ("" when it has none); a placeholder's is "a" and its link. */
  key: string;
  /** The start of the nearest text block before and after it, "" when there is none. */
  before: string;
  after: string;
}>;

const EMBEDS = "iframe, video, audio, embed, object";
/** What the extractors drop with its wrapper, never as article content: a lazy loader's noscript copy, templates, hidden subtrees. */
const NOT_EXTRACTED = "noscript, template, [hidden]";
const TEXT_BLOCKS = "p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, pre, dt, dd, td, th";
const ANCHOR_CHARS = 100;

const flat = (text: string | null | undefined) => (text ?? "").replace(/\s+/gu, " ").trim();

function keyOf(element: Element, baseUri: string | undefined) {
  const tag = element.tagName.toLowerCase();
  if (tag !== "a") return `${tag} ${embedSourceUrl(element, baseUri)?.href ?? ""}`;
  const href = element.getAttribute("href") ?? "";
  // Placeholders link absolute URLs; a page's own link that merely reads like one keys by what it says.
  return `a ${URL.canParse(href, baseUri) ? new URL(href, baseUri).href : href}`;
}

/**
 * The start of the nearest text block from `start` in `step` direction, leaving out the one the embed sits in,
 * fallback content inside any embed (a browser never shows it) and text the extractors never keep.
 */
function anchorText(nodes: readonly Element[], start: number, step: 1 | -1, embed: Element) {
  for (let index = start; index >= 0 && index < nodes.length; index += step) {
    const node = nodes[index] as Element;
    if (!node.matches(TEXT_BLOCKS) || node.closest(`${EMBEDS}, ${NOT_EXTRACTED}`) || node.contains(embed)) continue;
    const text = flat(node.textContent);
    if (text) return text.slice(0, ANCHOR_CHARS);
  }
  return "";
}

/** The embeds (and interactive placeholders) under `root` that are article content, with the text around each. */
export function embedSites(root: Element, baseUri: string | undefined): EmbedSite[] {
  const nodes = Array.from(root.querySelectorAll(`${EMBEDS}, ${TEXT_BLOCKS}, a`));
  const isSite = (node: Element) =>
    !node.closest(NOT_EXTRACTED) &&
    (isInteractivePlaceholder(node) ||
      (node.matches(EMBEDS) && !node.parentElement?.closest(EMBEDS) && !isNoiseEmbed(node, baseUri)));
  return nodes.flatMap((node, index) => isSite(node)
    ? [{ after: anchorText(nodes, index + 1, 1, node), before: anchorText(nodes, index - 1, -1, node), key: keyOf(node, baseUri) }]
    : []);
}

/** How many of the sites sat between text the extracted content kept and have nothing like them in it. */
export function droppedEmbedCount(sites: readonly EmbedSite[], content: string, baseUri: string | undefined) {
  const enclosed = sites.filter((site) => site.before && site.after);
  if (enclosed.length === 0) return 0;
  const body = parseHTML(`<html><body>${content}</body></html>`).document.body as unknown as Element;
  const text = flat(body.textContent);
  // Each embed of the content stands for one site.
  const kept = new Map<string, number>();
  for (const node of Array.from(body.querySelectorAll(`${EMBEDS}, a`))) {
    if (node.tagName.toLowerCase() === "a" && !isInteractivePlaceholder(node)) continue;
    const key = keyOf(node, baseUri);
    kept.set(key, (kept.get(key) ?? 0) + 1);
  }
  let dropped = 0;
  for (const site of enclosed) {
    if (!text.includes(site.before) || !text.includes(site.after)) continue;
    const left = kept.get(site.key) ?? 0;
    if (left > 0) kept.set(site.key, left - 1);
    else dropped += 1;
  }
  return dropped;
}
