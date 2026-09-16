import { useEffect, useState } from "react";

export type RevisionReadingProgress = Readonly<{
  progress: number;
  updatedAt: string;
  version: 1;
}>;

export type ReadingProgressChangedDetail = Readonly<{
  progress: number;
  representationIdentity: string;
  resourceRevisionId: string;
}>;

export const READING_PROGRESS_CHANGED_EVENT =
  "research-workbench:reading-progress-changed";

const storagePrefix = "research-workbench:reading-progress:";

function normalizedProgress(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : undefined;
}

export function revisionReadingProgressKey(
  resourceRevisionId: string,
  representationIdentity: string,
): string {
  return `${storagePrefix}${resourceRevisionId}:${representationIdentity}`;
}

export function readRevisionReadingProgress(
  resourceRevisionId: string,
  representationIdentity: string,
): RevisionReadingProgress | undefined {
  try {
    const stored = window.localStorage.getItem(
      revisionReadingProgressKey(resourceRevisionId, representationIdentity),
    );
    if (!stored) return undefined;
    const value = JSON.parse(stored) as Partial<RevisionReadingProgress>;
    const progress = normalizedProgress(value.progress);
    if (
      value.version !== 1 ||
      progress === undefined ||
      typeof value.updatedAt !== "string" ||
      !value.updatedAt
    )
      return undefined;
    return { progress, updatedAt: value.updatedAt, version: 1 };
  } catch {
    return undefined;
  }
}

export function rememberRevisionReadingProgress(
  resourceRevisionId: string,
  representationIdentity: string,
  progress: number,
): void {
  const normalized = normalizedProgress(progress);
  if (!resourceRevisionId || !representationIdentity || normalized === undefined)
    return;
  const current = readRevisionReadingProgress(
    resourceRevisionId,
    representationIdentity,
  );
  if (current && Math.abs(current.progress - normalized) < 0.0005) return;
  const snapshot: RevisionReadingProgress = {
    progress: normalized,
    updatedAt: new Date().toISOString(),
    version: 1,
  };
  try {
    window.localStorage.setItem(
      revisionReadingProgressKey(resourceRevisionId, representationIdentity),
      JSON.stringify(snapshot),
    );
    window.dispatchEvent(
      new CustomEvent<ReadingProgressChangedDetail>(
        READING_PROGRESS_CHANGED_EVENT,
        {
          detail: {
            progress: normalized,
            representationIdentity,
            resourceRevisionId,
          },
        },
      ),
    );
  } catch {
    // Reading progress is a device-local convenience. It must never block the
    // immutable revision or its primary reader state from opening.
  }
}

export function pdfReadingProgress(
  position: Readonly<{ page: number; pageOffset: number }>,
  pageCount: number | undefined,
): number | undefined {
  if (!Number.isSafeInteger(pageCount) || !pageCount || pageCount < 1)
    return undefined;
  const page = Math.min(pageCount, Math.max(1, Math.trunc(position.page)));
  const pageOffset = Math.min(1, Math.max(0, position.pageOffset));
  return Math.min(1, Math.max(0, (page - 1 + pageOffset) / pageCount));
}

export function readingProgressPercent(
  snapshot: RevisionReadingProgress | undefined,
): number | undefined {
  if (!snapshot) return undefined;
  const percent = Math.round(snapshot.progress * 100);
  return percent >= 2 && percent <= 98 ? percent : undefined;
}

export function readingPositionLabel(
  snapshot: RevisionReadingProgress | undefined,
): string | undefined {
  if (!snapshot) return undefined;
  const percent = Math.round(snapshot.progress * 100);
  if (percent <= 1) return "At document start";
  if (percent >= 99) return "At document end";
  return `${percent}% through document`;
}

type ReadingProgressRepresentation = Readonly<{ id?: string; contentIdentity?: string; canonicalReader?: boolean }> & Record<string, unknown>;
/** Structural view of whatever the host shows: only the identity fields matter here. */
type ReadingProgressDocument = Readonly<{
  activeReadingRepresentationId?: string;
  contentIdentity: string;
  materializationIdentity?: string;
  metadata?: (Readonly<{ representations?: readonly ReadingProgressRepresentation[] }> & Record<string, unknown>) | undefined;
  pdfDocument?: (Readonly<{ contentIdentity?: string }> & Record<string, unknown>) | undefined;
  readerRepresentation?: (Readonly<{ contentIdentity?: string }> & Record<string, unknown>) | undefined;
  readingRepresentations?: readonly ReadingProgressRepresentation[];
}> & Record<string, unknown>;

/**
 * Resolves the identity of the representation that is actually on screen.
 * New records name it explicitly. Structured readers then use the exact
 * normalized reader payload; older records fall back through the PDF viewer,
 * canonical source capture, and revision-level identities.
 */
export function activeReadingRepresentationIdentity(
  document: ReadingProgressDocument | undefined,
): string | undefined {
  if (!document) return undefined;
  const representations = [
    ...(document.readingRepresentations ?? []),
    ...(document.metadata?.representations ?? []),
  ];
  const activeRepresentation = document.activeReadingRepresentationId
    ? representations.find((candidate) => candidate.id === document.activeReadingRepresentationId)
    : undefined;
  return activeRepresentation?.contentIdentity
    ?? document.readerRepresentation?.contentIdentity
    ?? (document.readerRepresentation ? document.materializationIdentity : undefined)
    ?? document.pdfDocument?.contentIdentity
    ?? representations.find((candidate) => candidate.canonicalReader)?.contentIdentity
    ?? document.materializationIdentity
    ?? document.contentIdentity;
}

export function useRevisionReadingProgress(
  resourceRevisionId: string,
  representationIdentity: string | undefined,
): RevisionReadingProgress | undefined {
  const requestedKey = representationIdentity
    ? revisionReadingProgressKey(resourceRevisionId, representationIdentity)
    : undefined;
  const [stored, setStored] = useState<{
    key: string | undefined;
    snapshot: RevisionReadingProgress | undefined;
  }>(() => ({
    key: requestedKey,
    snapshot: representationIdentity
      ? readRevisionReadingProgress(resourceRevisionId, representationIdentity)
      : undefined,
  }));

  // Effects synchronize subscriptions after a prop change. Never expose the
  // previous key's snapshot during the render that switches assets/revisions.
  const snapshot = stored.key === requestedKey
    ? stored.snapshot
    : representationIdentity
      ? readRevisionReadingProgress(resourceRevisionId, representationIdentity)
      : undefined;

  useEffect(() => {
    const read = () =>
      representationIdentity
        ? readRevisionReadingProgress(resourceRevisionId, representationIdentity)
        : undefined;
    const update = () => setStored({ key: requestedKey, snapshot: read() });
    update();
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<ReadingProgressChangedDetail>).detail;
      if (
        detail?.resourceRevisionId !== resourceRevisionId ||
        detail.representationIdentity !== representationIdentity
      )
        return;
      update();
    };
    const stored = (event: StorageEvent) => {
      if (
        !representationIdentity ||
        event.key !==
          revisionReadingProgressKey(resourceRevisionId, representationIdentity)
      )
        return;
      update();
    };
    window.addEventListener(READING_PROGRESS_CHANGED_EVENT, changed);
    window.addEventListener("storage", stored);
    return () => {
      window.removeEventListener(READING_PROGRESS_CHANGED_EVENT, changed);
      window.removeEventListener("storage", stored);
    };
  }, [representationIdentity, requestedKey, resourceRevisionId]);

  return snapshot;
}
