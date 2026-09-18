import { useState } from "react";
import { History, X } from "lucide-react";
import { Button, ConfirmSheet, DialogTrigger, Popover } from "@read/ui";
import type { AgentSessionSummary } from "../../shared/contracts";
import { relativeTime } from "./format";

/** "3 turns · 5 min ago" under a session's title. */
export function sessionMeta(session: AgentSessionSummary): string {
  return `${session.turnCount} ${session.turnCount === 1 ? "turn" : "turns"} · ${relativeTime(session.updatedAt)}`;
}

/**
 * The confirmation before a conversation is deleted: it cannot be undone. `onDelete` rejects with
 * the reason when it fails, which the sheet shows without closing.
 */
export function DeleteSessionSheet({ session, onDelete, onClose }: { session: AgentSessionSummary | undefined; onDelete: (id: string) => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const confirm = async () => {
    if (!session) return;
    setBusy(true); setError(undefined);
    try { await onDelete(session.id); onClose(); }
    catch (cause: unknown) { setError(cause instanceof Error ? cause.message : "Could not delete the conversation."); }
    finally { setBusy(false); }
  };
  return (
    <ConfirmSheet isOpen={session !== undefined} title={`Delete “${session?.title ?? ""}”?`} message="The conversation and its answers are removed; this cannot be undone. Artifacts it wrote stay in the library."
      confirmLabel="Delete" busyLabel="Deleting…" busy={busy} error={error} onConfirm={() => void confirm()} onCancel={() => { if (!busy) { setError(undefined); onClose(); } }} />
  );
}

/**
 * The History button in the panel's context row: a popover listing this context's conversations,
 * most recent first; a row opens it, its × asks before deleting.
 */
export function SessionsMenu({ sessions, currentId, onOpen, onDelete }: { sessions: readonly AgentSessionSummary[]; currentId: string | undefined; onOpen: (id: string) => void; onDelete: (id: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<AgentSessionSummary | undefined>(undefined);
  return (
    <>
      <DialogTrigger isOpen={open} onOpenChange={setOpen}>
        <Button variant="quiet" size="sm" aria-label={`Conversations (${sessions.length})`} className="size-7 min-w-0 shrink-0 px-0"><History className="size-3.5" /></Button>
        <Popover aria-label="Conversations" placement="bottom end" className="w-[300px] p-2">
          {sessions.length === 0 ? <p className="m-0 px-2 py-1.5 text-[12.5px] text-label-3">No conversations yet.</p> : null}
          <ul className="m-0 grid max-h-[320px] list-none gap-px overflow-y-auto p-0">
            {sessions.map((session) => (
              <li key={session.id} className={`group flex items-center gap-1 rounded-control ${session.id === currentId ? "bg-accent-soft" : "hover:bg-fill"}`}>
                <button type="button" className="min-w-0 flex-1 cursor-default border-0 bg-transparent px-2 py-1.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-accent-ring rounded-control" aria-current={session.id === currentId ? "true" : undefined}
                  onClick={() => { setOpen(false); onOpen(session.id); }}>
                  <span className="block truncate text-[13px] font-medium text-label">{session.title}</span>
                  <span className="block truncate text-[11.5px] text-label-3">{sessionMeta(session)}</span>
                </button>
                <Button variant="quiet" size="sm" aria-label={`Delete “${session.title}”`} className="mr-1 size-6 min-w-0 shrink-0 px-0 text-label-3" onPress={() => { setOpen(false); setDeleting(session); }}><X className="size-3.5" /></Button>
              </li>
            ))}
          </ul>
        </Popover>
      </DialogTrigger>
      <DeleteSessionSheet session={deleting} onDelete={onDelete} onClose={() => setDeleting(undefined)} />
    </>
  );
}
