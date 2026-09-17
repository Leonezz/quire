/** Normalized coordinates in the unrotated PDF page, with a top-left origin. */
export type PdfRegion = Readonly<{
  height: number;
  page: number;
  width: number;
  x: number;
  y: number;
}>;

export function parsePdfRegionLocator(locator: string): PdfRegion | undefined {
  const match = /^pdf-region:v1:(\d+):([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)$/.exec(locator);
  if (!match) return undefined;
  const [page, x, y, width, height] = match.slice(1).map(Number);
  if (!Number.isSafeInteger(page) || page < 1 ||
      ![x, y, width, height].every(Number.isFinite) ||
      x >= 1 || y >= 1 || width <= 0 || height <= 0) return undefined;
  return { page, x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
}
