import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSaveDownload } from "./update-download";

let directory = "";
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });
}

describe("createSaveDownload", () => {
  it("streams the installer into the folder with whole-percent progress and returns its path", async () => {
    directory = await mkdtemp(join(tmpdir(), "quire-dl-"));
    const fetch = vi.fn(async () => new Response(bodyOf(["abcd", "efgh"]), { status: 200, headers: { "content-length": "8" } }));
    const progress: number[] = [];
    const path = await createSaveDownload({ directory: () => directory, fetch, userAgent: "Quire/test" })("https://example.test/Q.dmg", "Q.dmg", (percent) => progress.push(percent));
    expect(path).toBe(join(directory, "Q.dmg"));
    expect(await readFile(path, "utf8")).toBe("abcdefgh");
    expect(progress).toEqual([50, 100]);
    expect(fetch).toHaveBeenCalledWith("https://example.test/Q.dmg", expect.objectContaining({ redirect: "follow" }));
  });

  it("says when the release has no installer for this Mac and leaves nothing behind", async () => {
    directory = await mkdtemp(join(tmpdir(), "quire-dl-"));
    const fetch = vi.fn(async () => new Response("Not Found", { status: 404 }));
    await expect(createSaveDownload({ directory: () => directory, fetch, userAgent: "Quire/test" })("https://example.test/Q.dmg", "Q.dmg", () => undefined)).rejects.toThrow("no installer for this Mac");
    expect(await readdir(directory)).toEqual([]);
  });

  it("removes the partial file when the connection is cut", async () => {
    directory = await mkdtemp(join(tmpdir(), "quire-dl-"));
    const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("ab")); controller.error(new Error("socket hang up")); } });
    const fetch = vi.fn(async () => new Response(broken, { status: 200, headers: { "content-length": "8" } }));
    await expect(createSaveDownload({ directory: () => directory, fetch, userAgent: "Quire/test" })("https://example.test/Q.dmg", "Q.dmg", () => undefined)).rejects.toThrow("socket hang up");
    expect(await readdir(directory)).toEqual([]);
  });
});
