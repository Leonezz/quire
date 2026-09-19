import { Children, isValidElement, type ReactNode } from "react";
import { Button as AriaButton, composeRenderProps, type ButtonProps as AriaButtonProps } from "react-aria-components";
import { cx } from "../cx";

export type ButtonVariant = "default" | "primary" | "plain" | "quiet";
export type ButtonSize = "md" | "sm";

export interface ButtonProps extends AriaButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const base = "inline-flex items-center justify-center gap-1.5 rounded-pill border-0 font-medium whitespace-nowrap select-none cursor-default outline-none transition-[background-color,transform] duration-100 data-[pressed]:scale-[.98] data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring data-[disabled]:opacity-45";
const variants: Record<ButtonVariant, string> = {
  default: "bg-fill text-label data-[hovered]:bg-fill-2",
  primary: "bg-accent text-on-accent data-[hovered]:brightness-105",
  plain: "bg-transparent text-accent-text data-[hovered]:bg-accent-soft",
  quiet: "bg-transparent text-label-2 data-[hovered]:bg-fill data-[hovered]:text-label",
};
const sizes: Record<ButtonSize, string> = {
  md: "h-8 px-3.5 text-[13.5px] leading-[18px]",
  sm: "h-7 px-[11px] text-[12.5px] leading-[16px]",
};
// A glyph alone: a square with no padding of its own (a caller's px-0 would lose to px-[11px]), at least 28px to hit.
const iconOnlySizes: Record<ButtonSize, string> = { md: "h-8 min-w-8 px-0", sm: "h-7 min-w-7 px-0" };
// The icon slot: a raw glyph beside text follows the button's size; a glyph alone is always md; an explicit <Icon size> wins.
const iconSlot = { md: "[&>svg:not(.icon)]:size-icon-md [&>svg:not(.icon)]:shrink-0", sm: "[&>svg:not(.icon)]:size-icon-sm [&>svg:not(.icon)]:shrink-0" } as const;

/** One element and nothing else (text nodes count, so `:only-child` cannot tell). */
function isIconOnly(children: AriaButtonProps["children"]): boolean {
  if (typeof children === "function") return false;
  const items = Children.toArray(children as ReactNode);
  return items.length === 1 && isValidElement(items[0]);
}

/** The one button. Variants are roles, not colours: primary is the single next step on a surface. */
export function Button({ variant = "default", size = "md", className, ...props }: ButtonProps) {
  const iconOnly = isIconOnly(props.children);
  const slot = iconSlot[size === "sm" && iconOnly ? "md" : size];
  return (
    <AriaButton
      {...props}
      className={composeRenderProps(className, (cls) => cx(base, variants[variant], iconOnly ? iconOnlySizes[size] : sizes[size], slot, cls))}
    />
  );
}

/** Keyboard hint inside a button or a footer. */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <kbd className={cx("font-sans text-[11px] leading-[14px] font-medium text-current", className)}>{children}</kbd>;
}
