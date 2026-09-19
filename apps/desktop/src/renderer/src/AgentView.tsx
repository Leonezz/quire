import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button, ItemList, ItemRow, Kbd } from "@read/ui";
import type { AgentContext, AgentSessionSummary } from "../../shared/contracts";
import { AgentPanel } from "./AgentPanel";
import { DeleteSessionSheet, sessionMeta } from "./AgentSessions";
import { ContentToolbar } from "./AppToolbar";
import { ContentColumn, ContentPane, EmptySentence, ListColumn, type ShellSlots } from "./ContentPane";
import { ErrorBoundary } from "./ErrorBoundary";
import { InlineError } from "./ItemPreview";
import { isTypingTarget, relativeTime } from "./format";
import type { AgentSessions } from "./useAgentSessions";
import { sessionContextLabel } from "./useAgentSessions";
import { useMaterialTitles } from "./useMaterialTitles";

const LIBRARY: AgentContext = { kind: "library" };

/** What the right pane shows: a stored session, or a fresh conversation in the Library context. `key` remounts the panel on every explicit choice. */
type Shown = { key: number; sessionId: string | undefined; context: AgentContext };

export interface AgentViewProps {
  sessions: AgentSessions;
  onOpenMaterial: (id: string) => void;
  onOpenLink: (url: string) => void;
  onOpenSettings: () => void;
  shell: ShellSlots;
}

/**
 * The Agent scope: every conversation on the left (title, what it is about, when, how many turns),
 * the chosen one on the right in a full-width panel; "New conversation" in the toolbar. ⌫ deletes the selected conversation after asking.
 */
export function AgentView({ sessions, onOpenMaterial, onOpenLink, onOpenSettings, shell }: AgentViewProps) {
  const { titles, titleOf } = useMaterialTitles();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [shown, setShown] = useState<Shown>({ key: 0, sessionId: undefined, context: LIBRARY });
  const [deleting, setDeleting] = useState<AgentSessionSummary | undefined>(undefined);
  const byId = useMemo(() => new Map(sessions.sessions.map((session) => [session.id, session])), [sessions.sessions]);
  const current = selected ? byId.get(selected) : undefined;
  const subject = shown.context.kind === "library" ? undefined : titles?.get(shown.context.materialId);

  const show = (session: AgentSessionSummary) => { setSelected(session.id); setShown((previous) => ({ key: previous.key + 1, sessionId: session.id, context: session.context })); };
  const fresh = () => { setSelected(undefined); setShown((previous) => ({ key: previous.key + 1, sessionId: undefined, context: LIBRARY })); };
  // The first conversation is shown once the list arrives, so the pane is never empty for no reason.
  useEffect(() => {
    if (selected !== undefined || shown.sessionId !== undefined) return;
    const first = sessions.sessions[0];
    if (first && shown.key === 0) show(first);
  }, [sessions.sessions, selected, shown]);

  // ⌫ / Delete on the selected conversation asks to delete it, unless the focus is in a text field.
  useEffect(() => {
    if (!current) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.key !== "Backspace" && event.key !== "Delete") || isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      setDeleting(current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);

  const remove = async (id: string) => {
    await sessions.remove(id);
    if (shown.sessionId === id) fresh();
  };

  const footer = current ? (
    <div className="flex items-center gap-2 border-t border-separator px-3 py-1.5 text-[12.5px] text-label-2">
      <span className="min-w-0 truncate">{sessionMeta(current)}</span>
      <Button size="sm" variant="quiet" className="ml-auto text-red-text" onPress={() => setDeleting(current)}><Trash2 className="size-3.5" />Delete <Kbd>⌫</Kbd></Button>
    </div>
  ) : undefined;
  const toolbar = <ContentToolbar actions={<Button size="sm" variant={shown.sessionId === undefined ? "plain" : "quiet"} className="gap-1" onPress={fresh}><Plus className="size-3.5" />New conversation</Button>} trailing={shell.trailing} />;

  return (
    <>
      <ListColumn family="agent" toolbar={shell.listToolbar} footer={footer}>
        {sessions.error ? <div className="p-3"><InlineError title="The conversations could not be loaded." message={sessions.error} /></div> : null}
        {/* `dependencies`: the collection caches rows by item, so the context label must be told when the titles arrive. */}
        {sessions.sessions.length ? (
          <ItemList aria-label="Conversations" items={sessions.sessions} dependencies={[titles]} selectionMode="single" selectionBehavior="replace" selectedKeys={selected ? new Set([selected]) : new Set()}
            onSelectionChange={(keys) => { const key = keys === "all" ? undefined : [...keys][0]; const session = key === undefined ? undefined : byId.get(String(key)); if (session && session.id !== selected) show(session); }} className="flex-1">
            {(session) => <ItemRow id={session.id} title={session.title} source={sessionContextLabel(session.context, titleOf)} time={relativeTime(session.updatedAt)} state="read" signals={[`${session.turnCount} ${session.turnCount === 1 ? "turn" : "turns"}`]} />}
          </ItemList>
        ) : sessions.loaded && !sessions.error ? (
          <EmptySentence>No conversations yet — press ⌘J anywhere to ask the agent; every conversation is kept here.</EmptySentence>
        ) : null}
      </ListColumn>
      <ContentColumn>
        <ContentPane toolbar={toolbar}>
          <section aria-label="Conversation" className="flex h-full min-h-0 flex-col px-5 pb-4 pt-4">
            {/* The panel labels stored turns with the material's title, so it mounts once the titles are known. */}
            {titles === undefined ? <EmptySentence>Opening…</EmptySentence> : (
              <ErrorBoundary key={shown.key} label="The agent panel">
                <AgentPanel key={shown.key} context={shown.context} subject={subject} sessionId={shown.sessionId} onSessionChange={(id) => { if (id) setSelected(id); }} openMaterialButton wide
                  onOpenMaterial={onOpenMaterial} onOpenLink={onOpenLink} onOpenSettings={onOpenSettings} />
              </ErrorBoundary>
            )}
          </section>
        </ContentPane>
      </ContentColumn>
      <DeleteSessionSheet session={deleting} onDelete={remove} onClose={() => setDeleting(undefined)} />
    </>
  );
}
