import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storageUsage } from "./storage-usage";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-usage-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("storageUsage", () => {
  it("adds up the bytes of the data directory by what they hold, the database with its WAL files", async () => {
    await mkdir(join(root, "materials"), { recursive: true });
    await writeFile(join(root, "materials", "8667175ac66aac06.json"), Buffer.alloc(100));
    await writeFile(join(root, "materials", "8667175ac66aac06.html"), Buffer.alloc(400));
    await writeFile(join(root, "materials", "8667175ac66aac06.pdf.json"), Buffer.alloc(600));
    await mkdir(join(root, "images"));
    await writeFile(join(root, "images", "a.bin"), Buffer.alloc(300));
    await writeFile(join(root, "images", "a.json"), Buffer.alloc(20));
    await mkdir(join(root, "figures", "8667175ac66aac06"), { recursive: true });
    await writeFile(join(root, "figures", "8667175ac66aac06", "2.png"), Buffer.alloc(50));
    await writeFile(join(root, "quire.sqlite"), Buffer.alloc(4096));
    await writeFile(join(root, "quire.sqlite-wal"), Buffer.alloc(10));
    await writeFile(join(root, "settings.json"), "{}");

    expect(await storageUsage(root)).toEqual({ materials: 1100, images: 320, figures: 50, database: 4106 });
  });

  it("counts a part that was never written as empty", async () => {
    expect(await storageUsage(root)).toEqual({ materials: 0, images: 0, figures: 0, database: 0 });
  });
});
