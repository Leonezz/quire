import {
  useCallback,
  useEffect,
  useState,
  type RefObject,
} from "react";
import { rememberRevisionReadingProgress } from "./reading-progress";
import type { HorizontalReadingPosition } from "./reveal-article-range";

type StoredDocumentReadingPosition = Readonly<{
  progress: number;
  scrollHeight: number;
  top: number;
  version: 1;
}>;

const storagePrefix = "research-workbench:document-reader:";
const saveDelayMs = 180;

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function documentReadingPositionKey(identity: string): string {
  return `${storagePrefix}${identity}`;
}

export function readDocumentReadingPosition(
  identity: string,
): StoredDocumentReadingPosition | undefined {
  try {
    const stored = window.localStorage.getItem(
      documentReadingPositionKey(identity),
    );
    if (!stored) return undefined;
    const value = JSON.parse(stored) as Partial<StoredDocumentReadingPosition>;
    const top = finiteNonNegative(value.top);
    const scrollHeight = finiteNonNegative(value.scrollHeight);
    const progress = finiteNonNegative(value.progress);
    if (
      value.version !== 1 ||
      top === undefined ||
      scrollHeight === undefined ||
      progress === undefined ||
      progress > 1
    ) {
      return undefined;
    }
    return { progress, scrollHeight, top, version: 1 };
  } catch {
    return undefined;
  }
}

function positionFor(viewport: HTMLDivElement): StoredDocumentReadingPosition {
  const top = Math.max(0, viewport.scrollTop);
  const scrollHeight = Math.max(0, viewport.scrollHeight);
  const maximumTop = Math.max(0, scrollHeight - viewport.clientHeight);
  return {
    progress: maximumTop > 0 ? Math.min(1, top / maximumTop) : 0,
    scrollHeight,
    top,
    version: 1,
  };
}

function storeDocumentReadingPosition(
  identity: string,
  position: StoredDocumentReadingPosition,
): void {
  try {
    window.localStorage.setItem(
      documentReadingPositionKey(identity),
      JSON.stringify(position),
    );
  } catch {
    // Reading-position persistence must never prevent an immutable revision
    // from opening.
  }
}

function restoredTop(
  stored: StoredDocumentReadingPosition,
  viewport: HTMLDivElement,
): number {
  const maximumTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  if (!maximumTop) return stored.top;
  const heightChanged =
    stored.scrollHeight > 0 &&
    Math.abs(viewport.scrollHeight - stored.scrollHeight) /
      stored.scrollHeight >
      0.08;
  return Math.min(
    maximumTop,
    heightChanged ? stored.progress * maximumTop : stored.top,
  );
}

export function useDocumentReadingPosition(
  viewportRef: RefObject<HTMLDivElement | null>,
  identity: string | undefined,
  resourceRevisionId?: string,
  representationIdentity?: string,
): void {
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !identity) return;

    const stored = readDocumentReadingPosition(identity);
    let initialized = false;
    let userMoved = false;
    let restoring = false;
    let latestPosition: StoredDocumentReadingPosition | undefined;
    let saveTimer: number | undefined;
    let restoreGuardFrame: number | undefined;
    let secondRestoreFrame: number | undefined;

    const restore = () => {
      if (userMoved) return;
      restoring = true;
      viewport.scrollTop = stored ? restoredTop(stored, viewport) : 0;
      latestPosition = positionFor(viewport);
      initialized = true;
      if (stored && resourceRevisionId && representationIdentity)
        rememberRevisionReadingProgress(
          resourceRevisionId,
          representationIdentity,
          stored.progress,
        );
      if (restoreGuardFrame !== undefined)
        window.cancelAnimationFrame(restoreGuardFrame);
      restoreGuardFrame = window.requestAnimationFrame(() => {
        restoring = false;
      });
    };
    restore();
    secondRestoreFrame = window.requestAnimationFrame(restore);

    const save = () => {
      if (!initialized) return;
      if (latestPosition) {
        storeDocumentReadingPosition(identity, latestPosition);
        if (resourceRevisionId && representationIdentity)
          rememberRevisionReadingProgress(
            resourceRevisionId,
            representationIdentity,
            latestPosition.progress,
          );
      }
    };
    const markUserIntent = () => {
      userMoved = true;
      restoring = false;
    };
    const handleScroll = () => {
      if (!initialized || restoring) return;
      userMoved = true;
      latestPosition = positionFor(viewport);
      if (saveTimer !== undefined) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(save, saveDelayMs);
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    viewport.addEventListener("load", restore, true);
    viewport.addEventListener("keydown", markUserIntent);
    viewport.addEventListener("pointerdown", markUserIntent, { passive: true });
    viewport.addEventListener("wheel", markUserIntent, { passive: true });

    return () => {
      viewport.removeEventListener("scroll", handleScroll);
      viewport.removeEventListener("load", restore, true);
      viewport.removeEventListener("keydown", markUserIntent);
      viewport.removeEventListener("pointerdown", markUserIntent);
      viewport.removeEventListener("wheel", markUserIntent);
      if (restoreGuardFrame !== undefined)
        window.cancelAnimationFrame(restoreGuardFrame);
      if (secondRestoreFrame !== undefined)
        window.cancelAnimationFrame(secondRestoreFrame);
      if (saveTimer !== undefined) window.clearTimeout(saveTimer);
      if (userMoved) save();
    };
  }, [identity, representationIdentity, resourceRevisionId, viewportRef]);
}

export type DocumentReadingReturn = Readonly<{
  canReturn: boolean;
  clear: () => void;
  rememberCurrent: (horizontalPositions?: readonly HorizontalReadingPosition[]) => void;
  returnToPrevious: () => boolean;
}>;

/**
 * Keeps the transient origin of an explicit deep-link jump separate from the
 * durable reading position. This lets a note or annotation take the reader to
 * evidence without replacing the place they were reading beforehand.
 */
export function useDocumentReadingReturn(
  viewportRef: RefObject<HTMLDivElement | null>,
  identity: string | undefined,
): DocumentReadingReturn {
  const [previousPosition, setPreviousPosition] = useState<{
    identity: string;
    viewport: HTMLDivElement;
    top: number;
    horizontal: readonly HorizontalReadingPosition[];
  }>();

  useEffect(() => {
    setPreviousPosition(undefined);
  }, [identity]);

  const clear = useCallback(() => setPreviousPosition(undefined), []);

  const rememberCurrent = useCallback((horizontal: readonly HorizontalReadingPosition[] = []) => {
    const viewport = viewportRef.current;
    if (!identity || !viewport) return;
    setPreviousPosition({ identity, viewport, top: Math.max(0, viewport.scrollTop), horizontal });
  }, [identity, viewportRef]);

  const returnToPrevious = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || previousPosition?.identity !== identity || previousPosition?.viewport !== viewport) {
      setPreviousPosition(undefined);
      return false;
    }
    for (const { element, left } of previousPosition.horizontal) {
      if (element.isConnected && viewport.contains(element))
        element.scrollTo({ left, behavior: "instant" });
    }
    viewport.scrollTop = previousPosition.top;
    setPreviousPosition(undefined);
    return true;
  }, [identity, previousPosition, viewportRef]);

  return {
    canReturn: previousPosition !== undefined && previousPosition.identity === identity,
    clear,
    rememberCurrent,
    returnToPrevious,
  };
}
