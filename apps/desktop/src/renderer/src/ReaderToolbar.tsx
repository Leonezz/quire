import type { ReactNode } from "react";
import { Highlighter, Info, List, Sparkles } from "lucide-react";
import { AskButton, Kbd, Toolbar, ToolbarButton, ToolbarGroup, ToolbarTitle } from "@read/ui";
import type { ReaderPanel } from "./ReaderInspector";
import { ReadingSettings } from "./ReadingSettings";
import type { ReadingPrefs } from "./readingPrefs";
import { ViewSwitch, type ViewSwitchProps } from "./ViewSwitch";

export interface ReaderToolbarProps {
  title: string;
  subtitle: string;
  /** The material's quality / format pill; `low` tints it orange. */
  badge: { text: string; low: boolean };
  tocPinned: boolean;
  tocDisabled?: boolean | undefined;
  onTocChange: (pinned: boolean) => void;
  panel: ReaderPanel | null;
  onPanelChange: (panel: ReaderPanel | null) => void;
  prefs: ReadingPrefs;
  onPrefsChange: (prefs: ReadingPrefs) => void;
  /** The shell's Add · Search, at the far right of the segment. */
  trailing?: ReactNode;
  /** The material's views (Web · PDF · Markdown); the switch shows only when there are at least two. */
  views?: ViewSwitchProps | undefined;
}

/** The toolbar's content segment while a material is open: title · where · progress, then the view switch (v) · Contents (t) · Info (i) · Notes (n) · Aa · Ask (⌘J), then the shell's icons. */
export function ReaderToolbar({ title, subtitle, badge, tocPinned, tocDisabled = false, onTocChange, panel, onPanelChange, prefs, onPrefsChange, trailing, views }: ReaderToolbarProps) {
  const toggle = (which: ReaderPanel) => (on: boolean) => onPanelChange(on ? which : null);
  return (
    <Toolbar aria-label="Reader toolbar" className="titlebar-drag">
      <span />
      <ToolbarTitle title={title} subtitle={subtitle} />
      <ToolbarGroup>
        <span className={`mr-1.5 inline-flex h-[20px] items-center rounded-pill px-2 text-[11px] font-medium ${badge.low ? "bg-orange-soft text-orange-text" : "bg-fill text-label-2"}`}>{badge.text}</span>
        {views ? <ViewSwitch {...views} /> : null}
        <ToolbarButton aria-label="Contents (t)" isSelected={tocPinned} isDisabled={tocDisabled} onChange={onTocChange}><List /></ToolbarButton>
        <ToolbarButton aria-label="Info (i)" isSelected={panel === "info"} onChange={toggle("info")}><Info /></ToolbarButton>
        <ToolbarButton aria-label="Notes (n)" isSelected={panel === "notes"} onChange={toggle("notes")}><Highlighter /></ToolbarButton>
        <ReadingSettings prefs={prefs} onChange={onPrefsChange} />
        <AskButton aria-label="Ask" isSelected={panel === "agent"} onChange={toggle("agent")}><Sparkles />Ask<Kbd>⌘J</Kbd></AskButton>
        {trailing ? <i aria-hidden="true" className="mx-1.5 h-4 w-px bg-separator" /> : null}
        {trailing}
      </ToolbarGroup>
    </Toolbar>
  );
}
