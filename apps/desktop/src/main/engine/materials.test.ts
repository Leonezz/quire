import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MaterialStore } from "./materials";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-materials-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("MaterialStore", () => {
  it("reads a dropped Markdown file into a reader document and lists it", async () => {
    const store = new MaterialStore(root);
    const md = "# Momentum, revisited\n\nA paragraph with **emphasis** and `code`.\n\n## Why it is stable\n\nBecause.\n";
    const result = await store.openFile({ name: "momentum.md", mediaType: "", bytes: new TextEncoder().encode(md) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.title).toBe("Momentum, revisited");
    expect(result.material.origin).toBe("file");
    expect(result.material.reader?.schema).toBe("reader.document.v2");
    expect(JSON.parse(result.material.reader!.payload).type).toBe("root");
    expect(result.material.readingMinutes).toBe(1);
    const listed = await store.list();
    expect(listed.map((item) => item.title)).toEqual(["Momentum, revisited"]);
    expect(await store.get(result.material.id)).toMatchObject({ title: "Momentum, revisited" });
  });

  it("reads a dropped HTML file through the article extractor", async () => {
    const store = new MaterialStore(root);
    const html = `<!doctype html><html><head><title>Cache keys</title></head><body><article><h1>Cache keys</h1>${"<p>Two harnesses cache the tokenised prompt keyed on the question text alone, so a changed system prompt silently reuses the old one. The fix is a cache key that includes the full rendered prompt hash.</p>".repeat(12)}</article></body></html>`;
    const result = await store.openFile({ name: "cache.html", mediaType: "text/html", bytes: new TextEncoder().encode(html) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.title).toBe("Cache keys");
    expect(result.material.reader).toBeDefined();
    expect(result.material.quality.safety).toBe("safe");
  });

  it("refuses unsupported file types with a clear code", async () => {
    const store = new MaterialStore(root);
    const result = await store.openFile({ name: "photo.png", mediaType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) });
    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED_TYPE" });
  });

  it("refuses private and non-http URLs before fetching", async () => {
    const store = new MaterialStore(root);
    expect(await store.openUrl("http://localhost:3000/x")).toMatchObject({ ok: false, code: "URL_PRIVATE" });
    expect(await store.openUrl("http://10.0.0.8/x")).toMatchObject({ ok: false, code: "URL_PRIVATE" });
    expect(await store.openUrl("ftp://example.com/x")).toMatchObject({ ok: false, code: "URL_SCHEME" });
    expect(await store.openUrl("https://user:pw@example.com/x")).toMatchObject({ ok: false, code: "URL_CREDENTIALS" });
    expect(await store.openUrl("not a url")).toMatchObject({ ok: false, code: "URL_INVALID" });
    expect(await store.list()).toEqual([]);
  });
});
