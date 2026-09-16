import { Toolbar as AriaToolbar, ToggleButton, composeRenderProps, type ToggleButtonProps, type ToolbarProps } from "react-aria-components";
import { cx } from "../cx";

/** Floating glass toolbar. Grid: left cluster · title · right cluster. */
export function Toolbar({ className, ...props }: ToolbarProps) {
  return (
    <AriaToolbar
      {...props}
      className={composeRenderProps(className, (cls) => cx("glass grid h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-panel pl-2 pr-2.5", cls))}
    />
  );
}

export function ToolbarGroup({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cx("flex items-center gap-1", className)}>{children}</div>;
}

export function ToolbarTitle({ title, subtitle }: { title: string; subtitle?: string | undefined }) {
  return (
    <div className="flex min-w-0 flex-col justify-center pl-1">
      <strong className="truncate text-[16px] leading-[21px] font-semibold tracking-[-.01em] text-label">{title}</strong>
      {subtitle ? <small className="text-[12.5px] leading-[17px] text-label-2">{subtitle}</small> : null}
    </div>
  );
}

/** Icon button in the toolbar. Use `isSelected` for a panel that is open. */
export function ToolbarButton({ className, ...props }: ToggleButtonProps) {
  return (
    <ToggleButton
      {...props}
      className={composeRenderProps(className, (cls) => cx(
        "inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-control px-2 text-label-2 outline-none transition-colors duration-100",
        "data-[hovered]:bg-fill data-[hovered]:text-label data-[selected]:bg-content data-[selected]:text-label data-[selected]:shadow-[0_1px_2px_rgba(15,17,21,.06),0_0_0_1px_var(--separator-soft)]",
        "data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring [&>svg]:size-[17px]",
        cls,
      ))}
    />
  );
}

/** The global Agent entry: quiet by default, tinted only while the inspector's Agent tab is open. */
export function AskButton({ className, ...props }: ToggleButtonProps) {
  return (
    <ToggleButton
      {...props}
      className={composeRenderProps(className, (cls) => cx(
        "inline-flex h-8 items-center gap-1.5 rounded-pill pl-2.5 pr-[11px] text-[13px] font-medium text-label-2 outline-none shadow-[inset_0_0_0_1px_var(--separator)] transition-colors duration-100",
        "data-[hovered]:bg-fill data-[hovered]:text-label data-[selected]:bg-purple-soft data-[selected]:text-purple-text data-[selected]:shadow-none",
        "data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring [&>svg]:size-4",
        cls,
      ))}
    />
  );
}
