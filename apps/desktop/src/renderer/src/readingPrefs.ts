import { useCallback, useSyncExternalStore } from "react";
import { read } from "./api";

// Reading settings are global: one set of values for every material. They live in localStorage
// and in a tiny store here, so the Aa popover in a reader and the Settings sheet in the shell
// edit the same values and every open reader follows at once.
export type ReadingPrefs = {
  font: "sans" | "serif" | "mono";
  size: 16 | 17 | 18 | 19 | 20 | 22;
  measure: "narrow" | "normal" | "wide";
  lineHeight: "tight" | "comfortable" | "loose";
  theme: "system" | "light" | "dark" | "sepia";
  justify: boolean;
  focus: boolean;
};

export const DEFAULT_PREFS: ReadingPrefs = { font: "sans", size: 18, measure: "normal", lineHeight: "comfortable", theme: "system", justify: false, focus: false };
const KEY = "read:reading-prefs:v1";
export const SIZES: ReadingPrefs["size"][] = [16, 17, 18, 19, 20, 22];

export function loadPrefs(): ReadingPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<ReadingPrefs>;
    return { ...DEFAULT_PREFS, ...parsed, size: SIZES.includes(parsed.size as ReadingPrefs["size"]) ? (parsed.size as ReadingPrefs["size"]) : DEFAULT_PREFS.size };
  } catch {
    // Storage may be unavailable; defaults are a legitimate mode, not a hidden failure.
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: ReadingPrefs) {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* same as above */ }
}

const measures = { narrow: 560, normal: 680, wide: 820 } as const;
const leadings = { tight: 1.5, comfortable: 1.65, loose: 1.8 } as const;
const fonts = { sans: "var(--font)", serif: "var(--font-serif)", mono: "var(--mono)" } as const;

/** CSS custom properties the reader body reads. */
export function prefsStyle(prefs: ReadingPrefs): Record<string, string> {
  return {
    "--measure": `${measures[prefs.measure]}px`,
    "--t-reading": `400 ${prefs.size}px/${leadings[prefs.lineHeight]} ${fonts[prefs.font]}`,
    "--reading-align": prefs.justify ? "justify" : "start",
    // Headings follow the body typeface; SF keeps its own display cut.
    ...(prefs.font === "sans" ? {} : { "--font-display": fonts[prefs.font] }),
  };
}

export function applyTheme(theme: ReadingPrefs["theme"]) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme; else root.dataset.theme = theme;
  // Paper is a light appearance for the window chrome.
  void read.setTheme(theme === "sepia" ? "light" : theme);
}

// ---------------------------------------------------------------------------
// The store: one value, subscribers, and a setter that saves and applies the theme.
// ---------------------------------------------------------------------------

let current: ReadingPrefs | undefined;
const listeners = new Set<() => void>();

function snapshot(): ReadingPrefs {
  if (!current) current = loadPrefs();
  return current;
}

/** Replaces the prefs everywhere: saved, the theme applied to the document, every subscriber told. */
export function setReadingPrefs(next: ReadingPrefs): void {
  const previous = snapshot();
  current = next;
  savePrefs(next);
  if (previous.theme !== next.theme) applyTheme(next.theme);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The shared reading prefs and their setter; every component using it re-renders on a change. */
export function useReadingPrefs(): [ReadingPrefs, (next: ReadingPrefs) => void] {
  const prefs = useSyncExternalStore(subscribe, snapshot, snapshot);
  const set = useCallback((next: ReadingPrefs) => setReadingPrefs(next), []);
  return [prefs, set];
}
