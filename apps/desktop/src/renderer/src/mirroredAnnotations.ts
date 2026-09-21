import type { Annotation, MaterialView, MaterialViewId } from "../../shared/contracts";
import { annotationView, hasReadyView } from "./materialViews";
import { pdfRegionsForQuote, textQuoteForRegions, type TextViewSource } from "./textViewAnchors";

// An annotation is stored once, with the locator of the view it was made in. The PDF and its text
// view show each other's notes by mapping locators through the text view's anchors at render time.

/** The views whose notes `view` can show in place through the text view's anchors, once that view's content is loaded. */
export function mirroredViews(view: MaterialViewId, textContent: TextViewSource | undefined): readonly MaterialViewId[] {
  if (!textContent) return [];
  if (view === "text") return ["pdf"];
  if (view === "pdf") return ["text"];
  return [];
}

/** Whether the Notes panel names each note's view: only when the material stores both renderings of the PDF. */
export function showsViewTags(views: readonly MaterialView[]): boolean {
  return hasReadyView(views, "pdf") && hasReadyView(views, "text");
}

/** An annotation of another view carried into `view`: the same record with the locator (and, for text, the quote) `view` resolves. */
function mirrored(annotation: Annotation, view: MaterialViewId, from: MaterialViewId, textContent: TextViewSource): Annotation | undefined {
  if (view === "text" && from === "pdf") {
    const quote = textQuoteForRegions(textContent, annotation.locator);
    return quote ? { ...annotation, locator: quote.locator, quote: quote.quote } : undefined;
  }
  if (view === "pdf" && from === "text") {
    const regions = pdfRegionsForQuote(textContent, annotation);
    return regions ? { ...annotation, locator: regions.locator } : undefined;
  }
  return undefined;
}

/**
 * The annotations a reader anchors in its body: those made in `view` as they are, and those made in the
 * mirrored view with their locator mapped. Ids are kept, so the Notes panel's active card follows.
 */
export function resolveViewAnnotations(annotations: readonly Annotation[], view: MaterialViewId, primaryView: MaterialViewId, textContent: TextViewSource | undefined): Annotation[] {
  const mirrors = mirroredViews(view, textContent);
  return annotations.flatMap((annotation) => {
    const from = annotationView(annotation, primaryView);
    if (from === view) return [annotation];
    if (!textContent || !mirrors.includes(from)) return [];
    const carried = mirrored(annotation, view, from, textContent);
    return carried ? [carried] : [];
  });
}
