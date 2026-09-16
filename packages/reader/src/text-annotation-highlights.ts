import type { TextAnnotation as AnnotationView, TextAnnotationColor as AnnotationColor, TextAnnotationKind as AnnotationKind } from "./types";
import { resolveTextQuoteRange } from "./text-quote-selection";

type HighlightRegistryLike = {
  delete: (name: string) => unknown;
  set: (name: string, highlight: unknown) => unknown;
};

type HighlightEnvironment = {
  makeHighlight: (...ranges: Range[]) => unknown;
  registry: HighlightRegistryLike;
};

type HighlightColorName =
  | "blue"
  | "gray"
  | "green"
  | "magenta"
  | "orange"
  | "purple"
  | "red"
  | "yellow";

type TextHighlightKind = Exclude<AnnotationKind, "area">;

type ResolvedAnnotationRange = Readonly<{
  annotationId: string;
  range: Range;
}>;

type PointCaretDocument = Document & {
  caretPositionFromPoint?: (
    x: number,
    y: number,
  ) => { offset: number; offsetNode: Node } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

const colorNames: Record<AnnotationColor, HighlightColorName> = {
  "#2ea8e5": "blue",
  "#5fb236": "green",
  "#a28ae5": "purple",
  "#aaaaaa": "gray",
  "#e56eee": "magenta",
  "#f19837": "orange",
  "#ff6666": "red",
  "#ffd400": "yellow",
};

const highlightColors: Record<HighlightColorName, string> = {
  blue: "46 168 229",
  gray: "130 130 130",
  green: "95 178 54",
  magenta: "229 110 238",
  orange: "241 152 55",
  purple: "162 138 229",
  red: "255 102 102",
  yellow: "255 212 0",
};

const textKinds = ["comment", "highlight", "underline"] as const satisfies readonly TextHighlightKind[];

function environmentFor(root: HTMLElement): HighlightEnvironment | undefined {
  const ownerWindow = root.ownerDocument.defaultView as
    | (Window & {
        CSS?: typeof CSS & { highlights?: HighlightRegistryLike };
        Highlight?: new (...ranges: Range[]) => unknown;
      })
    | null;
  const registry = ownerWindow?.CSS?.highlights;
  const HighlightConstructor = ownerWindow?.Highlight;
  if (!registry || !HighlightConstructor) return undefined;
  return {
    makeHighlight: (...ranges) => new HighlightConstructor(...ranges),
    registry,
  };
}

function groupName(
  namePrefix: string,
  kind: TextHighlightKind,
  color: HighlightColorName,
) {
  return `${namePrefix}-${kind}-${color}`;
}

function focusName(namePrefix: string) {
  return `${namePrefix}-focus`;
}

function textKind(annotation: AnnotationView): TextHighlightKind | undefined {
  const kind = annotation.kind ?? "highlight";
  return kind === "area" ? undefined : kind;
}

function caretPointAt(
  ownerDocument: PointCaretDocument,
  x: number,
  y: number,
) {
  const position = ownerDocument.caretPositionFromPoint?.(x, y);
  if (position)
    return { node: position.offsetNode, offset: position.offset };
  const range = ownerDocument.caretRangeFromPoint?.(x, y);
  if (!range) return undefined;
  return { node: range.startContainer, offset: range.startOffset };
}

function annotationAtPoint(
  root: HTMLElement,
  ranges: readonly ResolvedAnnotationRange[],
  x: number,
  y: number,
) {
  const point = caretPointAt(root.ownerDocument as PointCaretDocument, x, y);
  if (!point || (point.node !== root && !root.contains(point.node)))
    return undefined;
  return ranges
    .filter(({ range }) => {
      try {
        return range.isPointInRange(point.node, point.offset);
      } catch {
        return false;
      }
    })
    .sort((left, right) => left.range.toString().length - right.range.toString().length)
    .at(0)?.annotationId;
}

export function textAnnotationHighlightStyles(namePrefix: string) {
  const annotationStyles = (Object.entries(highlightColors) as Array<
    [HighlightColorName, string]
  >)
    .flatMap(([color, channels]) =>
      textKinds.map((kind) => {
        const name = groupName(namePrefix, kind, color);
        if (kind === "underline")
          return `::highlight(${name}) { background-color: rgb(${channels} / 0.10); text-decoration: underline 2px rgb(${channels} / 0.88); text-underline-offset: 0.17em; }`;
        const opacity = kind === "comment" ? "0.20" : "0.28";
        return `::highlight(${name}) { background-color: rgb(${channels} / ${opacity}); }`;
      }),
    )
    .join("\n");
  return `${annotationStyles}\n::highlight(${focusName(namePrefix)}) { background-color: rgb(63 125 89 / 0.30); text-decoration: underline 3px rgb(45 92 65 / 0.98); text-underline-offset: 0.18em; }`;
}

export function installTextAnnotationHighlights({
  annotations,
  emphasis,
  environment,
  namePrefix,
  onActivate,
  root,
}: {
  annotations: readonly AnnotationView[];
  emphasis?: Readonly<{ locator: string; quote: string }>;
  environment?: HighlightEnvironment;
  namePrefix: string;
  onActivate?: (annotationId: string) => void;
  root: HTMLElement;
}) {
  const activeEnvironment = environment ?? environmentFor(root);
  if (!activeEnvironment)
    return {
      dispose: () => undefined,
      emphasisResolved: false,
      resolved: 0,
      unresolved: 0,
    };

  const rangesByName = new Map<string, Range[]>();
  const resolvedRanges: ResolvedAnnotationRange[] = [];
  let resolved = 0;
  let unresolved = 0;
  for (const annotation of annotations) {
    if (
      annotation.status === "stale" ||
      !/^text-quote:v(?:1|2):/.test(annotation.locator)
    )
      continue;
    const kind = textKind(annotation);
    if (!kind) continue;
    const range = resolveTextQuoteRange(
      root,
      annotation.locator,
      annotation.quote,
    );
    if (!range) {
      unresolved += 1;
      continue;
    }
    const name = groupName(
      namePrefix,
      kind,
      colorNames[annotation.color ?? "#ffd400"],
    );
    const ranges = rangesByName.get(name) ?? [];
    ranges.push(range);
    rangesByName.set(name, ranges);
    resolvedRanges.push({ annotationId: annotation.id, range });
    resolved += 1;
  }

  let emphasisResolved = false;
  if (emphasis && /^text-quote:v(?:1|2):/.test(emphasis.locator)) {
    const range = resolveTextQuoteRange(root, emphasis.locator, emphasis.quote);
    if (range) {
      rangesByName.set(focusName(namePrefix), [range]);
      emphasisResolved = true;
    }
  }

  const installedNames = [...rangesByName.keys()];
  for (const [name, ranges] of rangesByName)
    activeEnvironment.registry.set(
      name,
      activeEnvironment.makeHighlight(...ranges),
    );

  const activate = (event: MouseEvent) => {
    if (
      !onActivate ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(
        "a, button, input, textarea, select, [contenteditable='true']",
      )
    )
      return;
    const selection = root.ownerDocument.defaultView?.getSelection();
    if (selection && !selection.isCollapsed) return;
    const annotationId = annotationAtPoint(
      root,
      resolvedRanges,
      event.clientX,
      event.clientY,
    );
    if (annotationId) onActivate(annotationId);
  };
  if (onActivate) root.addEventListener("click", activate);

  return {
    dispose: () => {
      if (onActivate) root.removeEventListener("click", activate);
      for (const name of installedNames) activeEnvironment.registry.delete(name);
    },
    emphasisResolved,
    resolved,
    unresolved,
  };
}
