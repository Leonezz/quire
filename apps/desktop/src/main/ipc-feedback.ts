import { ipcMain } from "electron";
import { RENDERING_PROBLEM_KINDS, type RenderingFeedbackDraft, type RenderingProblemKind } from "../shared/contracts";
import { MAX_FEEDBACK_NOTE, type FeedbackStore } from "./engine/feedback";
import { issueUrlFor, type IssueRepo } from "./engine/feedback-issue";
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
}

const MAX_ISSUE_URL = 2_048;

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

function issueUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ISSUE_URL) throw new Error("IPC_INVALID_URL");
  return value;
}

export function registerFeedbackHandlers({ feedback, repo, broadcast, openExternal, showItemInFolder }: FeedbackDeps): void {
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
