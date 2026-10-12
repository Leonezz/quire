import { ipcMain, type WebContents } from "electron";
import { join } from "node:path";
import { RENDERING_PROBLEM_KINDS, type RenderingFeedback, type RenderingFeedbackDraft, type RenderingProblemKind } from "../shared/contracts";
import { MAX_FEEDBACK_NOTE, type FeedbackStore, type SubmitDraft } from "./engine/feedback";
import { issueUrlFor, type IssueRepo } from "./engine/feedback-issue";
import { submitFeedback, type Capturer, type FeedbackProgress } from "./engine/feedback-submit";
import { isMaterialViewId } from "./engine/material-views";

// Rendering feedback handlers. Same rule as index.ts: validate every argument before touching
// the store, broadcast feedback:changed after every change the Settings list must see.

export type FeedbackChannel = "feedback:changed";

export interface FeedbackDeps {
  feedback: FeedbackStore;
  /** Where "Open GitHub issue" files the report. */
  repo: IssueRepo;
  broadcast: (channel: FeedbackChannel) => void;
  openExternal: (url: string) => Promise<void>;
  /** Reveals the bundle directory in the file manager. */
  showItemInFolder: (path: string) => void;
  /** The screenshots of a one-step report, taken in (and around) the window that asked for it. */
  capturerFor: (sender: WebContents) => Capturer;
  /** Broadcasts feedback:progress. */
  progress: (progress: FeedbackProgress) => void;
  /** Puts the PNG at `path` on the clipboard; rejects when it cannot. */
  copyImageToClipboard: (path: string) => Promise<void>;
}

const MAX_ISSUE_URL = 2_048;
const MAX_QUOTE = 20_000;
const MAX_CONTEXT = 2_000;
const MAX_PIXELS = 100_000;
const MAX_PREFS_JSON = 10_000;

function feedbackId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{16}$/.test(value)) throw new Error("IPC_INVALID_ID");
  return value;
}

function problemKinds(value: unknown): RenderingProblemKind[] {
  if (!Array.isArray(value) || value.length > RENDERING_PROBLEM_KINDS.length) throw new Error("IPC_INVALID_FEEDBACK_KINDS");
  if (!value.every((kind) => RENDERING_PROBLEM_KINDS.includes(kind as RenderingProblemKind))) throw new Error("IPC_INVALID_FEEDBACK_KINDS");
  return value as RenderingProblemKind[];
}

export function feedbackDraft(value: unknown): RenderingFeedbackDraft {
  const draft = value as { materialId?: unknown; view?: unknown; kinds?: unknown; note?: unknown; includeCapture?: unknown } | undefined;
  if (!draft || typeof draft !== "object") throw new Error("IPC_INVALID_FEEDBACK");
  if (!isMaterialViewId(draft.view)) throw new Error("IPC_INVALID_VIEW");
  if (typeof draft.note !== "string" || draft.note.length > MAX_FEEDBACK_NOTE) throw new Error("IPC_INVALID_FEEDBACK_NOTE");
  if (typeof draft.includeCapture !== "boolean") throw new Error("IPC_INVALID_FLAG");
  return { materialId: feedbackId(draft.materialId), view: draft.view, kinds: problemKinds(draft.kinds), note: draft.note, includeCapture: draft.includeCapture };
}

function finite(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error("IPC_INVALID_FEEDBACK_GEOMETRY");
  return value;
}

function rect(value: unknown): { x: number; y: number; width: number; height: number } {
  const box = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | undefined;
  if (!box || typeof box !== "object") throw new Error("IPC_INVALID_FEEDBACK_GEOMETRY");
  return { x: finite(box.x, -MAX_PIXELS, MAX_PIXELS), y: finite(box.y, -MAX_PIXELS, MAX_PIXELS), width: finite(box.width, 0, MAX_PIXELS), height: finite(box.height, 0, MAX_PIXELS) };
}

function viewport(value: unknown): NonNullable<RenderingFeedbackDraft["viewport"]> {
  const box = rect(value);
  if (box.width < 1 || box.height < 1) throw new Error("IPC_INVALID_FEEDBACK_GEOMETRY");
  return { ...box, scrollFraction: finite((value as { scrollFraction?: unknown }).scrollFraction, 0, 1) };
}

function boundedText(value: unknown, max: number, code: string, allowEmpty: boolean): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && value.trim().length === 0)) throw new Error(code);
  return value;
}

