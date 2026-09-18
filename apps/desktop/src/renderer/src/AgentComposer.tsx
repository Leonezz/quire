import { useState } from "react";
import { Square, X } from "lucide-react";
import { Button, Kbd, TextField } from "@read/ui";
import type { AgentStatus, AgentTask } from "../../shared/contracts";

export const taskLabel: Record<AgentTask, string> = { ask: "Ask", explain: "Explain", verify: "Verify", related: "Find related", summary: "Summarise", synthesis: "Synthesise", rebuild: "Rebuild" };

export interface AgentComposerProps {
  status: AgentStatus | undefined;
  statusError: string | undefined;
  /** The agent is signed out (a turn said so, or the status reason reads like it). */
  authRequired: boolean;
  running: boolean;
  /** A turn is in flight in another panel: the composer waits rather than failing. */
  busyElsewhere: boolean;
  /** "Ask about X…" when nothing is armed. */
  placeholder: string;
  armedTask: AgentTask;
  onArmedTaskChange: (task: AgentTask) => void;
  onSend: (task: AgentTask, text: string) => void;
  onStop: () => void;
  onLogin: () => Promise<void>;
  onOpenSettings?: (() => void) | undefined;
  composerRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * The bottom of the agent panel: what stands in the way (unavailable, sign-in, busy elsewhere),
 * then the text field with its armed task and the Send / Stop button.
 */
export function AgentComposer({ status, statusError, authRequired, running, busyElsewhere, placeholder, armedTask, onArmedTaskChange, onSend, onStop, onLogin, onOpenSettings, composerRef }: AgentComposerProps) {
  const [draft, setDraft] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const available = status?.available === true;
  const canSend = available && !running && !busyElsewhere;
  const submit = () => { if (draft.trim() && canSend) { onSend(armedTask, draft); setDraft(""); } };
  const login = async () => { setSigningIn(true); try { await onLogin(); } finally { setSigningIn(false); } };
  const signIn = <Button size="sm" variant="primary" isDisabled={signingIn} onPress={() => void login()}>{signingIn ? "Waiting for the browser…" : "Sign in to Codex"}</Button>;

  return (
    <div ref={composerRef} className="grid gap-2">
      {statusError ? <p role="alert" className="text-[12.5px] text-red-text">{statusError}</p> : null}
      {status === undefined && !statusError ? <p className="text-[12px] text-label-3">Checking the agent…</p> : null}
      {status && !available ? (
        <div className="grid gap-2 rounded-card bg-content-2 p-3 text-[12.5px] text-label-2">
          <span>{status.reason ?? "The agent is not available."}</span>
          <div className="flex flex-wrap gap-1.5">
            {authRequired ? signIn : null}
            {onOpenSettings ? <Button size="sm" onPress={onOpenSettings}>Agent settings…</Button> : null}
          </div>
        </div>
      ) : null}
      {available && authRequired ? <div className="justify-self-start">{signIn}</div> : null}
      {available && busyElsewhere ? <p role="status" className="text-[12.5px] text-label-2">Still answering in another panel… the composer opens when it is done.</p> : null}
      <div className="flex items-end gap-1.5">
        {armedTask !== "ask" ? <button type="button" className="mb-1.5 inline-flex h-[22px] shrink-0 cursor-default items-center gap-1 rounded-pill border-0 bg-purple-soft px-2 text-[11.5px] font-medium text-purple-text" aria-label={`${taskLabel[armedTask]} — press to clear`} onClick={() => onArmedTaskChange("ask")}>{taskLabel[armedTask]}<X className="size-3" /></button> : null}
        <TextField multiline aria-label="Ask the agent" placeholder={busyElsewhere ? "Still answering…" : placeholder} value={draft} onChange={setDraft} isDisabled={!available || busyElsewhere} className="min-w-0 flex-1"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
            if (event.key === "Escape" && armedTask !== "ask") { event.stopPropagation(); onArmedTaskChange("ask"); }
          }} />
        {running ? <Button size="sm" aria-label="Stop (⌘.)" className="mb-0.5 shrink-0" onPress={onStop}><Square className="size-3 fill-current" />Stop <Kbd>⌘.</Kbd></Button>
          : <Button size="sm" variant="primary" className="mb-0.5 shrink-0" isDisabled={!canSend || !draft.trim()} onPress={submit}>Send <Kbd>↵</Kbd></Button>}
      </div>
      {available ? <p className="text-[11px] text-label-3">Enter sends · Shift+Enter for a new line{status?.account ? ` · ${status.account}` : ""}</p> : null}
    </div>
  );
}
