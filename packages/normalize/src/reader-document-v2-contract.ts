import { z } from "zod";

export type ReaderV2Text = { type: "text"; value: string };

export type ReaderV2PhrasingParent = {
  children: ReaderV2PhrasingNode[];
  type:
    | "cite"
    | "delete"
    | "emphasis"
    | "insert"
    | "keyboard"
    | "mark"
    | "quote"
    | "strong"
    | "subscript"
    | "superscript";
};

export type ReaderV2Abbreviation = {
  children: ReaderV2PhrasingNode[];
  title: string | null;
  type: "abbreviation";
};

export type ReaderV2Link = {
  children: ReaderV2PhrasingNode[];
  targetAnchor?: string | null;
  title: string | null;
  type: "link";
  url: string;
};

export type ReaderV2Image = {
  alt: string;
  /** Intrinsic pixel size when the source declared one; lets the reader reserve space before the image loads. */
  height?: number;
  title: string | null;
  type: "image";
  url: string;
  width?: number;
};

export type ReaderV2Math = {
  display: boolean;
  format: "mathml" | "tex";
  label: string | null;
  type: "math";
  value: string;
};

export type ReaderV2FootnoteReference = {
  identifier: string;
  label: string;
  type: "footnoteReference";
};

export type ReaderV2PhrasingNode =
  | ReaderV2Abbreviation
  | ReaderV2FootnoteReference
  | ReaderV2Image
  | ReaderV2Link
  | ReaderV2Math
  | ReaderV2PhrasingParent
  | ReaderV2Text
  | { type: "break" }
  | { type: "inlineCode"; value: string };

export type ReaderV2Heading = {
  anchor?: string | null;
  children: ReaderV2PhrasingNode[];
  depth: 1 | 2 | 3 | 4 | 5 | 6;
  type: "heading";
};

export type ReaderV2Paragraph = {
  children: ReaderV2PhrasingNode[];
  type: "paragraph";
};

export type ReaderV2Section = {
  anchor?: string | null;
  children: ReaderV2FlowNode[];
  type: "section";
};

export type ReaderV2Blockquote = {
  children: ReaderV2FlowNode[];
  type: "blockquote";
};

export type ReaderV2List = {
  children: ReaderV2ListItem[];
  ordered: boolean;
  spread: boolean;
  start: number | null;
  type: "list";
};

export type ReaderV2ListItem = {
  children: ReaderV2FlowNode[];
  spread: boolean;
  type: "listItem";
};

export type ReaderV2Code = {
  lang: string | null;
  meta: string | null;
  type: "code";
  value: string;
};

export type ReaderV2Figure = {
  caption: ReaderV2PhrasingNode[];
  credit: ReaderV2PhrasingNode[];
  media: ReaderV2Image[];
  type: "figure";
};

export type ReaderV2TableCell = {
  align: "center" | "left" | "right" | null;
  children: ReaderV2FlowNode[];
  colSpan: number;
  header: boolean;
  rowSpan: number;
  scope: "col" | "colgroup" | "row" | "rowgroup" | null;
  type: "tableCell";
};

export type ReaderV2TableRow = {
  children: ReaderV2TableCell[];
  type: "tableRow";
};

export type ReaderV2TableSection = {
  children: ReaderV2TableRow[];
  type: "tableSection";
};

export type ReaderV2Table = {
  bodies: ReaderV2TableSection[];
  caption: ReaderV2PhrasingNode[];
  foot: ReaderV2TableSection | null;
  head: ReaderV2TableSection | null;
  type: "table";
};

export type ReaderV2FootnoteDefinition = {
  children: ReaderV2FlowNode[];
  identifier: string;
  label: string;
  type: "footnoteDefinition";
};

export type ReaderV2FlowNode =
  | ReaderV2Blockquote
  | ReaderV2Code
  | ReaderV2Figure
  | ReaderV2FootnoteDefinition
  | ReaderV2Heading
  | ReaderV2List
  | ReaderV2Math
  | ReaderV2Paragraph
  | ReaderV2Section
  | ReaderV2Table
  | { type: "thematicBreak" };

export type ReaderV2Loss = {
  code: string;
  fallback: "children" | "omitted" | "text";
  sourcePath: string;
  sourceTag: string;
};

export type ReaderDocumentV2 = {
  children: ReaderV2FlowNode[];
  losses: ReaderV2Loss[];
  type: "root";
};

/** Figure crops of a PDF's text view, served by the app itself (`quire-figure://<materialId>/<n>.png`). */
const FIGURE_PROTOCOL = "quire-figure:";

