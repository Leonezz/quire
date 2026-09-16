export type Sha256Identity = `sha256:${string}`;

export type NormalizationProblem = {
  code: string;
  recoverBy:
    | "acquire-linked-source"
    | "generic-fallback"
    | "none"
    | "plain-text-fallback"
    | "reopen";
  scope: "candidate" | "capture" | "representation";
  severity: "fatal" | "warning";
};

export type ProducerEvidence = {
  field: string;
  strength: "medium" | "strong" | "weak";
  value: string;
};

export type ProducerDetection = {
  evidence: ProducerEvidence[];
  key: string;
  version: string;
};

export type ContentRepresentation = {
  content: string;
  contentIdentity: Sha256Identity;
  purpose: "agent" | "reader" | "selection";
  schema: "agent.gfm.v1" | "reader.document.v1" | "reader.document.v2" | "selection.text.v1";
};

export type ContentNormalizationQuality = {
  completeness:
    | "ambiguous"
    | "declared_full"
    | "external"
    | "none"
    | "summary";
  conformance: "conformant" | "nonconformant" | "recoverable";
  identityConfidence: "conflict" | "derived" | "medium" | "strong";
  safety: "degraded_plaintext" | "rejected" | "safe";
  warnings: NormalizationProblem[];
};

export type ContentMaterialization = {
  identity: Sha256Identity;
  provenance: {
    captureIdentity: Sha256Identity;
    producer: ProducerDetection;
    rulesApplied: string[];
    selectedCandidate: {
      mediaType: string;
      role: "ambiguous" | "external" | "full" | "summary";
      sourcePath: string;
    };
  };
  quality: ContentNormalizationQuality;
  representations: ContentRepresentation[];
  sourceIdentity: Sha256Identity;
};

export type NormalizedFeedEntry = {
  externalId: string;
  legacyExternalIds: string[];
  link: string;
  materialization: ContentMaterialization;
  publishedAt?: string;
  sourceFingerprint: Sha256Identity;
  sourceIdentity: Sha256Identity;
  title: string;
};

export type FeedNormalizationSuccess = {
  feed: {
    entries: NormalizedFeedEntry[];
    producer: ProducerDetection;
    title: string;
  };
  ok: true;
  problems: NormalizationProblem[];
};

export type FeedNormalizationFailure = {
  ok: false;
  problems: NormalizationProblem[];
};

export type FeedNormalizationOutcome = FeedNormalizationFailure | FeedNormalizationSuccess;

export type FeedCaptureInput = {
  budget: {
    maxBytes: number;
    maxDepth: number;
    maxEntries: number;
    maxEntryOutputBytes: number;
    maxNodes: number;
    maxTotalOutputBytes: number;
  };
  capture: {
    baseLocator?: string;
    bytes: Uint8Array;
    contentIdentity: Sha256Identity;
    mediaType: string;
  };
};

export type ArticleCaptureInput = {
  budget: {
    maxBytes: number;
    maxDepth: number;
    maxNodes: number;
    maxOutputBytes: number;
  };
  capture: {
    baseLocator: string;
    bytes: Uint8Array;
    contentIdentity: Sha256Identity;
    mediaType: string;
  };
};

export type NormalizedArticle = {
  byline?: string;
  dir?: "ltr" | "rtl";
  lang?: string;
  materialization: ContentMaterialization;
  publishedAt?: string;
  source: string;
  sourceFingerprint: Sha256Identity;
  sourceIdentity: Sha256Identity;
  title: string;
};

export type ArticleNormalizationSuccess = {
  article: NormalizedArticle;
  ok: true;
  problems: NormalizationProblem[];
};

export type ArticleNormalizationFailure = {
  fallbackText?: string;
  ok: false;
  problems: NormalizationProblem[];
};

export type ArticleNormalizationOutcome = ArticleNormalizationFailure | ArticleNormalizationSuccess;
