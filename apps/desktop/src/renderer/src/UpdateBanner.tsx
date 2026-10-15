import { X } from "lucide-react";
import { Button, Icon, Presence } from "@read/ui";
import { latestOf, updateStore, useUpdateStore } from "./updateStore";

// A quiet line in the sidebar footer while a newer release is available, downloading or downloaded. One
// next step (install, download, open the installer, or restart) and a dismiss that holds for the session
// and that version.

export function UpdateBanner() {
  const { state, dismissed } = useUpdateStore();
  const latest = latestOf(state);
  // It rises in when a release turns up and sinks away when dismissed (toast open / close).
  const show = state !== undefined && latest !== undefined && latest !== dismissed;
  return <Presence show={show}>{show ? <UpdateNotice state={state} latest={latest} /> : null}</Presence>;
}

type NoticeState = NonNullable<ReturnType<typeof useUpdateStore>["state"]>;

/** The banner's one next step: restart, install in place, download this Mac's installer, open it, or (no installer for it) the release page. */
function nextStep(state: NoticeState): { label: string; run: () => Promise<void> } | undefined {
  switch (state.phase) {
    case "ready": return { label: "Restart to update", run: updateStore.install };
    case "saved": return { label: "Open installer", run: updateStore.openDownloaded };
    case "available":
      if (state.canInstall) return { label: "Install", run: updateStore.install };
      return { label: "Download", run: state.downloadUrl ? updateStore.download : updateStore.openReleasePage };
    default: return undefined;
  }
}

function headline(state: NoticeState, latest: string): string {
  switch (state.phase) {
    case "downloading": return `Downloading v${latest}… ${Math.round(state.percent)}%`;
    case "ready": return `v${latest} downloaded`;
    case "saved": return `v${latest} is in Downloads`;
    default: return `v${latest} available`;
  }
}

function UpdateNotice({ state, latest }: { state: NoticeState; latest: string }) {
  const step = nextStep(state);
  return (
    <div role="status" aria-label={`Update v${latest}`} className="t-toast mx-2.5 mb-1 grid gap-1.5 rounded-card bg-accent-soft px-2.5 py-2 text-[12.5px] text-label">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate font-medium tabular-nums">{headline(state, latest)}</span>
        <Button size="sm" variant="quiet" aria-label="Dismiss update notice" className="-mr-1.5" onPress={() => updateStore.dismiss()}><Icon of={X} size="sm" /></Button>
      </div>
      {step ? <Button size="sm" variant="primary" className="justify-self-start" onPress={() => { void step.run(); }}>{step.label}</Button> : null}
    </div>
  );
}
