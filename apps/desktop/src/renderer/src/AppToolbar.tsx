import type { ReactNode } from "react";
import { ArrowDownWideNarrow, ChevronDown, PanelLeft, Plus, Search as SearchIcon } from "lucide-react";
import { Button, Menu, MenuItem, MenuTrigger, Search, Toolbar, ToolbarButton, ToolbarGroup } from "@read/ui";
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
      <Button size="sm" variant="quiet" className="shrink-0 gap-1 px-2" aria-label={`Sort: ${SORT_LABELS[sort]}`}><ArrowDownWideNarrow className="size-3.5" />{compact ? null : <>{SORT_LABELS[sort]}<ChevronDown className="size-3 opacity-60" /></>}</Button>
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
  /** The Library's search field (Library and tag scopes only). */
  search?: { value: string; onChange: (value: string) => void } | undefined;
  sort?: { value: LibrarySort; onChange: (sort: LibrarySort) => void } | undefined;
}

/** The toolbar's list segment: "Inbox · 47", the search field in Library scopes, the sort at the far right. */
export function ListToolbar({ title, count, inset, onShowSidebar, search, sort }: ListToolbarProps) {
  return (
    <header aria-label="List toolbar" className={`titlebar-drag flex h-[52px] min-w-0 items-center gap-2 overflow-hidden border-b border-separator pr-2.5 ${inset ? "pl-[80px]" : "pl-3.5"}`}>
      {inset ? <ToolbarButton aria-label="Show sidebar (⌘\\)" isSelected={false} onChange={onShowSidebar} className="shrink-0"><PanelLeft /></ToolbarButton> : null}
      <strong className="min-w-[64px] shrink truncate text-[13.5px] font-semibold leading-[18px] tracking-[-.01em] text-label">{title} <span className="font-medium tabular-nums text-label-3">· {count}</span></strong>
      {search ? <Search aria-label="Search the library" placeholder="Search" value={search.value} onChange={search.onChange} className="ml-auto h-7 min-w-[40px] max-w-[220px] flex-1 px-2.5 text-[13px]" /> : null}
      {sort ? <div className={search ? "" : "ml-auto"}><SortMenu sort={sort.value} onChange={sort.onChange} compact={inset && search !== undefined} /></div> : null}
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
