export type HorizontalReadingPosition = Readonly<{
  element: HTMLElement;
  left: number;
}>;

/** Reveal a quote inside code/table scrollers owned by this reader only.
 * Return the positions we changed so a deep-link jump can be undone by Back.
 * Neither source nodes nor scroll containers outside the body are modified.
 */
export function revealArticleRangeHorizontally(
  body: HTMLElement,
  range: Range,
): HorizontalReadingPosition[] {
  const positions: HorizontalReadingPosition[] = [];
  if (
    !body.isConnected ||
    !body.contains(range.startContainer) ||
    !body.contains(range.endContainer)
  ) return positions;

  const start = range.startContainer;
  let parent = start.nodeType === 1 ? start as HTMLElement : start.parentElement;
  while (parent && parent !== body && body.contains(parent)) {
    if (
      parent.contains(range.endContainer) &&
      parent.clientWidth > 0 &&
      parent.scrollWidth > parent.clientWidth &&
      /^(auto|scroll)$/.test(
        parent.ownerDocument.defaultView?.getComputedStyle(parent).overflowX ?? "",
      )
    ) {
      const bounds = parent.getBoundingClientRect();
      // Re-measure after moving an inner scroller. Borders and a possible
      // vertical scrollbar are not part of the visible content area.
      const excerpt = range.getBoundingClientRect();
      const left = bounds.left + parent.clientLeft;
      const right = left + parent.clientWidth;
      if (excerpt.height && (excerpt.left < left || excerpt.right > right)) {
        const inset = Math.min(24, parent.clientWidth / 4);
        const delta = excerpt.left < left || excerpt.width > parent.clientWidth - inset * 2
          ? excerpt.left - left - inset
          : excerpt.right - right + inset;
        const previousLeft = parent.scrollLeft;
        parent.scrollTo({ left: previousLeft + delta, behavior: "instant" });
        if (parent.scrollLeft !== previousLeft)
          positions.push({ element: parent, left: previousLeft });
      }
    }
    parent = parent.parentElement;
  }
  return positions;
}
