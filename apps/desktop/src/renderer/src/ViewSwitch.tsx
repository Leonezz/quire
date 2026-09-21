import { useCallback, useEffect } from "react";
import { ArrowDownToLine, Hammer, TriangleAlert } from "lucide-react";
import { Icon, Segment, Segmented } from "@read/ui";
import type { MaterialView, MaterialViewId } from "../../shared/contracts";
import { isTypingTarget } from "./format";
import { fetchVerb, isMaterialViewId, nextView } from "./materialViews";

export interface ViewSwitchProps {
  view: MaterialViewId;
  views: readonly MaterialView[];
  /** The view being fetched: the control waits and says so. */
  fetching: MaterialViewId | undefined;
  onSelect: (view: MaterialViewId) => void;
}

/**
 * The toolbar's view switch (Web · PDF · Markdown · Text), shown when the material has more than one view. A view
 * that is not stored yet carries a down-arrow (it is fetched when chosen; the Text view a hammer, it is built from
 * the PDF); one whose fetch failed carries a warning with the error as its tooltip. `v` cycles through the views.
 */
export function ViewSwitch({ view, views, fetching, onSelect }: ViewSwitchProps) {
  const cycle = useCallback(() => {
    const next = nextView(views, view);
    if (next && next !== view) onSelect(next);
  }, [onSelect, view, views]);

  // On `document`, like the readers' own t / i / n, so it stops at text fields and modified keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "v" || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      event.preventDefault();
      cycle();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cycle]);

  if (views.length < 2) return null;
  const fetchingView = views.find((entry) => entry.id === fetching);
  return (
    <span className="mr-1.5 inline-flex items-center gap-2">
      <Segmented aria-label="View (v)" selectedKeys={[view]} isDisabled={fetching !== undefined}
        onSelectionChange={(keys) => { const key = [...keys][0]; if (isMaterialViewId(key)) onSelect(key); }}>
        {views.map((entry) => (
          <Segment key={entry.id} id={entry.id} className="h-[24px] px-2.5 text-[12px]" aria-label={segmentName(entry)}>
            <span className="inline-flex items-center gap-1" title={entry.status === "failed" ? entry.error ?? "The last fetch failed." : undefined}>
              {entry.label}
              {entry.status === "available" ? <Icon of={fetchVerb(entry.id) === "build" ? Hammer : ArrowDownToLine} size="sm" className="text-label-3" /> : null}
              {entry.status === "failed" ? <Icon of={TriangleAlert} size="sm" className="text-orange-text" /> : null}
            </span>
          </Segment>
        ))}
      </Segmented>
      {fetchingView ? <span role="status" className="whitespace-nowrap text-[11.5px] text-label-2">{fetchVerb(fetchingView.id) === "build" ? `Building ${fetchingView.label.toLowerCase()} view…` : `Fetching ${fetchingView.label}…`}</span> : null}
    </span>
  );
}

/** The accessible name says what choosing the segment does. */
function segmentName(entry: MaterialView): string {
  if (entry.status === "available") return `${entry.label} (${fetchVerb(entry.id)} on demand)`;
  if (entry.status === "failed") return `${entry.label} (fetch failed: ${entry.error ?? "unknown error"})`;
  return entry.label;
}
