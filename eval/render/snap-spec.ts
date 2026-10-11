// Pure helpers of render/snap.mjs: the spec format, needle normalization and the crop window.

/** Curly and prime quotes count as their straight forms when matching a needle. */
export const QUOTE_MAP: Readonly<Record<string, string>> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
};

/** Whitespace removed, quotes straightened: the form both the needle and the page text are compared in. */
export function normalizeText(text: string): string {
  let out = "";
  for (const char of text) {
    if (/\s/u.test(char)) continue;
    out += QUOTE_MAP[char] ?? char;
  }
  return out;
}

/**
 * wide: crop the reference at the full viewport width even when an article/main column holds the match.
 * highlight: a CSS selector whose elements get a dashed outline in the crop (e.g. an embed that renders blank).
 */
export interface Locator { text: string; before: number; after: number; nth: number; wide: boolean; highlight?: string }
export interface SnapEntry { id: string; slug: string; caption: string; reader: Locator | null; reference: Locator | null }

const DEFAULT_BEFORE = 250;
const DEFAULT_AFTER = 650;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function pixels(where: string, name: string, raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 20_000) throw new Error(`${where}.${name} must be an integer between 0 and 20000, got ${JSON.stringify(raw)}`);
  return raw;
}

function parseLocator(where: string, raw: unknown): Locator | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") throw new Error(`${where} must be null or { text, before?, after?, nth?, wide?, highlight? }`);
  const record = raw as Record<string, unknown>;
  if (typeof record.text !== "string" || !normalizeText(record.text)) throw new Error(`${where}.text must be a non-blank string`);
  const nth = record.nth === undefined ? 1 : record.nth;
  if (typeof nth !== "number" || !Number.isInteger(nth) || nth < 1) throw new Error(`${where}.nth must be a positive integer, got ${JSON.stringify(record.nth)}`);
  if (record.wide !== undefined && typeof record.wide !== "boolean") throw new Error(`${where}.wide must be a boolean`);
  if (record.highlight !== undefined && (typeof record.highlight !== "string" || !record.highlight.trim())) throw new Error(`${where}.highlight must be a non-blank CSS selector`);
  const locator: Locator = { text: record.text, before: pixels(where, "before", record.before, DEFAULT_BEFORE), after: pixels(where, "after", record.after, DEFAULT_AFTER), nth, wide: record.wide === true };
  return record.highlight === undefined ? locator : { ...locator, highlight: record.highlight as string };
}

/** Validates a spec file's content: an array of entries (or { entries: [...] }). Throws naming the bad field. */
export function parseSpec(raw: unknown): SnapEntry[] {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? (raw as { entries?: unknown }).entries : undefined);
  if (!Array.isArray(list) || !list.length) throw new Error("the spec must be a non-empty array of entries (or { entries: [...] })");
  const seen = new Set<string>();
  return list.map((item, index) => {
    const where = `entries[${index}]`;
    if (!item || typeof item !== "object") throw new Error(`${where} must be an object`);
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !ID_PATTERN.test(record.id)) throw new Error(`${where}.id must be a file-safe name, got ${JSON.stringify(record.id)}`);
    if (seen.has(record.id)) throw new Error(`${where}.id "${record.id}" is used twice`);
    seen.add(record.id);
    if (typeof record.slug !== "string" || !record.slug) throw new Error(`${where}.slug must be a corpus slug`);
    const caption = typeof record.caption === "string" ? record.caption : "";
    if (!("reader" in record) || !("reference" in record)) throw new Error(`${where} needs both reader and reference (either may be null)`);
    const reader = parseLocator(`${where}.reader`, record.reader);
    const reference = parseLocator(`${where}.reference`, record.reference);
    if (!reader && !reference) throw new Error(`${where}: reader and reference are both null`);
    return { id: record.id, slug: record.slug, caption, reader, reference };
  });
}

/** The vertical crop [top - before, top + after], kept inside the page. */
export function cropWindow(top: number, locator: Pick<Locator, "before" | "after">, pageHeight: number): { y: number; height: number } {
  const y = Math.max(0, Math.floor(top - locator.before));
  const bottom = Math.min(Math.ceil(pageHeight), Math.ceil(top + locator.after));
  return { y, height: Math.max(1, bottom - y) };
}
