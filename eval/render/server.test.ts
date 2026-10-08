import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveStatic, startStaticServer } from "./server";

const root = mkdtempSync(join(tmpdir(), "render-server-"));
const app = join(root, "app");
const corpus = join(root, "corpus");
mkdirSync(join(app, "assets"), { recursive: true });
mkdirSync(corpus);
writeFileSync(join(app, "index.html"), "<html>app</html>");
writeFileSync(join(app, "assets", "a.js"), "export {}");
writeFileSync(join(corpus, "index.json"), "[]");
writeFileSync(join(root, "secret.txt"), "no");
const mounts = [{ prefix: "/dev/corpus", dir: corpus }, { prefix: "/", dir: app }];
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("resolveStatic", () => {
  it("maps paths under the most specific mount and defaults to index.html", () => {
    expect(resolveStatic("/index.html?render=x", mounts)).toBe(join(app, "index.html"));
    expect(resolveStatic("/", mounts)).toBe(join(app, "index.html"));
    expect(resolveStatic("/dev/corpus/index.json", mounts)).toBe(join(corpus, "index.json"));
  });

  it("refuses to leave the mount", () => {
    expect(resolveStatic("/../secret.txt", mounts)).toBeUndefined();
    expect(resolveStatic("/dev/corpus/..%2F..%2Fsecret.txt", mounts)).toBeUndefined();
    expect(resolveStatic("/%E0%A4%A", mounts)).toBeUndefined();
  });
});

describe("startStaticServer", () => {
  it("serves files with their type on 127.0.0.1 and 404s the rest", async () => {
    const server = await startStaticServer(mounts);
    try {
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const page = await fetch(`${server.origin}/index.html?render=abc`);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toBe("<html>app</html>");
      expect((await fetch(`${server.origin}/assets/a.js`)).headers.get("content-type")).toContain("text/javascript");
      expect(await (await fetch(`${server.origin}/dev/corpus/index.json`)).text()).toBe("[]");
      expect((await fetch(`${server.origin}/__render/image?src=x`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
