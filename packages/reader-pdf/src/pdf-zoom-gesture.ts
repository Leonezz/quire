// Pure arithmetic for trackpad pinch zoom. During a pinch the pages container
// is only CSS-scaled; the real zoom is committed once the gesture settles.

/** Chromium reports a trackpad pinch as wheel events with ctrlKey set. */
export const PINCH_ZOOM_SENSITIVITY = 0.01;
/** A pinch ends once no ctrl/⌘ wheel event has arrived for this long. */
export const PINCH_COMMIT_DELAY_MS = 120;

export type ScrollAnchor = Readonly<{
  /** Horizontal offset inside the scroll container's client box. */
  x: number;
  /** Vertical offset inside the scroll container's client box. */
  y: number;
}>;

export type ScrollPosition = Readonly<{ left: number; top: number }>;

export type PinchGesture = Readonly<{
  /** Where the fingers are, relative to the scroll container's client box. */
  anchor: ScrollAnchor;
  /** Transform origin inside the (untransformed) pages container. */
  originX: number;
  originY: number;
  /** Provisional multiplier on top of the committed zoom. */
  scale: number;
}>;

/** Folds one wheel notch into the provisional scale, kept inside the zoom range. */
export function nextPinchScale(
  scale: number,
  deltaY: number,
  committedZoom: number,
  minZoom: number,
  maxZoom: number,
) {
  const proposed = scale * Math.exp(-deltaY * PINCH_ZOOM_SENSITIVITY);
  return Math.min(
    maxZoom / committedZoom,
    Math.max(minZoom / committedZoom, proposed),
  );
}

/**
 * Scroll offsets that keep the document point under `anchor` in place when the
 * content scales by `ratio` around the content origin (`contentLeft`,
 * `contentTop` are the pages container's layout offsets, i.e. the scroll
 * container's padding).
 */
export function scrollPositionAfterZoom(
  current: ScrollPosition,
  anchor: ScrollAnchor,
  ratio: number,
  contentLeft = 0,
  contentTop = 0,
): ScrollPosition {
  return {
    left: Math.max(
      0,
      (current.left + anchor.x - contentLeft) * ratio + contentLeft - anchor.x,
    ),
    top: Math.max(
      0,
      (current.top + anchor.y - contentTop) * ratio + contentTop - anchor.y,
    ),
  };
}
