// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaterialRecord, RenderingFeedback } from "../../shared/contracts";
import { deferred, flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { EMPTY_KINDS_MESSAGE, FeedbackSheet, INCLUDE_CAPTURE_KEY, SAVED_MESSAGE } from "./FeedbackSheet";

const quality: MaterialRecord["quality"] = { completeness: "declared_full", conformance: "recoverable", identityConfidence: "strong", safety: "safe", warnings: [] };
const material: MaterialRecord = {
  id: "a1b2c3d4e5f60718", url: "https://example.org/post", finalUrl: "https://example.org/post?x=1", title: "A post", fetchedAt: "2026-09-20T10:00:00.000Z", readingMinutes: 4, origin: "web", mediaType: "text/html",
  quality, tags: [], kind: "webpage", readyViews: ["web"], extracted: {}, meta: {}, views: [{ id: "web", label: "Web", url: "https://example.org/post", mediaType: "text/html", status: "ready" }], primaryView: "web",
  problems: [{ code: "SOURCE_ARTICLE_READABILITY_QUALITY_LOW", severity: "warning", scope: "candidate", recoverBy: "generic-fallback" } as MaterialRecord["problems"][number]],
  capture: { byteLength: 48_211, mediaType: "text/html" },
};
const saved: RenderingFeedback = {
  id: "fb1", createdAt: "2026-09-23T09:00:00.000Z", materialId: material.id, url: material.finalUrl, title: material.title, view: "web", kinds: ["tables"], note: "",
  app: { version: "test", platform: "test", normalize: "0.1" }, quality, problems: material.problems, capture: { included: true, byteLength: 48_211, mediaType: "text/html" }, bundleDir: "/data/feedback/fb1",
};

function mount(record: MaterialRecord = material, overrides: Partial<ReturnType<typeof mockRead>> = {}) {
  const onClose = vi.fn();
  api.read = mockRead({ feedbackCreate: vi.fn(async () => saved), ...overrides });
  render(<FeedbackSheet isOpen material={record} view="web" onClose={onClose} />);
  return { onClose };
}
const dialog = () => screen.getByRole("dialog");
const chip = (name: string) => within(dialog()).getByRole("button", { name });
const press = async (element: Element) => { await act(async () => { fireEvent.click(element); await flush(); }); };

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("FeedbackSheet › step 1", () => {
  it("lists the nine problems in the reader's words, what is saved, and the capture checkbox on by default", () => {
    mount();
    const sheet = dialog();
    expect(within(sheet).getByRole("heading", { name: "Report a rendering problem" })).toBeTruthy();
    const group = within(sheet).getByRole("toolbar", { name: "What went wrong" });
    expect(within(group).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Text or sections are missing", "Navigation, related posts, comments or share blocks kept", "Paragraphs out of order", "Code or formulas broken", "Tables mangled", "Figures missing or wrong", "Wrong title, author or date", "Headings, lists, quotes or footnotes wrong", "Something else",
    ]);
    expect((within(sheet).getByRole("checkbox", { name: "Include the saved original page so it can be reproduced" }) as HTMLInputElement).checked).toBe(true);
    const facts = within(sheet).getByText("What is saved").parentElement!;
    expect(facts.textContent).toContain("https://example.org/post?x=1");
    expect(facts.textContent).toContain("A post");
    expect(facts.textContent).toContain("Web");
    expect(facts.textContent).toContain("test");
    expect(facts.textContent).toContain("web extract · partial");
    expect(facts.textContent).toContain("1 extractor note");
    expect(facts.textContent).toContain("47 KB · text/html");
  });

  it("refuses to save without a problem chosen and clears the message once one is", async () => {
    mount();
    await press(within(dialog()).getByRole("button", { name: "Save report" }));
    expect(screen.getByRole("alert").textContent).toBe(EMPTY_KINDS_MESSAGE);
    expect(api.read.feedbackCreate).not.toHaveBeenCalled();
    await press(chip("Tables mangled"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("hands the draft to feedbackCreate: the view, the kinds in order, the note, and the capture choice", async () => {
    mount();
    await press(chip("Figures missing or wrong"));
    await press(chip("Text or sections are missing"));
    fireEvent.change(within(dialog()).getByLabelText("Note"), { target: { value: "  The second figure is gone. " } });
    await press(within(dialog()).getByRole("checkbox", { name: "Include the saved original page so it can be reproduced" }));
    expect(localStorage.getItem(INCLUDE_CAPTURE_KEY)).toBe("off");
    await press(within(dialog()).getByRole("button", { name: "Save report" }));
    expect(api.read.feedbackCreate).toHaveBeenCalledWith({ materialId: material.id, view: "web", kinds: ["missing_content", "images"], note: "  The second figure is gone. ", includeCapture: false });
    expect(screen.getByText(new RegExp(SAVED_MESSAGE))).toBeTruthy();
  });

  it("never asks for the capture when the material has none, and sends includeCapture false", async () => {
    const { capture: _capture, ...bare } = material;
    mount(bare);
    expect(within(dialog()).queryByRole("checkbox")).toBeNull();
    expect(within(dialog()).queryByText(/Original page/)).toBeNull();
    await press(chip("Something else"));
    await press(within(dialog()).getByRole("button", { name: "Save report" }));
    expect(api.read.feedbackCreate).toHaveBeenCalledWith(expect.objectContaining({ kinds: ["other"], includeCapture: false }));
  });

  it("remembers the capture choice across reports", () => {
    localStorage.setItem(INCLUDE_CAPTURE_KEY, "off");
    mount();
    expect((within(dialog()).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("shows the bridge's refusal inline and stays on the form", async () => {
    mount(material, { feedbackCreate: vi.fn(async () => { throw new Error("ENOSPC: no space left on device"); }) });
    await press(chip("Tables mangled"));
    await press(within(dialog()).getByRole("button", { name: "Save report" }));
    expect(screen.getByRole("alert").textContent).toBe("ENOSPC: no space left on device");
    expect(within(dialog()).getByRole("button", { name: "Save report" })).toBeTruthy();
  });

  it("says it is saving until the bridge answers", async () => {
    const pending = deferred<RenderingFeedback>();
    mount(material, { feedbackCreate: vi.fn(() => pending.promise) });
    await press(chip("Tables mangled"));
    await press(within(dialog()).getByRole("button", { name: "Save report" }));
    expect(within(dialog()).getByRole("button", { name: "Saving…" })).toBeTruthy();
    await act(async () => { pending.resolve(saved); await flush(); });
    expect(within(dialog()).getByRole("heading", { name: "Report saved" })).toBeTruthy();
  });
});

describe("FeedbackSheet › step 2", () => {
  async function save(overrides: Partial<ReturnType<typeof mockRead>> = {}) {
    const handles = mount(material, overrides);
    await press(chip("Tables mangled"));
    await press(within(dialog()).getByRole("button", { name: "Save report" }));
    return handles;
  }

  it("says nothing was sent, and opens the issue and reveals the bundle through the bridge", async () => {
    await save({ feedbackOpenIssue: vi.fn(async () => undefined), feedbackReveal: vi.fn(async () => undefined) });
    expect(screen.getByText(new RegExp(SAVED_MESSAGE))).toBeTruthy();
    await press(within(dialog()).getByRole("button", { name: "Open GitHub issue" }));
    expect(api.read.feedbackOpenIssue).toHaveBeenCalledWith("fb1");
    await press(within(dialog()).getByRole("button", { name: "Reveal bundle" }));
    expect(api.read.feedbackReveal).toHaveBeenCalledWith("fb1");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a failed reveal inline", async () => {
    await save({ feedbackReveal: vi.fn(async () => { throw new Error("The bundle directory is gone."); }) });
    await press(within(dialog()).getByRole("button", { name: "Reveal bundle" }));
    expect(screen.getByRole("alert").textContent).toBe("The bundle directory is gone.");
  });

  it("stores a pasted issue link on Enter, and only when there is one", async () => {
    const feedbackSetIssueUrl = vi.fn(async (_id: string, issueUrl: string) => ({ ...saved, issueUrl }));
    await save({ feedbackSetIssueUrl });
    const field = within(dialog()).getByLabelText("Paste the issue link") as HTMLInputElement;
    await act(async () => { fireEvent.keyDown(field, { key: "Enter" }); await flush(); });
    expect(feedbackSetIssueUrl).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: " https://github.com/Leonezz/quire/issues/12 " } });
    await act(async () => { fireEvent.keyDown(field, { key: "Enter" }); await flush(); });
    expect(feedbackSetIssueUrl).toHaveBeenCalledWith("fb1", "https://github.com/Leonezz/quire/issues/12");
    expect(within(dialog()).getByText("Saved on the report.")).toBeTruthy();
  });

  it("stores the link on blur and shows the bridge's refusal under the field", async () => {
    await save({ feedbackSetIssueUrl: vi.fn(async () => { throw new Error("Not a GitHub issue link."); }) });
    const field = within(dialog()).getByLabelText("Paste the issue link");
    fireEvent.change(field, { target: { value: "nope" } });
    await act(async () => { fireEvent.blur(field); await flush(); });
    expect(api.read.feedbackSetIssueUrl).toHaveBeenCalledWith("fb1", "nope");
    expect(within(dialog()).getByText("Not a GitHub issue link.")).toBeTruthy();
  });

  it("Done closes the sheet", async () => {
    const { onClose } = await save();
    await press(within(dialog()).getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("FeedbackSheet › closing", () => {
  it("Esc closes the sheet", async () => {
    const { onClose } = mount();
    await act(async () => { fireEvent.keyDown(dialog(), { key: "Escape" }); await flush(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
