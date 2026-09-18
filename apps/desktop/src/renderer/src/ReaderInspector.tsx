import { Highlighter, Info, Sparkles } from "lucide-react";
import { Inspector, InspectorPanel, InspectorTab, InspectorTabs, type Key } from "@read/ui";
import type { AgentContext, Annotation, MaterialRecord } from "../../shared/contracts";
import { AgentPanel } from "./AgentPanel";
import { InfoPanel } from "./InfoPanel";
import { NotesPanel, type NoteDraft } from "./NotesPanel";

export type ReaderTab = "info" | "notes" | "agent";

export interface ReaderInspectorProps {
  material: MaterialRecord;
  tab: ReaderTab;
  onTabChange: (tab: ReaderTab | null) => void;
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
}

/** The reader's right pane, shared by the article and PDF readers: Info (i), Notes (n), Agent (⌘J). */
export function ReaderInspector(props: ReaderInspectorProps) {
  const { material, tab, onTabChange, subject, agentContext, onClearSelection, annotations, annotationsError, activeAnnotation, noteDraft, onNoteDraftChange, onJump, onUpdateNote, onDeleteAnnotation, sectionFor, onMaterialSaved, onOpenLink, onOpenMaterial, onOpenSettings } = props;
  return (
    <Inspector aria-label="Inspector" className="h-full" selectedKey={tab} onSelectionChange={(key: Key) => onTabChange(key as ReaderTab)}>
      <InspectorTabs>
        <InspectorTab id="info"><Info />Info</InspectorTab>
        <InspectorTab id="notes"><Highlighter />Notes</InspectorTab>
        <InspectorTab id="agent"><Sparkles />Agent</InspectorTab>
      </InspectorTabs>
      <InspectorPanel id="info">
        <InfoPanel material={material} onSaved={onMaterialSaved} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} />
      </InspectorPanel>
      <InspectorPanel id="notes">
        <NotesPanel material={material} annotations={annotations} error={annotationsError} activeId={activeAnnotation} draft={noteDraft} onDraftChange={onNoteDraftChange}
          onJump={onJump} onUpdateNote={onUpdateNote} onDelete={onDeleteAnnotation} sectionFor={sectionFor} />
      </InspectorPanel>
      <InspectorPanel id="agent">
        <AgentPanel context={agentContext} subject={subject} onOpenMaterial={onOpenMaterial} onOpenLink={onOpenLink} onClearSelection={onClearSelection} onOpenSettings={onOpenSettings} />
      </InspectorPanel>
    </Inspector>
  );
}
