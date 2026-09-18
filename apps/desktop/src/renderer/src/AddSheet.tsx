import { useState } from "react";
import { Button, Sheet, SheetDialog, SheetFooter, TextField } from "@read/ui";
import type { SourceDetection, SourceRecord } from "../../shared/contracts";
import { read } from "./api";
import { isArxivCategory } from "./format";

type Detected = SourceDetection & { input: string };

function hostOf(url: string): string { try { return new URL(url).hostname; } catch { return url; } }
function describe(detected: Detected): { line: string; action: string } {
  switch (detected.kind) {
    case "feed": return { line: `Feed · ${detected.title ?? hostOf(detected.url)}`, action: `Subscribe to ${detected.title ?? hostOf(detected.url)}` };
    case "arxiv": return { line: `arXiv category · ${detected.category}`, action: `Subscribe to arXiv ${detected.category}` };
    case "page": return { line: `Page · ${hostOf(detected.url)}`, action: "Read" };
  }
}

/**
 * One field for everything that comes in. Submitting detects what it is (an arXiv category is
 * recognised locally, without the network); a page reads at once, a feed or category offers to subscribe.
 */
export function AddSheet({ open, busy, error, onClose, onSubmit, onSubscribed }: { open: boolean; busy: boolean; error?: string | undefined; onClose: () => void; onSubmit: (url: string) => void; onSubscribed: (result: { source: SourceRecord; added: number }) => void }) {
  const [value, setValue] = useState("");
  const [detected, setDetected] = useState<Detected | undefined>(undefined);
  const [phase, setPhase] = useState<"idle" | "detecting" | "subscribing">("idle");
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const working = busy || phase !== "idle";
  const input = value.trim();
  const known = detected && detected.input === input ? detected : undefined;
  const message = localError ?? error;

  const reset = () => { setValue(""); setDetected(undefined); setLocalError(undefined); setPhase("idle"); };
  const close = () => { if (!working) { reset(); onClose(); } };
  const onChange = (next: string) => {
    setValue(next); setLocalError(undefined);
    const trimmed = next.trim();
    if (isArxivCategory(trimmed)) setDetected({ kind: "arxiv", category: trimmed, title: `arXiv ${trimmed}`, input: trimmed });
  };

  const subscribe = async (target: string) => {
    setPhase("subscribing"); setLocalError(undefined);
    try {
      const result = await read.addSource(target);
      if (!result.ok) { setLocalError(result.message); return; }
      reset();
      onSubscribed({ source: result.source, added: result.added });
    } catch (cause: unknown) { setLocalError(cause instanceof Error ? cause.message : "Could not subscribe."); }
    finally { setPhase("idle"); }
  };
  const act = (target: Detected) => {
    if (target.kind === "page") { onSubmit(target.url); return; }
    void subscribe(target.kind === "arxiv" ? target.category : target.url);
  };
  const submit = async () => {
    if (!input || working) return;
    if (known) { act(known); return; }
    setPhase("detecting"); setLocalError(undefined);
    try {
      const result = await read.detectSource(input);
      const next = { ...result, input };
      setDetected(next);
      if (next.kind === "page") act(next);
    } catch (cause: unknown) { setLocalError(cause instanceof Error ? cause.message : "Could not tell what this is."); }
    finally { setPhase("idle"); }
  };

  const label = phase === "detecting" ? "Checking…" : phase === "subscribing" ? "Subscribing…" : busy ? "Fetching…" : known ? describe(known).action : "Add";
  return (
    <Sheet isOpen={open} onOpenChange={(next) => { if (!next) close(); }}>
      <SheetDialog title="Add">
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }} className="flex flex-col gap-4">
          <TextField autoFocus aria-label="Paste a URL or an arXiv category" placeholder="Paste a page URL, a feed, or an arXiv category like cs.CL…" value={value} onChange={onChange} isReadOnly={working}
            {...(message ? { errorMessage: message, isInvalid: true } : {})}
            {...(known ? {} : { description: "Pages are fetched once, extracted, and kept for offline reading. Feeds and arXiv categories become sources. Or drop a PDF, Markdown, HTML or text file anywhere in the window." })} />
          {known ? <p role="status" className="m-0 -mt-2 text-[12.5px] text-label-2"><span className="rounded-pill bg-accent-soft px-2 py-px text-[11.5px] font-medium text-accent-text">recognised</span> <span className="ml-1">{describe(known).line}</span></p> : null}
          <SheetFooter>
            <Button variant="quiet" onPress={close} isDisabled={working}>Cancel</Button>
            <Button variant="primary" type="submit" isDisabled={working || !input}>{label}</Button>
          </SheetFooter>
        </form>
      </SheetDialog>
    </Sheet>
  );
}
