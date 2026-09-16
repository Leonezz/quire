import { Switch as AriaSwitch, composeRenderProps, type SwitchProps } from "react-aria-components";
import { cx } from "../cx";

export function Switch({ className, children, ...props }: SwitchProps) {
  return (
    <AriaSwitch {...props} className={composeRenderProps(className, (cls) => cx("group inline-flex items-center gap-2.5 text-[14px] text-label outline-none", cls))}>
      {composeRenderProps(children, (child) => (
        <>
          <span className="relative h-[22px] w-[38px] rounded-full bg-fill-2 transition-colors group-data-[selected]:bg-accent group-data-[focus-visible]:ring-[3px] group-data-[focus-visible]:ring-accent-ring">
            <span className="absolute left-0.5 top-0.5 size-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,.25)] transition-[left] duration-150 group-data-[selected]:left-[18px]" />
          </span>
          {child}
        </>
      ))}
    </AriaSwitch>
  );
}
