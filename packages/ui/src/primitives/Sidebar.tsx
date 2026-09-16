import { Header, ListBox, ListBoxItem, ListBoxSection, composeRenderProps, type ListBoxItemProps, type ListBoxProps } from "react-aria-components";
import { cx } from "../cx";

/** Source list: single selection, roving focus, typeahead — all from ListBox. */
export function Sidebar<T extends object>({ className, ...props }: ListBoxProps<T>) {
  return (
    <ListBox
      {...props}
      selectionMode="single"
      disallowEmptySelection
      className={composeRenderProps(className, (cls) => cx("glass flex flex-col gap-0.5 rounded-panel px-2.5 pb-3 pt-14 outline-none", cls))}
    />
  );
}

export function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <ListBoxSection>
      <Header className="mx-2.5 mb-1.5 mt-3.5 text-[11px] font-semibold uppercase tracking-[.06em] text-label-3">{title}</Header>
      {children}
    </ListBoxSection>
  );
}

export interface SidebarItemProps extends ListBoxItemProps {
  icon?: React.ReactNode;
  label: string;
  count?: number | string;
  attention?: boolean;
}

export function SidebarItem({ icon, label, count, attention, className, ...props }: SidebarItemProps) {
  return (
    <ListBoxItem
      {...props}
      textValue={label}
      className={composeRenderProps(className, (cls) => cx(
        "group flex min-h-[34px] w-full items-center gap-2.5 rounded-control px-2.5 text-left outline-none transition-colors duration-100",
        "data-[hovered]:bg-fill data-[selected]:bg-content data-[selected]:shadow-[0_1px_2px_rgba(15,17,21,.06),0_0_0_1px_var(--separator-soft)]",
        "data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring",
        cls,
      ))}
    >
      {icon ? <span className="[&>svg]:size-[17px] text-label-2 group-data-[selected]:text-accent">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-5">{label}</span>
      {attention ? <i aria-label="needs attention" className="size-[7px] rounded-full bg-orange" /> : null}
      {count !== undefined ? <small className="text-[12px] font-medium tabular-nums text-label-3 group-data-[selected]:text-accent-text">{count}</small> : null}
    </ListBoxItem>
  );
}
