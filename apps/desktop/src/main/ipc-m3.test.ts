import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ipc-m3.ts registers handlers on ipcMain; they are captured here and called without Electron.
const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>());
vi.mock("electron", () => ({ ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, handler); } } }));
const { registerM3Handlers } = await import("./ipc-m3");
type Deps = Parameters<typeof registerM3Handlers>[0];

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-ipc-m3-")); handlers.clear(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function register(overrides: Partial<Record<keyof Deps, unknown>>) {
  const broadcast = vi.fn();
  registerM3Handlers({ dataDirectory: root, broadcast, ...overrides } as unknown as Deps);
  return { broadcast, call: (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) };
}

describe("material:delete", () => {
  it("says why the pictures were kept, and tells every window the library and the items changed", async () => {
    const store = { delete: vi.fn(async () => 1), imageReferences: vi.fn(async (ids?: readonly string[]) => (ids ? new Set(["https://img.test/a.png"]) : Promise.reject(new Error("EACCES")))) };
    const { broadcast, call } = register({ store, annotations: { deleteAll: async () => undefined }, items: { unlinkMaterial: () => 1 }, images: { forget: async () => 0 } });
    expect(await call("material:delete", ["0123456789abcdef"])).toEqual({ picturesKept: "The materials were deleted, but their cached pictures were kept: EACCES" });
    expect(store.delete).toHaveBeenCalledWith(["0123456789abcdef"]);
    expect(broadcast.mock.calls).toEqual([["library:changed"], ["sources:changed"]]);
  });

  it("answers nothing more when the pictures were forgotten too", async () => {
    const store = { delete: vi.fn(async () => 1), imageReferences: vi.fn(async () => new Set<string>()) };
    const { broadcast, call } = register({ store, annotations: { deleteAll: async () => undefined }, items: { unlinkMaterial: () => 0 }, images: { forget: async () => 0 } });
    expect(await call("material:delete", ["0123456789abcdef"])).toEqual({});
    expect(broadcast.mock.calls).toEqual([["library:changed"]]);
  });

  it("tells every window the library changed even when a step after the records went fails", async () => {
    const store = { delete: vi.fn(async () => 1), imageReferences: vi.fn(async () => new Set<string>()) };
    const { broadcast, call } = register({ store, annotations: { deleteAll: async () => { throw new Error("EACCES: annotations"); } }, items: { unlinkMaterial: () => 0 }, images: { forget: async () => 0 } });
    await expect(call("material:delete", ["0123456789abcdef"])).rejects.toThrow("EACCES: annotations");
    expect(store.delete).toHaveBeenCalledWith(["0123456789abcdef"]);
    expect(broadcast.mock.calls).toEqual([["library:changed"]]);
  });

  it("refuses ids that are not material ids without telling anyone anything changed", async () => {
    const store = { delete: vi.fn(async () => 0), imageReferences: vi.fn(async () => new Set<string>()) };
    const { broadcast, call } = register({ store });
    await expect(call("material:delete", ["../x"])).rejects.toThrow("IPC_INVALID_ID");
    expect(store.delete).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe("storage:usage", () => {
  it("measures the data directory it was given", async () => {
    await mkdir(join(root, "images"));
    await writeFile(join(root, "images", "a.bin"), Buffer.alloc(64));
    const { call } = register({});
    expect(await call("storage:usage")).toEqual({ materials: 0, images: 64, figures: 0, database: 0 });
  });
});
