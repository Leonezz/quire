import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Database } from "./db";
import { ItemStore, type ItemInput } from "./items";

let root = "";
let db: Database;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-items-")); db = openDatabase(join(root, "quire.sqlite")); });
afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); });

const source = { id: "src-a", title: "Systems Notes", kind: "feed" as const };
const other = { id: "src-b", title: "Beweise", kind: "feed" as const };

function input(overrides: Partial<ItemInput> & { externalId: string }): ItemInput {
  return { title: `Post ${overrides.externalId}`, link: `https://example.test/${overrides.externalId}`, publishedAt: "2026-09-10T00:00:00.000Z", gist: "gist", readingMinutes: 3, signals: {}, summaryOnly: true, ...overrides };
}

describe("ItemStore", () => {
  it("opens the schema once and keeps its version", () => {
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(4);
    const again = openDatabase(join(root, "quire.sqlite"));
    expect(again.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });
    again.close();
  });

  it("upserts by (source, externalId), counts only new rows and never resets a decision", () => {
    const items = new ItemStore(db);
    expect(items.upsert(source, [input({ externalId: "a" }), input({ externalId: "b" })])).toBe(2);
    const [first] = items.inbox();
    items.decide(first!.id, "queue");
    expect(items.upsert(source, [input({ externalId: "a", title: "Renamed" }), input({ externalId: "c" })])).toBe(1);
    const renamed = items.get(first!.id);
    expect(renamed?.title).toBe("Renamed");
    expect(renamed?.queuedAt).toBeDefined();
    expect(items.queue().map((item) => item.id)).toEqual([first!.id]);
    // The same externalId under another source is a different item.
    expect(items.upsert(other, [input({ externalId: "a" })])).toBe(1);
  });

  it("lists the inbox newest first and excludes opened, queued and dismissed items", () => {
    const items = new ItemStore(db);
    items.upsert(source, [
      input({ externalId: "old", publishedAt: "2026-09-01T00:00:00.000Z" }),
      input({ externalId: "new", publishedAt: "2026-09-15T00:00:00.000Z" }),
      input({ externalId: "mid", publishedAt: "2026-09-08T00:00:00.000Z" }),
      input({ externalId: "gone", publishedAt: "2026-09-16T00:00:00.000Z" }),
      input({ externalId: "read", publishedAt: "2026-09-17T00:00:00.000Z" }),
    ]);
    const byExternal = (externalId: string) => items.inbox().find((item) => item.link.endsWith(`/${externalId}`))!;
    items.decide(byExternal("gone").id, "dismiss");
    items.markOpened(byExternal("read").id, "0123456789abcdef");
    expect(items.inbox().map((item) => item.link.split("/").pop())).toEqual(["new", "mid", "old"]);
    expect(items.get(byExternal("new").id)?.sourceTitle).toBe("Systems Notes");
  });

  it("queues at the end, unqueues, dismisses and undismisses", () => {
    const items = new ItemStore(db, () => new Date("2026-09-18T10:00:00Z"));
    items.upsert(source, [input({ externalId: "a" }), input({ externalId: "b" }), input({ externalId: "c" })]);
    const ids = items.inbox().map((item) => item.id);
    const a = items.decide(ids[0]!, "queue");
    const b = items.decide(ids[1]!, "queue");
    expect(a.queuePosition).toBe(0);
    expect(b.queuePosition).toBe(1);
    expect(a.queuedAt).toBe("2026-09-18T10:00:00.000Z");
    expect(items.queue().map((item) => item.id)).toEqual([ids[0], ids[1]]);
    const unqueued = items.decide(ids[0]!, "unqueue");
    expect(unqueued.queuedAt).toBeUndefined();
    expect(unqueued.queuePosition).toBeUndefined();
    const c = items.decide(ids[2]!, "queue");
    expect(c.queuePosition).toBe(2);
    const dismissed = items.decide(ids[2]!, "dismiss");
    expect(dismissed.dismissedAt).toBeDefined();
    expect(dismissed.queuedAt).toBeUndefined();
    expect(items.queue().map((item) => item.id)).toEqual([ids[1]]);
    expect(items.decide(ids[2]!, "undismiss").dismissedAt).toBeUndefined();
    expect(items.inbox().map((item) => item.id).sort()).toEqual([ids[0], ids[2]].sort());
    expect(() => items.decide("nope", "queue")).toThrow("ITEM_NOT_FOUND");
  });

  it("reorders the queue only when given exactly the current queue", () => {
    const items = new ItemStore(db);
    items.upsert(source, [input({ externalId: "a" }), input({ externalId: "b" }), input({ externalId: "c" })]);
    const ids = items.inbox().map((item) => item.id);
    ids.forEach((id) => items.decide(id, "queue"));
    items.reorder([ids[2]!, ids[0]!, ids[1]!]);
    expect(items.queue().map((item) => item.queuePosition)).toEqual([0, 1, 2]);
    expect(items.queue().map((item) => item.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(() => items.reorder([ids[0]!, ids[1]!])).toThrow("QUEUE_ORDER_MISMATCH");
    expect(() => items.reorder([ids[0]!, ids[1]!, ids[1]!])).toThrow("QUEUE_ORDER_MISMATCH");
    expect(() => items.reorder([...ids, "extra"])).toThrow("QUEUE_ORDER_MISMATCH");
  });

  it("stores what the source declared about an entry and refreshes it on re-sync", () => {
    const items = new ItemStore(db);
    const meta = { kind: "preprint" as const, arxivId: "2409.12345", creators: [{ role: "author" as const, name: "Mara Lindqvist" }], abstract: "Long-context models." };
    items.upsert(source, [input({ externalId: "paper", meta }), input({ externalId: "plain" }), input({ externalId: "empty", meta: {} })]);
    const byExternal = (externalId: string) => items.inbox().find((item) => item.link.endsWith(`/${externalId}`))!;
    expect(items.meta(byExternal("paper").id)).toEqual(meta);
    expect(items.meta(byExternal("plain").id)).toBeUndefined();
    expect(items.meta(byExternal("empty").id)).toBeUndefined();
    expect(items.meta("missing")).toBeUndefined();
    items.upsert(source, [input({ externalId: "paper", meta: { ...meta, abstract: "Revised." } })]);
    expect(items.meta(byExternal("paper").id)?.abstract).toBe("Revised.");
  });

  it("keeps the first openedAt and the latest material id", () => {
    const items = new ItemStore(db);
    items.upsert(source, [input({ externalId: "a" })]);
    const id = items.inbox()[0]!.id;
    const first = items.markOpened(id, "aaaaaaaaaaaaaaaa");
    const second = items.markOpened(id, "bbbbbbbbbbbbbbbb");
    expect(second.openedAt).toBe(first.openedAt);
    expect(second.materialId).toBe("bbbbbbbbbbbbbbbb");
    expect(items.inbox()).toEqual([]);
  });

  it("keeps an item as decided without opening it, and a later read still opens it", () => {
    const items = new ItemStore(db, () => new Date("2026-09-18T10:00:00Z"));
    items.upsert(source, [input({ externalId: "a" }), input({ externalId: "b" })]);
    const [a, b] = items.inbox().map((item) => item.id) as [string, string];
    const kept = items.markKept(a, "aaaaaaaaaaaaaaaa");
    expect(kept).toMatchObject({ keptAt: "2026-09-18T10:00:00.000Z", materialId: "aaaaaaaaaaaaaaaa" });
    expect(kept.openedAt).toBeUndefined();
    expect(items.inbox().map((item) => item.id)).toEqual([b]);
    expect(items.queue()).toEqual([]);
    expect((db.prepare("SELECT state FROM items WHERE id = ?").get(a) as { state: string }).state).toBe("kept");
    expect(items.markKept(a, "bbbbbbbbbbbbbbbb").keptAt).toBe("2026-09-18T10:00:00.000Z");
    // Queueing a kept item shows it in the queue; unqueueing returns it to kept, not to the inbox.
    items.decide(a, "queue");
    expect(items.queue().map((item) => item.id)).toEqual([a]);
    items.decide(a, "unqueue");
    expect(items.inbox().map((item) => item.id)).toEqual([b]);
    expect(items.markOpened(a, "cccccccccccccccc").openedAt).toBeDefined();
    expect((db.prepare("SELECT state FROM items WHERE id = ?").get(a) as { state: string }).state).toBe("opened");
    expect(() => items.markKept("nope", "aaaaaaaaaaaaaaaa")).toThrow("ITEM_NOT_FOUND");
  });

  it("unlinks a deleted material from every item while keeping their decisions", () => {
    const items = new ItemStore(db);
    items.upsert(source, [input({ externalId: "a" }), input({ externalId: "b" }), input({ externalId: "c" })]);
    const [a, b, c] = items.inbox().map((item) => item.id) as [string, string, string];
    items.markOpened(a, "0123456789abcdef");
    items.markKept(b, "0123456789abcdef");
    items.markOpened(c, "fedcba9876543210");
    expect(items.unlinkMaterial("0123456789abcdef")).toBe(2);
    expect(items.unlinkMaterial("0123456789abcdef")).toBe(0);
    expect(items.get(a)).not.toHaveProperty("materialId");
    expect(items.get(a)?.openedAt).toBeDefined();
    expect(items.get(b)?.keptAt).toBeDefined();
    expect(items.get(c)?.materialId).toBe("fedcba9876543210");
    expect(items.inbox()).toEqual([]);
    expect(items.healthOf("src-a").keptCount).toBe(1);
  });

  it("finishes every item read as a material, once", () => {
    const items = new ItemStore(db, () => new Date("2026-09-18T10:00:00Z"));
    items.upsert(source, [input({ externalId: "a" }), input({ externalId: "b" })]);
    const [a, b] = items.inbox().map((item) => item.id) as [string, string];
    items.markOpened(a, "0123456789abcdef");
    expect(items.markFinished("0123456789abcdef")).toBe(1);
    expect(items.get(a)?.finishedAt).toBe("2026-09-18T10:00:00.000Z");
    expect(items.get(b)?.finishedAt).toBeUndefined();
    expect(items.markFinished("0123456789abcdef")).toBe(0);
  });

  it("searches every word across title and source title with escaped wildcards", () => {
    const items = new ItemStore(db);
    items.upsert(source, [input({ externalId: "a", title: "Cache keys that include the prompt" }), input({ externalId: "b", title: "100% of retries" })]);
    items.upsert(other, [input({ externalId: "c", title: "Momentum, revisited" })]);
    expect(items.search("cache PROMPT").map((item) => item.title)).toEqual(["Cache keys that include the prompt"]);
    expect(items.search("systems cache").map((item) => item.title)).toEqual(["Cache keys that include the prompt"]);
    expect(items.search("beweise").map((item) => item.title)).toEqual(["Momentum, revisited"]);
    expect(items.search("100%").map((item) => item.title)).toEqual(["100% of retries"]);
    expect(items.search("%")).toHaveLength(1);
    expect(items.search("nothing here")).toEqual([]);
    expect(items.search("   ")).toEqual([]);
  });

  it("stores feed content only for full entries and returns it on demand", () => {
    const items = new ItemStore(db);
    const content = { reader: { schema: "reader.document.v2" as const, payload: "{\"type\":\"root\"}" }, markdown: "# Hi", plain: "Hi" };
    items.upsert(source, [input({ externalId: "full", summaryOnly: false, content }), input({ externalId: "short" })]);
    const [full, short] = items.inbox().sort((a, b) => a.link.localeCompare(b.link));
    expect(items.content(full!.id)).toEqual(content);
    expect(items.content(short!.id)).toBeUndefined();
    expect(items.content("missing")).toBeUndefined();
  });

  it("drops only undecided items of a source and reports health counts", () => {
    const now = () => new Date("2026-09-18T00:00:00Z");
    const items = new ItemStore(db, now);
    items.upsert(source, [
      input({ externalId: "a", publishedAt: "2026-09-17T00:00:00.000Z" }),
      input({ externalId: "b", publishedAt: "2026-09-10T00:00:00.000Z" }),
      input({ externalId: "c", publishedAt: "2026-07-01T00:00:00.000Z" }),
      input({ externalId: "d", publishedAt: "2026-09-01T00:00:00.000Z" }),
    ]);
    const ids = items.inbox().map((item) => item.id);
    items.decide(ids[0]!, "queue");
    items.markOpened(ids[1]!, "0123456789abcdef");
    expect(items.healthOf("src-a")).toEqual({ itemCount: 4, keptCount: 1, weeklyRate: 0.8 });
    expect(items.removeUndecidedOf("src-a")).toBe(2);
    expect(items.get(ids[0])).toBeDefined();
    expect(items.get(ids[1])).toBeDefined();
    expect(items.healthOf("src-a")).toEqual({ itemCount: 2, keptCount: 1, weeklyRate: 0.5 });
    expect(items.healthOf("unknown")).toEqual({ itemCount: 0, keptCount: 0, weeklyRate: 0 });
  });
});
