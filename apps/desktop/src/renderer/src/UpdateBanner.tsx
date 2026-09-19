import { X } from "lucide-react";
import { Button, Icon } from "@read/ui";
import { latestOf, updateStore, useUpdateStore } from "./updateStore";

// A quiet line in the sidebar footer while a newer release is available or downloaded. One next
// step (install, download, or restart) and a dismiss that holds for the session and that version.

export function UpdateBanner() {
  const { state, dismissed } = useUpdateStore();
  const latest = latestOf(state);
  if (!state || latest === undefined || latest === dismissed) return null;
  const ready = state.phase === "ready";
  const installs = ready || (state.phase === "available" && state.canInstall);
  const act = () => { void (installs ? updateStore.install() : updateStore.openReleasePage()); };
  return (
    <div role="status" aria-label={`Update v${latest}`} className="mx-2.5 mb-1 grid gap-1.5 rounded-card bg-accent-soft px-2.5 py-2 text-[12.5px] text-label">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate font-medium">v{latest} {ready ? "downloaded" : "available"}</span>
        <Button size="sm" variant="quiet" aria-label="Dismiss update notice" className="-mr-1.5" onPress={() => updateStore.dismiss()}><Icon of={X} size="sm" /></Button>
      </div>
      <Button size="sm" variant="primary" className="justify-self-start" onPress={act}>{ready ? "Restart to update" : installs ? "Install" : "Download"}</Button>
    </div>
  );
}
