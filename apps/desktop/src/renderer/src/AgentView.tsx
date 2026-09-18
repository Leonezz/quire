import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button, ItemList, ItemRow, Kbd, SplitGroup, SplitPanel, SplitSeparator, useSplitSizes } from "@read/ui";
import type { AgentContext, AgentSessionSummary } from "../../shared/contracts";
import { AgentPanel } from "./AgentPanel";
import { DeleteSessionSheet, sessionMeta } from "./AgentSessions";
import { ErrorBoundary } from "./ErrorBoundary";
import { EmptyState, InlineError, panelClass } from "./ItemPreview";
import { isTypingTarget, relativeTime } from "./format";
import type { AgentSessions } from "./useAgentSessions";
import { sessionContextLabel } from "./useAgentSessions";
import { useMaterialTitles } from "./useMaterialTitles";

const LIBRARY: AgentContext = { kind: "library" };

/** What the right pane shows: a stored session, or a fresh conversation in the Library context. `key` remounts the panel on every explicit choice. */
type Shown = { key: number; sessionId: string | undefined; context: AgentContext };

/**
 * The Agent view: every conversation on the left (title, what it is about, when, how many turns),
 * the chosen one on the right in a full-width panel. ⌫ deletes the selected conversation after asking.
 */
export function AgentView({ sessions, onOpenMaterial, onOpenLink, onOpenSettings }: { sessions: AgentSessions; onOpenMaterial: (id: string) => void; onOpenLink: (url: string) => void; onOpenSettings: () => void }) {
  const { titles, titleOf } = useMaterialTitles();
  const sizes = useSplitSizes("agent");
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

  return (
    <>
      <SplitGroup id="agent" aria-label="Agent" className="min-h-0 flex-1 gap-3">
        <SplitPanel id="list" defaultSize={sizes.sizeOf("list", 320)} minSize={280} maxSize={560} onResize={sizes.onResize("list")}>
          <section className={`flex h-full min-h-0 flex-col overflow-hidden ${panelClass}`}>
            <div className="flex items-center gap-2 border-b border-separator-soft px-3 py-2">
              <span className="text-[12.5px] text-label-2">{sessions.sessions.length} {sessions.sessions.length === 1 ? "conversation" : "conversations"}</span>
              <Button size="sm" variant={shown.sessionId === undefined ? "plain" : "quiet"} className="ml-auto gap-1" onPress={fresh}><Plus className="size-3.5" />New conversation</Button>
            </div>
            {sessions.error ? <div className="p-3"><InlineError title="The conversations could not be loaded." message={sessions.error} /></div> : null}
            {/* `dependencies`: the collection caches rows by item, so the context label must be told when the titles arrive. */}
            {sessions.sessions.length ? (
              <ItemList aria-label="Conversations" items={sessions.sessions} dependencies={[titles]} selectionMode="single" selectionBehavior="replace" selectedKeys={selected ? new Set([selected]) : new Set()}
                onSelectionChange={(keys) => { const key = keys === "all" ? undefined : [...keys][0]; const session = key === undefined ? undefined : byId.get(String(key)); if (session && session.id !== selected) show(session); }} className="flex-1">
                {(session) => <ItemRow id={session.id} title={session.title} source={sessionContextLabel(session.context, titleOf)} time={relativeTime(session.updatedAt)} state="read" signals={[`${session.turnCount} ${session.turnCount === 1 ? "turn" : "turns"}`]} />}
              </ItemList>
            ) : sessions.loaded && !sessions.error ? (
              <EmptyState title="No conversations yet." hint="Press ⌘J anywhere to ask the agent; every conversation is kept here." />
            ) : null}
            {current ? (
              <div className="flex items-center gap-2 border-t border-separator-soft px-3 py-2 text-[12.5px] text-label-2">
                <span className="min-w-0 truncate">{sessionMeta(current)}</span>
                <Button size="sm" variant="quiet" className="ml-auto text-red-text" onPress={() => setDeleting(current)}><Trash2 className="size-3.5" />Delete <Kbd>⌫</Kbd></Button>
              </div>
            ) : null}
          </section>
        </SplitPanel>
        <SplitSeparator aria-label="Resize list" hit={12} footprint={12} line="hover" />
        <SplitPanel id="panel" minSize={420}>
          <section aria-label="Conversation" className={`flex h-full min-h-0 flex-col px-5 pb-4 pt-4 ${panelClass}`}>
            {/* The panel labels stored turns with the material's title, so it mounts once the titles are known. */}
            {titles === undefined ? <p className="text-[12px] text-label-3">Opening…</p> : (
              <ErrorBoundary key={shown.key} label="The agent panel">
                <AgentPanel key={shown.key} context={shown.context} subject={subject} sessionId={shown.sessionId} onSessionChange={(id) => { if (id) setSelected(id); }} openMaterialButton wide
                  onOpenMaterial={onOpenMaterial} onOpenLink={onOpenLink} onOpenSettings={onOpenSettings} />
              </ErrorBoundary>
            )}
          </section>
        </SplitPanel>
      </SplitGroup>
      <DeleteSessionSheet session={deleting} onDelete={remove} onClose={() => setDeleting(undefined)} />
    </>
  );
}
