// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MaterialRecord } from "../../shared/contracts";
import { mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { RenderHarness, RenderQueryError } from "./RenderHarness";
import { parseRenderQuery, proxyImageResolver, waitForArticleReady } from "./renderReadiness";

const html = document.documentElement;
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

const payload = { type: "root", losses: [], children: [{ type: "paragraph", children: [{ type: "text", value: "The body of the article." }] }] };
function material(overrides: Partial<MaterialRecord> = {}): MaterialRecord {
  const extracted = { kind: "webpage" as const, title: "Attention", url: "https://example.org/a", creators: [{ name: "Lilian Weng" }] };
  // Low quality on purpose: the app would show its quality banner here, the harness must not.
  const quality = { completeness: "declared_full" as const, conformance: "conformant" as const, identityConfidence: "strong" as const, safety: "safe" as const, warnings: [{ code: "SOURCE_ARTICLE_DEFUDDLE_QUALITY_LOW", recoverBy: "generic-fallback", scope: "candidate", severity: "warning" }] };
  const view = { id: "web" as const, label: "Web", url: "https://example.org/a", mediaType: "text/html", status: "ready" as const, fetchedAt: "2026-09-18T00:00:00.000Z" };
  return {
    id: "0123456789abcdef", url: "https://example.org/a", finalUrl: "https://example.org/a", title: "Attention", fetchedAt: "2026-09-18T00:00:00.000Z", origin: "web", tags: [], kind: "webpage",
    problems: quality.warnings, views: [view], primaryView: "web", readyViews: ["web"], extracted, meta: extracted, mediaType: "text/html", readingMinutes: 17, quality,
    markdown: "The body of the article.", reader: { schema: "reader.document.v2", payload: JSON.stringify(payload) },
    ...overrides,
  } as unknown as MaterialRecord;
}

describe("RenderHarness", () => {
  it("renders the article alone and flags ready once the body is up", async () => {
    api.read = mockRead({ getMaterial: vi.fn(async () => material()) });
    render(<RenderHarness id="0123456789abcdef" />);
    await waitFor(() => expect(html.dataset.renderReady).toBe("1"));
    expect(html.dataset.renderError).toBeUndefined();
    expect(html.dataset.theme).toBe("light");
    const article = document.querySelector("[data-render-article]")!;
    expect(article.querySelector("h1")?.textContent).toBe("Attention");
    expect(article.textContent).toContain("example.org");
    expect(article.textContent).toContain("Lilian Weng");
    expect(article.textContent).toContain("The body of the article.");
    expect(article.querySelector('[data-reader-schema="reader.document.v2"]')).not.toBeNull();
  });

  it("shows no app chrome: no toolbar, panels, banners or Open original link", async () => {
    api.read = mockRead({ getMaterial: vi.fn(async () => material()) });
    render(<RenderHarness id="0123456789abcdef" />);
    await waitFor(() => expect(html.dataset.renderReady).toBe("1"));
    expect(screen.queryByText(/Open original/)).toBeNull();
    expect(screen.queryByText(/extraction may be incomplete/i)).toBeNull();
    expect(screen.queryAllByRole("toolbar")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("navigation")).toHaveLength(0);
    expect(document.querySelector("main, aside, [role=separator]")).toBeNull();
  });

  it("uses the default reading settings even when others are stored", async () => {
    localStorage.setItem("read:reading-prefs:v1", JSON.stringify({ font: "serif", size: 22, measure: "wide", lineHeight: "loose", theme: "dark", justify: true }));
    api.read = mockRead({ getMaterial: vi.fn(async () => material()) });
    render(<RenderHarness id="0123456789abcdef" />);
    await waitFor(() => expect(html.dataset.renderReady).toBe("1"));
    const viewport = document.querySelector<HTMLElement>(".reader-viewport")!;
    expect(viewport.style.getPropertyValue("--t-reading")).toBe("400 18px/1.65 var(--font)");
    expect(viewport.style.getPropertyValue("--measure")).toBe("680px");
    expect(document.querySelector<HTMLElement>(".reader-body")!.style.textAlign).toBe("start");
    expect(html.dataset.theme).toBe("light");
  });

  it("takes the dark theme and a fixed width when asked", async () => {
    api.read = mockRead({ getMaterial: vi.fn(async () => material()) });
    render(<RenderHarness id="0123456789abcdef" theme="dark" width={900} />);
    await waitFor(() => expect(html.dataset.renderReady).toBe("1"));
    expect(html.dataset.theme).toBe("dark");
    expect(document.querySelector<HTMLElement>("[data-render-article]")!.style.width).toBe("900px");
  });

  it("flags and shows an error for an unknown id, never a blank page", async () => {
    api.read = mockRead({ getMaterial: vi.fn(async () => undefined) });
    render(<RenderHarness id="ffffffffffffffff" />);
    await waitFor(() => expect(html.dataset.renderError).toMatch(/No material with id "ffffffffffffffff"/));
    expect(html.dataset.renderReady).toBeUndefined();
    expect(screen.getByRole("alert").textContent).toMatch(/Render failed: No material/);
  });

  it("flags a fetch failure and a material without a reader payload", async () => {
    api.read = mockRead({ getMaterial: vi.fn(async () => { throw new Error("Preview corpus material failed: HTTP 500"); }) });
    const { unmount } = render(<RenderHarness id="0123456789abcdef" />);
    await waitFor(() => expect(html.dataset.renderError).toBe("Preview corpus material failed: HTTP 500"));
    unmount();
    expect(html.dataset.renderError).toBeUndefined();
    api.read = mockRead({ getMaterial: vi.fn(async () => material({ reader: undefined })) });
    render(<RenderHarness id="0123456789abcdef" />);
    await waitFor(() => expect(html.dataset.renderError).toMatch(/no reader payload/));
  });

  it("reports ready with a warning when an image never settles", async () => {
    const figure = { type: "figure", caption: [], credit: [], media: [{ type: "image", alt: "A dog", title: null, url: "https://example.org/dog.png" }] };
    const withImage = { ...payload, children: [...payload.children, figure] };
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    api.read = mockRead({ getMaterial: vi.fn(async () => material({ reader: { schema: "reader.document.v2", payload: JSON.stringify(withImage) } } as Partial<MaterialRecord>)) });
    render(<RenderHarness id="0123456789abcdef" timeoutMs={150} />);
    await waitFor(() => expect(html.dataset.renderReady).toBe("1"), { timeout: 2_000 });
    expect(document.querySelector('[data-reader-image="loading"]')).not.toBeNull();
    expect(html.dataset.renderWarning).toBe("images-timeout");
  });

  it("flags a malformed query", () => {
    render(<RenderQueryError message="render: unknown theme &quot;sepia&quot;" />);
    expect(html.dataset.renderError).toContain("unknown theme");
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});

describe("parseRenderQuery", () => {
  it("reads the id, width and theme, and refuses what it cannot honour", () => {
    expect(parseRenderQuery("?q=1")).toBeUndefined();
    expect(parseRenderQuery("?render=abc")).toEqual({ id: "abc", theme: "light" });
    expect(parseRenderQuery("?render=abc&width=1280&theme=dark")).toEqual({ id: "abc", width: 1280, theme: "dark" });
    expect(parseRenderQuery("?render=")).toHaveProperty("error");
    expect(parseRenderQuery("?render=abc&theme=sepia")).toHaveProperty("error");
    expect(parseRenderQuery("?render=abc&width=wide")).toHaveProperty("error");
    expect(parseRenderQuery("?render=abc&width=10")).toHaveProperty("error");
  });
});

describe("proxyImageResolver", () => {
  const signal = new AbortController().signal;
  it("turns the capture's image answer into a blob URL", async () => {
    const fetch = vi.fn(async () => new Response(new Blob(["png"]), { status: 200, headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:render/1") }));
    const missing = vi.fn();
    await expect(proxyImageResolver(missing)("https://example.org/a.png", signal)).resolves.toBe("blob:render/1");
    expect(fetch).toHaveBeenCalledWith("/__render/image?src=https%3A%2F%2Fexample.org%2Fa.png", { signal });
    expect(missing).not.toHaveBeenCalled();
  });
  it("leaves a failed image unresolved and reports a missing route", async () => {
    const missing = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404, headers: { "content-type": "text/plain" } })));
    await expect(proxyImageResolver(missing)("https://example.org/a.png", signal)).resolves.toBeUndefined();
    expect(missing).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } })));
    await expect(proxyImageResolver(missing)("https://example.org/a.png", signal)).resolves.toBeUndefined();
    expect(missing).toHaveBeenCalledOnce();
  });
});

describe("waitForArticleReady", () => {
  it("is an error when the surface never renders", async () => {
    const root = document.createElement("article");
    await expect(waitForArticleReady(root, { timeoutMs: 60, pollMs: 10 })).rejects.toThrow(/did not render/);
  });
  it("waits for pending math, then resolves without warnings", async () => {
    const root = document.createElement("article");
    root.innerHTML = '<div data-reader-schema="reader.document.v2"><span data-reader-math-enhancement="pending"></span></div>';
    const done = waitForArticleReady(root, { timeoutMs: 2_000, pollMs: 10 });
    setTimeout(() => { root.querySelector("span")!.dataset.readerMathEnhancement = "settled"; }, 40);
    await expect(done).resolves.toEqual([]);
  });
});
