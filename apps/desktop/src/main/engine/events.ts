import { randomBytes } from "node:crypto";
import type { ReadingEvent, ReadingEventKind, ReadingStats } from "../../shared/contracts";
import type { Database } from "./db";

const WEEK_MS = 7 * 86_400_000;

/** Monday 00:00 local time of the ISO week containing `date`. */
export function isoWeekStart(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (start.getDay() + 6) % 7; // Monday = 0
  start.setDate(start.getDate() - offset);
  return start;
}

/** Append-only log of what happened to items and materials; the stats are computed from it. */
export class EventStore {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  record(kind: ReadingEventKind, ref: string): ReadingEvent {
    const event: ReadingEvent = { id: randomBytes(8).toString("hex"), kind, ref, at: this.now().toISOString() };
    this.db.prepare("INSERT INTO reading_events (id, kind, ref, at) VALUES (?, ?, ?, ?)").run(event.id, event.kind, event.ref, event.at);
    return event;
  }

  list(kind?: ReadingEventKind): ReadingEvent[] {
    const rows = kind
      ? this.db.prepare("SELECT id, kind, ref, at FROM reading_events WHERE kind = ? ORDER BY at, id").all(kind)
      : this.db.prepare("SELECT id, kind, ref, at FROM reading_events ORDER BY at, id").all();
    return rows as unknown as ReadingEvent[];
  }

  /** Distinct refs per kind inside the current ISO week (local time) and the week before. */
  stats(): ReadingStats {
    const weekStart = isoWeekStart(this.now());
    const lastWeekStart = new Date(weekStart.getTime() - WEEK_MS);
    const count = this.db.prepare("SELECT COUNT(DISTINCT ref) AS n FROM reading_events WHERE kind = ? AND at >= ? AND at < ?");
    const between = (kind: ReadingEventKind, from: Date, to: Date) => (count.get(kind, from.toISOString(), to.toISOString()) as { n: number }).n;
    const farFuture = new Date(weekStart.getTime() + WEEK_MS);
    return {
      weekStart: weekStart.toISOString(),
      finishedThisWeek: between("finished", weekStart, farFuture),
      finishedLastWeek: between("finished", lastWeekStart, weekStart),
      openedThisWeek: between("opened", weekStart, farFuture),
    };
  }
}
