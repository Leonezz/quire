import { Panel } from "@read/ui";
import type { AgentContext, Annotation, MaterialRecord, MaterialViewId } from "../../shared/contracts";
import { AgentPanel } from "./AgentPanel";
import { InfoPanel } from "./InfoPanel";
import { NotesPanel, type NoteDraft } from "./NotesPanel";
import type { RebuildProps } from "./RebuildBanner";
import type { MaterialViewController } from "./useMaterialView";

export type ReaderPanel = "info" | "notes" | "agent";
const PANEL_TITLES: Record<ReaderPanel, string> = { info: "Info", notes: "Notes", agent: "Agent" };

export interface ReaderInspectorProps {
  material: MaterialRecord;
  /** The chosen view and the switch: the Notes panel groups by view, the Info panel lists and manages them. */
  views: MaterialViewController;
  /** Which panel is open; the toolbar's Info / Notes / Ask (and i / n / ⌘J) decide. */
  panel: ReaderPanel;
  onClose: () => void;
  subject: string;
  agentContext: AgentContext;
  onClearSelection: () => void;
  annotations: readonly Annotation[];
  annotationsError: string | undefined;
  /** Views whose notes this reader shows in place through the text view's anchors (see mirroredAnnotations.ts). */
  mirroredViews?: readonly MaterialViewId[] | undefined;
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
  /** The conversation the reader wants shown (its rebuild runs there), and which one the panel shows. */
  agentSessionId?: string | undefined;
  onAgentSessionChange?: ((sessionId: string | undefined) => void) | undefined;
  /** The reader's "Rebuild with the agent", as the Info panel offers it. */
  onRebuild?: RebuildProps["onRebuild"];
  rebuild?: RebuildProps["rebuild"] | undefined;
  rebuildError?: string | undefined;
}

/** The reader's side panel, shared by the article and PDF readers: one of Info (i), Notes (n), Agent (⌘J), with its name and × on top. */
export function ReaderInspector(props: ReaderInspectorProps) {
  const { material, views, panel, onClose, subject, agentContext, onClearSelection, annotations, annotationsError, mirroredViews, activeAnnotation, noteDraft, onNoteDraftChange, onJump, onUpdateNote, onDeleteAnnotation, sectionFor, onMaterialSaved, onOpenLink, onOpenMaterial, onOpenSettings, agentSessionId, onAgentSessionChange, onRebuild, rebuild = "idle", rebuildError } = props;
  return (
    <Panel title={PANEL_TITLES[panel]} onClose={onClose} className="h-full">
      {panel === "info" ? <InfoPanel material={material} views={views} onSaved={onMaterialSaved} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onRebuild={onRebuild} rebuild={rebuild} rebuildError={rebuildError} /> : null}
      {panel === "notes" ? (
        <NotesPanel material={material} view={views.view} mirroredViews={mirroredViews} annotations={annotations} error={annotationsError} activeId={activeAnnotation} draft={noteDraft} onDraftChange={onNoteDraftChange}
          onJump={onJump} onUpdateNote={onUpdateNote} onDelete={onDeleteAnnotation} sectionFor={sectionFor} />
      ) : null}
      {panel === "agent" ? (
        <AgentPanel context={agentContext} subject={subject} sessionId={agentSessionId} onSessionChange={onAgentSessionChange} onOpenMaterial={onOpenMaterial} onOpenLink={onOpenLink} onClearSelection={onClearSelection} onOpenSettings={onOpenSettings} />
      ) : null}
    </Panel>
  );
}
