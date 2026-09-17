import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnnotationStore } from "./annotations";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-annotations-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const material = "0123456789abcdef";
const base = { materialId: material, locator: "text-quote:v2:abc", quote: "a quote", kind: "highlight" as const, color: "#ffd400" as const, createdAt: "", updatedAt: "" };

describe("AnnotationStore", () => {
  it("saves, updates in place, lists in insertion order and deletes", async () => {
    const store = new AnnotationStore(root);
    const first = await store.save({ ...base, id: "aaaaaaaaaaaaaaaa" });
    await store.save({ ...base, id: "bbbbbbbbbbbbbbbb", quote: "second" });
    const updated = await store.save({ ...base, id: "aaaaaaaaaaaaaaaa", note: "why it matters" });
    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.note).toBe("why it matters");
    expect((await store.list(material)).map((a) => a.id)).toEqual(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]);
    await store.delete(material, "aaaaaaaaaaaaaaaa");
    expect((await store.list(material)).map((a) => a.id)).toEqual(["bbbbbbbbbbbbbbbb"]);
    await store.delete(material, "bbbbbbbbbbbbbbbb");
    expect(await store.list(material)).toEqual([]);
  });

  it("rejects malformed ids and empty locators loudly", async () => {
    const store = new AnnotationStore(root);
    await expect(store.save({ ...base, id: "nope" })).rejects.toThrow("ANNOTATION_INVALID_ID");
    await expect(store.save({ ...base, id: "aaaaaaaaaaaaaaaa", locator: "" })).rejects.toThrow("ANNOTATION_INVALID_LOCATOR");
    await expect(store.list("../etc")).rejects.toThrow("ANNOTATION_INVALID_MATERIAL");
  });
});