function isAllowedUrl(value: string, purpose: "image" | "link") {
  try {
    const parsed = new URL(value);
    if (purpose === "link" && parsed.protocol === "mailto:") return true;
    if (purpose === "image" && parsed.protocol === FIGURE_PROTOCOL) return parsed.username === "" && parsed.password === "";
    return ["http:", "https:"].includes(parsed.protocol) && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

const titleSchema = z.string().nullable();
const nonEmptyString = z.string().min(1);
type ReaderV2AnyNode = ReaderV2FlowNode | ReaderV2ListItem | ReaderV2PhrasingNode | ReaderV2TableCell | ReaderV2TableRow | ReaderV2TableSection;
const readerV2NodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), value: z.string() }).strict(),
    z.object({ type: z.literal("break") }).strict(),
    z.object({ type: z.literal("thematicBreak") }).strict(),
    z.object({ type: z.literal("inlineCode"), value: z.string() }).strict(),
    z.object({
      alt: z.string(),
      height: z.number().int().min(1).max(20_000).optional(),
      title: titleSchema,
      type: z.literal("image"),
      url: z.string().refine((value) => isAllowedUrl(value, "image")),
      width: z.number().int().min(1).max(20_000).optional(),
    }).strict(),
    z.object({
      children: z.array(readerV2NodeSchema),
      targetAnchor: nonEmptyString.nullable().optional(),
      title: titleSchema,
      type: z.literal("link"),
      url: z.string().refine((value) => isAllowedUrl(value, "link")),
    }).strict(),
    ...(["cite", "delete", "emphasis", "insert", "keyboard", "mark", "quote", "strong", "subscript", "superscript"] as const).map((type) =>
      z.object({ children: z.array(readerV2NodeSchema), type: z.literal(type) }).strict(),
    ),
    z.object({ children: z.array(readerV2NodeSchema), title: titleSchema, type: z.literal("abbreviation") }).strict(),
    z.object({
      display: z.boolean(),
      format: z.enum(["mathml", "tex"]),
      label: titleSchema,
      type: z.literal("math"),
      value: z.string(),
    }).strict(),
    z.object({ identifier: nonEmptyString, label: nonEmptyString, type: z.literal("footnoteReference") }).strict(),
    z.object({
      anchor: nonEmptyString.nullable().optional(),
      children: z.array(readerV2NodeSchema),
      depth: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
      type: z.literal("heading"),
    }).strict(),
    z.object({ children: z.array(readerV2NodeSchema), type: z.literal("paragraph") }).strict(),
    z.object({
      anchor: nonEmptyString.nullable().optional(),
      children: z.array(readerV2NodeSchema),
      type: z.literal("section"),
    }).strict(),
    z.object({ children: z.array(readerV2NodeSchema), type: z.literal("blockquote") }).strict(),
    z.object({
      children: z.array(readerV2NodeSchema),
      ordered: z.boolean(),
      spread: z.boolean(),
      start: z.number().int().nullable(),
      type: z.literal("list"),
    }).strict(),
    z.object({ children: z.array(readerV2NodeSchema), spread: z.boolean(), type: z.literal("listItem") }).strict(),
    z.object({ lang: titleSchema, meta: titleSchema, type: z.literal("code"), value: z.string() }).strict(),
    z.object({
      caption: z.array(readerV2NodeSchema),
      credit: z.array(readerV2NodeSchema),
      media: z.array(readerV2NodeSchema).min(1),
      type: z.literal("figure"),
    }).strict(),
    z.object({
      align: z.enum(["center", "left", "right"]).nullable(),
      children: z.array(readerV2NodeSchema),
      colSpan: z.number().int().min(1).max(1_000),
      header: z.boolean(),
      rowSpan: z.number().int().min(1).max(1_000),
      scope: z.enum(["col", "colgroup", "row", "rowgroup"]).nullable(),
      type: z.literal("tableCell"),
    }).strict(),
    z.object({ children: z.array(readerV2NodeSchema), type: z.literal("tableRow") }).strict(),
    z.object({ children: z.array(readerV2NodeSchema), type: z.literal("tableSection") }).strict(),
    z.object({
      bodies: z.array(readerV2NodeSchema),
      caption: z.array(readerV2NodeSchema),
      foot: readerV2NodeSchema.nullable(),
      head: readerV2NodeSchema.nullable(),
      type: z.literal("table"),
    }).strict(),
    z.object({
      children: z.array(readerV2NodeSchema),
      identifier: nonEmptyString,
      label: nonEmptyString,
      type: z.literal("footnoteDefinition"),
    }).strict(),
  ]),
);

function isPhrasing(node: ReaderV2AnyNode) {
  return ["abbreviation", "break", "cite", "delete", "emphasis", "footnoteReference", "image", "inlineCode", "insert", "keyboard", "link", "mark", "quote", "strong", "subscript", "superscript", "text"].includes(node.type) || (node.type === "math" && !node.display);
}

