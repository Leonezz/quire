import { GridList, GridListItem, composeRenderProps, type GridListItemProps, type GridListProps } from "react-aria-components";
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
      className={composeRenderProps(className, (cls) => cx("flex flex-col gap-px overflow-auto px-2 py-2.5 outline-none", cls))}
    />
  );
}

export function ItemGroup({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pb-1.5 pt-3.5 text-[11px] font-semibold uppercase tracking-[.07em] text-label-3 first:pt-1">{children}</div>;
}

export type RowState = "unread" | "read" | "queued";

export interface ItemRowProps extends Omit<GridListItemProps, "children"> {
  title: string;
  source: string;
  time?: string;
  gist?: string;
  minutes?: number;
  signals?: string[];
  state?: RowState;
  tag?: "agent" | "summary" | "artifact";
  progress?: number;
}

const tagLabel = { agent: "from Agent", summary: "summary only", artifact: "artifact" } as const;

export function ItemRow({ title, source, time, gist, minutes, signals = [], state = "unread", tag, progress, className, ...props }: ItemRowProps) {
  return (
    <GridListItem
      {...props}
      textValue={title}
      className={composeRenderProps(className, (cls) => cx(
        "group grid w-full grid-cols-[16px_minmax(0,1fr)] gap-x-2.5 rounded-xl py-[11px] pl-2.5 pr-3 text-left outline-none transition-colors duration-100",
        "data-[hovered]:bg-fill data-[selected]:bg-accent-soft data-[selected]:shadow-[inset_0_0_0_1px_rgba(52,103,224,.18)]",
        "data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring data-[dragging]:opacity-60",
        cls,
      ))}
    >
      <span aria-hidden="true" className={cx(
        "mt-[7px] block",
        state === "unread" && "size-[7px] rounded-full bg-accent",
        state === "queued" && "ml-0.5 size-0 border-y-[4.5px] border-l-[6px] border-y-transparent border-l-accent",
      )} />
      <div className="grid min-w-0 gap-0.5">
        <div className="flex items-baseline gap-2">
          <span className={cx("min-w-0 flex-1 truncate text-[14.5px] leading-5 tracking-[-.01em]", state === "read" ? "font-medium text-label-2" : "font-semibold text-label")}>{title}</span>
          {tag ? <span className={cx("whitespace-nowrap rounded-pill px-[7px] py-px text-[10.5px] font-medium leading-[14px]", tag === "summary" ? "bg-fill text-label-2" : "bg-purple-soft text-purple-text")}>{tagLabel[tag]}</span> : null}
          {time ? <span className="whitespace-nowrap text-[11.5px] tabular-nums text-label-3">{time}</span> : null}
        </div>
        <div className="truncate text-[12.5px] leading-[17px] text-label-2">{source}</div>
        {gist ? <div className="mt-0.5 line-clamp-2 text-[13px] leading-[18.5px] text-label-2">{gist}</div> : null}
        {minutes !== undefined || signals.length || progress !== undefined ? (
          <div className="mt-[5px] flex items-center gap-2 text-[11.5px] text-label-3">
            {minutes !== undefined ? <span>{minutes} min</span> : null}
            {signals.length ? <span className="font-mono text-[10.5px] font-medium">{signals.join(" · ")}</span> : null}
            {progress !== undefined ? <span aria-label={`${progress}% read`} className="h-1 w-[72px] overflow-hidden rounded-sm bg-fill-2"><i className="block h-full rounded-sm bg-accent" style={{ width: `${progress}%` }} /></span> : null}
          </div>
        ) : null}
      </div>
    </GridListItem>
  );
}
