import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { Button } from "@read/ui";
import type { MaterialRecord, MaterialViewContent } from "../../shared/contracts";
import { read } from "./api";

// An agent artifact's versions in the reader: every edit keeps the one before (materials.ts), so
// the reader can step back through them, read an earlier one, and restore it as the newest.

interface Shown { materialId: string; latest: number; version: number; content?: MaterialViewContent | undefined; missing?: boolean }

export interface ArtifactVersions {
  /** The version shown and the newest; equal when the reader is on the newest. */
  version: number;
  latest: number;
  /** The body to show: an earlier version's while one is chosen and loaded, else the material's own. */
  content: MaterialViewContent;
  missing: boolean;
  select: (version: number) => void;
  restore: () => Promise<void>;
  restoring: boolean;
  error?: string | undefined;
}

export function useArtifactVersions(material: Pick<MaterialRecord, "id" | "origin" | "artifact">, content: MaterialViewContent, onSaved: (record: MaterialRecord) => void): ArtifactVersions {
  const latest = material.origin === "agent" ? material.artifact?.version ?? 1 : 1;
  const [shown, setShown] = useState<Shown | undefined>(undefined);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // A choice belongs to the material and to the newest version it was made against: a new version shows itself.
  const current = shown && shown.materialId === material.id && shown.latest === latest ? shown : undefined;
  useEffect(() => { setError(undefined); }, [material.id, latest]);

  const select = useCallback((version: number) => {
    if (version >= latest) { setShown(undefined); return; }
    const choice: Shown = { materialId: material.id, latest, version };
    setShown(choice);
    read.getArtifactVersion(material.id, version).then(
      (loaded) => setShown((now) => (now === choice ? { ...choice, ...(loaded ? { content: loaded } : { missing: true }) } : now)),
      () => setShown((now) => (now === choice ? { ...choice, missing: true } : now)),
    );
  }, [material.id, latest]);

  const restore = useCallback(async () => {
    if (!current) return;
    setRestoring(true); setError(undefined);
    try {
      onSaved(await read.restoreArtifactVersion(material.id, current.version));
      setShown(undefined);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "The version could not be restored.");
    } finally { setRestoring(false); }
  }, [current, material.id, onSaved]);

  return { version: current?.version ?? latest, latest, content: current?.content ?? content, missing: current?.missing ?? false, select, restore, restoring, error };
}

/** "Version 2 of 3", the arrows between versions, and on an earlier one the way to restore it or go back. */
export function ArtifactVersionBar({ versions }: { versions: ArtifactVersions }) {
  const { version, latest, select, restore, restoring, missing, error } = versions;
  if (latest <= 1) return null;
  const earlier = version < latest;
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-label-2" data-artifact-versions="">
      <span className="inline-flex items-center gap-0.5">
        <Button variant="plain" size="sm" aria-label="Earlier version" isDisabled={version <= 1} onPress={() => select(version - 1)}><ChevronLeft /></Button>
        <span className="tabular-nums" aria-live="polite">Version {version} of {latest}</span>
        <Button variant="plain" size="sm" aria-label="Later version" isDisabled={!earlier} onPress={() => select(version + 1)}><ChevronRight /></Button>
      </span>
      {earlier ? (
        <span className="t-text-in inline-flex flex-wrap items-center gap-2">
          {missing ? <span className="text-red-text">This version is not kept.</span> : <Button size="sm" className="gap-1" isDisabled={restoring} onPress={() => void restore()}><RotateCcw />Restore this version</Button>}
          <Button size="sm" variant="quiet" onPress={() => select(latest)}>Back to latest</Button>
        </span>
      ) : null}
      {error ? <span role="alert" className="t-text-in text-red-text">{error}</span> : null}
    </div>
  );
}
