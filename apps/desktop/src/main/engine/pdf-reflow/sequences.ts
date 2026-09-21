import type { PageLayout } from "./columns";
import type { FigureRegion, Line, Sequence, SequenceItem } from "./types";

// Reading order as a list of sequences: each band's columns in turn, with the lines a
// figure swallowed replaced by the figure at its caption's place (or its first row's).

/** The line a region stands in for: its caption, else the topmost line it swallowed. */
function anchorOf(region: FigureRegion): Line | undefined {
  return region.caption[0] ?? [...region.consumed].sort((a, b) => a.rect.y - b.rect.y)[0];
}

export function sequencesOf(layout: PageLayout, regions: readonly FigureRegion[]): Sequence[] {
  const hidden = new Set(regions.flatMap((region) => [...region.caption, ...region.consumed]));
  const byAnchor = new Map(regions.flatMap((region) => { const anchor = anchorOf(region); return anchor ? [[anchor, region] as const] : []; }));
  const last = layout.extents[layout.extents.length - 1]!;
  return layout.bands.flatMap((band) =>
    band.columns.flatMap((column, at) => {
      const items = column.flatMap((line): SequenceItem[] => {
        const region = byAnchor.get(line);
        if (region) return [{ kind: "figure", region }];
        return hidden.has(line) ? [] : [{ kind: "line", line }];
      });
      if (items.length === 0) return [];
      const [left, right] = band.kind === "full" ? [layout.extents[0]![0], last[1]] : layout.extents[at]!;
      return [{ page: layout.page, items, left, right }];
    }),
  );
}
