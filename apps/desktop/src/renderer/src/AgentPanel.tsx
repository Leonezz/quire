import { useEffect, useMemo, useRef, useState } from "react";
import { Square, X } from "lucide-react";
import { AgentToolLine, AgentTurn, Button, InspectorSection, Kbd, TextField } from "@read/ui";
import type { AgentContext, AgentTask, MaterialSummary } from "../../shared/contracts";
import { AgentMarkdown } from "./AgentMarkdown";
import { useAgent } from "./useAgent";
import { read } from "./api";

interface QuickAction { label: string; task: AgentTask; /** Needs the user's words: arms the composer instead of sending. */ prompts?: boolean }
const materialActions: QuickAction[] = [
  { label: "Explain", task: "explain" },
  { label: "Verify", task: "verify" },
  { label: "Related", task: "related" },
  { label: "Summarise", task: "summary" },
];
const libraryActions: QuickAction[] = [
  { label: "Brief recent", task: "summary" },
  { label: "Find related to…", task: "related", prompts: true },
  { label: "Synthesise", task: "synthesis" },
];
const taskLabel: Record<AgentTask, string> = { ask: "Ask", explain: "Explain", verify: "Verify", related: "Find related", summary: "Summarise", synthesis: "Synthesise" };

function contextLabel(context: AgentContext, subject: string): string {
  if (context.kind === "library") return "Library";
  if (context.kind === "material") return subject;
  const quote = context.quote.replace(/\s+/g, " ").trim();
  return `selection: «${quote.length > 40 ? `${quote.slice(0, 40)}…` : quote}»`;
}

/** What the user bubble says: the words as typed, or the canned task and its subject. */
function promptLabel(task: AgentTask, text: string, context: AgentContext, subject: string): string {
  if (text.trim()) return task === "ask" ? text.trim() : `${taskLabel[task]}: ${text.trim()}`;
  const about = context.kind === "library" ? "the library" : context.kind === "selection" ? "this selection" : subject;
  return `${taskLabel[task]} ${about}`;
}

/**
 * The Agent inspector panel. `context` is decided by the caller: the shell passes the library,
 * a reader its material or, after "Ask about this" on a selection, the selected passage.
 * `subject` names the material for the pill and the canned prompts ("this article", "this PDF").
 */
