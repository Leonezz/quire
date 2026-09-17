import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cx } from "../cx";

export interface TocEntry {
  id: string;
  label: string;
  /** 1 = top level. Deeper levels get shorter ticks. */
  level: number;
}

export interface TocRailProps {
  entries: readonly TocEntry[];
  activeId?: string | undefined;
  onSelect: (id: string) => void;
  /** Opens the full label list (the `t` toggle). Without it the rail is a quiet column of ticks. */
  pinned?: boolean | undefined;
  "aria-label": string;
  className?: string | undefined;
}

const TICK_BY_LEVEL: Record<number, number> = { 1: 14, 2: 10, 3: 7 };
/** How much the tick under the pointer (or keyboard focus) grows, and its neighbours by distance. */
const MAGNIFY = [16, 10, 5, 2];
const ROW = 12;

function baseTick(entry: TocEntry) {
  return TICK_BY_LEVEL[Math.min(entry.level, 3)] ?? 6;
}

/**
 * Table of contents as a rail of short ticks: one per heading, the current one dark.
 * Under the pointer the ticks nearby grow and that heading's label appears beside the rail;
 * keyboard focus does the same for the focused entry. Pinning shows every label.
 */
export function TocRail({ entries, activeId, onSelect, pinned = false, className, ...props }: TocRailProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const activeIndex = entries.findIndex((entry) => entry.id === activeId);
  const magnifyIndex = hoverIndex ?? focusIndex;
  const magnified = !pinned && magnifyIndex !== null;

  useEffect(() => {
    if (!pinned || activeIndex < 0) return;
    (listRef.current?.children[activeIndex] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }, [pinned, activeIndex]);

  const onKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    const jump = { ArrowDown: current + 1, ArrowUp: current - 1, Home: 0, End: buttons.length - 1 }[event.key];
    if (jump === undefined) return;
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, jump))]?.focus();
  };

  return (
    <nav
      aria-label={props["aria-label"]}
      data-expanded={pinned || undefined}
      data-magnified={magnified || undefined}
      className={cx("group/toc pointer-events-auto relative flex max-h-full flex-col justify-center", className)}
    >
      <ol
        ref={listRef}
        onKeyDown={onKeyDown}
        onPointerLeave={() => setHoverIndex(null)}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusIndex(null); }}
        className={cx(
          "m-0 flex list-none flex-col p-0 transition-[background-color,box-shadow,padding] duration-150",
          pinned ? "glass-strong max-h-full overflow-y-auto rounded-card py-2 pl-2.5 pr-3" : "overflow-visible py-1 pl-6 pr-1",
        )}
      >
        {entries.map((entry, index) => {
          const active = index === activeIndex;
          const distance = magnifyIndex === null ? Number.POSITIVE_INFINITY : Math.abs(index - magnifyIndex);
          const grow = magnified ? MAGNIFY[distance] ?? 0 : 0;
          const width = pinned ? (active ? 14 : 8) : baseTick(entry) + grow;
          const showLabel = pinned || (magnified && distance === 0);
          return (
            <li key={entry.id} onPointerEnter={() => { if (!pinned) setHoverIndex(index); }} className={cx("relative flex items-center justify-end", pinned ? "h-6" : "")} style={pinned ? undefined : { height: `${ROW}px` }}>
              <button
                type="button"
                aria-label={entry.label}
                aria-current={active ? "location" : undefined}
                onClick={() => onSelect(entry.id)}
                onFocus={() => setFocusIndex(index)}
                className={cx(
                  "flex h-full w-full cursor-default items-center justify-end gap-2.5 rounded-[6px] border-0 bg-transparent px-1 text-right outline-none focus-visible:ring-[3px] focus-visible:ring-accent-ring",
                  pinned && "hover:bg-fill",
                )}
              >
                {pinned ? (
                  <span
                    className={cx("max-w-[220px] truncate text-[12.5px] leading-4", active ? "font-semibold text-label" : entry.level >= 3 ? "text-label-3" : "text-label-2")}
                    style={{ paddingLeft: `${(Math.min(entry.level, 3) - 1) * 10}px` }}
                  >
                    {entry.label}
                  </span>
                ) : null}
                <i
                  aria-hidden="true"
                  className={cx("block h-[2px] shrink-0 rounded-full transition-[width,background-color] duration-100", active ? "bg-label" : grow > 0 ? "bg-label-2" : "bg-label-4")}
                  style={{ width: `${width}px` }}
                />
              </button>
              {!pinned && showLabel ? (
                <span
                  role="presentation"
                  className="glass-strong pointer-events-none absolute right-full top-1/2 mr-3 max-w-[260px] -translate-y-1/2 truncate whitespace-nowrap rounded-[9px] px-2.5 py-1 text-[12.5px] font-medium leading-4 text-label"
                >
                  {entry.label}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
