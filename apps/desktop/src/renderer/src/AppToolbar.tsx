import type { ReactNode } from "react";
import { ArrowDownWideNarrow, ChevronDown, PanelLeft, Plus, Search as SearchIcon } from "lucide-react";
import { Button, Icon, Menu, MenuItem, MenuTrigger, Toolbar, ToolbarButton, ToolbarGroup } from "@read/ui";
import { SORT_LABELS, type LibrarySort } from "./useLibrary";

const SORTS = Object.keys(SORT_LABELS) as LibrarySort[];

/** Add (⌘N) and Search (⌘K): the two quiet icons at the right end of every content segment. */
export function ShellActions({ addOpen, onAdd, searchOpen, onSearch }: { addOpen: boolean; onAdd: (open: boolean) => void; searchOpen: boolean; onSearch: (open: boolean) => void }) {
  return (
    <>
      <ToolbarButton aria-label="Add (⌘N)" isSelected={addOpen} onChange={onAdd}><Plus /></ToolbarButton>
      <ToolbarButton aria-label="Search (⌘K)" isSelected={searchOpen} onChange={onSearch}><SearchIcon /></ToolbarButton>
    </>
  );
}

/** Newest / Oldest / Title, as a quiet button naming the current order. */
/** `compact`: the icon alone (the name stays in the label), where the segment has the traffic lights' inset to pay for. */
export function SortMenu({ sort, onChange, compact = false }: { sort: LibrarySort; onChange: (sort: LibrarySort) => void; compact?: boolean }) {
  return (
    <MenuTrigger>
      <Button size="sm" variant="quiet" className="shrink-0 gap-1 px-2" aria-label={`Sort: ${SORT_LABELS[sort]}`}><ArrowDownWideNarrow />{compact ? null : <>{SORT_LABELS[sort]}<Icon of={ChevronDown} size="sm" className="opacity-60" /></>}</Button>
      <Menu aria-label="Sort" selectionMode="single" disallowEmptySelection selectedKeys={[sort]} onSelectionChange={(keys) => { const key = keys === "all" ? undefined : [...keys][0]; if (key) onChange(key as LibrarySort); }}>
        {SORTS.map((entry) => <MenuItem key={entry} id={entry}>{SORT_LABELS[entry]}</MenuItem>)}
      </Menu>
    </MenuTrigger>
  );
}

export interface ListToolbarProps {
  title: string;
  count: number;
  /** The sidebar is hidden: the segment reaches the window's left edge, keeps the traffic lights' 80px clear, and carries the sidebar button. */
  inset: boolean;
  onShowSidebar: () => void;
  sort?: { value: LibrarySort; onChange: (sort: LibrarySort) => void } | undefined;
}

/** The toolbar's list segment: "Inbox · 47", the search field in Library scopes, the sort at the far right. */
export function ListToolbar({ title, count, inset, onShowSidebar, sort }: ListToolbarProps) {
  return (
    // With the sidebar hidden the segment starts under the traffic lights: 92px keeps the toggle clear of them, as Mail does.
    <header aria-label="List toolbar" className={`titlebar-drag flex h-[52px] min-w-0 items-center gap-2.5 overflow-hidden border-b border-separator pr-2.5 ${inset ? "pl-[92px]" : "pl-3.5"}`}>
      {inset ? <ToolbarButton aria-label="Show sidebar (⌘\\)" isSelected={false} onChange={onShowSidebar} className="reader-enter shrink-0"><PanelLeft /></ToolbarButton> : null}
      <strong className="min-w-[64px] shrink truncate text-[13.5px] font-semibold leading-[18px] tracking-[-.01em] text-label">{title} <span className="font-medium tabular-nums text-label-3">· {count}</span></strong>
      {sort ? <div className="ml-auto"><SortMenu sort={sort.value} onChange={sort.onChange} compact={false} /></div> : null}
    </header>
  );
}

/** The toolbar's content segment when no material is open: the scope's actions, then the shell's Add · Search. */
export function ContentToolbar({ actions, trailing }: { actions?: ReactNode; trailing: ReactNode }) {
  return (
    <Toolbar aria-label="Toolbar" className="titlebar-drag">
      <span />
      <span />
      <ToolbarGroup>
        {actions}
        {actions ? <i aria-hidden="true" className="mx-1.5 h-4 w-px bg-separator" /> : null}
        {trailing}
      </ToolbarGroup>
    </Toolbar>
  );
}
