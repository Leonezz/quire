import type { ReactNode, RefObject } from "react";
import { SplitGroup, SplitPanel, SplitSeparator, useSplitSizes } from "@read/ui";

/** Every scope renders these three slots the shell hands it: the list segment of the toolbar, the shell's Add · Search icons, and the Agent panel when ⌘J opened it. */
export interface ShellSlots {
  listToolbar: ReactNode;
  trailing: ReactNode;
  agentPanel: ReactNode | undefined;
}

/** Scopes that share one remembered list width. */
export type ListFamily = "library" | "items" | "agent" | "sources";
const LIST_DEFAULTS: Record<ListFamily, number> = { library: 340, items: 360, agent: 360, sources: 360 };
export const LIST_MIN = 280;
export const LIST_MAX = 560;
export const CONTENT_MIN = 420;
/** The page beside an open panel: with the sidebar (180), the list (280) and the panel (300) at their narrowest, this still fits an 1100px window. */
export const PAGE_MIN = 320;
export const PANEL_DEFAULT = 360;
export const PANEL_MIN = 300;
export const PANEL_MAX = 520;

/** The 1px column separator: the line is the drag handle. */
export function ColumnSeparator({ label }: { label: string }) {
  return <SplitSeparator aria-label={label} hit={10} footprint={1} line="always" />;
}

/**
 * The list column: the toolbar's list segment on top (52px, so it lines up with the content
 * segment beside it), the list below, and an optional action bar at the bottom.
 */
export function ListColumn({ family, toolbar, listRef, footer, children }: { family: ListFamily; toolbar: ReactNode; listRef?: RefObject<HTMLDivElement | null> | undefined; footer?: ReactNode; children: ReactNode }) {
  const sizes = useSplitSizes("columns");
  const key = `list:${family}`;
  return (
    <>
      <SplitPanel id="list" defaultSize={sizes.sizeOf(key, LIST_DEFAULTS[family])} minSize={LIST_MIN} maxSize={LIST_MAX} onResize={sizes.onResize(key)}>
        <div className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[52px_minmax(0,1fr)] overflow-hidden bg-content">
          {toolbar}
          <div className="flex min-h-0 flex-col">
            <div ref={listRef} className="flex min-h-0 flex-1 flex-col">{children}</div>
            {footer}
          </div>
        </div>
      </SplitPanel>
      <ColumnSeparator label="Resize list" />
    </>
  );
}

/** The content column: whatever the scope shows on the right (a reader, a preview, a conversation, a source). */
export function ContentColumn({ children }: { children: ReactNode }) {
  return <SplitPanel id="content" minSize={CONTENT_MIN} className="bg-content">{children}</SplitPanel>;
}

/**
 * The content column when no reader is open: the toolbar's content segment, the body, and the
 * side panel (the shell's Agent) beside the body when it is open. A reader draws the same rows itself.
 */
export function ContentPane({ toolbar, panel, children }: { toolbar: ReactNode; panel?: ReactNode | undefined; children: ReactNode }) {
  const sizes = useSplitSizes("reader");
  return (
    <div className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[52px_minmax(0,1fr)] overflow-hidden">
      {toolbar}
      <SplitGroup id="pane" aria-label="Content" className="h-full">
        <SplitPanel id="page" minSize={PAGE_MIN}><section className="flex h-full min-h-0 flex-col overflow-hidden">{children}</section></SplitPanel>
        {panel ? (
          <>
            <ColumnSeparator label="Resize panel" />
            <SplitPanel id="inspector" defaultSize={sizes.sizeOf("inspector", PANEL_DEFAULT)} minSize={PANEL_MIN} maxSize={PANEL_MAX} onResize={sizes.onResize("inspector")}>{panel}</SplitPanel>
          </>
        ) : null}
      </SplitGroup>
    </div>
  );
}

/** An empty state is one sentence in the middle of its column; no card, no title. */
export function EmptySentence({ children }: { children: ReactNode }) {
  return <p className="m-0 grid flex-1 place-items-center px-6 text-center text-[13px] text-label-3">{children}</p>;
}
