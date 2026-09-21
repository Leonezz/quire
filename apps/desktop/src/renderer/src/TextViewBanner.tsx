import { Button } from "@read/ui";
import type { TextViewReport } from "../../shared/contracts";

/** "2 pages · 1 column · 4 furniture lines dropped · … · refined by Jev · 12 asked · 3 changed": the reflow's report in one line, for Info › Views. */
export function textViewReportText(report: TextViewReport): string {
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const degraded = report.degradedPages.length ? `degraded: p. ${report.degradedPages.join(", ")}` : "no degraded pages";
  const judged = report.judged ? [`refined by ${report.judged.provider === "jev" ? "Jev" : report.judged.provider}`, `${report.judged.asked} asked`, `${report.judged.changed} changed`, ...(report.judged.error ? [report.judged.error] : [])] : [];
  return [plural(report.pages, "page"), plural(report.columns, "column"), `${plural(report.furnitureLines, "furniture line")} dropped`, plural(report.headings, "heading"), plural(report.paragraphs, "paragraph"), plural(report.figures, "figure"), degraded, ...judged].join(" · ");
}

/**
 * The text view's own quality banner: the pages the reflow could not read are missing from the view,
 * and the PDF view still has them. Nothing when every page reflowed.
 */
export function TextViewBanner({ report, onOpenPdf }: { report: TextViewReport; onOpenPdf: () => void }) {
  const count = report.degradedPages.length;
  if (count === 0) return null;
  return (
    <div role="status" className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-card bg-orange-soft p-4 text-[13px] text-label-2">
      <strong className="text-[14px] text-label">{count} {count === 1 ? "page" : "pages"} could not be reflowed</strong>
      <span>(p. {report.degradedPages.join(", ")}) ·</span>
      <Button size="sm" variant="plain" className="h-6 px-1.5" onPress={onOpenPdf}>Open the PDF view</Button>
    </div>
  );
}
