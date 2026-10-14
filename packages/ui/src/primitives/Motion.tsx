import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { cx } from "../cx";

/**
 * Keeps its child mounted while it leaves: when `show` turns false the last child stays, its wrapper is marked
 * [data-exiting] (theme.css switches `t-toast` to its exit), and it unmounts once its animations finish. The wrapper
 * is `display: contents`, so it takes no part in layout and the child positions itself as before.
 */
export function Presence({ show, children }: { show: boolean; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(show);
  const kept = useRef<React.ReactNode>(children);
  const wrapperRef = useRef<HTMLDivElement>(null);
  if (show) kept.current = children;
  if (show && !mounted) setMounted(true);
  const exiting = mounted && !show;
  useLayoutEffect(() => {
    if (!exiting) return;
    const animations = wrapperRef.current?.firstElementChild?.getAnimations?.({ subtree: true }) ?? [];
    if (!animations.length) { setMounted(false); return; }
    let cancelled = false;
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => { if (!cancelled) setMounted(false); });
    return () => { cancelled = true; };
  }, [exiting]);
  if (!mounted) return null;
  return <div ref={wrapperRef} className="contents" data-exiting={exiting || undefined}>{show ? children : kept.current}</div>;
}

/** Shakes the element once each time `error` turns to a new message (error state shake); give it `t-shake`. */
export function useShake<T extends HTMLElement>(error: string | undefined): RefObject<T | null> {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!error || !el) return;
    // Remove, reflow, re-add: the reflow is what lets the same animation replay on a second error.
    el.classList.remove("is-shaking");
    void el.offsetWidth;
    el.classList.add("is-shaking");
    const done = () => el.classList.remove("is-shaking");
    el.addEventListener("animationend", done, { once: true });
    return () => el.removeEventListener("animationend", done);
  }, [error]);
  return ref;
}

/** A status that is still working ("Answering…"): a highlight sweeps its glyphs (thinking states). */
export function ShimmerText({ children, className }: { children: string; className?: string | undefined }) {
  return <span data-text={children} className={cx("t-shimmer", className)}>{children}</span>;
}
