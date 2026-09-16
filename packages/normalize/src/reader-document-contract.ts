import { z } from "zod";

export type ReaderText = { type: "text"; value: string };

type ReaderParentNodeOf<
  NodeType extends
    | "blockquote"
    | "delete"
    | "emphasis"
    | "paragraph"
    | "strong"
    | "table"
    | "tableCell"
    | "tableRow",
> = { children: ReaderNode[]; type: NodeType };

export type ReaderParentNode =
  | ReaderParentNodeOf<"blockquote">
  | ReaderParentNodeOf<"delete">
  | ReaderParentNodeOf<"emphasis">
  | ReaderParentNodeOf<"paragraph">
  | ReaderParentNodeOf<"strong">
  | ReaderParentNodeOf<"table">
  | ReaderParentNodeOf<"tableCell">
  | ReaderParentNodeOf<"tableRow">;

export type ReaderHeading = {
  children: ReaderNode[];
  depth: 1 | 2 | 3 | 4 | 5 | 6;
  type: "heading";
};

export type ReaderLink = {
  children: ReaderNode[];
  title: string | null;
  type: "link";
  url: string;
};

export type ReaderImage = {
  alt: string;
  title: string | null;
  type: "image";
  url: string;
};

export type ReaderCode = {
  lang: string | null;
  meta: string | null;
  type: "code";
  value: string;
};

export type ReaderInlineCode = { type: "inlineCode"; value: string };

export type ReaderList = {
  children: ReaderNode[];
  ordered: boolean;
  spread: boolean;
  start: number | null;
  type: "list";
};

export type ReaderListItem = {
  children: ReaderNode[];
  spread: boolean;
  type: "listItem";
};

export type ReaderVoidNode = { type: "break" | "thematicBreak" };

export type ReaderNode =
  | ReaderCode
  | ReaderHeading
  | ReaderImage
  | ReaderInlineCode
  | ReaderLink
  | ReaderList
  | ReaderListItem
  | ReaderParentNode
  | ReaderText
  | ReaderVoidNode;

export type ReaderDocument = { children: ReaderNode[]; type: "root" };

function isAllowedUrl(value: string, purpose: "image" | "link") {
  try {
    const parsed = new URL(value);
    if (purpose === "link" && parsed.protocol === "mailto:") return true;
    return ["http:", "https:"].includes(parsed.protocol) && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

const titleSchema = z.string().nullable();
const readerNodeSchema: z.ZodType<ReaderNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), value: z.string() }).strict(),
    z.object({
      children: z.array(readerNodeSchema),
      depth: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
      type: z.literal("heading"),
    }).strict(),
    z.object({ children: z.array(readerNodeSchema), type: z.literal("paragraph") }).strict(),
    z.object({ children: z.array(readerNodeSchema), type: z.literal("emphasis") }).strict(),
    z.object({ children: z.array(readerNodeSchema), type: z.literal("strong") }).strict(),
    z.object({ children: z.array(readerNodeSchema), type: z.literal("delete") }).strict(),
    z.object({ children: z.array(readerNodeSchema), title: titleSchema, type: z.literal("link"), url: z.string().refine((value) => isAllowedUrl(value, "link")) }).strict(),
    z.object({ alt: z.string(), title: titleSchema, type: z.literal("image"), url: z.string().refine((value) => isAllowedUrl(value, "image")) }).strict(),
    z.object({ lang: z.string().nullable(), meta: z.string().nullable(), type: z.literal("code"), value: z.string() }).strict(),
    z.object({ type: z.literal("inlineCode"), value: z.string() }).strict(),
    z.object({ children: z.array(readerNodeSchema), type: z.literal("blockquote") }).strict(),
    z.object({ children: z.array(readerNodeSchema), ordered: z.boolean(), spread: z.boolean(), start: z.number().int().nullable(), type: z.literal("list") }).strict(),
    z.object({ children: z.array(readerNodeSchema), spread: z.boolean(), type: z.literal("listItem") }).strict(),
    z.object({ children: z.array(readerNodeSchema), type: z.literal("table") }).strict(),
    z.object({ children: z.array(readerNodeSchema), type: z.literal("tableRow") }).strict(),
    z.object({ children: z.array(readerNodeSchema), type: z.literal("tableCell") }).strict(),
    z.object({ type: z.literal("thematicBreak") }).strict(),
    z.object({ type: z.literal("break") }).strict(),
  ]),
);

const phrasingTypes = new Set<ReaderNode["type"]>(["break", "delete", "emphasis", "image", "inlineCode", "link", "strong", "text"]);
const flowTypes = new Set<ReaderNode["type"]>(["blockquote", "code", "heading", "list", "paragraph", "table", "thematicBreak"]);

function allChildrenAre(node: ReaderNode, allowed: ReadonlySet<ReaderNode["type"]>) {
  return "children" in node && node.children.every((child) => allowed.has(child.type));
}

function hasValidGrammar(node: ReaderNode, insideLink = false): boolean {
  if (node.type === "link" && insideLink) return false;
  switch (node.type) {
    case "heading":
    case "paragraph":
    case "delete":
    case "emphasis":
    case "strong":
    case "link":
    case "tableCell":
      return allChildrenAre(node, phrasingTypes) && node.children.every((child) => hasValidGrammar(child, insideLink || node.type === "link"));
    case "blockquote":
    case "listItem":
      return allChildrenAre(node, flowTypes) && node.children.every((child) => hasValidGrammar(child));
    case "list":
      return node.children.every((child) => child.type === "listItem" && hasValidGrammar(child));
    case "table":
      return node.children.every((child) => child.type === "tableRow" && hasValidGrammar(child));
    case "tableRow":
      return node.children.every((child) => child.type === "tableCell" && hasValidGrammar(child));
    default:
      return true;
  }
}

export const readerDocumentSchema: z.ZodType<ReaderDocument> = z
  .object({ children: z.array(readerNodeSchema), type: z.literal("root") })
  .strict()
  .superRefine((document, context) => {
    if (!document.children.every((node) => flowTypes.has(node.type) && hasValidGrammar(node))) {
      context.addIssue({ code: "custom", message: "Document nodes do not follow the reader grammar." });
    }
  });
