import { ChevronRight } from "lucide-react";
import { Icon } from "@read/ui";
import type { MaterialRecord } from "../../shared/contracts";
import { ArtifactLineage } from "./ArtifactLineage";
import { InfoViews } from "./InfoViews";
import { RebuildAction, type RebuildProps } from "./RebuildBanner";
import type { MaterialViewController } from "./useMaterialView";

const originLabel: Record<MaterialRecord["origin"], string> = { web: "Web page", feed: "From a feed", file: "Local file", agent: "Written by the agent" };

export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function qualityText(material: MaterialRecord): string {
  const q = material.quality;
  const completeness = q.completeness === "summary" ? "summary only" : q.completeness === "declared_full" ? "full text" : q.completeness;
  const conformance = q.conformance === "conformant" ? "clean extract" : q.conformance === "recoverable" ? "partial extract" : q.conformance;
  const safety = q.safety === "degraded_plaintext" ? " · plain text" : "";
  return `${completeness} · ${conformance}${safety}`;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-2 text-[12.5px] leading-[17px]"><dt className="text-label-3">{label}</dt><dd className="m-0 min-w-0 break-words text-label">{children}</dd></div>;
}

/** What is known about the material and cannot be edited: where it came from, when, how well it extracted, what it became. Collapsed by default. */
export function InfoFacts({ material, views, onOpenLink, onOpenMaterial, onRebuild, rebuild = "idle", rebuildError }: { material: MaterialRecord; views?: MaterialViewController | undefined; onOpenLink: (url: string) => void; onOpenMaterial: (id: string) => void } & Partial<RebuildProps>) {
  const url = material.finalUrl || material.url;
  return (
    <details className="group">
      <summary className="mb-2 inline-flex cursor-default list-none items-center gap-1 rounded-pill py-0.5 pr-2 text-[11px] font-semibold uppercase tracking-[.07em] text-label-3 outline-none hover:text-label-2 focus-visible:ring-[3px] focus-visible:ring-accent-ring [&::-webkit-details-marker]:hidden"><Icon of={ChevronRight} size="sm" className="transition-transform group-open:rotate-90" />About</summary>
      <dl className="m-0 grid gap-1.5">
        {material.origin === "agent" ? null : (
          <Fact label="Source"><a href={url} className="text-accent-text no-underline hover:underline" onClick={(event) => { event.preventDefault(); onOpenLink(url); }}>{material.origin === "file" ? decodeURIComponent(material.url.replace("file:///", "")) : url}</a></Fact>
        )}
        <Fact label="Origin">{originLabel[material.origin]}</Fact>
        <Fact label="Fetched">{new Date(material.fetchedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</Fact>
        <Fact label="Reading">{material.readingMinutes} min</Fact>
        <Fact label="Quality">{qualityText(material)}</Fact>
        {material.pdf ? <Fact label="Pages">{material.pdf.pages}{material.pdf.textLayer === "absent" ? " · no text layer" : ""}</Fact> : null}
        {material.pdf ? <Fact label="Size">{bytesLabel(material.pdf.byteLength)}</Fact> : null}
        {material.capture ? <Fact label="Capture">{bytesLabel(material.capture.byteLength)} · {material.capture.mediaType}</Fact> : null}
        {material.lang ? <Fact label="Language">{material.lang}{material.dir === "rtl" ? " · right to left" : ""}</Fact> : null}
        {views ? <Fact label="Views"><InfoViews material={material} views={views} onOpenLink={onOpenLink} /></Fact> : null}
        {material.rebuiltAs || onRebuild ? (
          <Fact label="Rebuilt"><RebuildAction material={material} onRebuild={onRebuild} rebuild={rebuild} rebuildError={rebuildError} onOpenMaterial={onOpenMaterial} /></Fact>
        ) : null}
      </dl>
      {material.origin === "agent" && material.lineage?.length ? (
        <div className="mt-3">
          <ArtifactLineage lineage={material.lineage} onOpenMaterial={onOpenMaterial} defaultOpen />
        </div>
      ) : null}
    </details>
  );
}
