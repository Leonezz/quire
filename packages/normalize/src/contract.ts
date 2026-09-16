// Browser-safe subset: the reader document contracts and quality types only.
// The renderer imports this; it must never pull linkedom / readability / defuddle.
export { readerDocumentSchema } from "./reader-document-contract";
export type { ReaderDocument } from "./reader-document-contract";
export { readerDocumentV2Schema } from "./reader-document-v2-contract";
export type { ReaderDocumentV2 } from "./reader-document-v2-contract";
export type { ContentMaterialization, ContentNormalizationQuality, ContentRepresentation, NormalizationProblem, ProducerDetection } from "./model";