function isFlow(node: ReaderV2AnyNode): node is ReaderV2FlowNode {
  return ["blockquote", "code", "figure", "footnoteDefinition", "heading", "list", "paragraph", "section", "table", "thematicBreak"].includes(node.type) || (node.type === "math" && node.display);
}

function phrasingChildrenAreValid(children: readonly ReaderV2AnyNode[], insideLink: boolean) {
  return children.every((child) => isPhrasing(child) && nodeHasValidGrammar(child, insideLink));
}

function flowChildrenAreValid(children: readonly ReaderV2AnyNode[]) {
  return children.every((child) => isFlow(child) && nodeHasValidGrammar(child, false));
}

function nodeHasValidGrammar(node: ReaderV2AnyNode, insideLink: boolean): boolean {
  if (node.type === "link" && insideLink) return false;
  switch (node.type) {
    case "abbreviation":
    case "cite":
    case "delete":
    case "emphasis":
    case "heading":
    case "insert":
    case "keyboard":
    case "mark":
    case "paragraph":
    case "quote":
    case "strong":
    case "subscript":
    case "superscript":
      return phrasingChildrenAreValid(node.children, insideLink);
    case "link":
      return phrasingChildrenAreValid(node.children, true);
    case "blockquote":
    case "footnoteDefinition":
    case "listItem":
    case "section":
    case "tableCell":
      return flowChildrenAreValid(node.children);
    case "list":
      return node.children.every((child) => child.type === "listItem" && nodeHasValidGrammar(child, false));
    case "figure":
      return node.media.every((child) => child.type === "image" && nodeHasValidGrammar(child, false)) &&
        phrasingChildrenAreValid(node.caption, false) && phrasingChildrenAreValid(node.credit, false);
    case "table":
      return (node.head === null || (node.head.type === "tableSection" && nodeHasValidGrammar(node.head, false))) &&
        node.bodies.every((section) => section.type === "tableSection" && nodeHasValidGrammar(section, false)) &&
        (node.foot === null || (node.foot.type === "tableSection" && nodeHasValidGrammar(node.foot, false))) &&
        phrasingChildrenAreValid(node.caption, false) &&
        (node.head !== null || node.bodies.length > 0 || node.foot !== null);
    case "tableSection":
      return node.children.every((child) => child.type === "tableRow" && nodeHasValidGrammar(child, false));
    case "tableRow":
      return node.children.every((child) => child.type === "tableCell" && nodeHasValidGrammar(child, false));
    case "math":
      return node.value.length > 0;
    default:
      return true;
  }
}

function collectFootnoteDefinitions(nodes: readonly ReaderV2FlowNode[], identifiers: Set<string>) {
  for (const node of nodes) {
    if (node.type === "footnoteDefinition") identifiers.add(node.identifier);
    if (node.type === "section" || node.type === "blockquote" || node.type === "footnoteDefinition") {
      collectFootnoteDefinitions(node.children, identifiers);
    } else if (node.type === "list") {
      for (const item of node.children) collectFootnoteDefinitions(item.children, identifiers);
    }
  }
}

const rawReaderDocumentV2Schema = z
  .object({
    children: z.array(readerV2NodeSchema),
    losses: z.array(z.object({
      code: nonEmptyString,
      fallback: z.enum(["children", "omitted", "text"]),
      sourcePath: nonEmptyString,
      sourceTag: nonEmptyString,
    }).strict()),
    type: z.literal("root"),
  })
  .strict()
  .superRefine((document, context) => {
    const children = document.children as ReaderV2AnyNode[];
    if (!flowChildrenAreValid(children)) {
      context.addIssue({ code: "custom", message: "Document nodes do not follow the Reader Document v2 grammar." });
    }
    const identifiers = new Set<string>();
    let definitionCount = 0;
    const countDefinitions = (nodes: readonly ReaderV2FlowNode[]) => {
      for (const node of nodes) {
        if (node.type === "footnoteDefinition") definitionCount += 1;
        if (node.type === "section" || node.type === "blockquote" || node.type === "footnoteDefinition") countDefinitions(node.children);
        else if (node.type === "list") for (const item of node.children) countDefinitions(item.children);
      }
    };
    collectFootnoteDefinitions(children.filter(isFlow), identifiers);
    countDefinitions(children.filter(isFlow));
    if (definitionCount !== identifiers.size) {
      context.addIssue({ code: "custom", message: "Footnote definition identifiers must be unique." });
    }
  });

export const readerDocumentV2Schema = rawReaderDocumentV2Schema as unknown as z.ZodType<ReaderDocumentV2>;
