import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore, titleFor } from "./agent-sessions";
import { openDatabase, type Database } from "./db";

let db: Database;
beforeEach(() => { db = openDatabase(":memory:"); });
afterEach(() => { db.close(); });

describe("titleFor", () => {
  it("uses the reader's words, collapsed and cut at 60 characters, else the task and the material", () => {
    expect(titleFor({ task: "ask", text: "  What did\n I read   about momentum? " })).toBe("What did I read about momentum?");
    const long = "word ".repeat(30).trim();
    const title = titleFor({ task: "ask", text: long });
    expect(title).toHaveLength(60);
    expect(title.endsWith("…")).toBe(true);
    expect(titleFor({ task: "summary", text: "" }, "Momentum, revisited")).toBe("Summary · Momentum, revisited");
    expect(titleFor({ task: "related", text: "   " })).toBe("Related · Library");
  });
});

describe("SessionStore", () => {
  it("creates, appends turns, lists newest updated first, gets with turns in order, and deletes", () => {
    let tick = 0;
    const sessions = new SessionStore(db, () => new Date(Date.UTC(2026, 8, 18, 10, 0, tick++)));
    const first = sessions.create({ kind: "library" }, "First");
    const second = sessions.create({ kind: "material", materialId: "abcdefabcdefabcd" }, "  ");
    expect(first).toEqual({ id: first.id, title: "First", context: { kind: "library" }, createdAt: "2026-09-18T10:00:00.000Z", updatedAt: "2026-09-18T10:00:00.000Z", turnCount: 0, turns: [] });
    expect(second.title).toBe("Untitled");
    expect(sessions.list().map((s) => s.id)).toEqual([second.id, first.id]);

    const user = sessions.appendTurn(first.id, { role: "user", text: "hi", task: "ask" });
    const agent = sessions.appendTurn(first.id, { role: "agent", text: "hello", task: "ask", status: "completed", tools: [{ name: "library_recent", status: "done", summary: "library_recent → 1 material" }] });
    sessions.setThread(first.id, "thread-1");
    expect(sessions.list().map((s) => [s.id, s.turnCount])).toEqual([[first.id, 2], [second.id, 0]]);
    const loaded = sessions.get(first.id)!;
    expect(loaded).toMatchObject({ threadId: "thread-1", updatedAt: agent.at, turnCount: 2 });
    expect(loaded.turns).toEqual([user, agent]);
    expect(loaded.turns[0]).not.toHaveProperty("tools");
    expect(loaded.turns[0]).not.toHaveProperty("status");
    expect(user.at < agent.at).toBe(true);
    expect(sessions.get(second.id)?.threadId).toBeUndefined();

    sessions.delete(first.id);
    expect(sessions.get(first.id)).toBeUndefined();
    expect(sessions.list().map((s) => s.id)).toEqual([second.id]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_turns").get()).toEqual({ n: 0 });
    sessions.delete("missing");
  });

  it("refuses turns and threads for unknown sessions", () => {
    const sessions = new SessionStore(db);
    expect(() => sessions.appendTurn("nope", { role: "user", text: "x" })).toThrow("SESSION_NOT_FOUND");
    expect(() => sessions.setThread("nope", "t")).toThrow("SESSION_NOT_FOUND");
    expect(sessions.get("nope")).toBeUndefined();
  });
});

describe("SessionStore sources", () => {
  it("keeps the ids an agent turn retrieved", () => {
    const db = openDatabase(":memory:");
    const store = new SessionStore(db);
    const session = store.create({ kind: "library" }, "t");
    store.appendTurn(session.id, { role: "agent", text: "x", status: "completed", sources: ["0123456789abcdef"] });
    expect(store.get(session.id)?.turns[0]?.sources).toEqual(["0123456789abcdef"]);
    db.close();
  });
});
