export const DEFAULT_PDF_SIDEBAR_WIDTH = 216;
export const MIN_PDF_SIDEBAR_WIDTH = 180;
export const MAX_PDF_SIDEBAR_WIDTH = 400;
export const PDF_SIDEBAR_WIDTH_STEP = 16;
// The canvas reserves up to 112px of responsive horizontal padding plus the
// native scrollbar, so a 608px reading area preserves about 480px of PDF page.
export const MIN_PDF_READING_AREA_WIDTH = 608;
export const MIN_PDF_SIDEBAR_LAYOUT_WIDTH =
  MIN_PDF_SIDEBAR_WIDTH + MIN_PDF_READING_AREA_WIDTH;

export function pdfSidebarUsesOverlay(containerWidth: unknown) {
  return (
    typeof containerWidth === "number" &&
    Number.isFinite(containerWidth) &&
    containerWidth > 0 &&
    containerWidth < MIN_PDF_SIDEBAR_LAYOUT_WIDTH
  );
}

export function maximumPdfSidebarWidth(containerWidth: unknown) {
  if (
    typeof containerWidth !== "number" ||
    !Number.isFinite(containerWidth) ||
    containerWidth <= 0
  )
    return MAX_PDF_SIDEBAR_WIDTH;
  return Math.min(
    MAX_PDF_SIDEBAR_WIDTH,
    Math.max(
      MIN_PDF_SIDEBAR_WIDTH,
      Math.floor(containerWidth - MIN_PDF_READING_AREA_WIDTH),
    ),
  );
}

export function clampPdfSidebarWidth(
  value: unknown,
  maximum = MAX_PDF_SIDEBAR_WIDTH,
) {
  if (typeof value !== "number" || !Number.isFinite(value))
    return DEFAULT_PDF_SIDEBAR_WIDTH;
  const boundedMaximum = Math.min(
    MAX_PDF_SIDEBAR_WIDTH,
    Math.max(MIN_PDF_SIDEBAR_WIDTH, Math.floor(maximum)),
  );
  return Math.min(
    boundedMaximum,
    Math.max(MIN_PDF_SIDEBAR_WIDTH, Math.round(value)),
  );
}
