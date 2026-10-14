import { useLayoutEffect, useRef } from "react";
import { ToggleButton, ToggleButtonGroup, composeRenderProps, type ToggleButtonGroupProps, type ToggleButtonProps } from "react-aria-components";
import { cx } from "../cx";

/** Capsule segmented control: exactly one selected. One pill slides under the selected segment. */
export function Segmented({ className, children, ...props }: ToggleButtonGroupProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const group = groupRef.current;
    const pill = pillRef.current;
    if (!group || !pill) return;
    // The pill follows the segment react-aria marks selected, however the selection changed (a press, the owner's
    // state, a keyboard move). The first placement and a resize snap; only a change of segment slides.
    const place = (animate: boolean) => {
      const segment = group.querySelector<HTMLElement>("[data-selected]");
      pill.style.opacity = segment ? "1" : "0";
      if (!segment) return;
      if (!animate) pill.style.transition = "none";
      pill.style.transform = `translate(${segment.offsetLeft}px, ${segment.offsetTop}px)`;
      pill.style.width = `${segment.offsetWidth}px`;
      pill.style.height = `${segment.offsetHeight}px`;
      if (!animate) { void pill.offsetWidth; pill.style.transition = ""; }
    };
    place(false);
    const selection = new MutationObserver(() => place(true));
    selection.observe(group, { subtree: true, attributeFilter: ["data-selected"] });
    const size = new ResizeObserver(() => place(false));
    size.observe(group);
    return () => { selection.disconnect(); size.disconnect(); };
  }, []);
  return (
    <ToggleButtonGroup
      {...props}
      ref={groupRef}
      selectionMode="single"
      disallowEmptySelection
      className={composeRenderProps(className, (cls) => cx("relative inline-flex rounded-pill bg-fill p-[3px]", cls))}
    >
      {composeRenderProps(children, (child) => (
        <>
          <span ref={pillRef} aria-hidden="true" className="t-tabs-pill pointer-events-none absolute left-0 top-0 h-0 w-0 rounded-pill bg-content opacity-0 shadow-[0_1px_3px_rgba(15,17,21,.10)]" />
          {child}
        </>
      ))}
    </ToggleButtonGroup>
  );
}

export function Segment({ className, ...props }: ToggleButtonProps) {
  return (
    <ToggleButton
      {...props}
      className={composeRenderProps(className, (cls) => cx(
        "relative h-[26px] rounded-pill px-3 text-[12.5px] font-medium leading-4 text-label-2 outline-none transition-colors duration-(--tabs-dur) ease-(--ease-smooth-out) motion-reduce:transition-none",
        "data-[hovered]:text-label data-[selected]:text-label",
        "data-[focus-visible]:ring-[3px] data-[focus-visible]:ring-accent-ring",
        cls,
      ))}
    />
  );
}
