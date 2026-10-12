import type { MaterialRecord, ReadApiFeedback, RenderingFeedback, RenderingFeedbackDraft, RenderingFeedbackPackage } from "../../shared/contracts";
import { RENDERING_PROBLEM_KINDS } from "../../shared/contracts";
import { PROBLEM_KIND_LABELS } from "./feedbackKinds";

// The browser preview's rendering feedback: the records live in localStorage, no bundle is written, and
// "Open GitHub issue" opens the prefilled issue in a new tab the way the desktop app opens it in the browser.
// Revealing a bundle needs Finder, so the preview refuses it with a message (an explicit preview limit).
// The one-step report (feedbackSubmit) walks through the progress steps on timers and returns a record whose
// package names a zip under a fake path: nothing is captured, zipped or put on the clipboard in a browser.

export const PREVIEW_FEEDBACK_KEY = "read:preview-feedback";
const ISSUE_URL = "https://github.com/Leonezz/quire/issues/new";
const PREVIEW_BUNDLE_ROOT = "~/Library/Application Support/Quire/feedback";
const MAX_NOTE_LENGTH = 4000;
/** How long each faked progress step lasts, so the panel's progress can be watched. */
export const PREVIEW_STEP_MS = 450;
type Progress = Parameters<Parameters<ReadApiFeedback["onFeedbackProgress"]>[0]>[0];
const PREVIEW_STEPS: Progress["step"][] = ["capturing", "rendering-original", "packaging", "opening"];
const PREVIEW_MESSAGES: Record<Progress["step"], string> = { capturing: "Capturing the reader…", "rendering-original": "Rendering the original page…", packaging: "Packaging…", opening: "Opening the issue…" };

function readAll(): RenderingFeedback[] {
  const raw = localStorage.getItem(PREVIEW_FEEDBACK_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as RenderingFeedback[]; }
  catch (error) { throw new Error(`Preview feedback unreadable (${(error as Error).message}); clear localStorage key ${PREVIEW_FEEDBACK_KEY}.`); }
}

/** The prefilled issue, as the desktop app builds it: the record's facts, never the capture. */
export function issueUrlOf(record: RenderingFeedback): string {
  const title = `Rendering problem: ${record.title}`;
  const body = [
    `**URL:** ${record.url}`, `**View:** ${record.view}`, `**Problems:** ${record.kinds.length ? record.kinds.map((kind) => PROBLEM_KIND_LABELS[kind]).join(", ") : "not given"}`,
    `**Quality:** ${record.quality.completeness} · ${record.quality.conformance} · ${record.quality.safety}`, `**Extractor notes:** ${record.problems.length}`,
    `**App:** ${record.app.version} (${record.app.platform}) · normalize ${record.app.normalize}`, "",
    record.note ? `${record.note}\n` : "", "_Bundle: attach the feedback folder revealed by the app; the saved page is not in this link._",
  ].join("\n");
  const params = new URLSearchParams({ title, body, labels: "rendering" });
  return `${ISSUE_URL}?${params.toString()}`;
}

function validateDraft(draft: RenderingFeedbackDraft, { requireKinds }: { requireKinds: boolean }): RenderingFeedbackDraft {
  const kinds = [...new Set(draft.kinds)];
  if (requireKinds && kinds.length === 0) throw new Error("Choose at least one problem.");
  const unknown = kinds.filter((kind) => !RENDERING_PROBLEM_KINDS.includes(kind));
  if (unknown.length) throw new Error(`Unknown problem kind(s): ${unknown.join(", ")}.`);
  if (draft.note.length > MAX_NOTE_LENGTH) throw new Error(`The note must be at most ${MAX_NOTE_LENGTH} characters.`);
  return { ...draft, kinds, note: draft.note.trim() };
}

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** The original a preview report would carry: the capture, or the PDF. */
function originalOfPreview(material: MaterialRecord): { byteLength: number; mediaType: string } | undefined {
  if (material.capture) return material.capture;
  const pdf = material.pdf ?? material.views.find((view) => view.id === "pdf" && view.status === "ready")?.pdf;
  return pdf ? { byteLength: pdf.byteLength, mediaType: "application/pdf" } : undefined;
}

const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "page";

/**
 * What the desktop app would have produced, named as it names it; the sizes are made up (nothing is captured).
 * The issue really opens (a new tab); the zip cannot be shown (no Finder); the clipboard copy is pretended so the
 * done state reads as it does in the app — the preview has no screenshot to copy.
 */
