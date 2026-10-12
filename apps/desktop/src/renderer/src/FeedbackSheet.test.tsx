// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaterialRecord, ReadApi, RenderingFeedback } from "../../shared/contracts";
import { deferred, flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { FeedbackSheet, INCLUDE_CAPTURE_KEY, RUNNING_NOTE } from "./FeedbackSheet";
import { finishSentence } from "./FeedbackDone";
import { DEFAULT_PREFS, setReadingPrefs } from "./readingPrefs";
import type { ReportRequest, ReportSelection } from "./reportRequest";

type Progress = Parameters<Parameters<ReadApi["onFeedbackProgress"]>[0]>[0];

const quality: MaterialRecord["quality"] = { completeness: "declared_full", conformance: "recoverable", identityConfidence: "strong", safety: "safe", warnings: [] };
const material: MaterialRecord = {
  id: "a1b2c3d4e5f60718", url: "https://example.org/post", finalUrl: "https://example.org/post?x=1", title: "A post", fetchedAt: "2026-09-20T10:00:00.000Z", readingMinutes: 4, origin: "web", mediaType: "text/html",
  quality, tags: [], kind: "webpage", readyViews: ["web"], extracted: {}, meta: {}, views: [{ id: "web", label: "Web", url: "https://example.org/post", mediaType: "text/html", status: "ready" }], primaryView: "web",
  problems: [{ code: "SOURCE_ARTICLE_READABILITY_QUALITY_LOW", severity: "warning", scope: "candidate", recoverBy: "generic-fallback" } as MaterialRecord["problems"][number]],
  capture: { byteLength: 48_211, mediaType: "text/html" },
};
const pdfMaterial: MaterialRecord = {
  ...material, id: "0f0e0d0c0b0a0908", mediaType: "application/pdf", readyViews: ["pdf"], primaryView: "pdf", pdf: { pages: 12, byteLength: 1_258_291, textLayer: "available" },
  views: [{ id: "pdf", label: "PDF", url: "https://example.org/paper.pdf", mediaType: "application/pdf", status: "ready" }],
};
const packaged: RenderingFeedback = {
  id: "fb1", createdAt: "2026-10-13T09:00:00.000Z", materialId: material.id, url: material.finalUrl, title: material.title, view: "web", kinds: [], note: "",
  app: { version: "test", platform: "darwin", normalize: "0.1" }, quality, problems: material.problems, capture: { included: true, byteLength: 48_211, mediaType: "text/html" }, bundleDir: "/data/feedback/fb1",
  package: { zipPath: "/data/feedback/fb1/quire-report-a-post-fb1.zip", zipBytes: 3_400_000, screenshots: ["screenshots/reader-viewport.png", "screenshots/composite.png"], composite: "screenshots/composite.png", issueOpened: true, revealed: true, copiedToClipboard: true, warnings: [] },
};
const VIEWPORT = { x: 240, y: 52, width: 900, height: 700, scrollFraction: 0.42 };
const PASSAGE: ReportSelection = { locator: "text-quote:v2:x", quote: "the table lost its header row", prefix: "As shown, ", suffix: " in the output.", rect: { x: 300, y: 380, width: 220, height: 40 } };

let progress: ((value: Progress) => void) | undefined;

function mount({ record = material, view = "web" as const, selection, measured = { viewport: VIEWPORT }, overrides = {} }: { record?: MaterialRecord; view?: "web" | "pdf"; selection?: ReportSelection; measured?: ReturnType<ReportRequest["measure"]>; overrides?: Partial<ReadApi> } = {}) {
  const onClose = vi.fn();
  const measure = vi.fn(() => measured);
  api.read = mockRead({
    platform: "darwin",
    feedbackSubmit: vi.fn(async () => packaged),
    onFeedbackProgress: (listener) => { progress = listener; return () => { progress = undefined; }; },
    ...overrides,
  });
  const request: ReportRequest = { measure, ...(selection ? { selection } : {}) };
  render(<FeedbackSheet isOpen material={record} view={view} request={request} nonce={1} onClose={onClose} />);
  return { onClose, measure };
}
const dialog = () => screen.getByRole("dialog");
const button = (name: string) => within(dialog()).getByRole("button", { name });
const press = async (element: Element) => { await act(async () => { fireEvent.click(element); await flush(); }); };
const overlay = () => dialog().closest(".fixed") as HTMLElement;

beforeEach(() => {
  localStorage.clear();
  setReadingPrefs(DEFAULT_PREFS);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); progress = undefined; });

