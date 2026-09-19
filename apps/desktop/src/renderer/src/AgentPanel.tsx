import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Plus, X } from "lucide-react";
import { AgentToolLine, AgentTurn, Button, InspectorSection } from "@read/ui";
import type { AgentContext, AgentTask } from "../../shared/contracts";
import { AgentComposer, taskLabel } from "./AgentComposer";
import { AgentMarkdown } from "./AgentMarkdown";
import { SessionsMenu } from "./AgentSessions";
import { truncate } from "./format";
import { useAgent, type AgentTurnState, type AskFailure } from "./useAgent";
import { useAgentSessions } from "./useAgentSessions";
import { useMaterialTitles } from "./useMaterialTitles";

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

function contextLabel(context: AgentContext, subject: string): string {
  if (context.kind === "library") return "Library";
  if (context.kind === "material") return subject;
  return `selection: «${truncate(context.quote, 40)}»`;
}

/** What the user bubble says: the words as typed, or the canned task and its subject. */
export function promptLabel(task: AgentTask, text: string, context: AgentContext, subject: string): string {
  if (text.trim()) return task === "ask" ? text.trim() : `${taskLabel[task]}: ${text.trim()}`;
  const about = context.kind === "library" ? "the library" : context.kind === "selection" ? "this selection" : subject;
  return `${taskLabel[task]} ${about}`;
}

export interface AgentPanelProps {
  /** Decided by the caller: the shell passes the library, a reader its material or the selected passage. */
  context: AgentContext;
  /** The material's title, for the pill and the canned prompts (truncated to ~40 characters here). */
  subject?: string | undefined;
  /** Open this stored conversation instead of the context's most recent one; a new value opens that one (a reader's rebuild names its session). */
  sessionId?: string | undefined;
  onSessionChange?: ((sessionId: string | undefined) => void) | undefined;
  /** Offers "Open material" in the context row (the Agent view, where the material is not on screen). */
  openMaterialButton?: boolean | undefined;
  /** Wider transcript for a full-pane layout. */
  wide?: boolean | undefined;
  onOpenMaterial: (id: string) => void;
  onOpenLink: (url: string) => void;
  onClearSelection?: (() => void) | undefined;
  /** Opens the Settings sheet at the Agent section (Codex path, model), offered when the agent is unavailable. */
  onOpenSettings?: (() => void) | undefined;
}

/** The Agent panel: context row (pill, canned actions, new conversation, history), the transcript, the composer. */
export function AgentPanel({ context, subject: rawSubject, sessionId, onSessionChange, openMaterialButton = false, wide = false, onOpenMaterial, onOpenLink, onClearSelection, onOpenSettings }: AgentPanelProps) {
  const { titles, error: titlesError, titleOf } = useMaterialTitles();
  const subject = truncate(rawSubject ?? (context.kind === "library" ? "the library" : (titles?.get(context.materialId) ?? "this material")), 40);
  const labelOf = useCallback((task: AgentTask, text: string) => promptLabel(task, text, context, subject), [context, subject]);
  const agent = useAgent(context, { sessionId, labelOf, onSessionChange });
  const { status, statusError, turns, running, sessionError, loadingSession, askFailure, stopError, authRequired, ask, retry, stop, login, loadSession, newConversation } = agent;
  const sessions = useAgentSessions();
  const [armedTask, setArmedTask] = useState<AgentTask>("ask");
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const actions = context.kind === "library" ? libraryActions : materialActions;
  const available = status?.available === true;
  const canSend = available && !running;
  const contextSessions = useMemo(() => sessions.forContext(context), [sessions, context]);

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

  const send = useCallback((task: AgentTask, text: string) => {
    void ask(task, text.trim());
    setArmedTask("ask");
  }, [ask]);

  const focusComposer = () => composerRef.current?.querySelector("textarea")?.focus();
  const quick = (action: QuickAction) => {
    if (action.prompts) { setArmedTask(action.task); focusComposer(); return; }
    send(action.task, "");
  };
  const placeholder = !available ? "The agent is not available" : armedTask !== "ask" ? `${taskLabel[armedTask]}…` : context.kind === "library" ? "Ask about your library…" : `Ask about ${context.kind === "selection" ? "this selection" : subject}…`;
  const emptyHint = context.kind === "library" ? "Ask across everything you kept, or pick an action above." : `Ask about ${context.kind === "selection" ? "the selected passage" : subject}, or pick an action above.`;
  const iconButton = "shrink-0";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <InspectorSection title="Context">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="inline-flex h-[26px] min-w-0 items-center rounded-pill bg-content px-2.5 text-[12.5px] font-medium shadow-[0_0_0_1px_var(--separator)]"><span className="truncate">{contextLabel(context, subject)}</span></span>
          {context.kind === "selection" && onClearSelection ? <Button variant="quiet" size="sm" aria-label="Drop the selection" className={iconButton} onPress={onClearSelection}><X /></Button> : null}
          {openMaterialButton && context.kind !== "library" ? <Button variant="quiet" size="sm" className="h-7 gap-1 px-2 text-[12px]" onPress={() => onOpenMaterial(context.materialId)}>Open material<ArrowUpRight /></Button> : null}
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            <Button variant="quiet" size="sm" aria-label="New conversation" className={iconButton} isDisabled={running || turns.length === 0} onPress={newConversation}><Plus /></Button>
            <SessionsMenu sessions={contextSessions} currentId={agent.sessionId} onOpen={(id) => void loadSession(id)} onDelete={async (id) => { await sessions.remove(id); if (id === agent.sessionId) newConversation(); }} />
          </span>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {actions.map((action) => <Button key={action.label} size="sm" isDisabled={!canSend} onPress={() => quick(action)}>{action.label}</Button>)}
        </div>
      </InspectorSection>

      <div ref={transcriptRef} className="list-scroll -mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-1 pb-1">
        <div className={`flex flex-col gap-3 ${wide ? "mx-auto w-full max-w-[760px]" : ""}`}>
          {loadingSession ? <p className="text-[12px] text-label-3">Opening the conversation…</p> : turns.length === 0 ? <p className="text-[13px] text-label-2">{emptyHint}</p> : null}
          {sessions.error ? <p role="alert" className="text-[12.5px] text-red-text">{sessions.error}</p> : null}
          {sessionError ? <p role="alert" className="text-[12.5px] text-red-text">{sessionError}</p> : null}
          {titlesError ? <p role="alert" className="text-[12.5px] text-red-text">{titlesError}</p> : null}
          {turns.map((turn) => <TurnView key={turn.id} turn={turn} titleOf={titleOf} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onRetry={canSend ? () => void retry(turn) : undefined} />)}
          {askFailure ? <AskFailureLine failure={askFailure} onRetry={canSend ? () => void retry({ task: askFailure.task, prompt: askFailure.text }) : undefined} /> : null}
          {stopError ? <p role="alert" className="text-[12.5px] text-red-text">{stopError}</p> : null}
        </div>
      </div>

      <div className={wide ? "mx-auto w-full max-w-[760px]" : ""}>
        <AgentComposer status={status} statusError={statusError} authRequired={authRequired} running={running} placeholder={placeholder}
          armedTask={armedTask} onArmedTaskChange={setArmedTask} onSend={send} onStop={() => void stop()} onLogin={login} onOpenSettings={onOpenSettings} composerRef={composerRef} />
      </div>
    </div>
  );
}

