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
  /** Keeps the labels open without hover (the `t` toggle); hover and keyboard focus open them anyway. */
  pinned?: boolean | undefined;
  "aria-label": string;
  className?: string | undefined;
}

const TICK_BY_LEVEL: Record<number, number> = { 1: 18, 2: 14, 3: 10 };
const ACTIVE_TICK = 30;
/** Ticks next to the active one grow a little, like a fisheye, so the eye finds the position. */
const NEIGHBOUR_BONUS = [0, 6, 3, 1];

function tickWidth(entry: TocEntry, index: number, activeIndex: number): number {
  if (index === activeIndex) return ACTIVE_TICK;
  const base = TICK_BY_LEVEL[Math.min(entry.level, 3)] ?? 8;
  const distance = Math.abs(index - activeIndex);
  return base + (activeIndex >= 0 ? NEIGHBOUR_BONUS[distance] ?? 0 : 0);
}

/**
 * Table of contents as a rail of ticks: one tick per heading, the current one dark and long.
 * Hovering, focusing or pinning opens the labels beside the ticks. Arrow keys move between entries.
 */
export function TocRail({ entries, activeId, onSelect, pinned = false, className, ...props }: TocRailProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const expanded = pinned || hovered || focused;
  const activeIndex = entries.findIndex((entry) => entry.id === activeId);

  // When the labels open, keep the current section in view.
  useEffect(() => {
    if (!expanded || activeIndex < 0) return;
    const item = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [expanded, activeIndex]);

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
      data-expanded={expanded || undefined}
      className={cx("group/toc pointer-events-auto flex max-h-full flex-col justify-center", className)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
    >
      <ol
        ref={listRef}
        onKeyDown={onKeyDown}
        className={cx(
          "m-0 flex list-none flex-col p-0 transition-[padding,background-color,box-shadow] duration-150",
          expanded ? "glass-strong max-h-full gap-0 overflow-y-auto rounded-card py-2 pl-2.5 pr-3" : "gap-0 overflow-hidden py-1 pr-1",
        )}
        style={expanded ? undefined : { maxHeight: "100%" }}
      >
        {entries.map((entry, index) => {
          const active = index === activeIndex;
          return (
            <li key={entry.id} className={cx("flex items-center justify-end", expanded ? "h-6" : "h-3")}>
              <button
                type="button"
                aria-label={entry.label}
                aria-current={active ? "location" : undefined}
                onClick={() => onSelect(entry.id)}
                className={cx(
                  "flex h-full w-full cursor-default items-center justify-end gap-2.5 rounded-[6px] border-0 bg-transparent px-1 text-right outline-none",
                  "data-[focus-visible]:ring-[3px] focus-visible:ring-[3px] focus-visible:ring-accent-ring",
                  expanded && "hover:bg-fill",
                )}
              >
                <span
                  className={cx(
                    "truncate text-[12.5px] leading-4 transition-opacity duration-150",
                    expanded ? "max-w-[220px] opacity-100" : "hidden",
                    active ? "font-semibold text-label" : entry.level >= 3 ? "text-label-3" : "text-label-2",
                  )}
                  style={expanded ? { paddingLeft: `${(Math.min(entry.level, 3) - 1) * 10}px` } : undefined}
                >
                  {entry.label}
                </span>
                <i
                  aria-hidden="true"
                  className={cx("block h-[2px] shrink-0 rounded-full transition-[width,background-color] duration-150", active ? "bg-label" : "bg-label-4")}
                  style={{ width: `${expanded ? (active ? 14 : 8) : tickWidth(entry, index, activeIndex)}px` }}
                />
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
