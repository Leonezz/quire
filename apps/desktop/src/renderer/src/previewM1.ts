import type { ItemRecord, MaterialRecord, MaterialSummary, OpenUrlResult, ReadApiM1, ReadingEvent, ReadingStats, SearchHit, SourceRecord } from "../../shared/contracts";
import { isArxivCategory } from "./format";

// The M1 half of the browser preview: two sources and a handful of items seeded into
// localStorage on first use, so decisions, queue order and reading events survive reloads.
// Anything that needs the network (subscribing, syncing) reports itself unavailable.

const STORAGE_KEY = "read:preview-m1";
const PREVIEW_CODE = "PREVIEW_MODE";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface PreviewState { sources: SourceRecord[]; items: ItemRecord[]; events: ReadingEvent[] }

const feedId = "src-srw";
const arxivId = "src-arxiv-cs-cl";

function seed(now: number): PreviewState {
  const at = (ms: number) => new Date(now - ms).toISOString();
  type Origin = Pick<ItemRecord, "sourceTitle" | "sourceKind"> & { id: string };
  const feed: Origin = { id: feedId, sourceTitle: "Systems Research Weekly", sourceKind: "feed" };
  const arxiv: Origin = { id: arxivId, sourceTitle: "arXiv cs.CL", sourceKind: "arxiv" };
  const item = (id: string, src: Origin, title: string, gist: string, link: string, publishedMs: number, readingMinutes: number, signals: ItemRecord["signals"], extra: Partial<ItemRecord> = {}): ItemRecord => ({
    id, sourceId: src.id, sourceTitle: src.sourceTitle, sourceKind: src.sourceKind, title, gist, link, publishedAt: at(publishedMs), fetchedAt: at(Math.max(0, publishedMs - HOUR)), readingMinutes, signals, summaryOnly: false, ...extra,
  });
  return {
    sources: [
      { id: feedId, kind: "feed", locator: "https://systemsresearch.weekly/feed.xml", title: "Systems Research Weekly", siteUrl: "https://systemsresearch.weekly", addedAt: at(30 * DAY), intervalMinutes: 60, lastSyncAt: at(2 * HOUR), lastSuccessAt: at(2 * HOUR), failureCount: 0, itemCount: 41, keptCount: 9, weeklyRate: 3.2 },
      { id: arxivId, kind: "arxiv", locator: "cs.CL", title: "arXiv cs.CL", addedAt: at(12 * DAY), intervalMinutes: 360, lastSyncAt: at(20 * 60_000), lastSuccessAt: at(20 * 60_000), failureCount: 0, itemCount: 612, keptCount: 12, weeklyRate: 184 },
    ],
    items: [
      item("it-1", feed, "CSS Custom Highlight API", "Style ranges of text without touching the DOM: the Highlight registry, ::highlight() pseudo-elements, and where the API still bites in Safari.", "https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API", 2 * HOUR, 8, { code: true }, { materialId: "526130b61f003c33" }),
      item("it-2", arxiv, "Attention Is All You Need", "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.", "https://arxiv.org/abs/1706.03762", 3 * HOUR, 22, { math: true, figures: true }, { materialId: "5f725f31pdf00001" }),
      item("it-3", feed, "Evaluation harnesses in the wild", "Nine public harnesses and the assumptions each bakes in; most leak the test set through the prompt template.", "https://systemsresearch.weekly/2026/harnesses", 5 * HOUR, 8, { code: true }),
      item("it-4", arxiv, "Position bias in retrieval-augmented evaluation", "We measure how passage order shifts judged answer quality across 12 models and propose a debiasing protocol.", "https://arxiv.org/abs/2609.01234", 7 * HOUR, 19, { math: true, figures: true }),
      item("it-5", feed, "Bluesky's Firehose, one year in", "Only the feed summary is available; the full text is fetched when you open it.", "https://systemsresearch.weekly/2026/firehose", DAY + 3 * HOUR, 4, {}, { summaryOnly: true }),
      item("it-6", arxiv, "动量的新理解：逼近特征层面的梯度下降", "把动量看成对特征空间梯度的近似，可以解释为什么它在宽网络上更稳。", "https://arxiv.org/abs/2609.02345", DAY + 6 * HOUR, 14, { math: true, lang: "zh" }),
      item("it-7", feed, "The evaluation harness I actually use", "Notes from a year of benchmarks: one script, one JSONL, one plot per claim.", "https://systemsresearch.weekly/2026/harness-i-use", 3 * DAY + 2 * HOUR, 6, { code: true }),
      item("it-8", arxiv, "Why long-context models still need retrieval", "Cost, latency, and the failure modes that a bigger window does not fix.", "https://arxiv.org/abs/2608.09876", 6 * DAY + 4 * HOUR, 11, { figures: true }),
    ],
    events: [],
  };
}

