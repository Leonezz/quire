import { useState } from "react";
import { ExternalLink, FolderOpen } from "lucide-react";
import { Button, Checkbox, ChoiceChips, Sheet, SheetDialog, SheetFooter, TextField } from "@read/ui";
import type { MaterialRecord, MaterialViewId, RenderingFeedback, RenderingProblemKind } from "../../shared/contracts";
import { read } from "./api";
import { PROBLEM_KIND_OPTIONS, isProblemKind } from "./feedbackKinds";
import { bytesLabel } from "./InfoFacts";
import { viewOf } from "./materialViews";
import { qualityLabel } from "./qualityLabel";

export interface FeedbackSheetProps {
  isOpen: boolean;
  material: MaterialRecord;
  /** The view the reader is looking at: the report is about it. */
  view: MaterialViewId;
  onClose: () => void;
}

/** Whether the saved page goes into the bundle: remembered per machine; the default (on) stands when storage is unavailable. */
export const INCLUDE_CAPTURE_KEY = "read:feedback:includeCapture";
function readIncludeCapture(): boolean {
  try { return localStorage.getItem(INCLUDE_CAPTURE_KEY) !== "off"; }
  catch { return true; }
}
function rememberIncludeCapture(value: boolean) {
  // A convenience only: when it cannot be remembered the next report starts from the default, which the sheet shows.
  try { localStorage.setItem(INCLUDE_CAPTURE_KEY, value ? "on" : "off"); }
  catch { /* storage blocked: the sheet still works from its own state */ }
}

export const SAVED_MESSAGE = "Saved to this Mac. Nothing was sent.";
export const EMPTY_KINDS_MESSAGE = "Choose at least one problem.";
const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-2"><dt className="text-label-3">{label}</dt><dd className="m-0 min-w-0 break-words text-label">{children}</dd></div>;
}

/** Step 1: what went wrong, a note, whether the saved page goes along, and what the report will hold. */
function ReportForm({ material, view, onSaved, onClose }: { material: MaterialRecord; view: MaterialViewId; onSaved: (record: RenderingFeedback) => void; onClose: () => void }) {
  const [kinds, setKinds] = useState<RenderingProblemKind[]>([]);
  const [note, setNote] = useState("");
  const [includeCapture, setIncludeCapture] = useState(readIncludeCapture);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [validation, setValidation] = useState<string | undefined>(undefined);
  const hasCapture = material.capture !== undefined;
  const includes = hasCapture && includeCapture;
  const viewLabel = viewOf(material.views, view)?.label ?? view;
  const quality = qualityLabel(material, { view, quality: material.quality, ...(material.pdf ? { pdf: material.pdf } : {}) });

  const save = async () => {
    if (kinds.length === 0) { setValidation(EMPTY_KINDS_MESSAGE); return; }
    setSaving(true); setError(undefined);
    try {
      onSaved(await read.feedbackCreate({ materialId: material.id, view, kinds, note, includeCapture: includes }));
    } catch (cause: unknown) {
      setError(message(cause, "Could not save the report."));
      setSaving(false);
    }
  };

  return (
    <SheetDialog title="Report a rendering problem" className="max-h-[84vh]">
      <div className="list-scroll -mx-6 grid min-h-0 gap-4 overflow-y-auto px-6">
        <div className="grid gap-2">
          <span id="feedback-kinds-label" className="text-[12.5px] font-medium text-label-2">What went wrong</span>
          <ChoiceChips aria-labelledby="feedback-kinds-label" options={PROBLEM_KIND_OPTIONS} value={kinds} isDisabled={saving}
            onChange={(ids) => { setKinds(ids.filter(isProblemKind)); if (ids.length) setValidation(undefined); }} />
          {validation ? <p role="alert" className="m-0 text-[12px] text-red">{validation}</p> : null}
        </div>
        <TextField label="Note" multiline maxRows={5} placeholder="What you expected, where it goes wrong…" value={note} onChange={setNote} isDisabled={saving} />
        {hasCapture ? (
          <Checkbox isSelected={includeCapture} isDisabled={saving} onChange={(value) => { setIncludeCapture(value); rememberIncludeCapture(value); }}>
            Include the saved original page so it can be reproduced
          </Checkbox>
        ) : null}
        <div className="grid gap-1.5 rounded-card bg-content-2 p-3 text-[12.5px] leading-[17px]">
          <span className="text-[11px] font-semibold uppercase tracking-[.07em] text-label-3">What is saved</span>
          <dl className="m-0 grid gap-1">
            <Fact label="URL">{material.finalUrl || material.url}</Fact>
            <Fact label="Title">{material.title}</Fact>
            <Fact label="View">{viewLabel}</Fact>
            <Fact label="App">{read.version}</Fact>
            <Fact label="Quality">{quality.text}</Fact>
            <Fact label="Problems">{material.problems.length === 1 ? "1 extractor note" : `${material.problems.length} extractor notes`}</Fact>
            {includes && material.capture ? <Fact label="Original page">{bytesLabel(material.capture.byteLength)} · {material.capture.mediaType}</Fact> : null}
          </dl>
        </div>
        {error ? <p role="alert" className="m-0 rounded-card bg-red-soft px-3 py-2 text-[12.5px] text-red-text">{error}</p> : null}
      </div>
      <SheetFooter>
        <Button variant="quiet" onPress={onClose} isDisabled={saving}>Cancel</Button>
        <Button variant="primary" onPress={() => void save()} isDisabled={saving}>{saving ? "Saving…" : "Save report"}</Button>
      </SheetFooter>
    </SheetDialog>
  );
}

