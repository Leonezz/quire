import type { MaterialRecord, MaterialViewContent } from "../../shared/contracts";

/** The toolbar's quality / format pill: what the reader is looking at and whether it reads badly (`low` tints it orange). */
export interface QualityBadge { text: string; low: boolean }

/**
 * The pill for one view of a material: the PDF's text layer, the text view's reflow report, the agent's own
 * writing, or the web extraction's quality. The feedback sheet reuses it as the "quality" line of a report.
 */
export function qualityLabel(material: Pick<MaterialRecord, "origin" | "media">, content: Pick<MaterialViewContent, "quality" | "view" | "report" | "pdf">): QualityBadge {
  const q = content.quality;
  if (content.view === "pdf") return content.pdf?.textLayer === "absent" ? { text: "scanned PDF", low: true } : { text: "PDF", low: false };
  if (content.view === "text") return { text: "reflowed from PDF", low: (content.report?.degradedPages.length ?? 0) > 0 };
  if (content.view === "shownotes") {
    return material.media?.transcriptOrigin === "absent"
      ? { text: "show notes only", low: false }
      : { text: "show notes", low: false };
  }
  if (content.view === "transcript" && material.media) {
    switch (material.media.transcriptOrigin) {
      case "official": return { text: "publisher transcript", low: false };
      case "captions": return { text: "captions", low: false };
      case "auto_captions": return { text: "auto captions", low: true };
      case "local_asr": return { text: "local whisper", low: false };
      case "cloud_asr": return { text: "cloud transcript", low: false };
      case "agent_refined": return { text: "refined by agent", low: false };
      case "absent": return { text: "show notes only", low: false };
    }
  }
  if (material.origin === "agent") return { text: "written by the agent", low: false };
  if (q.safety === "degraded_plaintext") return { text: "plain text only", low: true };
  if (q.completeness === "summary") return { text: "summary only", low: true };
  if (q.conformance === "recoverable") return { text: "web extract · partial", low: true };
  return { text: material.origin === "feed" ? "feed full text" : "web extract", low: false };
}
