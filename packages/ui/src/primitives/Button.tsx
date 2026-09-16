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

/** The one button. Variants are roles, not colours: primary is the single next step on a surface. */
export function Button({ variant = "default", size = "md", className, ...props }: ButtonProps) {
  return (
    <AriaButton
      {...props}
      className={composeRenderProps(className, (cls) => cx(base, variants[variant], sizes[size], cls))}
    />
  );
}

/** Keyboard hint inside a button or a footer. */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <kbd className={cx("font-sans text-[11px] leading-[14px] font-medium text-current", className)}>{children}</kbd>;
}
