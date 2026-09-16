import { Dialog, Popover as AriaPopover, composeRenderProps, type PopoverProps } from "react-aria-components";
import { cx } from "../cx";

/** Glass popover anchored to its trigger; Esc and outside click dismiss. */
export function Popover({ className, children, "aria-label": ariaLabel, ...props }: PopoverProps & { children: React.ReactNode; "aria-label"?: string | undefined }) {
  return (
    <AriaPopover
      {...props}
      offset={props.offset ?? 8}
      className={composeRenderProps(className, (cls) => cx("glass-strong rounded-[18px] p-3.5 outline-none entering:animate-[fade_.12s_ease] exiting:animate-[fade_.1s_ease_reverse]", cls))}
    >
      <Dialog className="outline-none" {...(ariaLabel ? { "aria-label": ariaLabel } : {})}>{children}</Dialog>
    </AriaPopover>
  );
}
