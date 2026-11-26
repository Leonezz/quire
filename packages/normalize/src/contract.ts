// Browser-safe subset: the reader document contracts and quality types only.
// The renderer imports this; it must never pull linkedom / readability / defuddle.
export { readerDocumentSchema } from "./reader-document-contract";
export type { ReaderDocument } from "./reader-document-contract";
export { isInlineImageUrl, readerDocumentV2Schema } from "./reader-document-v2-contract";
export type { ReaderDocumentV2 } from "./reader-document-v2-contract";
export type {
  ContentMaterialization,
  ContentNormalizationQuality,
  ContentRepresentation,
  NormalizationProblem,
  NormalizedFeedMedia,
  NormalizedFeedTranscriptRef,
  NormalizedMediaChapter,
  ProducerDetection,
} from "./model";
export type {
  TranscriptAnchor,
  TranscriptChapter,
  TranscriptCue,
  TranscriptKeyframe,
  TranscriptOrigin,
} from "./transcript-contract";
export {
  extractDescriptionChapters,
  formatShowNotesMarkdown,
  isCollapsedShowNotesReader,
  parseShowNotesTimestamp,
  splitShowNotesTimestamps,
  type ShowNotesTextPart,
} from "./shownotes";
