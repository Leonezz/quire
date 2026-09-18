import { Button, Collection, GridList, GridListHeader, GridListItem, GridListSection, composeRenderProps, type GridListItemProps, type GridListProps, type GridListSectionProps } from "react-aria-components";
import { Bookmark, GripVertical } from "lucide-react";
import { cx } from "../cx";

/**
 * The one list row: Inbox, Queue, Library. GridList gives selection (single /
 * multiple with Shift and ⌘ like Finder), roving focus, typeahead, and — when
 * `dragAndDropHooks` is passed — keyboard-accessible reordering.
 */
export function ItemList<T extends object>({ className, ...props }: GridListProps<T>) {
  return (
    <GridList
      {...props}
      className={composeRenderProps(className, (cls) => cx("flex flex-col gap-px overflow-y-auto overflow-x-hidden px-2 py-2.5 outline-none", cls))}
    />
  );
}

const groupClass = "px-3 pb-1.5 pt-3.5 text-[11px] font-semibold uppercase tracking-[.07em] text-label-3 first:pt-1";

/** A heading above a list (or above the first section) that is not part of the keyboard collection. */
export function ItemGroup({ children }: { children: React.ReactNode }) {
  return <div className={groupClass}>{children}</div>;
}

/**
 * A titled section inside an ItemList: rows of several sections form one collection, so ↑/↓,
 * typeahead and selection cross section boundaries (unlike stacking several lists).
 */
export function ItemSection<T extends object>({ title, className, items, children, ...props }: Omit<GridListSectionProps<T>, "children" | "items"> & { title: string; items: Iterable<T>; children: (item: T) => React.ReactElement }) {
  return (
    <GridListSection {...props} className={cx("flex flex-col gap-px", className)}>
      <GridListHeader className={groupClass}>{title}</GridListHeader>
      <Collection items={items}>{children}</Collection>
    </GridListSection>
  );
}

export type RowState = "unread" | "read" | "queued";
/** A source's health, shown as a coloured dot in the marker column (with a text label for assistive tech). */
export type RowHealth = "ok" | "paused" | "failing";

export interface ItemRowProps extends Omit<GridListItemProps, "children"> {
  title: string;
  source: string;
  time?: string;
  gist?: string;
  minutes?: number;
  signals?: string[];
  state?: RowState;
  tag?: "agent" | "summary" | "artifact" | "rebuilt";
  progress?: number;
  /** User tags, shown as small chips after the source (the first `maxChips`, then "+n"). */
  chips?: string[];
  maxChips?: number;
  /** A bookmark glyph after the time: the item was kept into the library. */
  kept?: boolean;
  /** Replaces the read-state marker; use for Sources. */
  health?: RowHealth;
  /** A line under the source, for something the row must say in its own words (an error). */
  detail?: React.ReactNode;
}

const tagLabel = { agent: "from Agent", summary: "summary only", artifact: "artifact", rebuilt: "rebuilt" } as const;
const healthLabel: Record<RowHealth, string> = { ok: "healthy", paused: "paused", failing: "failing" };

export function ItemRow({ title, source, time, gist, minutes, signals = [], state = "unread", tag, progress, chips = [], maxChips = 3, kept = false, health, detail, className, ...props }: ItemRowProps) {
  const shownChips = chips.slice(0, maxChips);
  const hiddenChips = chips.length - shownChips.length;
  return (
    <GridListItem
      {...props}
      textValue={title}
      className={composeRenderProps(className, (cls) => cx(
        "group relative grid w-full min-w-0 max-w-full shrink-0 grid-cols-[16px_minmax(0,1fr)] gap-x-2.5 rounded-xl py-[11px] pl-2.5 pr-3 text-left outline-none transition-colors duration-100",
        "data-[hovered]:bg-fill data-[selected]:bg-accent-soft data-[selected]:shadow-[inset_0_0_0_1px_rgba(52,103,224,.18)]",
        "data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring data-[dragging]:opacity-60",
        cls,
      ))}
    >
      {({ allowsDragging }) => (<>
      {allowsDragging ? (
        // The keyboard path for reordering: → from the row focuses the grip; Enter lifts, ↑/↓ move, Enter drops, Esc cancels.
        <Button slot="drag" aria-label={`Drag ${title}`} className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 cursor-grab place-items-center rounded-control text-label-3 opacity-0 outline-none transition-opacity duration-100 group-data-[hovered]:opacity-100 group-data-[focus-visible]:opacity-100 data-[focus-visible]:opacity-100 data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring [&>svg]:size-[15px]"><GripVertical /></Button>
      ) : null}
      {health ? (
        <span role="img" aria-label={healthLabel[health]} className={cx("mt-[7px] block size-[7px] rounded-full", health === "ok" && "bg-green", health === "paused" && "bg-orange", health === "failing" && "bg-red")} />
      ) : (
        <span aria-hidden="true" className={cx(
          "mt-[7px] block",
          state === "unread" && "size-[7px] rounded-full bg-accent",
          state === "queued" && "ml-0.5 size-0 border-y-[4.5px] border-l-[6px] border-y-transparent border-l-accent",
        )} />
      )}
      <div className="grid min-w-0 grid-cols-1 gap-0.5">
        <div className="flex items-baseline gap-2">
          <span className={cx("min-w-0 flex-1 truncate text-[14.5px] leading-5 tracking-[-.01em]", state === "read" ? "font-medium text-label-2" : "font-semibold text-label")}>{title}</span>
          {tag ? <span className={cx("whitespace-nowrap rounded-pill px-[7px] py-px text-[10.5px] font-medium leading-[14px]", tag === "summary" ? "bg-fill text-label-2" : tag === "rebuilt" ? "bg-accent-soft text-accent-text" : "bg-purple-soft text-purple-text")}>{tagLabel[tag]}</span> : null}
          {time ? <span className="whitespace-nowrap text-[11.5px] tabular-nums text-label-3">{time}</span> : null}
          {kept ? <Bookmark role="img" aria-label="kept" className="size-3 shrink-0 self-center fill-current text-label-3" /> : null}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-[17px] text-label-2">
          <span className="min-w-0 truncate">{source}</span>
          {shownChips.length ? (
            <span className="flex shrink-0 items-center gap-1" aria-label={`tags: ${chips.join(", ")}`}>
              {shownChips.map((chip) => <span key={chip} className="max-w-[96px] truncate rounded-pill bg-fill px-1.5 text-[10.5px] font-medium leading-[15px] text-label-2">{chip}</span>)}
              {hiddenChips > 0 ? <span className="text-[10.5px] font-medium text-label-3">+{hiddenChips}</span> : null}
            </span>
          ) : null}
        </div>
        {detail ? <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-[17px]">{detail}</div> : null}
        {gist ? <div className="mt-0.5 line-clamp-2 text-[13px] leading-[18.5px] text-label-2">{gist}</div> : null}
        {minutes !== undefined || signals.length || progress !== undefined ? (
          <div className="mt-[5px] flex items-center gap-2 text-[11.5px] text-label-3">
            {minutes !== undefined ? <span>{minutes} min</span> : null}
            {signals.length ? <span className="font-mono text-[10.5px] font-medium">{signals.join(" · ")}</span> : null}
            {progress !== undefined ? <span aria-label={`${progress}% read`} className="h-1 w-[72px] overflow-hidden rounded-sm bg-fill-2"><i className="block h-full rounded-sm bg-accent" style={{ width: `${progress}%` }} /></span> : null}
          </div>
        ) : null}
      </div>
      </>)}
    </GridListItem>
  );
}
