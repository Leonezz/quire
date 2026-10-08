// Tiling of a tall region into fixed-height screenshots, and the tile file names.

export interface Tile { index: number; y: number; height: number }
export interface TilePlan { tiles: Tile[]; truncated: boolean }

/** Cuts [top, top + height) into tiles of tileHeight (the last one shorter), at most maxTiles; truncated when cut off. */
export function planTiles(top: number, height: number, tileHeight: number, maxTiles: number): TilePlan {
  if (!(tileHeight > 0)) throw new Error(`tile height must be positive, got ${tileHeight}`);
  const total = Math.max(0, Math.ceil(height));
  if (total === 0 || maxTiles <= 0) return { tiles: [], truncated: total > 0 };
  const needed = Math.ceil(total / tileHeight);
  const count = Math.min(needed, maxTiles);
  const start = Math.max(0, Math.floor(top));
  const tiles = Array.from({ length: count }, (_, index) => {
    const y = start + index * tileHeight;
    return { index, y, height: Math.min(tileHeight, start + total - y) };
  });
  return { tiles, truncated: needed > count };
}

/** `rendered-01.png`, `reference-12.png`: 1-based, two digits minimum so they sort. */
export function tileName(side: "rendered" | "reference", index: number): string {
  return `${side}-${String(index + 1).padStart(2, "0")}.png`;
}

export const TILE_PATTERN = /^(rendered|reference)-\d+\.png$/;
