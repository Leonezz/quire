import { useEffect, useRef, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import { Button, Checkbox, ChoiceChips, Icon, Sheet, SheetDialog, SheetFooter, TextField } from "@read/ui";
import type { MaterialRecord, MaterialViewId, ReadApiFeedback, RenderingFeedback, RenderingProblemKind } from "../../shared/contracts";
import { read } from "./api";
import { ReportPackaged } from "./FeedbackDone";
import { PROBLEM_KIND_OPTIONS, isProblemKind } from "./feedbackKinds";
import { useReadingPrefs } from "./readingPrefs";
import { ReportIncluded, originalOf } from "./ReportIncluded";
import { draftSelectionOf, type ReportRequest, type ReportSelection } from "./reportRequest";

export interface FeedbackSheetProps {
  isOpen: boolean;
  material: MaterialRecord;
  /** The view the reader is looking at: the report is about it. */
  view: MaterialViewId;
  /** From the reader that asked: how to measure it at submit time, and the passage it pointed at. */
  request: ReportRequest;
  /** A new value starts a fresh form (another Report press). */
  nonce: number;
  onClose: () => void;
}

/** Whether the original goes into the bundle: remembered per machine; the default (on) stands when storage is unavailable. */
export const INCLUDE_CAPTURE_KEY = "read:feedback:includeCapture";
function readIncludeCapture(): boolean {
  try { return localStorage.getItem(INCLUDE_CAPTURE_KEY) !== "off"; }
  catch { return true; }
}
function rememberIncludeCapture(value: boolean) {
  // A convenience only: when it cannot be remembered the next report starts from the default, which the panel shows.
  try { localStorage.setItem(INCLUDE_CAPTURE_KEY, value ? "on" : "off"); }
  catch { /* storage blocked: the panel still works from its own state */ }
}

type ProgressStep = Parameters<Parameters<ReadApiFeedback["onFeedbackProgress"]>[0]>[0]["step"];
export const STEP_LABELS: Record<ProgressStep, string> = {
  capturing: "Capturing the reader…",
  "rendering-original": "Rendering the original page…",
  packaging: "Packaging…",
  opening: "Opening the issue…",
};
export const RUNNING_NOTE = "Takes a few seconds. It cannot be cancelled once started: Esc does not stop it, and the panel stays until the report is packaged.";
const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

/** Two frames: the panel's transparent frame is on screen before the main process captures the window. */
const nextPaint = () => new Promise<void>((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(() => resolve()); }); });

/** While the reader is captured the panel is drawn transparent (still mounted, so focus and Esc stay inside it). */
const CAPTURE_STYLE: CSSProperties = { opacity: 0, backdropFilter: "none", background: "transparent", transition: "none", animation: "none" };

type Running = { step: ProgressStep; text: string };

function AttachedSelection({ selection, onDetach, isDisabled }: { selection: ReportSelection; onDetach: () => void; isDisabled: boolean }) {
  return (
    <figure aria-label="Selected passage" className="m-0 flex items-start gap-2 rounded-card bg-content-2 py-2 pl-3 pr-1.5">
      <blockquote className="m-0 line-clamp-3 min-w-0 flex-1 border-l-2 border-accent pl-2.5 text-[13px] leading-[18px] text-label-2">{selection.quote}</blockquote>
      <Button variant="quiet" size="sm" aria-label="Detach the passage" className="size-6 shrink-0" isDisabled={isDisabled} onPress={onDetach}><Icon of={X} size="sm" /></Button>
    </figure>
  );
}

interface FormProps {
  material: MaterialRecord;
  view: MaterialViewId;
  request: ReportRequest;
  onRunning: (running: Running | undefined) => void;
  running: Running | undefined;
  onPackaged: (record: RenderingFeedback) => void;
  onClose: () => void;
}