export function AgentPanel({ context, subject = "this material", onOpenMaterial, onOpenLink, onClearSelection }: {
  context: AgentContext;
  subject?: string;
  onOpenMaterial: (id: string) => void;
  onOpenLink: (url: string) => void;
  onClearSelection?: (() => void) | undefined;
}) {
  const { status, statusError, turns, running, ask, stop, login } = useAgent(context);
  const [draft, setDraft] = useState("");
  const [armedTask, setArmedTask] = useState<AgentTask>("ask");
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const [titlesError, setTitlesError] = useState<string | undefined>(undefined);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const actions = context.kind === "library" ? libraryActions : materialActions;
  const available = status?.available === true;
  const authRequired = turns.some((turn) => turn.authRequired) || (!available && /sign in|log in|login/i.test(status?.reason ?? ""));

  // Titles for citation pills: resolved once from the library list.
  useEffect(() => {
    let cancelled = false;
    read.listMaterials()
      .then((list: MaterialSummary[]) => { if (!cancelled) setTitles(new Map(list.map((material) => [material.id, material.title]))); })
      .catch((cause: unknown) => { if (!cancelled) setTitlesError(cause instanceof Error ? cause.message : "Could not load material titles."); });
    return () => { cancelled = true; };
  }, []);

  // Follow the stream: the transcript stays pinned to its end unless the reader scrolled up.
  const lastLength = useMemo(() => turns.reduce((sum, turn) => sum + turn.answer.length + turn.tools.length, 0), [turns]);
  useEffect(() => {
    const node = transcriptRef.current;
    if (!node) return;
    const nearEnd = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    if (nearEnd) node.scrollTop = node.scrollHeight;
  }, [lastLength, turns.length]);

  // ⌘. stops the running turn from anywhere in the window.
  useEffect(() => {
    if (!running) return;
    const onKey = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key === ".") { event.preventDefault(); void stop(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, stop]);

  const send = (task: AgentTask, text: string) => {
    if (!available || running) return;
    void ask(task, text.trim(), promptLabel(task, text, context, subject));
    setDraft(""); setArmedTask("ask");
  };
  const submitDraft = () => { if (draft.trim()) send(armedTask, draft); };
  const focusComposer = () => composerRef.current?.querySelector("textarea")?.focus();
  const quick = (action: QuickAction) => {
    if (action.prompts) { setArmedTask(action.task); focusComposer(); return; }
    send(action.task, "");
  };
  const titleOf = (id: string) => titles.get(id);
  const placeholder = !available ? "The agent is not available" : armedTask !== "ask" ? `${taskLabel[armedTask]}…` : context.kind === "library" ? "Ask about your library…" : `Ask about ${context.kind === "selection" ? "this selection" : subject}…`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <InspectorSection title="Context">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="inline-flex h-[26px] min-w-0 items-center rounded-pill bg-content px-2.5 text-[12.5px] font-medium shadow-[0_0_0_1px_var(--separator)]"><span className="truncate">{contextLabel(context, subject)}</span></span>
          {context.kind === "selection" && onClearSelection ? <Button variant="quiet" size="sm" aria-label="Drop the selection" className="size-7 min-w-0 shrink-0 px-0" onPress={onClearSelection}><X className="size-3.5" /></Button> : null}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {actions.map((action) => <Button key={action.label} size="sm" isDisabled={!available || running} onPress={() => quick(action)}>{action.label}</Button>)}
        </div>
      </InspectorSection>

      <div ref={transcriptRef} className="list-scroll -mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden px-1 pb-1">
        {turns.length === 0 ? (
          <p className="text-[13px] text-label-2">{context.kind === "library" ? "Ask across everything you kept, or pick an action above." : `Ask about ${context.kind === "selection" ? "the selected passage" : subject}, or pick an action above.`}</p>
        ) : null}
        {titlesError ? <p role="alert" className="text-[12.5px] text-red-text">{titlesError}</p> : null}
        {turns.map((turn) => (
          <div key={turn.id} className="grid gap-2">
            <AgentTurn role="user">{turn.label}</AgentTurn>
            {turn.tools.length ? <div className="grid gap-1">{turn.tools.map((tool) => <AgentToolLine key={tool.key} name={tool.name} status={tool.status} summary={tool.summary} />)}</div> : null}
            {turn.answer || turn.status === "running" ? (
              <AgentTurn role="agent">
                {turn.answer ? <AgentMarkdown text={turn.answer} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} titleOf={titleOf} /> : null}
                {turn.status === "running" ? <span role="status" aria-label="Answering" className="mt-1 inline-block h-[15px] w-[7px] animate-pulse rounded-[2px] bg-label-3 align-text-bottom" /> : null}
              </AgentTurn>
            ) : null}
            {turn.status === "interrupted" ? <p className="text-[12.5px] text-label-3">Stopped{turn.error ? ` · ${turn.error}` : "."}</p> : null}
            {turn.status === "failed" || (turn.error && turn.status === "running") ? <p role="alert" className="text-[12.5px] text-red-text">{turn.error ?? "The agent did not answer."}</p> : null}
          </div>
        ))}
      </div>

      <div ref={composerRef} className="grid gap-2">
        {statusError ? <p role="alert" className="text-[12.5px] text-red-text">{statusError}</p> : null}
        {status === undefined && !statusError ? <p className="text-[12px] text-label-3">Checking the agent…</p> : null}
        {status && !available ? (
          <div className="grid gap-2 rounded-card bg-content-2 p-3 text-[12.5px] text-label-2">
            <span>{status.reason ?? "The agent is not available."}</span>
            {authRequired ? <Button size="sm" variant="primary" className="justify-self-start" onPress={() => void login()}>Sign in to Codex</Button> : null}
          </div>
        ) : null}
        {available && authRequired ? <Button size="sm" variant="primary" className="justify-self-start" onPress={() => void login()}>Sign in to Codex</Button> : null}
        <div className="flex items-end gap-1.5">
          {armedTask !== "ask" ? <button type="button" className="mb-1.5 inline-flex h-[22px] shrink-0 cursor-default items-center gap-1 rounded-pill border-0 bg-purple-soft px-2 text-[11.5px] font-medium text-purple-text" aria-label={`${taskLabel[armedTask]} — press to clear`} onClick={() => setArmedTask("ask")}>{taskLabel[armedTask]}<X className="size-3" /></button> : null}
          <TextField multiline aria-label="Ask the agent" placeholder={placeholder} value={draft} onChange={setDraft} isDisabled={!available} className="min-w-0 flex-1"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submitDraft(); }
              if (event.key === "Escape" && armedTask !== "ask") { event.stopPropagation(); setArmedTask("ask"); }
            }} />
          {running ? <Button size="sm" aria-label="Stop (⌘.)" className="mb-0.5 shrink-0" onPress={() => void stop()}><Square className="size-3 fill-current" />Stop <Kbd>⌘.</Kbd></Button>
            : <Button size="sm" variant="primary" className="mb-0.5 shrink-0" isDisabled={!available || !draft.trim()} onPress={submitDraft}>Send <Kbd>↵</Kbd></Button>}
        </div>
        {available ? <p className="text-[11px] text-label-3">Enter sends · Shift+Enter for a new line{status?.account ? ` · ${status.account}` : ""}</p> : null}
      </div>
    </div>
  );
}
