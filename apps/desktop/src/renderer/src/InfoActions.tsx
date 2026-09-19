import { useState } from "react";
import { Copy, Quote, RefreshCw } from "lucide-react";
import { Button } from "@read/ui";
import type { MaterialMeta, MaterialRecord } from "../../shared/contracts";
import { read } from "./api";
import { citationMarkdown } from "./materialMeta";

/** How many fields of `extracted` changed between two versions of a record. */
export function changedFieldCount(before: MaterialMeta, after: MaterialMeta): number {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)] as (keyof MaterialMeta)[]);
  return [...fields].filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field])).length;
}

/** Whether there is a source to re-extract from: a stored capture, or a URL the engine can fetch again. */
export function canRefresh(material: Pick<MaterialRecord, "capture" | "origin" | "url">): boolean {
  return material.capture !== undefined || /^https?:\/\//i.test(material.url);
}

type Status = { tone: "ok" | "error"; text: string };

/** The Info panel's footer: copy a citation or the BibTeX entry, re-run extraction on the source. */
export function InfoActions({ material, onSaved }: { material: MaterialRecord; onSaved: (record: MaterialRecord) => void }) {
  const [busy, setBusy] = useState<"citation" | "bibtex" | "refresh" | undefined>(undefined);
  const [status, setStatus] = useState<Status | undefined>(undefined);
  const run = async (what: NonNullable<typeof busy>, action: () => Promise<string>) => {
    setBusy(what); setStatus(undefined);
    try { setStatus({ tone: "ok", text: await action() }); }
    catch (cause: unknown) { setStatus({ tone: "error", text: cause instanceof Error ? cause.message : "The action failed." }); }
    finally { setBusy(undefined); }
  };
  const copyCitation = () => run("citation", async () => {
    await navigator.clipboard.writeText(citationMarkdown(material.meta, { title: material.title, url: material.finalUrl || material.url }));
    return "Citation copied";
  });
  const copyBibtex = () => run("bibtex", async () => {
    await navigator.clipboard.writeText(await read.exportBibtex([material.id]));
    return "BibTeX copied";
  });
  const refresh = () => run("refresh", async () => {
    const updated = await read.refreshMetadata(material.id);
    onSaved(updated);
    const changed = changedFieldCount(material.extracted, updated.extracted);
    return changed ? `Updated ${changed} ${changed === 1 ? "field" : "fields"}` : "Nothing new";
  });

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" isDisabled={busy !== undefined} onPress={() => void copyCitation()}><Quote />Copy citation</Button>
        <Button size="sm" isDisabled={busy !== undefined} onPress={() => void copyBibtex()}><Copy />Copy BibTeX</Button>
        <Button size="sm" variant="quiet" isDisabled={busy !== undefined || !canRefresh(material)} onPress={() => void refresh()}><RefreshCw className={busy === "refresh" ? "animate-spin" : ""} />Refresh from source</Button>
      </div>
      {status ? <p role={status.tone === "error" ? "alert" : "status"} className={`m-0 text-[12px] ${status.tone === "error" ? "text-red-text" : "text-label-3"}`}>{status.text}</p> : null}
    </div>
  );
}
