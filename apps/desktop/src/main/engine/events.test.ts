import { describe, expect, it } from "vitest";
import { openDatabase } from "./db";
import { EventStore, isoWeekStart } from "./events";

describe("isoWeekStart", () => {
  it("returns the local Monday 00:00 of the week", () => {
    expect(isoWeekStart(new Date(2026, 8, 18, 15, 30)).getTime()).toBe(new Date(2026, 8, 14).getTime()); // Friday -> Monday
    expect(isoWeekStart(new Date(2026, 8, 14, 0, 0)).getTime()).toBe(new Date(2026, 8, 14).getTime()); // Monday stays
    expect(isoWeekStart(new Date(2026, 8, 20, 23, 59)).getTime()).toBe(new Date(2026, 8, 14).getTime()); // Sunday belongs to the week before
  });
});

describe("EventStore", () => {
  it("records events with server-side timestamps and lists them", () => {
    const db = openDatabase(":memory:");
    const events = new EventStore(db, () => new Date(2026, 8, 18, 10));
    const event = events.record("queued", "item-1");
    expect(event).toMatchObject({ kind: "queued", ref: "item-1", at: new Date(2026, 8, 18, 10).toISOString() });
    expect(events.list().map((e) => e.id)).toEqual([event.id]);
    expect(events.list("finished")).toEqual([]);
    db.close();
  });

  it("counts distinct finished materials in this ISO week and the one before, opened this week", () => {
    const db = openDatabase(":memory:");
    let clock = new Date(2026, 8, 7, 12); // Monday of last week
    const events = new EventStore(db, () => clock);
    events.record("finished", "m-last-1");
    clock = new Date(2026, 8, 13, 23, 59); // Sunday of last week, still last week
    events.record("finished", "m-last-2");
    events.record("opened", "i-last");
    clock = new Date(2026, 8, 14, 0, 0); // Monday 00:00 this week
    events.record("finished", "m-this-1");
    clock = new Date(2026, 8, 18, 9);
    events.record("finished", "m-this-1"); // the same material twice counts once
    events.record("finished", "m-this-2");
    events.record("opened", "i-this-1");
    events.record("opened", "i-this-2");
    events.record("kept", "m-this-2");
    clock = new Date(2026, 8, 18, 10);
    expect(events.stats()).toEqual({ weekStart: new Date(2026, 8, 14).toISOString(), finishedThisWeek: 2, finishedLastWeek: 2, openedThisWeek: 2 });
    clock = new Date(2026, 8, 21, 8); // next Monday: this week rolls over
    expect(events.stats()).toEqual({ weekStart: new Date(2026, 8, 21).toISOString(), finishedThisWeek: 0, finishedLastWeek: 2, openedThisWeek: 0 });
    db.close();
  });
});
