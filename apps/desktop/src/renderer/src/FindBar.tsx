import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search as SearchIcon, X } from "lucide-react";
import { Icon, ToolbarButton } from "@read/ui";
import { findArticleText, highlightArticleMatches, indexArticleText } from "@read/reader";

export const FIND_HIGHLIGHT = "read-find";

/** ⌘F: matches are painted with the CSS Custom Highlight API; nothing in the document changes. */
export function FindBar({ root, onClose, generation }: { root: HTMLElement | null; onClose: () => void; generation: number }) {
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const index = useMemo(() => (root ? indexArticleText(root) : []), [root, generation]);
  const { ranges, limited } = useMemo(() => findArticleText(index, query), [index, query]);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  useEffect(() => { setCurrent(0); }, [query]);
  useEffect(() => {
    if (!root) return;
    const active = ranges[current];
    const dispose = highlightArticleMatches(root, FIND_HIGHLIGHT, ranges, active);
    if (active) {
      const target = active.startContainer.parentElement;
      target?.scrollIntoView({ block: "center" });
    }
    return dispose;
  }, [root, ranges, current]);

  const step = (delta: number) => { if (ranges.length) setCurrent((value) => (value + delta + ranges.length) % ranges.length); };
  const count = ranges.length ? `${current + 1} of ${ranges.length}${limited ? "+" : ""}` : query ? "0" : "";

  return (
    <div role="search" className="glass-strong absolute right-9 top-[76px] z-10 flex items-center gap-1.5 rounded-pill py-[5px] pl-3 pr-1.5">
      <Icon of={SearchIcon} size="sm" className="text-label-3" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
          if (event.key === "Escape") { event.preventDefault(); onClose(); }
        }}
        aria-label="Find in page"
        placeholder="Find in page"
        className="w-[200px] bg-transparent text-[14px] text-label outline-none placeholder:text-label-3"
      />
      <small className="mr-1 min-w-[48px] text-right text-[11.5px] tabular-nums text-label-3">{count}</small>
      <ToolbarButton aria-label="Previous" isDisabled={!ranges.length} onChange={() => step(-1)}><ChevronUp /></ToolbarButton>
      <ToolbarButton aria-label="Next" isDisabled={!ranges.length} onChange={() => step(1)}><ChevronDown /></ToolbarButton>
      <ToolbarButton aria-label="Close" onChange={onClose}><X /></ToolbarButton>
    </div>
  );
}
