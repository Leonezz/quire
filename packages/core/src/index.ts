// Domain model for the reading-first MVP. No UI, no Electron.
// Keep this small: what a row, a reader and the agent need to know.

export type MaterialClass = "paper" | "feed" | "web" | "note" | "code";
export type ReadState = "unread" | "read";

export interface Signals {
  code?: boolean;
  math?: boolean;
  figures?: boolean;
  lang?: string;
}

/** One thing in the Inbox: undecided until you read, queue or dismiss it. */
export interface Item {
  id: string;
  sourceId: string;
  sourceTitle: string;
  title: string;
  gist: string;
  publishedAt: string;
  readingMinutes: number;
  signals: Signals;
  readState: ReadState;
  queuedAt?: string;
  queuePosition?: number;
  keptAt?: string;
  dismissedAt?: string;
  introducedBy?: "agent";
  summaryOnly?: boolean;
}

export interface Source {
  id: string;
  kind: "feed" | "arxiv";
  locator: string;
  title: string;
  lastSuccessAt?: string;
  lastError?: string;
  failureCount: number;
  pausedAt?: string;
  weeklyRate?: number;
  itemCount: number;
  keptCount: number;
}

export type ReadingEventKind = "opened" | "kept" | "finished" | "dismissed" | "marked" | "authored" | "queued" | "introduced";

export interface ReadingEvent {
  kind: ReadingEventKind;
  ref: string;
  at: string;
}
