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

  it("deletes every annotation of a material at once", async () => {
    const store = new AnnotationStore(root);
    await store.save({ ...base, id: "aaaaaaaaaaaaaaaa" });
    await store.save({ ...base, id: "bbbbbbbbbbbbbbbb" });
    await store.deleteAll(material);
    expect(await store.list(material)).toEqual([]);
    await store.deleteAll(material);
    await expect(store.deleteAll("../etc")).rejects.toThrow("ANNOTATION_INVALID_MATERIAL");
  });

  it("keeps the view an annotation belongs to and rejects unknown view ids", async () => {
    const store = new AnnotationStore(root);
    const onPdf = await store.save({ ...base, id: "aaaaaaaaaaaaaaaa", view: "pdf", locator: "pdf-region:1:0.1,0.2,0.3,0.4" });
    expect(onPdf.view).toBe("pdf");
    await store.save({ ...base, id: "bbbbbbbbbbbbbbbb", view: "web" });
    await store.save({ ...base, id: "cccccccccccccccc" });
    expect((await store.list(material)).map((a) => a.view)).toEqual(["pdf", "web", undefined]);
    await expect(store.save({ ...base, id: "dddddddddddddddd", view: "epub" as never })).rejects.toThrow("ANNOTATION_INVALID_VIEW");
  });

  it("rejects malformed ids and empty locators loudly", async () => {
    const store = new AnnotationStore(root);
    await expect(store.save({ ...base, id: "nope" })).rejects.toThrow("ANNOTATION_INVALID_ID");
    await expect(store.save({ ...base, id: "aaaaaaaaaaaaaaaa", locator: "" })).rejects.toThrow("ANNOTATION_INVALID_LOCATOR");
    await expect(store.list("../etc")).rejects.toThrow("ANNOTATION_INVALID_MATERIAL");
  });
});
