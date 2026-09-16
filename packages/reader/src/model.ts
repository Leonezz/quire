import type { ReaderDocument as ReaderDocumentV1 } from "@read/normalize/contract/v1";
import type { ReaderDocumentV2 } from "@read/normalize/contract/v2";

export type {
  ReaderCode,
  ReaderDocument as ReaderDocumentV1,
  ReaderHeading,
  ReaderImage,
  ReaderInlineCode,
  ReaderLink,
  ReaderList,
  ReaderListItem,
  ReaderNode,
  ReaderParentNode,
  ReaderText,
  ReaderVoidNode,
} from "@read/normalize/contract/v1";
export type {
  ReaderDocumentV2,
  ReaderV2Abbreviation,
  ReaderV2Blockquote,
  ReaderV2Code,
  ReaderV2Figure,
  ReaderV2FlowNode,
  ReaderV2FootnoteDefinition,
  ReaderV2FootnoteReference,
  ReaderV2Heading,
  ReaderV2Image,
  ReaderV2Link,
  ReaderV2List,
  ReaderV2ListItem,
  ReaderV2Loss,
  ReaderV2Math,
  ReaderV2Paragraph,
  ReaderV2PhrasingNode,
  ReaderV2PhrasingParent,
  ReaderV2Section,
  ReaderV2Table,
  ReaderV2TableCell,
  ReaderV2TableRow,
  ReaderV2TableSection,
  ReaderV2Text,
} from "@read/normalize/contract/v2";

export type ReaderDocument = ReaderDocumentV1 | ReaderDocumentV2;
