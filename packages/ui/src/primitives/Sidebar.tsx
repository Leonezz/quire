import type { Ref } from "react";
import { Header, ListBox, ListBoxItem, ListBoxSection, composeRenderProps, type ListBoxItemProps, type ListBoxProps } from "react-aria-components";
import { cx } from "../cx";

/**
 * The scope list: one ListBox over every section, so ↑/↓ and typeahead cross section boundaries.
 * Single selection; section headers are not options. Transparent: the window's vibrancy shows through.
 */
export function Sidebar<T extends object>({ className, ...props }: ListBoxProps<T>) {
  return (
    <ListBox
      {...props}
      selectionMode="single"
      disallowEmptySelection
      className={composeRenderProps(className, (cls) => cx("flex min-h-0 flex-col gap-px overflow-y-auto overflow-x-hidden px-2.5 pb-2 outline-none", cls))}
    />
  );
}

/** A titled group of scopes; without `title` (the first section) the items start at the top. */
export function SidebarSection({ title, children }: { title?: string | undefined; children: React.ReactNode }) {
  return (
    <ListBoxSection className="flex flex-col gap-px">
      {title ? <Header className="mx-2.5 mb-1 mt-4 text-[11px] font-semibold uppercase tracking-[.06em] text-label-3">{title}</Header> : null}
      {children}
    </ListBoxSection>
  );
}

/** A source's health, as a dot before its name (with a text label for assistive tech). */
export type SidebarHealth = "ok" | "paused" | "failing";
const healthLabel: Record<SidebarHealth, string> = { ok: "healthy", paused: "paused", failing: "failing" };

export interface SidebarItemProps extends ListBoxItemProps {
  icon?: React.ReactNode;
  label: string;
  count?: number | string;
  attention?: boolean;
  health?: SidebarHealth | undefined;
  /** Quieter type for an entry that opens something rather than naming a scope ("All tags…", "Manage sources…"). */
  quiet?: boolean | undefined;
  ref?: Ref<HTMLDivElement> | undefined;
}

export function SidebarItem({ icon, label, count, attention, health, quiet, className, ...props }: SidebarItemProps) {
  return (
    <ListBoxItem
      {...props}
      textValue={label}
      className={composeRenderProps(className, (cls) => cx(
        "group flex h-[28px] w-full items-center gap-2 rounded-control px-2.5 text-left outline-none transition-colors duration-100",
        "data-[hovered]:bg-fill data-[selected]:bg-fill-2",
        "data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring",
        cls,
      ))}
    >
      {icon ? <span className="shrink-0 text-label-2 [&>svg]:size-4 group-data-[selected]:text-accent">{icon}</span> : null}
      {health ? <span role="img" aria-label={healthLabel[health]} className={cx("size-[7px] shrink-0 rounded-full", health === "ok" && "bg-green", health === "paused" && "bg-orange", health === "failing" && "bg-red")} /> : null}
      <span className={cx("min-w-0 flex-1 truncate text-[13px] leading-5", quiet ? "text-label-3" : "font-medium text-label")}>{label}</span>
      {attention ? <i aria-label="needs attention" className="size-[7px] rounded-full bg-orange" /> : null}
      {count !== undefined ? <small className="text-[12px] font-medium tabular-nums text-label-3">{count}</small> : null}
    </ListBoxItem>
  );
}
