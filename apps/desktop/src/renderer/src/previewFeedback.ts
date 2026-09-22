import type { MaterialRecord, ReadApiFeedback, RenderingFeedback, RenderingFeedbackDraft } from "../../shared/contracts";
import { RENDERING_PROBLEM_KINDS } from "../../shared/contracts";
import { PROBLEM_KIND_LABELS } from "./feedbackKinds";

// The browser preview's rendering feedback: the records live in localStorage, no bundle is written, and
// "Open GitHub issue" opens the prefilled issue in a new tab the way the desktop app opens it in the browser.
// Revealing a bundle needs Finder, so the preview refuses it with a message (an explicit preview limit).

export const PREVIEW_FEEDBACK_KEY = "read:preview-feedback";
const ISSUE_URL = "https://github.com/Leonezz/quire/issues/new";
const PREVIEW_BUNDLE_ROOT = "~/Library/Application Support/Quire/feedback";
const MAX_NOTE_LENGTH = 4000;

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
    `**URL:** ${record.url}`, `**View:** ${record.view}`, `**Problems:** ${record.kinds.map((kind) => PROBLEM_KIND_LABELS[kind]).join(", ")}`,
    `**Quality:** ${record.quality.completeness} · ${record.quality.conformance} · ${record.quality.safety}`, `**Extractor notes:** ${record.problems.length}`,
    `**App:** ${record.app.version} (${record.app.platform}) · normalize ${record.app.normalize}`, "",
    record.note ? `${record.note}\n` : "", "_Bundle: attach the feedback folder revealed by the app; the saved page is not in this link._",
  ].join("\n");
  const params = new URLSearchParams({ title, body, labels: "rendering" });
  return `${ISSUE_URL}?${params.toString()}`;
}

function validateDraft(draft: RenderingFeedbackDraft): RenderingFeedbackDraft {
  const kinds = [...new Set(draft.kinds)];
  if (kinds.length === 0) throw new Error("Choose at least one problem.");
  const unknown = kinds.filter((kind) => !RENDERING_PROBLEM_KINDS.includes(kind));
  if (unknown.length) throw new Error(`Unknown problem kind(s): ${unknown.join(", ")}.`);
  if (draft.note.length > MAX_NOTE_LENGTH) throw new Error(`The note must be at most ${MAX_NOTE_LENGTH} characters.`);
  return { ...draft, kinds, note: draft.note.trim() };
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

  return {
    feedbackCreate: async (raw) => {
      const draft = validateDraft(raw);
      const material = await getMaterial(draft.materialId);
      if (!material) throw new Error("This material is no longer in the library.");
      if (draft.includeCapture && !material.capture) throw new Error("This material has no saved original page to include.");
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const record: RenderingFeedback = {
        id, createdAt: new Date().toISOString(), materialId: material.id, url: material.finalUrl || material.url, title: material.title,
        view: draft.view, kinds: draft.kinds, note: draft.note,
        app: { version: "preview", platform: "browser", normalize: "preview" },
        quality: material.quality, problems: material.problems,
        capture: draft.includeCapture && material.capture ? { included: true, byteLength: material.capture.byteLength, mediaType: material.capture.mediaType } : { included: false },
        bundleDir: `${PREVIEW_BUNDLE_ROOT}/${id} (preview: nothing is written here)`,
      };
      write([record, ...readAll()]);
      return record;
    },
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