function selection(value: unknown): NonNullable<RenderingFeedbackDraft["selection"]> {
  const chosen = value as { quote?: unknown; prefix?: unknown; suffix?: unknown; rect?: unknown } | undefined;
  if (!chosen || typeof chosen !== "object") throw new Error("IPC_INVALID_FEEDBACK_SELECTION");
  return {
    quote: boundedText(chosen.quote, MAX_QUOTE, "IPC_INVALID_FEEDBACK_SELECTION", false),
    prefix: boundedText(chosen.prefix, MAX_CONTEXT, "IPC_INVALID_FEEDBACK_SELECTION", true),
    suffix: boundedText(chosen.suffix, MAX_CONTEXT, "IPC_INVALID_FEEDBACK_SELECTION", true),
    rect: rect(chosen.rect),
  };
}

/** The reading settings: a plain object, small once serialized; it is copied through JSON so nothing but data is kept. */
function prefsOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("IPC_INVALID_FEEDBACK_PREFS");
  const json = JSON.stringify(value);
  if (json.length > MAX_PREFS_JSON) throw new Error("IPC_INVALID_FEEDBACK_PREFS");
  return JSON.parse(json) as Record<string, unknown>;
}

/** The one-step report's draft: the form's fields (kinds may be empty), where the reader is, the selection, and the reading settings. */
export function feedbackSubmitDraft(value: unknown): SubmitDraft {
  const base = feedbackDraft(value);
  const draft = value as { viewport?: unknown; selection?: unknown; prefs?: unknown };
  return {
    ...base,
    ...(draft.viewport !== undefined ? { viewport: viewport(draft.viewport) } : {}),
    ...(draft.selection !== undefined ? { selection: selection(draft.selection) } : {}),
    prefs: prefsOf(draft.prefs),
  };
}

function issueUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ISSUE_URL) throw new Error("IPC_INVALID_URL");
  return value;
}

export function registerFeedbackHandlers({ feedback, repo, broadcast, openExternal, showItemInFolder, capturerFor, progress, copyImageToClipboard }: FeedbackDeps): void {
  // One report at a time: each one opens hidden windows and ends by opening the browser and Finder.
  let submitting = false;
  ipcMain.handle("feedback:submit", async (event, draft: unknown): Promise<RenderingFeedback> => {
    const valid = feedbackSubmitDraft(draft);
    if (submitting) throw new Error("A report is already being made; wait for it to finish.");
    submitting = true;
    try {
      return await submitFeedback({ store: feedback, capturer: capturerFor(event.sender), repo, progress, openExternal, showItemInFolder, copyImageToClipboard }, valid);
    } finally {
      submitting = false;
      // A report that failed half-way may still have left its record behind.
      broadcast("feedback:changed");
    }
  });
  ipcMain.handle("feedback:copyScreenshot", async (_event, id: unknown) => {
    const record = await feedback.get(feedbackId(id));
    if (!record) throw new Error(`Feedback ${String(id)} does not exist.`);
    if (!record.package?.composite) throw new Error("This report has no side-by-side screenshot to copy.");
    await copyImageToClipboard(join(record.bundleDir, record.package.composite));
  });
  ipcMain.handle("feedback:create", async (_event, draft: unknown) => {
    const record = await feedback.create(feedbackDraft(draft));
    broadcast("feedback:changed");
    return record;
  });
  ipcMain.handle("feedback:list", () => feedback.list());
  ipcMain.handle("feedback:delete", async (_event, id: unknown) => {
    await feedback.delete(feedbackId(id));
    broadcast("feedback:changed");
  });
  ipcMain.handle("feedback:openIssue", async (_event, id: unknown) => {
    const record = await feedback.get(feedbackId(id));
    if (!record) throw new Error(`Feedback ${String(id)} does not exist.`);
    await openExternal(issueUrlFor(record, repo));
  });
  ipcMain.handle("feedback:setIssueUrl", async (_event, id: unknown, url: unknown) => {
    const record = await feedback.setIssueUrl(feedbackId(id), issueUrl(url));
    broadcast("feedback:changed");
    return record;
  });
  ipcMain.handle("feedback:reveal", async (_event, id: unknown) => {
    const record = await feedback.get(feedbackId(id));
    if (!record) throw new Error(`Feedback ${String(id)} does not exist.`);
    showItemInFolder(feedback.bundleDir(record.id));
  });
}
