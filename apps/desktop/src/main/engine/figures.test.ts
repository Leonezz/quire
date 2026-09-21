import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FigureStore, figureUrl, parseFigureUrl } from "./figures";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-figures-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const PNG = Buffer.from([137, 80, 78, 71]);

describe("figure URLs", () => {
  it("round-trips a material id and crop index and rejects anything else", () => {
    expect(figureUrl("8667175ac66aac06", 3)).toBe("quire-figure://8667175ac66aac06/3.png");
    expect(parseFigureUrl("quire-figure://8667175ac66aac06/3.png")).toEqual({ materialId: "8667175ac66aac06", index: 3 });
    expect(parseFigureUrl("quire-figure://8667175ac66aac06/0.png")).toBeUndefined();
    expect(parseFigureUrl("quire-figure://../3.png")).toBeUndefined();
    expect(parseFigureUrl("quire-figure://8667175ac66aac0/3.png")).toBeUndefined();
    expect(parseFigureUrl("quire-figure://8667175ac66aac06/3.jpg")).toBeUndefined();
    expect(parseFigureUrl("https://example.test/3.png")).toBeUndefined();
  });
});

describe("FigureStore", () => {
  it("writes crops under figures/<id>, serves them as data URLs and removes them with the material", async () => {
    const store = new FigureStore(root);
    const url = await store.write("8667175ac66aac06", 1, PNG);
    expect(url).toBe("quire-figure://8667175ac66aac06/1.png");
    expect((await stat(join(root, "figures", "8667175ac66aac06", "1.png"))).size).toBe(4);
    expect(await store.read(url)).toBe("data:image/png;base64,iVBORw==");
    expect(await store.read("quire-figure://8667175ac66aac06/2.png")).toBeUndefined();
    expect(await store.read("https://example.test/x.png")).toBeUndefined();
    await store.remove("8667175ac66aac06");
    expect(await store.read(url)).toBeUndefined();
    await expect(readFile(join(root, "figures", "8667175ac66aac06", "1.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
