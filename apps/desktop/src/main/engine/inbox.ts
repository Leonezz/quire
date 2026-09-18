import type { ItemRecord, OpenUrlResult } from "../../shared/contracts";
import { arxivHtmlUrl, arxivIdOf, arxivPdfUrl } from "./arxiv";
import type { EventStore } from "./events";
import type { ItemStore } from "./items";
import type { MaterialStore } from "./materials";

export interface ReadItemDeps {
  items: ItemStore;
  events: EventStore;
  store: MaterialStore;
  /** Called when the item became a new material (the library changed). */
  onMaterialized?: () => void;
  /** A fallback is never silent: the reason the page could not be fetched lands here. */
  warn: (message: string) => void;
}

async function materializeArxiv(item: ItemRecord, store: MaterialStore): Promise<OpenUrlResult> {
  const id = arxivIdOf(item.link);
  if (!id) return { ok: false, code: "ARXIV_ID_INVALID", message: `Not an arXiv link: ${item.link}` };
  const html = await store.openUrl(arxivHtmlUrl(id), "feed");
  if (html.ok) return html;
  const pdf = await store.openUrl(arxivPdfUrl(id), "feed");
  if (pdf.ok) return pdf;
  return { ok: false, code: pdf.code, message: `Neither the HTML rendering (${html.message}) nor the PDF (${pdf.message}) of ${id} could be read.` };
}

async function materializeFeedItem(item: ItemRecord, deps: ReadItemDeps): Promise<OpenUrlResult> {
  const page = await deps.store.openUrl(item.link, "feed");
  if (page.ok) return page;
  const content = deps.items.content(item.id);
  if (!content) return page;
  deps.warn(`Could not fetch ${item.link} (${page.code}: ${page.message}); showing the feed's copy.`);
  const material = await deps.store.saveFromFeed({
    url: item.link, title: item.title, publishedAt: item.publishedAt, content,
    ...(item.signals.lang ? { lang: item.signals.lang } : {}),
  });
  return { ok: true, material };
}

/**
 * Read now. An item already read returns its material; otherwise the link is materialized
 * (arXiv: HTML rendering first, then the PDF; feeds: the page, then the feed's own copy).
 */
export async function readItem(id: string, deps: ReadItemDeps): Promise<OpenUrlResult> {
  const item = deps.items.get(id);
  if (!item) return { ok: false, code: "ITEM_NOT_FOUND", message: "This item is no longer in the library." };
  if (item.materialId) {
    const existing = await deps.store.get(item.materialId);
    if (existing) {
      deps.events.record("opened", id);
      return { ok: true, material: existing };
    }
  }
  const result = item.sourceKind === "arxiv" ? await materializeArxiv(item, deps.store) : await materializeFeedItem(item, deps);
  if (!result.ok) return result;
  deps.items.markOpened(id, result.material.id);
  deps.events.record("opened", id);
  deps.onMaterialized?.();
  return result;
}
