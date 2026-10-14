import { useState } from "react";
import { Copy, ExternalLink, FolderOpen } from "lucide-react";
import { Button, Icon, SheetDialog, SheetFooter, TextField } from "@read/ui";
import type { RenderingFeedback, RenderingFeedbackPackage } from "../../shared/contracts";
import { read } from "./api";

// The report panel once the main process has packaged the report: one sentence on how to finish filing it,
// the ways to redo each automatic step, the warnings of the capture, and where to paste the issue link back.

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const pasteKey = () => (read.platform === "darwin" || read.platform === "browser" ? "⌘V" : "Ctrl+V");
const baseName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

/** What is left for the reader to do, following what the main process managed (issue opened, zip shown, screenshot copied). */
export function finishSentence(pkg: RenderingFeedbackPackage): string {
  const where = pkg.issueOpened ? "In the GitHub issue that just opened" : "In the GitHub issue (Open issue again opens it)";
  const paste = pkg.copiedToClipboard ? `press ${pasteKey()} to paste the screenshot, then ` : "";
  const zip = `${baseName(pkg.zipPath)} ${pkg.revealed ? "(shown in Finder)" : "(Show zip finds it)"}`;
  return `${where}: ${paste}drag ${zip} into the box.`;
}

function IssueLinkField({ id }: { id: string }) {
  const [issueUrl, setIssueUrl] = useState("");
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const store = async () => {
    const trimmed = issueUrl.trim();
    if (!trimmed || trimmed === saved) return;
    setError(undefined);
    try { setSaved((await read.feedbackSetIssueUrl(id, trimmed)).issueUrl); }
    catch (cause: unknown) { setError(message(cause, "Could not save the issue link.")); }
  };
  return (
    <TextField label="Paste the issue link (optional)" placeholder="https://github.com/…/issues/123" value={issueUrl} onChange={setIssueUrl}
      onBlur={() => void store()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void store(); } }}
      errorMessage={error} description={saved ? "Saved on the report." : undefined} />
  );
}

export function ReportPackaged({ record, onClose }: { record: RenderingFeedback; onClose: () => void }) {
  const [error, setError] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const run = (action: () => Promise<void>, fallback: string, after?: () => void) => async () => {
    setError(undefined);
    try { await action(); after?.(); } catch (cause: unknown) { setError(message(cause, fallback)); }
  };
  const pkg = record.package;
  return (
    <SheetDialog title="Report packaged" className="max-h-[84vh]">
      {pkg ? <p className="m-0 text-[13.5px] leading-[19px] text-label">{finishSentence(pkg)}</p> : (
        <p role="alert" className="t-text-in m-0 rounded-card bg-red-soft px-3 py-2 text-[12.5px] text-red-text">The report was saved, but the app did not say where its zip is. Reveal the bundle from Settings › Feedback.</p>
      )}
      {pkg && pkg.warnings.length > 0 ? (
        <div className="grid gap-1 rounded-card bg-orange-soft px-3 py-2 text-[12.5px] text-orange-text">
          <span className="font-medium">Some parts could not be captured:</span>
          <ul aria-label="Capture warnings" className="m-0 grid gap-0.5 pl-4">{pkg.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {pkg?.composite ? <Button onPress={() => void run(() => read.feedbackCopyScreenshot(record.id), "Could not copy the screenshot.", () => setCopied(true))()}><Icon of={Copy} />Copy screenshot again</Button> : null}
        <Button onPress={() => void run(() => read.feedbackOpenIssue(record.id), "Could not open the issue.")()}><Icon of={ExternalLink} />Open issue again</Button>
        <Button onPress={() => void run(() => read.feedbackReveal(record.id), "Could not show the zip.")()}><Icon of={FolderOpen} />Show zip</Button>
      </div>
      {copied ? <p role="status" className="t-text-in m-0 text-[12px] text-label-3">The screenshot is on the clipboard.</p> : null}
      {error ? <p role="alert" className="t-text-in m-0 rounded-card bg-red-soft px-3 py-2 text-[12.5px] text-red-text">{error}</p> : null}
      <IssueLinkField id={record.id} />
      <SheetFooter>
        <Button variant="primary" onPress={onClose}>Done</Button>
      </SheetFooter>
    </SheetDialog>
  );
}
