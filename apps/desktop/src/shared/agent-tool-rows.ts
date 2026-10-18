// The tool rows of an agent turn, as the main process stores them and the renderer shows them.
// A call that settles exactly like the row before it (same tool, outcome and summary) folds into
// that row as a count, so a turn that repeats one call thousands of times stays one row long
// instead of growing the run, every event's copy of it, and the stored turn without bound.

export type ToolRowStatus = "running" | "done" | "failed";

export interface ToolRow { name: string; status: ToolRowStatus; summary?: string | undefined; count?: number | undefined }

/** One tool event: a call started (`running`) or settled (`done` / `failed`) with its summary. */
export interface ToolProgressEvent { name: string; status: ToolRowStatus; summary?: string | undefined }

function sameSettled(row: ToolRow, event: ToolProgressEvent): boolean {
  return row.status !== "running" && row.name === event.name && row.status === event.status && (row.summary ?? "") === (event.summary ?? "");
}

/**
 * The rows with `event` applied. A running event appends a row; a settled event replaces the last
 * running row of that tool, or folds into the settled row before it when it repeats that row.
 * `make` builds a new row (the renderer gives each one a key); `previous` is the row it replaces.
 */
export function applyToolProgress<T extends ToolRow>(rows: readonly T[], event: ToolProgressEvent, make: (row: ToolRow, previous?: T) => T): T[] {
  if (event.status === "running") return [...rows, make({ name: event.name, status: "running" })];
  const settled: ToolRow = { name: event.name, status: event.status, ...(event.summary ? { summary: event.summary } : {}) };
  const running = rows.findLastIndex((row) => row.name === event.name && row.status === "running");
  // The row the settled call would follow once its running placeholder is gone.
  const before = running >= 0 ? rows.slice(0, running).findLast((row) => row.status !== "running") : rows.findLast((row) => row.status !== "running");
  const beforeIndex = before ? rows.lastIndexOf(before) : -1;
  if (before && sameSettled(before, event) && (running < 0 || rows.slice(beforeIndex + 1, running).every((row) => row.status === "running"))) {
    const folded = make({ ...settled, count: (before.count ?? 1) + 1 }, before);
    return rows.flatMap((row, i) => (i === beforeIndex ? [folded] : i === running ? [] : [row]));
  }
  if (running < 0) return [...rows, make(settled)];
  return rows.map((row, i) => (i === running ? make(settled, row) : row));
}