function previewPackage(record: RenderingFeedback, draft: RenderingFeedbackDraft): RenderingFeedbackPackage {
  const original = draft.includeCapture;
  const screenshots = [
    "screenshots/reader-viewport.png",
    ...(draft.selection ? ["screenshots/reader-selection.png"] : []),
    "screenshots/reader-article.jpg",
    ...(original ? ["screenshots/original-top.png", ...(draft.selection ? ["screenshots/original-selection.png"] : [])] : []),
    "screenshots/composite.png",
  ];
  return {
    zipPath: `${PREVIEW_BUNDLE_ROOT}/${record.id}/quire-report-${slugOf(record.title)}-${record.id}.zip`,
    zipBytes: 1_400_000 + (record.capture.byteLength ?? 0) + screenshots.length * 180_000,
    screenshots, composite: "screenshots/composite.png",
    issueOpened: true, revealed: false, copiedToClipboard: true, warnings: [],
  };
}

export function createPreviewFeedback({ getMaterial }: { getMaterial: (id: string) => Promise<MaterialRecord | undefined> }): ReadApiFeedback {
  const listeners = new Set<() => void>();
  const write = (records: RenderingFeedback[]) => {
    localStorage.setItem(PREVIEW_FEEDBACK_KEY, JSON.stringify(records));
    for (const listener of listeners) listener();
  };
  const requireRecord = (id: string): RenderingFeedback => {
    const record = readAll().find((entry) => entry.id === id);
    if (!record) throw new Error("This report is no longer saved.");
    return record;
  };

  const progressListeners = new Set<(progress: Progress) => void>();
  const recordOf = async (draft: RenderingFeedbackDraft): Promise<RenderingFeedback> => {
    const material = await getMaterial(draft.materialId);
    if (!material) throw new Error("This material is no longer in the library.");
    const original = originalOfPreview(material);
    if (draft.includeCapture && !original) throw new Error("This material has no saved original page to include.");
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      id, createdAt: new Date().toISOString(), materialId: material.id, url: material.finalUrl || material.url, title: material.title,
      view: draft.view, kinds: draft.kinds, note: draft.note,
      app: { version: "preview", platform: "browser", normalize: "preview" },
      quality: material.quality, problems: material.problems,
      capture: draft.includeCapture && original ? { included: true, byteLength: original.byteLength, mediaType: original.mediaType } : { included: false },
      bundleDir: `${PREVIEW_BUNDLE_ROOT}/${id} (preview: nothing is written here)`,
    };
  };

  return {
    feedbackCreate: async (raw) => {
      const record = await recordOf(validateDraft(raw, { requireKinds: true }));
      write([record, ...readAll()]);
      return record;
    },
    feedbackSubmit: async ({ prefs, ...raw }) => {
      const draft = validateDraft(raw, { requireKinds: false });
      const base = await recordOf(draft);
      const steps = PREVIEW_STEPS.filter((step) => step !== "rendering-original" || draft.includeCapture);
      for (const step of steps) {
        for (const listener of progressListeners) listener({ id: base.id, step, message: PREVIEW_MESSAGES[step] });
        await wait(PREVIEW_STEP_MS);
      }
      const record: RenderingFeedback = {
        ...base, package: previewPackage(base, draft),
        ...(draft.selection ? { selection: { quote: draft.selection.quote, prefix: draft.selection.prefix, suffix: draft.selection.suffix } } : {}),
        readerState: { scrollFraction: draft.viewport?.scrollFraction ?? 0, prefs },
      };
      write([record, ...readAll()]);
      // As the desktop app does: the prefilled issue opens in the browser.
      window.open(issueUrlOf(record), "_blank", "noopener");
      return record;
    },
    onFeedbackProgress: (listener) => { progressListeners.add(listener); return () => { progressListeners.delete(listener); }; },
    // Nothing to copy in a browser (no composite exists); the preview resolves so the done state can be walked through.
    feedbackCopyScreenshot: async (id) => { requireRecord(id); },
    feedbackList: async () => [...readAll()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    feedbackDelete: async (id) => { requireRecord(id); write(readAll().filter((entry) => entry.id !== id)); },
    feedbackOpenIssue: async (id) => { window.open(issueUrlOf(requireRecord(id)), "_blank", "noopener"); },
    feedbackSetIssueUrl: async (id, issueUrl) => {
      const trimmed = issueUrl.trim();
      if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+\/?$/.test(trimmed)) throw new Error("Paste the link of a GitHub issue (https://github.com/<owner>/<repo>/issues/<number>).");
      const record = { ...requireRecord(id), issueUrl: trimmed };
      write(readAll().map((entry) => (entry.id === id ? record : entry)));
      return record;
    },
    feedbackReveal: async (id) => { requireRecord(id); throw new Error("The bundle is revealed in Finder by the desktop app; the browser preview keeps its reports in localStorage only."); },
    onFeedbackChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
