import { Button as AriaButton, Toolbar as AriaToolbar, ToggleButton, composeRenderProps, type ButtonProps, type ToggleButtonProps, type ToolbarProps } from "react-aria-components";
import { ChevronDown } from "lucide-react";
import { Icon } from "./Icon";
import { cx } from "../cx";

/**
 * One segment of the window's 52px toolbar: flat, on the column's own background, closed by the
 * hairline every segment shares so the bar reads as one line across the columns.
 * Grid: left cluster · title · right cluster.
 */
export function Toolbar({ className, ...props }: ToolbarProps) {
  return (
    <AriaToolbar
      {...props}
      className={composeRenderProps(className, (cls) => cx("grid h-[52px] min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-separator px-2.5", cls))}
    />
  );
}

export function ToolbarGroup({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cx("flex items-center gap-0.5", className)}>{children}</div>;
}

export function ToolbarTitle({ title, subtitle }: { title: string; subtitle?: string | undefined }) {
  return (
    <div className="flex min-w-0 flex-col justify-center pl-1">
      <strong className="truncate text-[13.5px] leading-[18px] font-semibold tracking-[-.01em] text-label">{title}</strong>
      {subtitle ? <small className="truncate text-[11.5px] leading-[15px] text-label-2">{subtitle}</small> : null}
    </div>
  );
}

/** Icon button in the toolbar. Use `isSelected` for a panel that is open. */
export function ToolbarButton({ className, ...props }: ToggleButtonProps) {
  return (
    <ToggleButton
      {...props}
      className={composeRenderProps(className, (cls) => cx(
        "inline-flex h-7 min-w-7 items-center justify-center gap-1.5 rounded-control px-1.5 text-label-2 outline-none transition-colors duration-100",
        "data-[hovered]:bg-fill data-[hovered]:text-label data-[selected]:bg-fill-2 data-[selected]:text-label data-[disabled]:opacity-40",
        "data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring [&>svg:not(.icon)]:size-icon-md",
        cls,
      ))}
    />
  );
}

/** The Ask entry: quiet by default, tinted only while the Agent panel is open. */
export function AskButton({ className, ...props }: ToggleButtonProps) {
  return (
    <ToggleButton
      {...props}
      className={composeRenderProps(className, (cls) => cx(
        "inline-flex h-7 items-center gap-1.5 rounded-pill pl-2 pr-2.5 text-[12.5px] font-medium text-label-2 outline-none shadow-[inset_0_0_0_1px_var(--separator)] transition-colors duration-100",
        "data-[hovered]:bg-fill data-[hovered]:text-label data-[selected]:bg-purple-soft data-[selected]:text-purple-text data-[selected]:shadow-none",
        "data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring [&>svg:not(.icon)]:size-icon-md",
        cls,
      ))}
    />
  );
}

export type ToolbarPillTone = "neutral" | "warning";
const pillTones: Record<ToolbarPillTone, string> = {
  neutral: "bg-fill text-label-2 data-[hovered]:bg-fill-2 data-[hovered]:text-label",
  warning: "bg-orange-soft text-orange-text data-[hovered]:brightness-95",
};

/** A small status pill in the toolbar that opens something (a menu) when pressed; `warning` tints it orange. */
export function ToolbarPill({ tone = "neutral", className, children, ...props }: ButtonProps & { tone?: ToolbarPillTone | undefined }) {
  return (
    <AriaButton
      {...props}
      className={composeRenderProps(className, (cls) => cx(
        "inline-flex h-[20px] cursor-default select-none items-center gap-0.5 rounded-pill pl-2 pr-1.5 text-[11px] font-medium outline-none transition-colors duration-100",
        "data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring data-[disabled]:opacity-45",
        pillTones[tone],
        cls,
      ))}
    >
      {composeRenderProps(children, (child) => <>{child}<Icon of={ChevronDown} size="sm" className="opacity-60" /></>)}
    </AriaButton>
  );
}
