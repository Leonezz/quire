import { ArrowRight, Sparkles } from "lucide-react";
import { Button, Icon } from "@read/ui";
import type { MaterialRecord } from "../../shared/contracts";

export type RebuildState = "idle" | "running" | "failed";

export interface RebuildProps {
  /** Present when the material has a capture to rebuild from and no rebuilt version yet. */
  onRebuild?: (() => void) | undefined;
  rebuild: RebuildState;
  /** Why the last rebuild did not finish, when the bridge said. */
  rebuildError?: string | undefined;
}

/** Whether the agent can rebuild this material: there is a raw capture and it has not been rebuilt already. */
export function canRebuild(material: Pick<MaterialRecord, "capture" | "rebuiltAs" | "origin">): boolean {
  return material.capture !== undefined && material.rebuiltAs === undefined && material.origin !== "agent";
}

/** "Rebuild with the agent" / "Rebuilding…" / "A rebuilt version exists · Open", as one line for the banner and the Info panel. */
export function RebuildAction({ material, onRebuild, rebuild, rebuildError, onOpenMaterial, size = "sm" }: RebuildProps & { material: MaterialRecord; onOpenMaterial: (id: string) => void; size?: "sm" | "md" }) {
  if (material.rebuiltAs) {
    const id = material.rebuiltAs;
    return <span className="inline-flex items-center gap-1.5">A rebuilt version exists · <Button variant="plain" size={size} className="h-6 px-1.5 text-[12.5px]" onPress={() => onOpenMaterial(id)}>Open<ArrowRight /></Button></span>;
  }
  if (!onRebuild) return null;
  if (rebuild === "running") return <span role="status" className="inline-flex items-center gap-1.5"><Icon of={Sparkles} size="sm" className="animate-pulse text-purple-text" />Rebuilding…</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Button size={size} className="gap-1" onPress={onRebuild}><Sparkles />Rebuild with the agent</Button>
      {rebuild === "failed" ? <span role="alert" className="text-red-text">The rebuild did not finish{rebuildError ? ` — ${rebuildError}` : " — see the Agent panel."}</span> : null}
    </span>
  );
}

/**
 * The reader's quality banner: why the page reads badly, the way to the original, and — when
 * there is a capture — the agent's rebuild (or the rebuilt version once it exists).
 */
export function QualityBanner({ material, low, onOpenLink, onOpenMaterial, onRebuild, rebuild, rebuildError }: RebuildProps & { material: MaterialRecord; low: boolean; onOpenLink: (url: string) => void; onOpenMaterial: (id: string) => void }) {
  const plain = material.quality.safety === "degraded_plaintext";
  if (!plain && !low) return null;
  const original = <a href={material.finalUrl} onClick={(event) => { event.preventDefault(); onOpenLink(material.finalUrl); }}>Open the original ↗</a>;
  const action = <RebuildAction material={material} onRebuild={onRebuild} rebuild={rebuild} rebuildError={rebuildError} onOpenMaterial={onOpenMaterial} />;
  if (plain) {
    return (
      <div className="mb-6 grid gap-2 rounded-card bg-content-2 p-4 text-[13px] text-label-2">
        <strong className="text-[16px] text-label">Could not extract an article from this page.</strong>
        <span>What the page returned is shown below as plain text. {original} for the full page.</span>
        {action ? <div className="mt-1">{action}</div> : null}
      </div>
    );
  }
  const summary = material.quality.completeness === "summary";
  return (
    <div className="mb-6 grid gap-1.5 rounded-card bg-orange-soft p-4 text-[13px] text-label-2">
      <strong className="text-[14px] text-label">{summary ? "Only a summary was available." : "The extraction may be incomplete."}</strong>
      <span>{summary ? "The full text is fetched when the source allows it. " : `The extractors disagreed about this page (${material.problems.length} notes). `}{original}</span>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
