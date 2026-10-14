import { Checkbox as AriaCheckbox, composeRenderProps, type CheckboxProps } from "react-aria-components";
import { cx } from "../cx";

/** A labelled checkbox: the box is drawn here, the label is the children. Space toggles. */
export function Checkbox({ className, children, ...props }: CheckboxProps) {
  return (
    <AriaCheckbox {...props} className={composeRenderProps(className, (cls) => cx("group inline-flex cursor-default items-start gap-2.5 text-[13.5px] leading-[19px] text-label outline-none data-[disabled]:opacity-45", cls))}>
      {composeRenderProps(children, (child, { isSelected }) => (
        <>
          <span className="mt-px grid size-[18px] shrink-0 place-items-center rounded-[5px] bg-fill shadow-[inset_0_0_0_1px_var(--separator)] transition-[background-color,box-shadow] duration-(--check-box) ease-(--ease-smooth-out) motion-reduce:transition-none group-data-[selected]:bg-accent group-data-[selected]:shadow-none group-data-[focus-visible]:ring-[3px] group-data-[focus-visible]:ring-accent-ring">
            {/* The mark is drawn, not an icon glyph: its stroke has to be a known length to draw itself in. */}
            <svg aria-hidden="true" data-on={isSelected} viewBox="0 0 10.1668 10.1668" className="size-[10px] overflow-visible text-on-accent" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              <path className="t-check-mark" d="M1 5.52L3.92 9.17L9.17 1" />
            </svg>
          </span>
          <span className="min-w-0">{child}</span>
        </>
      ))}
    </AriaCheckbox>
  );
}