/** The one step: optional problems and note, whether the original goes along, what is included, and Report. */
function ReportForm({ material, view, request, running, onRunning, onPackaged, onClose }: FormProps) {
  const [kinds, setKinds] = useState<RenderingProblemKind[]>([]);
  const [note, setNote] = useState("");
  const [includeCapture, setIncludeCapture] = useState(readIncludeCapture);
  const [selection, setSelection] = useState<ReportSelection | undefined>(request.selection);
  const [error, setError] = useState<string | undefined>(undefined);
  const [prefs] = useReadingPrefs();
  const original = originalOf(material, view);
  const includes = original !== undefined && includeCapture;
  const busy = running !== undefined;

  // Progress is reported for the one running submit (its id is not known until it returns).
  const runningRef = useRef(false);
  useEffect(() => read.onFeedbackProgress((progress) => {
    if (runningRef.current) onRunning({ step: progress.step, text: progress.message || STEP_LABELS[progress.step] });
  }), [onRunning]);

  const submit = async () => {
    setError(undefined);
    runningRef.current = true;
    onRunning({ step: "capturing", text: STEP_LABELS.capturing });
    try {
      await nextPaint();
      const measured = request.measure(selection);
      const record = await read.feedbackSubmit({
        materialId: material.id, view, kinds, note, includeCapture: includes,
        ...(measured.viewport ? { viewport: measured.viewport } : {}),
        ...(selection ? { selection: draftSelectionOf(selection, measured) } : {}),
        prefs: { ...prefs },
      });
      runningRef.current = false;
      onRunning(undefined);
      onPackaged(record);
    } catch (cause: unknown) {
      runningRef.current = false;
      onRunning(undefined);
      setError(message(cause, "Could not package the report."));
    }
  };

  return (
    <SheetDialog title="Report a problem" className="max-h-[84vh]">
      <div className="list-scroll -mx-6 grid min-h-0 gap-3.5 overflow-y-auto px-6">
        {selection ? <AttachedSelection selection={selection} isDisabled={busy} onDetach={() => setSelection(undefined)} /> : null}
        <div className="grid gap-2">
          <span id="feedback-kinds-label" className="text-[12.5px] font-medium text-label-2">What went wrong <span className="font-normal text-label-3">(optional)</span></span>
          <ChoiceChips aria-labelledby="feedback-kinds-label" options={PROBLEM_KIND_OPTIONS} value={kinds} isDisabled={busy} onChange={(ids) => setKinds(ids.filter(isProblemKind))} />
        </div>
        <TextField label="Note (optional)" multiline maxRows={4} placeholder="What you expected, where it goes wrong…" value={note} onChange={setNote} isDisabled={busy} />
        {original ? (
          <Checkbox isSelected={includeCapture} isDisabled={busy} onChange={(value) => { setIncludeCapture(value); rememberIncludeCapture(value); }}>
            Include the original page <span className="text-label-3">— uncheck for a private page</span>
          </Checkbox>
        ) : null}
        <ReportIncluded material={material} view={view} original={includes ? original : undefined} withSelection={selection !== undefined} />
      </div>
      {/* Outside the scrolling body, so the progress and a refusal show however far the details are open. */}
      {running ? (
        <div className="grid gap-1 text-[12.5px]">
          <p role="status" className="m-0 font-medium text-label">{running.text}</p>
          <p className="m-0 text-label-3">{RUNNING_NOTE}</p>
        </div>
      ) : null}
      {error ? <p role="alert" className="m-0 rounded-card bg-red-soft px-3 py-2 text-[12.5px] text-red-text">{error}</p> : null}
      <SheetFooter>
        <Button variant="quiet" onPress={onClose} isDisabled={busy}>Cancel</Button>
        <Button variant="primary" onPress={() => void submit()} isDisabled={busy}>{busy ? "Reporting…" : "Report"}</Button>
      </SheetFooter>
    </SheetDialog>
  );
}

/**
 * "Report a problem": one step from the reader to a packaged report. Report hands the draft (with where the reader is,
 * the attached passage and the reading settings) to the main process, which captures, packages, opens the issue, shows
 * the zip and copies the screenshot; the panel then says how to finish. Nothing is uploaded by the app. Esc and an
 * outside click close the panel, except while a report is running.
 */
export function FeedbackSheet({ isOpen, material, view, request, nonce, onClose }: FeedbackSheetProps) {
  const [packaged, setPackaged] = useState<RenderingFeedback | undefined>(undefined);
  const [running, setRunning] = useState<Running | undefined>(undefined);
  const busy = running !== undefined;
  const close = () => { if (busy) return; setPackaged(undefined); onClose(); };
  return (
    <Sheet isOpen={isOpen} isKeyboardDismissDisabled={busy} onOpenChange={(next) => { if (!next) close(); }}
      style={running?.step === "capturing" ? CAPTURE_STYLE : undefined}>
      {packaged ? <ReportPackaged record={packaged} onClose={close} />
        : <ReportForm key={`${nonce}:${material.id}:${view}`} material={material} view={view} request={request} running={running} onRunning={setRunning} onPackaged={setPackaged} onClose={close} />}
    </Sheet>
  );
}
