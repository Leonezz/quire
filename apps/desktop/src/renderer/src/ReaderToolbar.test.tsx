// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MaterialView } from "../../shared/contracts";
import { mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { ReaderToolbar, type ReaderToolbarProps } from "./ReaderToolbar";
import { DEFAULT_PREFS } from "./readingPrefs";

const web: MaterialView = { id: "web", label: "Web", url: "https://example.org/a", mediaType: "text/html", status: "ready" };
const pdf: MaterialView = { id: "pdf", label: "PDF", url: "https://example.org/a.pdf", mediaType: "application/pdf", status: "available" };
const failed: MaterialView = { id: "markdown", label: "Markdown", url: "https://example.org/a.md", mediaType: "text/markdown", status: "failed", error: "HTTP 503" };

function renderToolbar(views: ReaderToolbarProps["views"]) {
  api.read = mockRead();
  render(<ReaderToolbar title="A page" subtitle="example.org · 0% · 3 min" badge={{ text: "web extract", low: false }} tocPinned={false} onTocChange={() => undefined} panel={null} onPanelChange={() => undefined} prefs={DEFAULT_PREFS} onPrefsChange={() => undefined} views={views} />);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ReaderToolbar view switch", () => {
  it("shows one segment per view, the active one selected, only when there are at least two", () => {
    renderToolbar({ view: "web", views: [web, pdf, failed], fetching: undefined, onSelect: () => undefined });
    const group = screen.getByRole("radiogroup", { name: "View (v)" });
    const segments = screen.getAllByRole("radio");
    expect(group).toBeTruthy();
    expect(segments.map((segment) => segment.getAttribute("aria-label"))).toEqual(["Web", "PDF (fetch on demand)", "Markdown (fetch failed: HTTP 503)"]);
    expect(segments[0]!.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTitle("HTTP 503")).toBeTruthy();
    cleanup();
    renderToolbar({ view: "web", views: [web], fetching: undefined, onSelect: () => undefined });
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("says which view is being fetched", () => {
    renderToolbar({ view: "web", views: [web, pdf], fetching: "pdf", onSelect: () => undefined });
    expect(screen.getByRole("status").textContent).toBe("Fetching PDF…");
  });

  it("selects a segment on click and cycles with v, but not while typing", () => {
    const onSelect = vi.fn();
    renderToolbar({ view: "web", views: [web, pdf], fetching: undefined, onSelect });
    fireEvent.click(screen.getByRole("radio", { name: "PDF (fetch on demand)" }));
    expect(onSelect).toHaveBeenLastCalledWith("pdf");
    fireEvent.keyDown(document, { key: "v" });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith("pdf");
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "v" });
    fireEvent.keyDown(document, { key: "v", metaKey: true });
    expect(onSelect).toHaveBeenCalledTimes(2);
    input.remove();
  });

  it("wraps the cycle around to the first view", () => {
    const onSelect = vi.fn();
    renderToolbar({ view: "pdf", views: [web, pdf], fetching: undefined, onSelect });
    fireEvent.keyDown(document, { key: "v" });
    expect(onSelect).toHaveBeenCalledWith("web");
  });
});
