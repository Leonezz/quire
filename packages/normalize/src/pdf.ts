import type {
  ContentMaterialization,
  NormalizationProblem,
  Sha256Identity,
} from "./model";
import { createRepresentations, sha256Identity } from "./representations";

const MAX_LOCATOR_CHARACTERS = 4_096;
const MAX_TITLE_CHARACTERS = 500;
const MIN_OUTPUT_BYTES = 512;
const MAX_FALLBACK_TEXT_BYTES = 64 * 1024;

export type PdfCaptureInput = {
  budget: {
    maxBytes: number;
    maxOutputBytes: number;
  };
  capture: {
    baseLocator: string;
    bytes: Uint8Array;
    contentIdentity: Sha256Identity;
    mediaType: string;
  };
  extraction: {
    extractedPageCount?: number;
    pageCount: number;
    text: string;
    truncated?: boolean;
  };
  title: string;
};

export type NormalizedPdf = {
  materialization: ContentMaterialization;
  pageCount: number;
  source: string;
  sourceFingerprint: Sha256Identity;
  sourceIdentity: Sha256Identity;
  title: string;
};

export type PdfNormalizationSuccess = {
  ok: true;
  pdf: NormalizedPdf;
  problems: NormalizationProblem[];
};

export type PdfNormalizationFailure = {
  fallbackText?: string;
  ok: false;
  problems: NormalizationProblem[];
};

export type PdfNormalizationOutcome =
  | PdfNormalizationFailure
  | PdfNormalizationSuccess;

function problem(
  code: string,
  severity: NormalizationProblem["severity"],
  recoverBy: NormalizationProblem["recoverBy"],
  scope: NormalizationProblem["scope"],
): NormalizationProblem {
  return { code, recoverBy, scope, severity };
}

function serializedBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncateUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    characters.push(character);
    bytes += characterBytes;
  }
  return characters.join("").trimEnd();
}

function isByteArray(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

function normalizeLocator(value: string) {
  const locator = value.normalize("NFKC").trim();
  return locator.length > 0 && locator.length <= MAX_LOCATOR_CHARACTERS
    ? locator
    : "";
}

function fallbackTitle(locator: string) {
  try {
    const parsed = new URL(locator);
    const pathname = decodeURIComponent(parsed.pathname).split("/").filter(Boolean).at(-1);
    if (pathname) return pathname;
  } catch {
    // A local path is a valid locator too.
  }
  return locator.split(/[\\/]/u).filter(Boolean).at(-1) ?? "Untitled PDF";
}

function normalizeTitle(value: string, locator: string) {
  const title = value.normalize("NFKC").trim().slice(0, MAX_TITLE_CHARACTERS);
  return title || fallbackTitle(locator).slice(0, MAX_TITLE_CHARACTERS) || "Untitled PDF";
}

function normalizeExtractedText(value: string) {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/\f/gu, "\n\n")
    .replace(/[\u0000\u0008\u000b\u000e-\u001f\u007f]/gu, "")
    .trim();
}

function failure(
  problems: NormalizationProblem[],
  maxOutputBytes: number,
  fallbackText?: string,
): PdfNormalizationFailure {
  const boundedFallback = fallbackText
    ? truncateUtf8(
        fallbackText,
        Math.min(MAX_FALLBACK_TEXT_BYTES, Math.max(1, Math.floor(maxOutputBytes / 4))),
      )
    : undefined;
  const candidate: PdfNormalizationFailure = {
    ...(boundedFallback ? { fallbackText: boundedFallback } : {}),
    ok: false,
    problems,
  };
  if (maxOutputBytes > 0 && serializedBytes(candidate) > maxOutputBytes) {
    const fatalProblems = problems.filter((value) => value.severity === "fatal");
    return {
      ok: false,
      problems: fatalProblems.length ? fatalProblems : problems.slice(0, 1),
    };
  }
  return candidate;
}

function knownErrorCode(error: unknown) {
  return error instanceof Error && /^SOURCE_[A-Z0-9_]+$/u.test(error.message)
    ? error.message
    : "SOURCE_PDF_INVALID";
}

function extractionIsTruncated(input: PdfCaptureInput["extraction"]) {
  return input.truncated === true || (
    input.extractedPageCount !== undefined &&
    input.extractedPageCount < input.pageCount
  );
}

