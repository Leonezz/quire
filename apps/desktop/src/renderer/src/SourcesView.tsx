import { useState } from "react";
import { Plus } from "lucide-react";
import { Button, ConfirmSheet, ItemList, ItemRow } from "@read/ui";
import type { SourceRecord } from "../../shared/contracts";
import { read } from "./api";
import { ContentToolbar } from "./AppToolbar";
import { ContentColumn, ContentPane, EmptySentence, ListColumn, type ShellSlots } from "./ContentPane";
import { InlineError } from "./ItemPreview";
import { relativeTime, sourceHealth, sourceKindLabel, sourceLocatorLabel, weeklyRateLabel } from "./format";
import { neighbourOf } from "./useItemReader";

type SyncOutcome = { id: string; text: string; isError: boolean };

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 text-[13px]"><dt className="text-label-3">{label}</dt><dd className="m-0 min-w-0 break-words text-label">{children}</dd></div>;
}

export interface SourcesViewProps {
  sources: SourceRecord[];
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  refresh: () => Promise<void>;
  onOpenLink: (url: string) => void;
  /** "Add source" in the toolbar: the Add sheet, which detects feeds and arXiv categories. */
  onAdd: () => void;
  shell: ShellSlots;
}

/** Source management ("Manage sources…"): every subscription on the left, the chosen one's health and actions (Sync now / Pause / Disconnect) on the right. */
export function SourcesView({ sources, selectedId, onSelect, refresh, onOpenLink, onAdd, shell }: SourcesViewProps) {
  const [busy, setBusy] = useState<"sync" | "pause" | "remove" | undefined>(undefined);
  const [outcome, setOutcome] = useState<SyncOutcome | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  // A failed Disconnect is shown inside the still-open confirm sheet, never behind it.
  const [removeError, setRemoveError] = useState<string | undefined>(undefined);
  const current = sources.find((source) => source.id === selectedId);
  const messageOf = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

  const sync = async (source: SourceRecord) => {
    setBusy("sync"); setOutcome(undefined); setActionError(undefined);
    try {
      const result = await read.syncSource(source.id);
      setOutcome(result.ok ? { id: source.id, text: `+${result.added} new`, isError: false } : { id: source.id, text: result.message, isError: true });
      await refresh();
    } catch (cause: unknown) { setActionError(messageOf(cause, "Sync failed.")); }
    finally { setBusy(undefined); }
  };
  const pause = async (source: SourceRecord) => {
    setBusy("pause"); setActionError(undefined);
    try { await read.pauseSource(source.id, !source.pausedAt); await refresh(); }
    catch (cause: unknown) { setActionError(messageOf(cause, "Could not change the pause state.")); }
    finally { setBusy(undefined); }
  };
  const remove = async (source: SourceRecord) => {
    setBusy("remove"); setRemoveError(undefined);
    try {
      await read.removeSource(source.id);
      setConfirming(false);
      onSelect(neighbourOf(sources.map((candidate) => candidate.id), source.id));
      await refresh();
    } catch (cause: unknown) { setRemoveError(messageOf(cause, "Could not disconnect the source.")); }
    finally { setBusy(undefined); }
  };

  const toolbar = <ContentToolbar actions={<Button size="sm" variant="quiet" className="gap-1" onPress={onAdd}><Plus />Add source</Button>} trailing={shell.trailing} />;

  return (
    <>
      <ListColumn family="sources" toolbar={shell.listToolbar}>
        {sources.length ? (
          <ItemList aria-label="Sources" items={sources} selectionMode="single" selectionBehavior="replace" disallowEmptySelection selectedKeys={selectedId ? new Set([selectedId]) : new Set()}
            onSelectionChange={(keys) => { const key = keys === "all" ? undefined : [...keys][0]; if (key !== undefined) onSelect(String(key)); }} className="flex-1">
            {(source) => {
              const health = sourceHealth(source);
              return (
                <ItemRow id={source.id} title={source.title} source={`${sourceKindLabel(source.kind)} · ${sourceLocatorLabel(source)}`} time={relativeTime(source.lastSyncAt)} health={health.tone}
                  signals={[weeklyRateLabel(source.weeklyRate), `${source.itemCount} items`, `${source.keptCount} kept`]}
                  {...(health.tone === "failing" ? { detail: <span className="text-red-text">{health.text}</span> } : health.tone === "paused" ? { detail: <span className="text-orange-text">paused</span> } : {})} />
              );
            }}
          </ItemList>
        ) : (
          <EmptySentence>No sources yet — ⌘N and paste a feed URL, a site, or an arXiv category like cs.CL.</EmptySentence>
        )}
      </ListColumn>
      <ContentColumn>
        <ContentPane toolbar={toolbar} panel={shell.agentPanel}>
          {current ? (() => {
            const health = sourceHealth(current);
            const tone = health.tone === "ok" ? "bg-green" : health.tone === "paused" ? "bg-orange" : "bg-red";
            return (
              <div key={current.id} className="reader-enter overflow-auto px-9 pb-10 pt-7">
                <div className="flex items-center gap-2 text-[12.5px] text-label-2">
                  <span className="rounded-pill bg-fill px-2 py-px text-[11.5px] font-medium">{sourceKindLabel(current.kind)}</span>
                  <span className="truncate">{sourceLocatorLabel(current)}</span>
                </div>
                <h1 className="mb-1.5 mt-2.5 text-[24px] font-bold leading-[29px] tracking-[-.02em] text-balance">{current.title}</h1>
                <div className="flex items-center gap-2 text-[12.5px] text-label-2"><i aria-hidden="true" className={`size-[7px] rounded-full ${tone}`} /><span className={health.tone === "failing" ? "text-red-text" : health.tone === "paused" ? "text-orange-text" : ""}>{health.text}</span></div>
                <div className="flex flex-wrap items-center gap-2 py-[18px]">
                  <Button variant="primary" onPress={() => void sync(current)} isDisabled={busy !== undefined || Boolean(current.pausedAt)}>{busy === "sync" ? "Syncing…" : "Sync now"}</Button>
                  <Button onPress={() => void pause(current)} isDisabled={busy !== undefined}>{current.pausedAt ? "Resume" : "Pause"}</Button>
                  <Button variant="quiet" onPress={() => { setRemoveError(undefined); setConfirming(true); }} isDisabled={busy !== undefined}>Disconnect</Button>
                  {outcome?.id === current.id ? <span role={outcome.isError ? "alert" : "status"} className={`text-[12.5px] ${outcome.isError ? "text-red-text" : "text-label-2"}`}>{outcome.text}</span> : null}
                </div>
                {actionError ? <div className="mb-4 max-w-[560px]"><InlineError title="That did not go through." message={actionError} /></div> : null}
                <dl className="m-0 grid max-w-[560px] gap-2">
                  <Detail label="Locator">{current.kind === "feed" ? <a href={current.locator} className="text-accent-text" onClick={(event) => { event.preventDefault(); onOpenLink(current.locator); }}>{current.locator}</a> : current.locator}</Detail>
                  {current.siteUrl ? <Detail label="Site"><a href={current.siteUrl} className="text-accent-text" onClick={(event) => { event.preventDefault(); onOpenLink(current.siteUrl!); }}>{current.siteUrl}</a></Detail> : null}
                  <Detail label="Rate">{weeklyRateLabel(current.weeklyRate)}</Detail>
                  <Detail label="Items">{current.itemCount} received · {current.keptCount} kept</Detail>
                  <Detail label="Refresh">every {current.intervalMinutes >= 60 ? `${Math.round(current.intervalMinutes / 60)} h` : `${current.intervalMinutes} min`}</Detail>
                  <Detail label="Last sync">{relativeTime(current.lastSyncAt)}</Detail>
                  <Detail label="Last success">{relativeTime(current.lastSuccessAt)}</Detail>
                  {current.failureCount > 0 ? <Detail label="Failures"><span className="text-red-text">{current.failureCount} in a row{current.lastError ? ` — ${current.lastError}` : ""}</span></Detail> : null}
                  <Detail label="Added">{new Date(current.addedAt).toLocaleDateString()}</Detail>
                </dl>
                <ConfirmSheet isOpen={confirming} title={`Disconnect ${current.title}?`} message="Undecided items from this source are removed; read and kept material stays."
                  confirmLabel="Disconnect" busyLabel="Disconnecting…" busy={busy === "remove"} error={removeError} onConfirm={() => void remove(current)} onCancel={() => setConfirming(false)} />
              </div>
            );
          })() : (
            <EmptySentence>Select a source.</EmptySentence>
          )}
        </ContentPane>
      </ContentColumn>
    </>
  );
}
