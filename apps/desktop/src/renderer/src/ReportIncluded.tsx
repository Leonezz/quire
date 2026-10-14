import { ChevronRight } from "lucide-react";
import { Icon } from "@read/ui";
import type { MaterialRecord, MaterialViewId } from "../../shared/contracts";
import { read } from "./api";
import { bytesLabel } from "./InfoFacts";
import { viewOf } from "./materialViews";
import { qualityLabel } from "./qualityLabel";

// "What's included" in a one-step report: one line, and a disclosure that says what each part holds.
// The main process writes the bundle (docs/design/eval-feedback.md § E); this only describes it.

/** The original the report can carry: the saved page (web) or the PDF itself (the PDF and Text views, or a PDF without a capture). */
export type ReportOriginal = { kind: "page"; byteLength: number; mediaType: string } | { kind: "pdf"; byteLength?: number | undefined };

export function originalOf(material: MaterialRecord, view: MaterialViewId): ReportOriginal | undefined {
  const pdfView = material.views.find((entry) => entry.id === "pdf" && entry.status === "ready");
  const hasPdf = material.pdf !== undefined || pdfView !== undefined;
  const wantsPdf = view === "pdf" || view === "text";
  if (hasPdf && (wantsPdf || !material.capture)) return { kind: "pdf", byteLength: material.pdf?.byteLength ?? pdfView?.byteLength };
  if (material.capture) return { kind: "page", byteLength: material.capture.byteLength, mediaType: material.capture.mediaType };
  return undefined;
}

/** The one line: "snapshot · extraction · screenshots of the reader and the original page · versions", less what is left out. */
export function includedSummary(withOriginal: boolean): string {
  return [withOriginal ? "snapshot" : undefined, "extraction", withOriginal ? "screenshots of the reader and the original page" : "screenshots of the reader", "versions"].filter(Boolean).join(" · ");
}

function originalText(original: ReportOriginal): string {
  if (original.kind === "pdf") return original.byteLength !== undefined ? `The PDF (${bytesLabel(original.byteLength)})` : "The PDF";
  return `The saved page (${bytesLabel(original.byteLength)} · ${original.mediaType}, as page.html.gz)`;
}

function Part({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-2"><dt className="text-label-3">{label}</dt><dd className="m-0 min-w-0 break-words text-label-2">{children}</dd></div>;
}

export function ReportIncluded({ material, view, original, withSelection }: { material: MaterialRecord; view: MaterialViewId; original: ReportOriginal | undefined; withSelection: boolean }) {
  const quality = qualityLabel(material, { view, quality: material.quality, ...(material.pdf ? { pdf: material.pdf } : {}) });
  const notes = material.problems.length === 1 ? "1 extractor note" : `${material.problems.length} extractor notes`;
  const viewLabel = viewOf(material.views, view)?.label || view;
  const readerShots = ["what you see in the reader", ...(withSelection ? ["the selected passage"] : []), "the whole article in your reading settings"];
  const originalShots = original ? [`the original page at the top${withSelection ? " and at the selected passage" : ""}`] : [];
  const screenshots = [...readerShots, ...originalShots].join(", ");
  return (
    <details className="t-acc group rounded-card bg-content-2 px-3 py-2 text-[12.5px] leading-[17px]">
      <summary className="flex cursor-default list-none items-center gap-1.5 rounded-control text-label-2 outline-none focus-visible:ring-[3px] focus-visible:ring-accent-ring [&::-webkit-details-marker]:hidden">
        <Icon of={ChevronRight} size="sm" className="t-acc-chevron text-label-3 group-open:rotate-90" />
        <span className="min-w-0"><span className="font-medium text-label">What's included:</span> {includedSummary(original !== undefined)}</span>
      </summary>
      <dl aria-label="Included in the report" className="m-0 mt-2 grid gap-1">
        {original ? <Part label="Snapshot">{originalText(original)}</Part> : null}
        <Part label="Extraction">The reader document, the Markdown, the quality report ({quality.text}) and {notes}</Part>
        <Part label="Screenshots">{screenshots.charAt(0).toUpperCase() + screenshots.slice(1)}</Part>
        <Part label="Context">{material.finalUrl || material.url} · {viewLabel} view · reading settings · scroll position{withSelection ? " · the selected passage with the text around it" : ""}</Part>
        <Part label="Versions">Quire {read.version} and its extractor</Part>
      </dl>
      <p className="m-0 mt-2 text-label-3">It all goes into one zip on this Mac. Nothing is uploaded: you attach the zip to the GitHub issue yourself.</p>
    </details>
  );
}