function validPageCount(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function materializationIdentity(
  materialization: ContentMaterialization,
  sourceFingerprint: Sha256Identity,
) {
  const basis = JSON.stringify({
    normalizationVersion: "3",
    producer: materialization.provenance.producer,
    quality: materialization.quality,
    representations: materialization.representations.map(
      ({ contentIdentity, purpose, schema }) => ({
        contentIdentity,
        purpose,
        schema,
      }),
    ),
    rulesApplied: materialization.provenance.rulesApplied,
    selectedCandidate: materialization.provenance.selectedCandidate,
    sourceFingerprint,
    sourceIdentity: materialization.sourceIdentity,
  });
  return sha256Identity(basis);
}

export function normalizePdfCapture(
  input: PdfCaptureInput,
): PdfNormalizationOutcome {
  const maxOutputBytes = input?.budget?.maxOutputBytes;
  const budgetValues = [input?.budget?.maxBytes, maxOutputBytes];
  if (!budgetValues.every((value) => Number.isSafeInteger(value) && value > 0)) {
    return failure(
      [problem("SOURCE_BUDGET_INVALID", "fatal", "none", "capture")],
      typeof maxOutputBytes === "number" ? maxOutputBytes : 0,
    );
  }
  if (maxOutputBytes < MIN_OUTPUT_BYTES) {
    return failure(
      [problem("SOURCE_OUTPUT_BUDGET_INVALID", "fatal", "none", "capture")],
      maxOutputBytes,
    );
  }

  const bytes = input.capture.bytes;
  if (!isByteArray(bytes) || bytes.byteLength > input.budget.maxBytes) {
    return failure(
      [problem("SOURCE_PDF_TOO_LARGE", "fatal", "none", "capture")],
      maxOutputBytes,
    );
  }
  if (sha256Identity(bytes) !== input.capture.contentIdentity) {
    return failure(
      [problem("SOURCE_CAPTURE_IDENTITY_MISMATCH", "fatal", "none", "capture")],
      maxOutputBytes,
    );
  }

  const mediaType = typeof input.capture.mediaType === "string"
    ? input.capture.mediaType.split(";", 1)[0].trim().toLowerCase()
    : "";
  if (mediaType !== "application/pdf") {
    return failure(
      [problem("SOURCE_PDF_MEDIA_TYPE_UNSUPPORTED", "fatal", "none", "capture")],
      maxOutputBytes,
    );
  }
  const source = typeof input.capture.baseLocator === "string"
    ? normalizeLocator(input.capture.baseLocator)
    : "";
  if (!source) {
    return failure(
      [problem("SOURCE_PDF_LOCATOR_INVALID", "fatal", "none", "capture")],
      maxOutputBytes,
    );
  }

  const extraction = input.extraction;
  if (
    !extraction ||
    typeof extraction.text !== "string" ||
    !validPageCount(extraction.pageCount) ||
    (extraction.extractedPageCount !== undefined &&
      (!validPageCount(extraction.extractedPageCount) ||
        extraction.extractedPageCount > extraction.pageCount)) ||
    (extraction.truncated !== undefined && typeof extraction.truncated !== "boolean")
  ) {
    return failure(
      [problem("SOURCE_PDF_EXTRACTION_INVALID", "fatal", "none", "capture")],
      maxOutputBytes,
    );
  }

  const title = normalizeTitle(
    typeof input.title === "string" ? input.title : "",
    source,
  );
  const text = normalizeExtractedText(extraction.text);
  const truncated = extractionIsTruncated(extraction);
  const problems: NormalizationProblem[] = [];
  if (!text) {
    problems.push(
      problem("SOURCE_PDF_TEXT_EMPTY", "warning", "reopen", "representation"),
    );
  }
  if (truncated) {
    problems.push(
      problem("SOURCE_PDF_TEXT_TRUNCATED", "warning", "reopen", "representation"),
    );
  }

  try {
    const representationResult = createRepresentations({
      baseUri: source,
      content: text,
      maxDepth: 40,
      maxNodes: 100_000,
      maxOutputBytes,
      mediaType: "text/plain",
      outputBudgetErrorCode: "SOURCE_PDF_OUTPUT_BUDGET_EXCEEDED",
      producerKey: "pdf",
      title,
    });
    const rulesApplied = [
      "pdf.raw-capture@1",
      "pdf.injected-text@1",
      "pdf.page-count@1",
      ...representationResult.rulesApplied,
    ];
    const producer: ContentMaterialization["provenance"]["producer"] = {
      evidence: [],
      key: "pdf",
      version: "1",
    };
    const sourceIdentity = sha256Identity(`pdf\0${source}`);
    const sourceFingerprint = input.capture.contentIdentity;
    const quality: ContentMaterialization["quality"] = {
      completeness: !text ? "none" : truncated ? "ambiguous" : "declared_full",
      conformance: !text || truncated ? "recoverable" : "conformant",
      identityConfidence: "strong",
      safety: "safe",
      warnings: problems,
    };
    const provenance: ContentMaterialization["provenance"] = {
      captureIdentity: sourceFingerprint,
      producer,
      rulesApplied,
      selectedCandidate: {
        mediaType,
        role: !text || truncated ? "ambiguous" : "full",
        sourcePath: "pdf.extractor.injected-text",
      },
    };
    const materialization: ContentMaterialization = {
      identity: `sha256:${"0".repeat(64)}` as Sha256Identity,
      provenance,
      quality,
      representations: representationResult.representations,
      sourceIdentity,
    };
    materialization.identity = materializationIdentity(materialization, sourceFingerprint);
    const pdf: NormalizedPdf = {
      materialization,
      pageCount: extraction.pageCount,
      source,
      sourceFingerprint,
      sourceIdentity,
      title,
    };
    const outcome: PdfNormalizationSuccess = { ok: true, pdf, problems };
    if (serializedBytes(outcome) > maxOutputBytes) {
      return failure(
        [problem("SOURCE_PDF_OUTPUT_BUDGET_EXCEEDED", "fatal", "none", "representation")],
        maxOutputBytes,
        text,
      );
    }
    return outcome;
  } catch (error) {
    return failure(
      [
        ...problems,
        problem(
          knownErrorCode(error),
          "fatal",
          text ? "plain-text-fallback" : "none",
          "representation",
        ),
      ],
      maxOutputBytes,
      text,
    );
  }
}
