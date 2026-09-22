import { useEffect, useState } from "react";
import { ExternalLink, FolderOpen, Trash2 } from "lucide-react";
import { Button, Chip, ConfirmSheet } from "@read/ui";
import type { RenderingFeedback } from "../../shared/contracts";
import { read } from "./api";
import { PROBLEM_KIND_LABELS } from "./feedbackKinds";

// Settings › Feedback: every rendering report saved on this Mac, newest first, with the way to its issue
// and its bundle. The list follows the bridge's change notice, so a report saved from the reader shows up
// while the sheet is open. Nothing here sends anything.

export const FEEDBACK_EMPTY_MESSAGE = "Reports stay on this Mac until you attach them to a GitHub issue.";
const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}
const dateOf = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function ReportRow({ report, onOpenLink, onError, onDelete }: { report: RenderingFeedback; onOpenLink: (url: string) => void; onError: (message: string | undefined) => void; onDelete: () => void }) {
  const run = (action: () => Promise<void>, fallback: string) => async () => {
    onError(undefined);
    try { await action(); } catch (cause: unknown) { onError(message(cause, fallback)); }
  };
  const issueUrl = report.issueUrl;
  return (
    <li className="grid gap-1.5 border-t border-separator-soft py-2.5 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px]">
        <strong className="min-w-0 truncate font-semibold text-label">{report.title}</strong>
        <span className="text-[12px] text-label-3">{hostOf(report.url)} · {report.view} · {dateOf(report.createdAt)}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {report.kinds.map((kind) => <Chip key={kind}>{PROBLEM_KIND_LABELS[kind]}</Chip>)}
        {issueUrl ? <Chip tone="accent">Issue filed</Chip> : null}
        {report.capture.included ? <Chip>Page included</Chip> : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {issueUrl
          ? <Button size="sm" variant="plain" className="gap-1" onPress={() => onOpenLink(issueUrl)}><ExternalLink />Open filed issue</Button>
          : <Button size="sm" variant="plain" className="gap-1" onPress={() => void run(() => read.feedbackOpenIssue(report.id), "Could not open the issue.")()}><ExternalLink />Open issue</Button>}
        <Button size="sm" variant="quiet" className="gap-1" onPress={() => void run(() => read.feedbackReveal(report.id), "Could not reveal the bundle.")()}><FolderOpen />Reveal bundle</Button>
        <Button size="sm" variant="quiet" className="gap-1 text-red-text" onPress={onDelete}><Trash2 />Delete</Button>
      </div>
    </li>
  );
}

export function FeedbackSection({ onOpenLink }: { onOpenLink: (url: string) => void }) {
  const [reports, setReports] = useState<RenderingFeedback[] | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<RenderingFeedback | undefined>(undefined);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const load = () => read.feedbackList()
      .then((list) => { if (cancelled) return; setReports([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))); setLoadError(undefined); })
      .catch((cause: unknown) => { if (!cancelled) setLoadError(message(cause, "Could not load the reports.")); });
    void load();
    const unsubscribe = read.onFeedbackChanged(() => { void load(); });
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  const confirmDelete = async () => {
    if (!pending) return;
    setDeleting(true); setDeleteError(undefined);
    try {
      await read.feedbackDelete(pending.id);
      setReports((current) => current?.filter((report) => report.id !== pending.id));
      setPending(undefined);
    } catch (cause: unknown) {
      setDeleteError(message(cause, "Could not delete the report."));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="grid gap-2">
      {loadError ? <p role="alert" className="m-0 rounded-card bg-red-soft px-3 py-2 text-[12.5px] text-red-text">{loadError}</p> : null}
      {actionError ? <p role="alert" className="m-0 rounded-card bg-red-soft px-3 py-2 text-[12.5px] text-red-text">{actionError}</p> : null}
      {reports === undefined && !loadError ? <p className="m-0 text-[12.5px] text-label-3">Reading the reports…</p> : null}
      {reports?.length === 0 ? <p className="m-0 text-[12.5px] text-label-3">{FEEDBACK_EMPTY_MESSAGE}</p> : null}
      {reports?.length ? (
        <ul aria-label="Rendering reports" className="m-0 grid list-none p-0">
          {reports.map((report) => <ReportRow key={report.id} report={report} onOpenLink={onOpenLink} onError={setActionError} onDelete={() => { setDeleteError(undefined); setPending(report); }} />)}
        </ul>
      ) : null}
      <ConfirmSheet isOpen={pending !== undefined} title="Delete this report?" message={`The bundle for “${pending?.title ?? ""}” is removed from this Mac. An issue already filed stays on GitHub.`}
        confirmLabel="Delete" busyLabel="Deleting…" busy={deleting} error={deleteError} onConfirm={() => void confirmDelete()} onCancel={() => { if (!deleting) setPending(undefined); }} />
    </div>
  );
}
