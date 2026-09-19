import { Button, Switch } from "@read/ui";
import type { UpdateState } from "../../shared/contracts";
import { AgentMarkdown } from "./AgentMarkdown";
import { updateStore, useUpdateStore } from "./updateStore";

// Settings › About: the running version, the update state with its one next step, and the
// automatic-check switch. The state is the shared update store's, so a check started from the
// sidebar banner shows here too.

export const NOTES_LINES = 12;
export const APP_NAME = "Quire";

export interface AboutSectionProps {
  /** The bridge's version, shown until the update state names the running one. */
  version: string;
  autoCheck: boolean | undefined;
  disabled: boolean;
  onAutoCheck: (value: boolean) => void;
  autoCheckError?: string | undefined;
  autoCheckNote?: string | undefined;
  onOpenLink: (url: string) => void;
}

function Row({ label, hint, children }: { label: string; hint?: string | undefined; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)] items-start gap-3">
      <div className="pt-2 text-[13px] font-medium text-label-2">{label}{hint ? <span className="mt-0.5 block text-[11.5px] font-normal text-label-3">{hint}</span> : null}</div>
      <div className="grid min-w-0 gap-1.5">{children}</div>
    </div>
  );
}

/** The first lines of the release notes, with a marker when there are more. */
export function clipNotes(notes: string, lines = NOTES_LINES): string {
  const all = notes.split("\n");
  return all.length > lines ? `${all.slice(0, lines).join("\n")}\n…` : notes;
}

function statusLine(state: UpdateState | undefined): string {
  if (!state) return "Reading the update state…";
  switch (state.phase) {
    case "idle": return "Not checked yet.";
    case "checking": return "Checking…";
    case "up-to-date": return "You're on the latest alpha.";
    case "available": return `v${state.latest} is available`;
    case "downloading": return `Downloading v${state.latest}… ${Math.round(state.percent)}%`;
    case "ready": return `v${state.latest} is downloaded. Restart to update.`;
    case "error": return state.message;
  }
}

const checkLabel = (state: UpdateState | undefined) => (state?.phase === "error" ? "Retry" : "Check for updates");

export function AboutSection({ version, autoCheck, disabled, onAutoCheck, autoCheckError, autoCheckNote, onOpenLink }: AboutSectionProps) {
  const { state, actionError } = useUpdateStore();
  const busy = state?.phase === "checking" || state?.phase === "downloading";
  const canCheck = state !== undefined && !busy && state.phase !== "ready";
  const isError = state?.phase === "error";

  return (
    <>
      <Row label="Version">
        <div className="flex flex-wrap items-center gap-2 pt-2 text-[13px] text-label">
          <span className="font-medium">{APP_NAME} {state?.current ?? version}</span>
          {canCheck ? <Button size="sm" variant="quiet" onPress={() => void updateStore.check()}>{checkLabel(state)}</Button> : null}
        </div>
      </Row>
      <Row label="Updates">
        <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-2 pt-2 text-[13px] text-label">
          <span className={isError ? "text-red-text" : ""}>{statusLine(state)}</span>
          {state?.phase === "available" ? (
            <>
              <Button size="sm" variant="plain" onPress={() => void updateStore.openReleasePage()}>Release notes ↗</Button>
              {state.canInstall
                ? <Button size="sm" variant="primary" onPress={() => void updateStore.install()}>Install and restart</Button>
                : <Button size="sm" variant="primary" onPress={() => void updateStore.openReleasePage()}>Download</Button>}
            </>
          ) : null}
          {state?.phase === "ready" ? <Button size="sm" variant="primary" onPress={() => void updateStore.install()}>Restart to update</Button> : null}
        </div>
        {actionError ? <p role="alert" className="m-0 text-[12px] text-red-text">{actionError}</p> : null}
        {state?.phase === "available" && state.notes ? (
          <div className="rounded-card bg-content-2 px-3 py-2.5">
            <AgentMarkdown text={clipNotes(state.notes)} onOpenLink={onOpenLink} onOpenMaterial={() => undefined} />
          </div>
        ) : null}
      </Row>
      <Row label="Check automatically" hint="On launch and once a day.">
        <div className="pt-1.5">
          <Switch aria-label="Check for updates automatically" isSelected={autoCheck ?? true} isDisabled={disabled} onChange={onAutoCheck}>{autoCheck === false ? "Only when asked" : "On launch and daily"}</Switch>
        </div>
        {autoCheckError ? <p role="alert" className="m-0 text-[12px] text-red-text">{autoCheckError}</p> : autoCheckNote ? <span className="text-[11.5px] text-label-3">{autoCheckNote}</span> : null}
      </Row>
    </>
  );
}
