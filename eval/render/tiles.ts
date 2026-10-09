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

/**
 * The 1-based tile whose band [y, y + height) holds page y; null beyond the captured tiles. A y a pixel or
 * two above the first tile (sub-pixel layout against the floored tile start) counts as the first tile.
 */
export function tileAt(y: number, tiles: readonly Tile[]): number | null {
  const first = tiles[0];
  if (!first || !Number.isFinite(y)) return null;
  const at = y < first.y && first.y - y <= 2 ? first.y : y;
  const tile = tiles.find((t) => at >= t.y && at < t.y + t.height);
  return tile ? tile.index + 1 : null;
}

/** `rendered-01.png`, `reference-12.png`: 1-based, two digits minimum so they sort. */
export function tileName(side: "rendered" | "reference", index: number): string {
  return `${side}-${String(index + 1).padStart(2, "0")}.png`;
}

export const TILE_PATTERN = /^(rendered|reference)-\d+\.png$/;
