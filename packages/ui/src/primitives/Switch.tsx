import { useState } from "react";
import { Switch as AriaSwitch, composeRenderProps, type SwitchProps } from "react-aria-components";
import { cx } from "../cx";

export function Switch({ className, children, onChange, ...props }: SwitchProps) {
  // The thumb's bounce plays only once the switch has been flipped, never when it mounts already on.
  const [flipped, setFlipped] = useState(false);
  return (
    <AriaSwitch {...props} onChange={(value) => { setFlipped(true); onChange?.(value); }} className={composeRenderProps(className, (cls) => cx("group inline-flex items-center gap-2.5 text-[14px] text-label outline-none", cls))}>
      {composeRenderProps(children, (child, { isSelected }) => (
        <>
          <span data-on={isSelected} data-init={flipped || undefined} className="relative h-[22px] w-[38px] rounded-full bg-fill-2 [--toggle-travel:16px] group-data-[selected]:bg-accent group-data-[focus-visible]:ring-[3px] group-data-[focus-visible]:ring-accent-ring">
            <span className="t-toggle-thumb absolute left-0.5 top-0.5 size-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,.25)]" />
          </span>
          {child}
        </>
      ))}
    </AriaSwitch>
  );
}
