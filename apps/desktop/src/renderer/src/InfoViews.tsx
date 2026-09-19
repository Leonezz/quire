import { useState } from "react";
import { Button } from "@read/ui";
import type { MaterialView, MaterialViewId } from "../../shared/contracts";
import { bytesLabel } from "./InfoFacts";
import type { MaterialViewController } from "./useMaterialView";

/** "2.1 MB · fetched 17 Sept 2026": what a stored view says about itself. */
function readyText(view: MaterialView): string {
  const size = view.byteLength !== undefined ? bytesLabel(view.byteLength) : view.pdf ? bytesLabel(view.pdf.byteLength) : undefined;
  const when = view.fetchedAt ? `fetched ${new Date(view.fetchedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}` : undefined;
  return [size, when].filter(Boolean).join(" · ") || "stored";
}

/**
 * The material's views in Info › About: each with its status (stored, with size and date; not fetched, with Fetch;
 * failed, with the error and Retry), "Make primary" for a stored view that is not the primary, and the view's source.
 */
export function InfoViews({ views, onOpenLink }: { views: MaterialViewController; onOpenLink: (url: string) => void }) {
  const [promoting, setPromoting] = useState<MaterialViewId | undefined>(undefined);
  const [error, setError] = useState<{ view: MaterialViewId; message: string } | undefined>(undefined);
  const makePrimary = async (view: MaterialViewId) => {
    setPromoting(view); setError(undefined);
    try { await views.makePrimary(view); }
    catch (cause: unknown) { setError({ view, message: cause instanceof Error ? cause.message : "Could not make this view the primary." }); }
    finally { setPromoting(undefined); }
  };
  const busy = views.fetching !== undefined || promoting !== undefined;
  return (
    <ul className="m-0 grid list-none gap-1.5 p-0">
      {views.views.map((view) => {
        const fetching = views.fetching === view.id;
        const fetchError = views.fetchError?.view === view.id ? views.fetchError.message : undefined;
        const primaryError = error?.view === view.id ? error.message : undefined;
        const isPrimary = view.id === views.primaryView;
        return (
          <li key={view.id} className="grid gap-0.5">
            <span className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="font-medium">{view.label}</span>
              {isPrimary ? <span className="rounded-pill bg-fill px-1.5 text-[10.5px] font-medium leading-[15px] text-label-2">primary</span> : null}
              {view.id === views.view && !isPrimary ? <span className="text-[11px] text-label-3">reading</span> : null}
            </span>
            <span className="text-label-2">
              {view.status === "ready" ? readyText(view) : fetching ? "Fetching…" : view.status === "available" ? "not fetched" : null}
              {view.status === "failed" && !fetching ? <span role="alert" className="text-red-text">{view.error ?? "The last fetch failed."}</span> : null}
            </span>
            {fetchError && !fetching ? <span role="alert" className="text-red-text">{fetchError}</span> : null}
            {primaryError ? <span role="alert" className="text-red-text">{primaryError}</span> : null}
            <span className="flex flex-wrap items-center gap-1">
              {view.status === "ready" && !isPrimary ? <Button size="sm" variant="plain" className="h-6 px-1.5" isDisabled={busy} onPress={() => void makePrimary(view.id)}>{promoting === view.id ? "Making primary…" : "Make primary"}</Button> : null}
              {view.status === "available" ? <Button size="sm" variant="plain" className="h-6 px-1.5" isDisabled={busy} onPress={() => void views.fetch(view.id)}>{fetching ? "Fetching…" : "Fetch"}</Button> : null}
              {view.status === "failed" ? <Button size="sm" variant="plain" className="h-6 px-1.5" isDisabled={busy} onPress={() => void views.fetch(view.id)}>{fetching ? "Fetching…" : "Retry"}</Button> : null}
              <Button size="sm" variant="quiet" className="h-6 px-1.5" onPress={() => onOpenLink(view.url)}>Open</Button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
