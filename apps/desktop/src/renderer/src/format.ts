import type { ItemSignals, SourceRecord } from "../../shared/contracts";

/** "09:12" — the time of day, for rows grouped by day. */
export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", or the date beyond a week. */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}

const dayMs = 86_400_000;
function startOfDay(at: number): number { const date = new Date(at); date.setHours(0, 0, 0, 0); return date.getTime(); }

/** "Today", "Yesterday", the weekday within a week, the date beyond. */
export function dayLabel(iso: string, now = Date.now()): string {
  const day = startOfDay(new Date(iso).getTime());
  const today = startOfDay(now);
  const diff = Math.round((today - day) / dayMs);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return new Date(iso).toLocaleDateString(undefined, { weekday: "long" });
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

export function signalsOf(signals: ItemSignals): string[] {
  const out: string[] = [];
  if (signals.code) out.push("code");
  if (signals.math) out.push("math");
  if (signals.figures) out.push("figures");
  if (signals.lang) out.push(signals.lang);
  return out;
}

export function sourceKindLabel(kind: SourceRecord["kind"]): string { return kind === "arxiv" ? "arXiv" : "feed"; }

/** The host of a feed URL, or the arXiv category. */
export function sourceLocatorLabel(source: SourceRecord): string {
  if (source.kind === "arxiv") return source.locator;
  try { return new URL(source.locator).hostname; } catch { return source.locator; }
}

export function weeklyRateLabel(rate: number): string { return `~${rate < 1 ? rate.toFixed(1) : Math.round(rate)} / week`; }

export type SourceHealth = { tone: "ok" | "paused" | "failing"; text: string };
export function sourceHealth(source: SourceRecord, now = Date.now()): SourceHealth {
  if (source.pausedAt) return { tone: "paused", text: "paused" };
  if (source.failureCount > 0) return { tone: "failing", text: source.lastError ?? `${source.failureCount} failed syncs` };
  const stale = source.lastSuccessAt ? now - new Date(source.lastSuccessAt).getTime() > 3 * source.intervalMinutes * 60_000 : true;
  return { tone: "ok", text: stale ? (source.lastSuccessAt ? "waiting for the next sync" : "not synced yet") : "healthy" };
}

/** At most `max` characters, ending in an ellipsis when cut; whitespace collapsed. */
export function truncate(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Everything that is neither a text field nor a control: where list shortcuts apply. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") !== null;
}

const ARXIV_ARCHIVES = ["astro-ph", "cond-mat", "cs", "econ", "eess", "gr-qc", "hep-ex", "hep-lat", "hep-ph", "hep-th", "math", "math-ph", "nlin", "nucl-ex", "nucl-th", "physics", "q-bio", "q-fin", "quant-ph", "stat"];
const ARXIV_CATEGORY = /^([a-z-]+)(\.[A-Z]{2})?$/;

/** "cs.CL", "stat.ML", "hep-th": an arXiv category, recognised without the network. */
export function isArxivCategory(input: string): boolean {
  const match = ARXIV_CATEGORY.exec(input.trim());
  return match !== null && ARXIV_ARCHIVES.includes(match[1] ?? "");
}
