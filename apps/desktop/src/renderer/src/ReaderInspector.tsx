import { Panel } from "@read/ui";
import type { AgentContext, AgentTask, Annotation, MaterialRecord } from "../../shared/contracts";
import { AgentPanel, type PendingTask } from "./AgentPanel";
import { InfoPanel } from "./InfoPanel";
import { NotesPanel, type NoteDraft } from "./NotesPanel";
import type { RebuildProps } from "./RebuildBanner";

export type ReaderPanel = "info" | "notes" | "agent";
const PANEL_TITLES: Record<ReaderPanel, string> = { info: "Info", notes: "Notes", agent: "Agent" };

export interface ReaderInspectorProps {
  material: MaterialRecord;
  /** Which panel is open; the toolbar's Info / Notes / Ask (and i / n / ⌘J) decide. */
  panel: ReaderPanel;
  onClose: () => void;
  subject: string;
  agentContext: AgentContext;
  onClearSelection: () => void;
  annotations: readonly Annotation[];
  annotationsError: string | undefined;
  activeAnnotation: string | undefined;
  noteDraft: NoteDraft | null;
  onNoteDraftChange: (draft: NoteDraft | null) => void;
  onJump: (annotation: Annotation) => void;
  onUpdateNote: (id: string, note: string) => void;
  onDeleteAnnotation: (id: string) => void;
  sectionFor: (annotation: Annotation) => string | undefined;
  onMaterialSaved: (record: MaterialRecord) => void;
  onOpenLink: (url: string) => void;
  onOpenMaterial: (id: string) => void;
  onOpenSettings?: (() => void) | undefined;
  /** The reader's "Rebuild with the agent": the task the Agent panel sends once, and what the Info panel offers. */
  pendingTask?: PendingTask | undefined;
  onPendingTaskSent?: ((accepted: boolean) => void) | undefined;
  onTaskSettled?: ((task: AgentTask, status: "done" | "failed" | "interrupted") => void) | undefined;
  onRebuild?: RebuildProps["onRebuild"];
  rebuild?: RebuildProps["rebuild"] | undefined;
}

/** The reader's side panel, shared by the article and PDF readers: one of Info (i), Notes (n), Agent (⌘J), with its name and × on top. */
export function ReaderInspector(props: ReaderInspectorProps) {
  const { material, panel, onClose, subject, agentContext, onClearSelection, annotations, annotationsError, activeAnnotation, noteDraft, onNoteDraftChange, onJump, onUpdateNote, onDeleteAnnotation, sectionFor, onMaterialSaved, onOpenLink, onOpenMaterial, onOpenSettings, pendingTask, onPendingTaskSent, onTaskSettled, onRebuild, rebuild = "idle" } = props;
  return (
    <Panel title={PANEL_TITLES[panel]} onClose={onClose} className="h-full">
      {panel === "info" ? <InfoPanel material={material} onSaved={onMaterialSaved} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onRebuild={onRebuild} rebuild={rebuild} /> : null}
      {panel === "notes" ? (
        <NotesPanel material={material} annotations={annotations} error={annotationsError} activeId={activeAnnotation} draft={noteDraft} onDraftChange={onNoteDraftChange}
          onJump={onJump} onUpdateNote={onUpdateNote} onDelete={onDeleteAnnotation} sectionFor={sectionFor} />
      ) : null}
      {panel === "agent" ? (
        <AgentPanel context={agentContext} subject={subject} onOpenMaterial={onOpenMaterial} onOpenLink={onOpenLink} onClearSelection={onClearSelection} onOpenSettings={onOpenSettings}
          pendingTask={pendingTask} onPendingTaskSent={onPendingTaskSent} onTaskSettled={onTaskSettled} />
      ) : null}
    </Panel>
  );
}