/** The bridge would not start the question: why, in one line, and Retry once it can. "Still answering" is this session's own turn, which the composer already shows. */
function AskFailureLine({ failure, onRetry }: { failure: AskFailure; onRetry: (() => void) | undefined }) {
  const text = failure.code === "TURN_RUNNING" ? "Still answering — wait for this conversation's turn to finish, or stop it."
    : failure.code === "AGENT_UNAVAILABLE" ? "The agent is not available — see below."
    : failure.code === "AUTH_REQUIRED" ? "Sign in first — see below."
    : failure.message;
  return (
    <p role="alert" className="flex flex-wrap items-center gap-2 text-[12.5px] text-red-text">
      <span>{text}</span>
      {onRetry && failure.code !== "AGENT_UNAVAILABLE" && failure.code !== "AUTH_REQUIRED" ? <Button size="sm" onPress={onRetry}>Retry</Button> : null}
    </p>
  );
}

/** One exchange: the user bubble, the tool lines, the answer (streaming or final), and how it ended. */
function TurnView({ turn, titleOf, onOpenLink, onOpenMaterial, onRetry }: { turn: AgentTurnState; titleOf: (id: string) => string | undefined; onOpenLink: (url: string) => void; onOpenMaterial: (id: string) => void; onRetry: (() => void) | undefined }) {
  const timedOut = turn.status === "failed" && turn.code === "TURN_TIMEOUT";
  return (
    <div className="grid gap-2">
      <AgentTurn role="user">{turn.label}</AgentTurn>
      {turn.tools.length ? <div className="grid gap-1">{turn.tools.map((tool) => <AgentToolLine key={tool.key} name={tool.name} status={tool.status} summary={tool.summary} />)}</div> : null}
      {turn.answer || turn.status === "running" ? (
        <AgentTurn role="agent">
          {turn.answer ? <AgentMarkdown text={turn.answer} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} titleOf={titleOf} sources={turn.sources} /> : null}
          {turn.status === "running" ? (
            // The caret alone while the answer streams; with "Thinking…" while the bridge has not started the turn yet.
            <span role="status" aria-label={turn.pending ? "Thinking" : "Answering"} className="mt-1 inline-flex items-center gap-1.5 align-text-bottom text-[12.5px] text-label-3">
              <i aria-hidden="true" className="inline-block h-[15px] w-[7px] animate-pulse rounded-[2px] bg-label-3" />
              {turn.pending ? "Thinking…" : null}
            </span>
          ) : null}
        </AgentTurn>
      ) : null}
      {turn.status === "interrupted" ? <p className="text-[12.5px] text-label-3">Stopped{turn.error ? ` · ${turn.error}` : "."}</p> : null}
      {timedOut ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-[12.5px] text-label-2">
          <span>The agent took too long to answer.</span>
          {onRetry ? <Button size="sm" onPress={onRetry}>Retry</Button> : null}
        </p>
      ) : turn.status === "failed" ? (
        <p role="alert" className="text-[12.5px] text-red-text">{turn.error ?? "The agent did not answer."}</p>
      ) : null}
    </div>
  );
}