/** Step 2: the report is on disk; the reader files the issue and attaches the bundle by hand, and can paste the issue link back. */
function SavedReport({ record, onClose }: { record: RenderingFeedback; onClose: () => void }) {
  const [error, setError] = useState<string | undefined>(undefined);
  const [issueUrl, setIssueUrl] = useState("");
  const [issueSaved, setIssueSaved] = useState<string | undefined>(undefined);
  const [issueError, setIssueError] = useState<string | undefined>(undefined);
  const run = (action: () => Promise<void>, fallback: string) => async () => {
    setError(undefined);
    try { await action(); } catch (cause: unknown) { setError(message(cause, fallback)); }
  };
  const storeIssueUrl = async () => {
    const trimmed = issueUrl.trim();
    if (!trimmed || trimmed === issueSaved) return;
    setIssueError(undefined);
    try { setIssueSaved((await read.feedbackSetIssueUrl(record.id, trimmed)).issueUrl); }
    catch (cause: unknown) { setIssueError(message(cause, "Could not save the issue link.")); }
  };

  return (
    <SheetDialog title="Report saved">
      <p className="m-0 text-[13.5px] text-label-2">{SAVED_MESSAGE} Open a GitHub issue prefilled from the report, then attach the bundle to it.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onPress={() => void run(() => read.feedbackOpenIssue(record.id), "Could not open the issue.")()}><ExternalLink />Open GitHub issue</Button>
        <Button onPress={() => void run(() => read.feedbackReveal(record.id), "Could not reveal the bundle.")()}><FolderOpen />Reveal bundle</Button>
      </div>
      {error ? <p role="alert" className="m-0 rounded-card bg-red-soft px-3 py-2 text-[12.5px] text-red-text">{error}</p> : null}
      <TextField label="Paste the issue link" placeholder="https://github.com/…/issues/123" value={issueUrl} onChange={setIssueUrl}
        onBlur={() => void storeIssueUrl()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void storeIssueUrl(); } }}
        errorMessage={issueError} description={issueSaved ? "Saved on the report." : undefined} />
      <SheetFooter>
        <Button variant="primary" onPress={onClose}>Done</Button>
      </SheetFooter>
    </SheetDialog>
  );
}

/**
 * "Report a rendering problem": what went wrong, in the reader's words, saved as a bundle on this Mac;
 * once saved, the way to a GitHub issue. Nothing is sent by the app. Esc and outside click close it.
 */
export function FeedbackSheet({ isOpen, material, view, onClose }: FeedbackSheetProps) {
  const [saved, setSaved] = useState<RenderingFeedback | undefined>(undefined);
  const close = () => { setSaved(undefined); onClose(); };
  return (
    <Sheet isOpen={isOpen} onOpenChange={(next) => { if (!next) close(); }}>
      {saved ? <SavedReport record={saved} onClose={close} /> : <ReportForm key={`${material.id}:${view}`} material={material} view={view} onSaved={setSaved} onClose={close} />}
    </Sheet>
  );
}