describe("FeedbackSheet › the one step", () => {
  it("asks for nothing: the problems and the note are optional, the original goes along by default, and the summary says what is included", () => {
    mount();
    const sheet = dialog();
    expect(within(sheet).getByRole("heading", { name: "Report a problem" })).toBeTruthy();
    expect(within(within(sheet).getByRole("toolbar", { name: /What went wrong/ })).getAllByRole("button")).toHaveLength(9);
    expect((within(sheet).getByRole("checkbox", { name: /Include the original page/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(sheet).getByText(/^What's included:/).parentElement!.textContent).toBe("What's included: snapshot · extraction · screenshots of the reader and the original page · versions");
    const details = sheet.querySelector('dl[aria-label="Included in the report"]')!;
    expect(details.textContent).toContain("The saved page (47 KB · text/html, as page.html.gz)");
    expect(details.textContent).toContain("web extract · partial");
    expect(details.textContent).toContain("1 extractor note");
    expect(details.textContent).toContain("https://example.org/post?x=1");
    expect(details.textContent).toContain("Quire test");
    expect(button("Report").hasAttribute("disabled") || button("Report").getAttribute("aria-disabled") === "true").toBe(false);
  });

  it("hands feedbackSubmit the view, the empty choices, the original by default, the viewport measured at submit time and the reading settings", async () => {
    setReadingPrefs({ ...DEFAULT_PREFS, font: "serif", size: 20 });
    const { measure } = mount();
    expect(measure).not.toHaveBeenCalled();
    await press(button("Report"));
    expect(measure).toHaveBeenCalledWith(undefined);
    expect(api.read.feedbackSubmit).toHaveBeenCalledWith({
      materialId: material.id, view: "web", kinds: [], note: "", includeCapture: true, viewport: VIEWPORT,
      prefs: { ...DEFAULT_PREFS, font: "serif", size: 20 },
    });
  });

  it("passes the chosen problems, the note and an unchecked original, and remembers the choice", async () => {
    mount();
    await press(button("Figures missing or wrong"));
    await press(button("Text or sections are missing"));
    fireEvent.change(within(dialog()).getByLabelText("Note (optional)"), { target: { value: "The second figure is gone." } });
    await press(within(dialog()).getByRole("checkbox", { name: /Include the original page/ }));
    expect(localStorage.getItem(INCLUDE_CAPTURE_KEY)).toBe("off");
    expect(within(dialog()).getByText(/^What's included:/).parentElement!.textContent).toBe("What's included: extraction · screenshots of the reader · versions");
    await press(button("Report"));
    expect(api.read.feedbackSubmit).toHaveBeenCalledWith(expect.objectContaining({ kinds: ["missing_content", "images"], note: "The second figure is gone.", includeCapture: false }));
  });

  it("hides the original checkbox when there is nothing to include, and sends includeCapture false", async () => {
    const { capture: _capture, ...bare } = material;
    mount({ record: bare });
    expect(within(dialog()).queryByRole("checkbox")).toBeNull();
    expect(within(dialog()).getByText(/^What's included:/).parentElement!.textContent).not.toContain("snapshot");
    await press(button("Report"));
    expect(api.read.feedbackSubmit).toHaveBeenCalledWith(expect.objectContaining({ includeCapture: false }));
  });

  it("offers the PDF itself as the original of a PDF", () => {
    mount({ record: pdfMaterial, view: "pdf" });
    expect(within(dialog()).getByRole("checkbox", { name: /Include the original page/ })).toBeTruthy();
    expect(dialog().textContent).toContain("The PDF (1.2 MB)");
  });
});

describe("FeedbackSheet › an attached passage", () => {
  it("shows the quote, and sends it with its context and the box measured at submit time", async () => {
    const { measure } = mount({ selection: PASSAGE, measured: { viewport: VIEWPORT, selectionRect: { x: 300, y: 300, width: 220, height: 40 } } });
    expect(within(dialog()).getByRole("figure", { name: "Selected passage" }).textContent).toContain("the table lost its header row");
    await press(button("Report"));
    expect(measure).toHaveBeenCalledWith(PASSAGE);
    expect(api.read.feedbackSubmit).toHaveBeenCalledWith(expect.objectContaining({
      selection: { quote: "the table lost its header row", prefix: "As shown, ", suffix: " in the output.", rect: { x: 300, y: 300, width: 220, height: 40 } },
    }));
  });

  it("keeps the box from when Report was pressed when the reader cannot find the passage again", async () => {
    mount({ selection: PASSAGE });
    await press(button("Report"));
    expect(api.read.feedbackSubmit).toHaveBeenCalledWith(expect.objectContaining({ selection: expect.objectContaining({ rect: PASSAGE.rect }) }));
  });

  it("× detaches it: the report goes without a selection", async () => {
    const { measure } = mount({ selection: PASSAGE });
    await press(button("Detach the passage"));
    expect(within(dialog()).queryByRole("figure", { name: "Selected passage" })).toBeNull();
    await press(button("Report"));
    expect(measure).toHaveBeenCalledWith(undefined);
    expect(vi.mocked(api.read.feedbackSubmit).mock.calls[0]![0]).not.toHaveProperty("selection");
  });
});

describe("FeedbackSheet › while it runs", () => {
  it("shows each progress step, is transparent while the reader is captured, cannot be closed, and says why", async () => {
    const pending = deferred<RenderingFeedback>();
    const { onClose } = mount({ overrides: { feedbackSubmit: vi.fn(() => pending.promise) } });
    await press(button("Report"));
    expect(within(dialog()).getByRole("status").textContent).toBe("Capturing the reader…");
    expect(within(dialog()).getByText(RUNNING_NOTE)).toBeTruthy();
    expect(button("Reporting…")).toBeTruthy();
    expect(overlay().style.opacity).toBe("0");
    act(() => { progress?.({ id: "fb1", step: "rendering-original", message: "" }); });
    expect(within(dialog()).getByRole("status").textContent).toBe("Rendering the original page…");
    expect(overlay().style.opacity).toBe("");
    act(() => { progress?.({ id: "fb1", step: "packaging", message: "Packaging 6 files…" }); });
    expect(within(dialog()).getByRole("status").textContent).toBe("Packaging 6 files…");
    await act(async () => { fireEvent.keyDown(dialog(), { key: "Escape" }); await flush(); });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(packaged); await flush(); });
    expect(within(dialog()).getByRole("heading", { name: "Report packaged" })).toBeTruthy();
  });

  it("shows the bridge's refusal inline and lets the reader try again", async () => {
    mount({ overrides: { feedbackSubmit: vi.fn(async () => { throw new Error("The original page never finished loading (timeout after 15 s)."); }) } });
    await press(button("Report"));
    expect(within(dialog()).getByRole("alert").textContent).toBe("The original page never finished loading (timeout after 15 s).");
    expect(button("Report")).toBeTruthy();
    expect(within(dialog()).queryByRole("status")).toBeNull();
  });
});

describe("FeedbackSheet › packaged", () => {
  async function submit(overrides: Partial<ReadApi> = {}) {
    const handles = mount({ overrides });
    await press(button("Report"));
    return handles;
  }

  it("says how to finish in one sentence, and redoes each step through the bridge", async () => {
    await submit({ feedbackCopyScreenshot: vi.fn(async () => undefined), feedbackOpenIssue: vi.fn(async () => undefined), feedbackReveal: vi.fn(async () => undefined) });
    expect(dialog().textContent).toContain("In the GitHub issue that just opened: press ⌘V to paste the screenshot, then drag quire-report-a-post-fb1.zip (shown in Finder) into the box.");
    await press(button("Copy screenshot again"));
    expect(api.read.feedbackCopyScreenshot).toHaveBeenCalledWith("fb1");
    expect(within(dialog()).getByRole("status").textContent).toBe("The screenshot is on the clipboard.");
    await press(button("Open issue again"));
    expect(api.read.feedbackOpenIssue).toHaveBeenCalledWith("fb1");
    await press(button("Show zip"));
    expect(api.read.feedbackReveal).toHaveBeenCalledWith("fb1");
    expect(within(dialog()).queryByRole("alert")).toBeNull();
  });

  it("lists the capture warnings", async () => {
    const warned = { ...packaged, package: { ...packaged.package!, warnings: ["The original page did not finish loading; its screenshot shows what had loaded."] } };
    await submit({ feedbackSubmit: vi.fn(async () => warned) });
    expect(within(within(dialog()).getByRole("list", { name: "Capture warnings" })).getByRole("listitem").textContent).toContain("did not finish loading");
  });

  it("shows a failed step inline", async () => {
    await submit({ feedbackReveal: vi.fn(async () => { throw new Error("The zip is gone."); }) });
    await press(button("Show zip"));
    expect(within(dialog()).getByRole("alert").textContent).toBe("The zip is gone.");
  });

  it("stores a pasted issue link on Enter", async () => {
    const feedbackSetIssueUrl = vi.fn(async (_id: string, issueUrl: string) => ({ ...packaged, issueUrl }));
    await submit({ feedbackSetIssueUrl });
    const field = within(dialog()).getByLabelText("Paste the issue link (optional)");
    fireEvent.change(field, { target: { value: " https://github.com/Leonezz/quire/issues/12 " } });
    await act(async () => { fireEvent.keyDown(field, { key: "Enter" }); await flush(); });
    expect(feedbackSetIssueUrl).toHaveBeenCalledWith("fb1", "https://github.com/Leonezz/quire/issues/12");
    expect(within(dialog()).getByText("Saved on the report.")).toBeTruthy();
  });

  it("Done closes the panel", async () => {
    const { onClose } = await submit();
    await press(button("Done"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("finishSentence", () => {
  it("leaves out what the main process could not do", () => {
    const pkg = { ...packaged.package!, issueOpened: false, revealed: false, copiedToClipboard: false };
    api.read = mockRead({ platform: "darwin" });
    expect(finishSentence(pkg)).toBe("In the GitHub issue (Open issue again opens it): drag quire-report-a-post-fb1.zip (Show zip finds it) into the box.");
  });
});

describe("FeedbackSheet › closing", () => {
  it("Esc closes the panel when nothing is running", async () => {
    const { onClose } = mount();
    await act(async () => { fireEvent.keyDown(dialog(), { key: "Escape" }); await flush(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