function load(): PreviewState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try { return JSON.parse(raw) as PreviewState; }
    catch (error) { throw new Error(`Preview M1 state unreadable (${(error as Error).message}); clear localStorage key ${STORAGE_KEY}.`); }
  }
  const fresh = seed(Date.now());
  save(fresh);
  return fresh;
}
function save(state: PreviewState) { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function update(mutate: (state: PreviewState) => PreviewState): PreviewState { const next = mutate(load()); save(next); return next; }

const listeners = new Set<() => void>();
function notify() { for (const listener of listeners) listener(); }

const undecided = (item: ItemRecord) => !item.openedAt && !item.queuedAt && !item.dismissedAt && !item.keptAt;
const byNewest = (a: ItemRecord, b: ItemRecord) => b.publishedAt.localeCompare(a.publishedAt);
const byQueue = (a: ItemRecord, b: ItemRecord) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0);
const newId = () => `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function requireItem(state: PreviewState, id: string): ItemRecord {
  const item = state.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`No item ${id} in the preview inbox.`);
  return item;
}
function requireSource(state: PreviewState, id: string): SourceRecord {
  const source = state.sources.find((candidate) => candidate.id === id);
  if (!source) throw new Error(`No source ${id} in the preview.`);
  return source;
}

/** Monday 00:00 local of the week containing `at`. */
function isoWeekStart(at: number): number {
  const date = new Date(at); date.setHours(0, 0, 0, 0);
  const weekday = (date.getDay() + 6) % 7;
  return date.getTime() - weekday * DAY;
}

function matches(query: string, haystack: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = haystack.toLowerCase();
  return words.length > 0 && words.every((word) => text.includes(word));
}

/**
 * M3's keep, on M1's items: an Inbox / Queue item backed by a sample material is marked kept
 * (decided, like opened) and a "kept" event recorded; queued items stay queued. Anything else
 * would need the engine to fetch.
 */
export async function keepPreviewItem(id: string, getMaterial: (id: string) => Promise<MaterialRecord | undefined>): Promise<OpenUrlResult> {
  const item = requireItem(load(), id);
  const material = item.materialId ? await getMaterial(item.materialId) : undefined;
  if (!material) return { ok: false, code: PREVIEW_CODE, message: "Keeping an item fetches its full text, which needs the engine. Run the desktop app; in the preview only the two items backed by sample materials can be kept." };
  const now = new Date().toISOString();
  update((current) => ({ ...current, items: current.items.map((candidate) => (candidate.id === id ? { ...candidate, keptAt: candidate.keptAt ?? now, materialId: material.id } : candidate)), events: [...current.events, { id: newId(), kind: "kept", ref: material.id, at: now }] }));
  notify();
  return { ok: true, material };
}

export function createPreviewM1(deps: { getMaterial: (id: string) => Promise<MaterialRecord | undefined>; listMaterials: () => Promise<MaterialSummary[]> }): ReadApiM1 {
  return {
    detectSource: async (input) => {
      const value = input.trim();
      if (isArxivCategory(value)) return { kind: "arxiv", category: value, title: `arXiv ${value}` };
      return { kind: "page", url: value };
    },
    addSource: async (input) => ({ ok: false, code: PREVIEW_CODE, message: `Subscribing to "${input.trim()}" needs the engine. Run the desktop app to add sources; the browser preview ships two seeded ones.` }),
    listSources: async () => load().sources,
    syncSource: async (id) => ({ ok: false, code: PREVIEW_CODE, message: "Syncing needs the engine. Run the desktop app to fetch new items.", source: requireSource(load(), id) }),
    syncAllSources: async () => undefined,
    pauseSource: async (id, paused) => {
      const state = update((current) => ({ ...current, sources: current.sources.map((source) => {
        if (source.id !== id) return source;
        const { pausedAt: _dropped, ...rest } = source;
        return paused ? { ...rest, pausedAt: new Date().toISOString() } : rest;
      }) }));
      notify();
      return requireSource(state, id);
    },
    removeSource: async (id) => {
      update((current) => { requireSource(current, id); return { ...current, sources: current.sources.filter((source) => source.id !== id), items: current.items.filter((item) => item.sourceId !== id || !undecided(item)) }; });
      notify();
    },
    onSourcesChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },

    listInbox: async () => load().items.filter(undecided).sort(byNewest),
    listQueue: async () => load().items.filter((item) => item.queuedAt && !item.dismissedAt).sort(byQueue),
    getItem: async (id) => load().items.find((item) => item.id === id),
    readItem: async (id) => {
      const item = requireItem(load(), id);
      const material = item.materialId ? await deps.getMaterial(item.materialId) : undefined;
      if (!material) return { ok: false, code: PREVIEW_CODE, message: "Fetching the full text needs the engine. Run the desktop app to read this item; in the preview only the two items backed by sample materials open." };
      const now = new Date().toISOString();
      update((current) => ({ ...current, items: current.items.map((candidate) => (candidate.id === id ? { ...candidate, openedAt: candidate.openedAt ?? now } : candidate)), events: [...current.events, { id: newId(), kind: "opened", ref: id, at: now }] }));
      notify();
      return { ok: true, material };
    },
    decideItem: async (id, decision) => {
      const now = new Date().toISOString();
      const state = update((current) => {
        const item = requireItem(current, id);
        const { queuedAt: _q, queuePosition: _p, dismissedAt: _d, ...bare } = item;
        const queueEnd = Math.max(-1, ...current.items.filter((candidate) => candidate.queuedAt && candidate.id !== id).map((candidate) => candidate.queuePosition ?? 0)) + 1;
        const next: ItemRecord =
          decision === "queue" ? { ...bare, queuedAt: now, queuePosition: queueEnd }
          : decision === "dismiss" ? { ...bare, dismissedAt: now }
          : bare;
        const event: ReadingEvent | undefined = decision === "queue" ? { id: newId(), kind: "queued", ref: id, at: now } : decision === "dismiss" ? { id: newId(), kind: "dismissed", ref: id, at: now } : undefined;
        return { ...current, items: current.items.map((candidate) => (candidate.id === id ? next : candidate)), events: event ? [...current.events, event] : current.events };
      });
      notify();
      return requireItem(state, id);
    },
    reorderQueue: async (ids) => {
      update((current) => {
        const queued = current.items.filter((item) => item.queuedAt).map((item) => item.id);
        const missing = queued.filter((id) => !ids.includes(id));
        if (missing.length || ids.length !== queued.length) throw new Error(`The new order must list every queued item exactly once (${missing.length} missing).`);
        return { ...current, items: current.items.map((item) => (item.queuedAt ? { ...item, queuePosition: ids.indexOf(item.id) } : item)) };
      });
      notify();
    },

    recordReadingEvent: async (kind, ref) => {
      const event: ReadingEvent = { id: newId(), kind, ref, at: new Date().toISOString() };
      update((current) => ({ ...current, events: [...current.events, event], items: kind === "finished" ? current.items.map((item) => (item.materialId === ref ? { ...item, finishedAt: event.at } : item)) : current.items }));
      return event;
    },
    readingStats: async (): Promise<ReadingStats> => {
      const now = Date.now();
      const thisWeek = isoWeekStart(now);
      const lastWeek = thisWeek - 7 * DAY;
      const events = load().events;
      const within = (kind: ReadingEvent["kind"], from: number, to: number) => new Set(events.filter((event) => event.kind === kind && new Date(event.at).getTime() >= from && new Date(event.at).getTime() < to).map((event) => event.ref)).size;
      return { weekStart: new Date(thisWeek).toISOString(), finishedThisWeek: within("finished", thisWeek, Infinity), finishedLastWeek: within("finished", lastWeek, thisWeek), openedThisWeek: within("opened", thisWeek, Infinity) };
    },

    search: async (query) => {
      if (!query.trim()) return [];
      const materials = await deps.listMaterials();
      const materialHits: SearchHit[] = materials
        .filter((material) => matches(query, `${material.title} ${material.byline ?? ""} ${material.url}`))
        .map((material) => ({ kind: "material", id: material.id, title: material.title, subtitle: [material.origin === "file" ? "Local file" : new URL(material.url).hostname, material.publishedAt ? new Date(material.publishedAt).toLocaleDateString() : undefined].filter(Boolean).join(" · ") }));
      const itemHits: SearchHit[] = load().items
        .filter((item) => matches(query, `${item.title} ${item.sourceTitle}`))
        .map((item) => ({ kind: "item", id: item.id, title: item.title, subtitle: `${item.sourceTitle} · ${new Date(item.publishedAt).toLocaleDateString()}` }));
      return [...materialHits, ...itemHits].slice(0, 50);
    },
  };
}
