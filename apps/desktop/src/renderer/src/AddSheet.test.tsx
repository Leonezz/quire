// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRecord } from "../../shared/contracts";
import { flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { AddSheet } from "./AddSheet";

const source: SourceRecord = { id: "src-1", kind: "arxiv", locator: "cs.CL", title: "arXiv cs.CL", addedAt: "2026-09-18T00:00:00.000Z", intervalMinutes: 360, failureCount: 0, itemCount: 0, keptCount: 0, weeklyRate: 0 };

function setup() {
  const onSubmit = vi.fn();
  const onSubscribed = vi.fn();
  render(<AddSheet open busy={false} onClose={() => undefined} onSubmit={onSubmit} onSubscribed={onSubscribed} />);
  const input = screen.getByRole("textbox", { name: "Paste a URL or an arXiv category" });
  const form = input.closest("form")!;
  return { input, form, onSubmit, onSubscribed };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("AddSheet", () => {
  it("recognises an arXiv category locally and subscribes on submit", async () => {
    api.read = mockRead({ addSource: vi.fn(async () => ({ ok: true as const, source, added: 12 })) });
    const { input, form, onSubscribed } = setup();
    fireEvent.change(input, { target: { value: "cs.CL" } });
    expect(screen.getByRole("status").textContent).toContain("arXiv category · cs.CL");
    expect(screen.getByRole("button", { name: "Subscribe to arXiv cs.CL" })).toBeTruthy();
    expect(api.read.detectSource).not.toHaveBeenCalled();
    await act(async () => { fireEvent.submit(form); await flush(); });
    expect(api.read.addSource).toHaveBeenCalledWith("cs.CL");
    expect(onSubscribed).toHaveBeenCalledWith({ source, added: 12 });
  });

  it("detects a page through the engine and hands it to the owner to read", async () => {
    api.read = mockRead({ detectSource: vi.fn(async () => ({ kind: "page" as const, url: "https://example.org/post" })) });
    const { input, form, onSubmit } = setup();
    fireEvent.change(input, { target: { value: "https://example.org/post" } });
    await act(async () => { fireEvent.submit(form); await flush(); });
    expect(api.read.detectSource).toHaveBeenCalledWith("https://example.org/post");
    expect(onSubmit).toHaveBeenCalledWith("https://example.org/post");
  });

  it("holds a page that declares a feed: reading it is the next step, subscribing to its feed the other", async () => {
    const page = { kind: "page" as const, url: "https://example.org/docs/guide", feed: "https://example.org/rss.xml" };
    api.read = mockRead({ detectSource: vi.fn(async () => page), addSource: vi.fn(async () => ({ ok: true as const, source, added: 3 })) });
    const { input, form, onSubmit, onSubscribed } = setup();
    fireEvent.change(input, { target: { value: page.url } });
    await act(async () => { fireEvent.submit(form); await flush(); });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Page · example.org");
    expect(screen.getByRole("button", { name: "Read" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Subscribe to example.org" })); await flush(); });
    expect(api.read.addSource).toHaveBeenCalledWith("https://example.org/rss.xml");
    expect(onSubscribed).toHaveBeenCalledWith({ source, added: 3 });
  });

  it("reads a page that declares a feed when the field is submitted again", async () => {
    api.read = mockRead({ detectSource: vi.fn(async () => ({ kind: "page" as const, url: "https://example.org/docs/guide", feed: "https://example.org/rss.xml" })) });
    const { input, form, onSubmit } = setup();
    fireEvent.change(input, { target: { value: "https://example.org/docs/guide" } });
    await act(async () => { fireEvent.submit(form); await flush(); });
    await act(async () => { fireEvent.submit(form); await flush(); });
    expect(onSubmit).toHaveBeenCalledWith("https://example.org/docs/guide");
    expect(api.read.addSource).not.toHaveBeenCalled();
  });

  it("detects a feed, offers to subscribe, and shows a refused subscription in the field", async () => {
    api.read = mockRead({
      detectSource: vi.fn(async () => ({ kind: "feed" as const, url: "https://example.org/feed.xml", title: "Example" })),
      addSource: vi.fn(async () => ({ ok: false as const, code: "SOURCE_EXISTS", message: "Already subscribed." })),
    });
    const { input, form, onSubscribed } = setup();
    fireEvent.change(input, { target: { value: "https://example.org/feed.xml" } });
    await act(async () => { fireEvent.submit(form); await flush(); });
    expect(screen.getByRole("button", { name: "Subscribe to Example" })).toBeTruthy();
    await act(async () => { fireEvent.submit(form); await flush(); });
    expect(api.read.addSource).toHaveBeenCalledWith("https://example.org/feed.xml");
    expect(onSubscribed).not.toHaveBeenCalled();
    expect(screen.getByText("Already subscribed.")).toBeTruthy();
  });

  it("shows a detection failure instead of swallowing it", async () => {
    api.read = mockRead({ detectSource: vi.fn(async () => { throw new Error("offline"); }) });
    const { input, form } = setup();
    fireEvent.change(input, { target: { value: "https://example.org" } });
    await act(async () => { fireEvent.submit(form); await flush(); });
    expect(screen.getByText("offline")).toBeTruthy();
  });
});
