import { Checkbox as AriaCheckbox, composeRenderProps, type CheckboxProps } from "react-aria-components";
import { Check } from "lucide-react";
import { Icon } from "./Icon";
import { cx } from "../cx";

/** A labelled checkbox: the box is drawn here, the label is the children. Space toggles. */
export function Checkbox({ className, children, ...props }: CheckboxProps) {
  return (
    <AriaCheckbox {...props} className={composeRenderProps(className, (cls) => cx("group inline-flex cursor-default items-start gap-2.5 text-[13.5px] leading-[19px] text-label outline-none data-[disabled]:opacity-45", cls))}>
      {composeRenderProps(children, (child) => (
        <>
          <span className="mt-px grid size-[18px] shrink-0 place-items-center rounded-[5px] bg-fill shadow-[inset_0_0_0_1px_var(--separator)] transition-colors group-data-[selected]:bg-accent group-data-[selected]:shadow-none group-data-[focus-visible]:ring-[3px] group-data-[focus-visible]:ring-accent-ring">
            <Icon of={Check} size="sm" className="text-on-accent opacity-0 transition-opacity group-data-[selected]:opacity-100" />
          </span>
          <span className="min-w-0">{child}</span>
        </>
      ))}
    </AriaCheckbox>
  );
}
