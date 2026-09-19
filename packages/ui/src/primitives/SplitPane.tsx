import { useCallback, useMemo } from "react";
import { Group, Panel, Separator, usePanelRef, type GroupProps, type PanelImperativeHandle, type PanelProps, type SeparatorProps } from "react-resizable-panels";
import { cx } from "../cx";

export type { PanelImperativeHandle as SplitPanelHandle };
export { usePanelRef as useSplitPanelRef };

const STORAGE_PREFIX = "read:layout:";

type Sizes = Record<string, number>;

/** The saved pixel sizes of a group's panels, or {} when storage is empty, unreadable or unavailable. */
export function loadSplitSizes(group: string): Sizes {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${group}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || !Object.values(parsed).every((value) => typeof value === "number")) return {};
    return parsed as Sizes;
  } catch {
    // Storage may be unavailable (private mode, a blocked origin); the default sizes are a legitimate mode.
    return {};
  }
}

function saveSplitSize(group: string, panel: string, size: number): void {
  try { localStorage.setItem(`${STORAGE_PREFIX}${group}`, JSON.stringify({ ...loadSplitSizes(group), [panel]: size })); } catch { /* same as above */ }
}

/**
 * Remembered pixel sizes for the fixed panels of a group, under `read:layout:<group>`.
 * `sizeOf` gives a panel's `defaultSize`; `onResize` saves what the user drags it to.
 * Sizes are pixels, not percentages, so a panel comes back the same width whatever the window is.
 */
export function useSplitSizes(group: string) {
  const saved = useMemo(() => loadSplitSizes(group), [group]);
  const sizeOf = useCallback((panel: string, fallback: number) => saved[panel] ?? fallback, [saved]);
  // The mount report (no previous size) is the default or a measurement in progress, never something to remember.
  const onResize = useCallback((panel: string) => (size: { inPixels: number }, _id: string | number | undefined, previous: { inPixels: number } | undefined) => {
    if (previous !== undefined && size.inPixels > 0) saveSplitSize(group, panel, Math.round(size.inPixels));
  }, [group]);
  return { sizeOf, onResize };
}

export interface SplitGroupProps extends Omit<GroupProps, "id"> {
  /** Names the group (and its storage key when its panels use `useSplitSizes`). */
  id: string;
  "aria-label"?: string | undefined;
}

/** A horizontal (or vertical) group of resizable panels. Panels persist their own sizes through `useSplitSizes`. */
export function SplitGroup({ id, className, orientation = "horizontal", children, ...props }: SplitGroupProps) {
  return (
    <Group {...props} id={id} orientation={orientation} className={cx("min-h-0 min-w-0", className)}>
      {children}
    </Group>
  );
}

export interface SplitPanelProps extends PanelProps {
  id: string;
}

/**
 * One pane. Sizes in pixels: `minSize`, `maxSize`, `defaultSize`; `collapsible` lets it fold to zero.
 * A pane with a `defaultSize` keeps its pixel width when the window resizes; the one without absorbs the change.
 */
export function SplitPanel({ className, children, ...props }: SplitPanelProps) {
  const behaviour = props.groupResizeBehavior ?? (props.defaultSize !== undefined ? "preserve-pixel-size" : "preserve-relative-size");
  return <Panel {...props} groupResizeBehavior={behaviour} className={cx("flex min-h-0 min-w-0 flex-col", className)}>{children}</Panel>;
}

export interface SplitSeparatorProps extends Omit<SeparatorProps, "style"> {
  "aria-label": string;
  /** The parent group's orientation (it decides which way the line runs); horizontal by default. */
  orientation?: "horizontal" | "vertical" | undefined;
  /** Width of the pointer target in pixels (8 by default). */
  hit?: number | undefined;
  /** Space the separator takes in the layout (1px by default); the hit area overflows it on both sides. */
  footprint?: number | undefined;
  /** "always": a hairline is drawn at rest (it replaces a border); "hover": invisible until hovered, dragged or focused. */
  line?: "always" | "hover" | undefined;
}

/**
 * A 1px line whose hit area is wider than its footprint. Hover, drag and keyboard focus tint it
 * with the accent; ←/→ (or ↑/↓) resize in steps, Home/End collapse or expand, Enter toggles a
 * collapsible neighbour — all from react-resizable-panels' separator role.
 */
export function SplitSeparator({ className, orientation = "horizontal", hit = 8, footprint = 1, line = "always", ...props }: SplitSeparatorProps) {
  const horizontal = orientation === "horizontal";
  const overflow = Math.max(0, (hit - footprint) / 2);
  const style = horizontal ? { width: hit, marginLeft: -overflow, marginRight: -overflow } : { height: hit, marginTop: -overflow, marginBottom: -overflow };
  return (
    <Separator
      {...props}
      style={style}
      className={cx("group relative z-10 shrink-0 outline-none", horizontal ? "cursor-col-resize" : "cursor-row-resize", className)}
    >
      <span aria-hidden="true" className={cx(
        "pointer-events-none absolute transition-colors duration-100",
        horizontal ? "inset-y-0 left-1/2 w-px -translate-x-1/2" : "inset-x-0 top-1/2 h-px -translate-y-1/2",
        line === "always" ? "bg-separator" : "bg-transparent",
        "group-data-[separator=hover]:bg-accent group-data-[separator=active]:bg-accent group-data-[separator=focus]:bg-accent",
        horizontal ? "group-data-[separator=active]:w-[2px] group-data-[separator=focus]:w-[2px]" : "group-data-[separator=active]:h-[2px] group-data-[separator=focus]:h-[2px]",
      )} />
    </Separator>
  );
}
