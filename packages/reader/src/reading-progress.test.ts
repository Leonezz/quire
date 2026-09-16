import { afterEach, describe, expect, it, vi } from "vitest";
import {
  READING_PROGRESS_CHANGED_EVENT,
  activeReadingRepresentationIdentity,
  pdfReadingProgress,
  readingPositionLabel,
  readRevisionReadingProgress,
  readingProgressPercent,
  rememberRevisionReadingProgress,
  revisionReadingProgressKey,
} from "./reading-progress";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("revision reading progress", () => {
  it("stores one format-neutral position for an immutable revision", () => {
    const revisionId = "paper@r3";
    const representationIdentity = "sha256:representation-a";

    rememberRevisionReadingProgress(revisionId, representationIdentity, 0.4234);

    expect(
      readRevisionReadingProgress(revisionId, representationIdentity),
    ).toMatchObject({
      progress: 0.4234,
      version: 1,
    });
    expect(
      JSON.parse(
        window.localStorage.getItem(
          revisionReadingProgressKey(revisionId, representationIdentity),
        )!,
      ),
    ).toMatchObject({ progress: 0.4234, version: 1 });
  });

  it("notifies mounted asset cards when the current revision advances", () => {
    const listener = vi.fn();
    window.addEventListener(READING_PROGRESS_CHANGED_EVENT, listener);

    rememberRevisionReadingProgress("paper@r3", "sha256:representation-a", 0.5);

    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({
      progress: 0.5,
      representationIdentity: "sha256:representation-a",
      resourceRevisionId: "paper@r3",
    });
    window.removeEventListener(READING_PROGRESS_CHANGED_EVENT, listener);
  });

  it("does not notify readers again for cosmetic PDF state changes", () => {
    const listener = vi.fn();
    window.addEventListener(READING_PROGRESS_CHANGED_EVENT, listener);

    rememberRevisionReadingProgress("paper@r3", "sha256:representation-a", 0.5);
    rememberRevisionReadingProgress("paper@r3", "sha256:representation-a", 0.5);

    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(READING_PROGRESS_CHANGED_EVENT, listener);
  });

  it("does not reuse progress across representations of one revision", () => {
    rememberRevisionReadingProgress(
      "paper@r3",
      "sha256:representation-a",
      0.64,
    );

    expect(
      readRevisionReadingProgress("paper@r3", "sha256:representation-a"),
    ).toMatchObject({ progress: 0.64 });
    expect(
      readRevisionReadingProgress("paper@r3", "sha256:representation-b"),
    ).toBeUndefined();
  });

  it("uses the representation shown by each reader without crossing formats", () => {
    expect(activeReadingRepresentationIdentity({
      activeReadingRepresentationId: "pdf",
      contentIdentity: "sha256:revision",
      materializationIdentity: "sha256:materialization",
      metadata: {
        contributors: [],
        identity: "sha256:metadata",
        identifiers: [],
        providerEvidence: [],
        representations: [],
        schema: "source.metadata.v1",
        subjects: [],
        title: "Paper",
      },
      pdfDocument: {
        byteLength: 10,
        contentIdentity: "sha256:pdf",
        mediaType: "application/pdf",
        textLayer: "available",
      },
      readingRepresentations: [{
        canonicalReader: true,
        contentIdentity: "sha256:html",
        id: "reader",
        mediaType: "text/html",
        role: "full-text",
        status: "ready",
      }, {
        contentIdentity: "sha256:pdf",
        id: "pdf",
        mediaType: "application/pdf",
        role: "publication",
        status: "ready",
      }],
    })).toBe("sha256:pdf");

    expect(activeReadingRepresentationIdentity({
      activeReadingRepresentationId: "rfc-html",
      contentIdentity: "sha256:revision",
      materializationIdentity: "sha256:materialization",
      metadata: {
        contributors: [],
        identity: "sha256:metadata",
        identifiers: [],
        providerEvidence: [],
        representations: [{
          canonicalReader: true,
          contentIdentity: "sha256:rfc-html",
          id: "rfc-html",
          mediaType: "text/html",
          role: "full-text",
          status: "ready",
        }],
        schema: "source.metadata.v1",
        subjects: [],
        title: "RFC",
      },
      pdfDocument: {
        byteLength: 10,
        contentIdentity: "sha256:rfc-pdf",
        mediaType: "application/pdf",
        textLayer: "available",
      },
      readingRepresentations: [],
    })).toBe("sha256:rfc-html");
  });

  it("does not invent PDF progress before a page count is known", () => {
    expect(
      pdfReadingProgress({ page: 4, pageOffset: 0.375 }, undefined),
    ).toBeUndefined();
  });

  it("ignores malformed and cross-revision positions", () => {
    window.localStorage.setItem(
      revisionReadingProgressKey("paper@r3", "sha256:representation-a"),
      JSON.stringify({ progress: 4, version: 1 }),
    );

    expect(
      readRevisionReadingProgress("paper@r3", "sha256:representation-a"),
    ).toBeUndefined();
    expect(
      readRevisionReadingProgress("paper@r4", "sha256:representation-a"),
    ).toBeUndefined();
  });

  it("normalizes PDF pages into the same zero-to-one progress scale", () => {
    expect(pdfReadingProgress({ page: 4, pageOffset: 0.375 }, 7)).toBeCloseTo(
      3.375 / 7,
    );
    expect(pdfReadingProgress({ page: 99, pageOffset: 2 }, 7)).toBe(1);
  });

  it("discloses only meaningful in-progress positions on asset cards", () => {
    const snapshot = (progress: number) => ({
      progress,
      updatedAt: "2026-09-02T10:00:00.000Z",
      version: 1 as const,
    });

    expect(readingProgressPercent(snapshot(0.014))).toBeUndefined();
    expect(readingProgressPercent(snapshot(0.423))).toBe(42);
    expect(readingProgressPercent(snapshot(0.991))).toBeUndefined();
  });

  it("describes the exact saved reading position for metadata", () => {
    const snapshot = (progress: number) => ({
      progress,
      updatedAt: "2026-08-24T10:00:00.000Z",
      version: 1 as const,
    });

    expect(readingPositionLabel(undefined)).toBeUndefined();
    expect(readingPositionLabel(snapshot(0.004))).toBe("At document start");
    expect(readingPositionLabel(snapshot(0.423))).toBe("42% through document");
    expect(readingPositionLabel(snapshot(0.995))).toBe("At document end");
  });
});
