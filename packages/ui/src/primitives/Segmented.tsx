import { ToggleButton, ToggleButtonGroup, composeRenderProps, type ToggleButtonGroupProps, type ToggleButtonProps } from "react-aria-components";
import { cx } from "../cx";

/** Capsule segmented control: exactly one selected. */
export function Segmented({ className, ...props }: ToggleButtonGroupProps) {
  return (
    <ToggleButtonGroup
      {...props}
      selectionMode="single"
      disallowEmptySelection
      className={composeRenderProps(className, (cls) => cx("inline-flex rounded-pill bg-fill p-[3px]", cls))}
    />
  );
}

export function Segment({ className, ...props }: ToggleButtonProps) {
  return (
    <ToggleButton
      {...props}
      className={composeRenderProps(className, (cls) => cx(
        "h-[26px] rounded-pill px-3 text-[12.5px] font-medium leading-4 text-label-2 outline-none transition-colors duration-100",
        "data-[hovered]:text-label data-[selected]:bg-content data-[selected]:text-label data-[selected]:shadow-[0_1px_3px_rgba(15,17,21,.10)]",
        "data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring",
        cls,
      ))}
    />
  );
}
