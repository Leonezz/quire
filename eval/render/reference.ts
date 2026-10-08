// The original page as a reader would have seen it without JavaScript: the snapshot HTML with a
// <base> pointing at the page's final URL so relative CSS and images load from the origin.

const HEAD_OPEN = /<head(?=[\s>/])[^>]*>/i;
const HTML_OPEN = /<html(?=[\s>])[^>]*>/i;
const DOCTYPE = /^\s*<!doctype[^>]*>/i;
const BASE_TAG = /<base\b[^>]*>/gi;
const HREF_ATTR = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** The href of the page's own first <base href>, resolved against finalUrl, if it has a usable one. */
function existingBase(html: string, finalUrl: string): string | undefined {
  for (const tag of html.match(BASE_TAG) ?? []) {
    const match = HREF_ATTR.exec(tag);
    const raw = match ? (match[1] ?? match[2] ?? match[3] ?? "") : undefined;
    if (raw === undefined || raw.trim() === "") continue;
    try { return new URL(raw.trim(), finalUrl).href; } catch { return undefined; }
  }
  return undefined;
}

/**
 * Puts `<base href>` first in <head> (creating <head> when there is none). A base the page declares
 * itself is resolved against finalUrl and replaces it, so the page's relative URLs mean what they meant.
 */
export function injectBase(html: string, finalUrl: string): string {
  const href = existingBase(html, finalUrl) ?? finalUrl;
  const tag = `<base href="${escapeAttribute(href)}">`;
  const stripped = html.replace(BASE_TAG, "");
  const head = HEAD_OPEN.exec(stripped);
  if (head) return stripped.slice(0, head.index + head[0].length) + tag + stripped.slice(head.index + head[0].length);
  const root = HTML_OPEN.exec(stripped);
  if (root) return stripped.slice(0, root.index + root[0].length) + `<head>${tag}</head>` + stripped.slice(root.index + root[0].length);
  const doctype = DOCTYPE.exec(stripped);
  const at = doctype ? doctype[0].length : 0;
  return `${stripped.slice(0, at)}<head>${tag}</head>${stripped.slice(at)}`;
}
