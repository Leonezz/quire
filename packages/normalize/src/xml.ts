import { XMLParser } from "fast-xml-parser";

import { hasValidIriReferenceLexicalForm } from "./iri";

const ATOM_NAMESPACE = "http://www.w3.org/2005/Atom";
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

// XML Namespaces 1.0 uses NCName (XML Name without a colon) for each QName
// component. Keep this lexical check here because fast-xml-parser deliberately
// accepts some names that a namespace-aware XML processor must reject.
const XML_NCNAME = /^(?:[A-Z_a-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02ff\u0370-\u037d\u037f-\u1fff\u200c-\u200d\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd\u{10000}-\u{effff}])(?:[A-Z_a-z0-9.\-\u00b7\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u037d\u037f-\u1fff\u200c-\u200d\u203f-\u2040\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd\u0300-\u036f\u{10000}-\u{effff}])*$/u;

type OrderedRecord = Record<string, unknown> & { ":@"?: Record<string, unknown> };

type XmlEncoding = "utf-16be" | "utf-16le" | "utf-8";

const XML_PREDEFINED_ENTITIES = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["quot", '"'],
]);

export type XmlAttribute = {
  localName: string;
  namespaceUri: string;
  qualifiedName: string;
  value: string;
};

export type XmlNode = {
  attributes: XmlAttribute[];
  baseUri?: string;
  children: XmlNode[];
  content: Array<{ kind: "element"; value: XmlNode } | { kind: "text"; value: string }>;
  localName: string;
  namespaceUri: string;
  qualifiedName: string;
  textParts: string[];
};

function isXmlCharacter(codePoint: number) {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function validateXmlCharacters(value: string) {
  for (const character of value) {
    if (!isXmlCharacter(character.codePointAt(0) ?? 0))
      throw new Error("SOURCE_XML_CHARACTER_INVALID");
  }
}

function decodeXmlCharacterReferences(value: string) {
  const chunks: string[] = [];
  const referencePattern = /&(?:#([0-9]+)|#x([0-9a-fA-F]+)|([A-Za-z]+));/uy;
  let cursor = 0;
  while (cursor < value.length) {
    const referenceStart = value.indexOf("&", cursor);
    if (referenceStart < 0) {
      chunks.push(value.slice(cursor));
      break;
    }
    chunks.push(value.slice(cursor, referenceStart));
    referencePattern.lastIndex = referenceStart;
    const reference = referencePattern.exec(value);
    if (!reference) throw new Error("SOURCE_XML_ENTITY_INVALID");

    const predefined = reference[3]
      ? XML_PREDEFINED_ENTITIES.get(reference[3])
      : undefined;
    let decoded = predefined;
    if (reference[1] || reference[2]) {
      const codePoint = Number.parseInt(
        reference[1] ?? reference[2],
        reference[1] ? 10 : 16,
      );
      if (!isXmlCharacter(codePoint)) throw new Error("SOURCE_XML_ENTITY_INVALID");
      decoded = String.fromCodePoint(codePoint);
    }
    if (decoded === undefined) throw new Error("SOURCE_XML_ENTITY_INVALID");
    chunks.push(decoded);
    cursor = referenceStart + reference[0].length;
  }
  return chunks.join("");
}

function splitQualifiedName(value: string) {
  const parts = value.split(":");
  if (parts.length > 2 || parts.some((part) => !XML_NCNAME.test(part))) {
    throw new Error("SOURCE_XML_NAMESPACE_INVALID");
  }
  return parts.length === 1
    ? { localName: parts[0], prefix: "" }
    : { localName: parts[1], prefix: parts[0] };
}

function sniffXmlEncoding(bytes: Uint8Array): XmlEncoding {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0x00 && bytes[1] === 0x3c && bytes[2] === 0x00 && bytes[3] === 0x3f) return "utf-16be";
  if (bytes[0] === 0x3c && bytes[1] === 0x00 && bytes[2] === 0x3f && bytes[3] === 0x00) return "utf-16le";
  return "utf-8";
}

function normalizedDeclaredEncoding(value: string): "utf-16" | XmlEncoding | "unsupported" {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "utf8" || normalized === "utf-8") return "utf-8";
  if (normalized === "utf16" || normalized === "utf-16") return "utf-16";
  if (normalized === "utf16le" || normalized === "utf-16le") return "utf-16le";
  if (normalized === "utf16be" || normalized === "utf-16be") return "utf-16be";
  return "unsupported";
}

function processingInstructions(source: string) {
  const instructions: Array<{ end: number; index: number; target: string }> = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (source.startsWith("<!--", cursor)) {
      const end = source.indexOf("-->", cursor + 4);
      cursor = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", cursor)) {
      const end = source.indexOf("]]>", cursor + 9);
      cursor = end < 0 ? source.length : end + 3;
      continue;
    }
    if (!source.startsWith("<?", cursor)) {
      cursor += 1;
      continue;
    }

    const terminator = source.indexOf("?>", cursor + 2);
    const end = terminator < 0 ? source.length : terminator + 2;
    const body = source.slice(cursor + 2, terminator < 0 ? source.length : terminator);
    const target = /^([^\t\n\r ?]+)/u.exec(body)?.[1] ?? "";
    instructions.push({ end, index: cursor, target });
    cursor = end;
  }
  return instructions;
}

function declaredXmlEncoding(source: string) {
  const instructions = processingInstructions(source);
  const declarationInstruction = instructions[0];
  const hasDeclaration = declarationInstruction?.index === 0 && declarationInstruction.target === "xml";
  if (!hasDeclaration) {
    if (instructions.some((instruction) => instruction.target.toLowerCase() === "xml")) {
      throw new Error("SOURCE_XML_DECLARATION_INVALID");
    }
    return undefined;
  }

  const declaration = /^<\?xml[\t\n\r ]+version[\t\n\r ]*=[\t\n\r ]*(?:"1\.0"|'1\.0')(?:[\t\n\r ]+encoding[\t\n\r ]*=[\t\n\r ]*(?:"([A-Za-z][A-Za-z0-9._-]*)"|'([A-Za-z][A-Za-z0-9._-]*)'))?(?:[\t\n\r ]+standalone[\t\n\r ]*=[\t\n\r ]*(?:"(?:yes|no)"|'(?:yes|no)'))?[\t\n\r ]*\?>/u.exec(source);
  if (!declaration) throw new Error("SOURCE_XML_DECLARATION_INVALID");
  if (declarationInstruction.end !== declaration[0].length) throw new Error("SOURCE_XML_DECLARATION_INVALID");
  if (instructions.slice(1).some((instruction) => instruction.target.toLowerCase() === "xml")) {
    throw new Error("SOURCE_XML_DECLARATION_INVALID");
  }
  return declaration[1] ?? declaration[2];
}

export function decodeXmlBytes(bytes: Uint8Array) {
  const encoding = sniffXmlEncoding(bytes);
  const source = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const declaredEncoding = declaredXmlEncoding(source);
  if (!declaredEncoding) return source;
  const declared = normalizedDeclaredEncoding(declaredEncoding);
  if (declared === "unsupported") throw new Error("SOURCE_XML_ENCODING_UNSUPPORTED");
  const matches = declared === encoding || (declared === "utf-16" && encoding !== "utf-8");
  if (!matches) throw new Error("SOURCE_XML_ENCODING_MISMATCH");
  return source;
}

function safeBase(value: string | undefined, parentBase: string | undefined) {
  if (value === undefined || value === "") return parentBase;
  if (!hasValidIriReferenceLexicalForm(value)) throw new Error("SOURCE_XML_BASE_INVALID");
  try {
    return new URL(value, parentBase).toString();
  } catch {
    throw new Error("SOURCE_XML_BASE_INVALID");
  }
}

function validateNamespaceBinding(prefix: string, namespaceUri: string) {
  if (namespaceUri !== "" && !hasValidIriReferenceLexicalForm(namespaceUri)) {
    throw new Error("SOURCE_XML_NAMESPACE_INVALID");
  }
  if (prefix === "xmlns" || namespaceUri === XMLNS_NAMESPACE) {
    throw new Error("SOURCE_XML_NAMESPACE_INVALID");
  }
  if (prefix === "xml") {
    if (namespaceUri !== XML_NAMESPACE) throw new Error("SOURCE_XML_NAMESPACE_INVALID");
    return;
  }
  if (namespaceUri === XML_NAMESPACE || (prefix !== "" && namespaceUri === "")) {
    throw new Error("SOURCE_XML_NAMESPACE_INVALID");
  }
}

function convertElement(
  qualifiedName: string,
  rawChildren: unknown,
  rawAttributes: Record<string, unknown> | undefined,
  inheritedNamespaces: ReadonlyMap<string, string>,
  inheritedBase: string | undefined,
  counters: { nodes: number },
  maxNodes: number,
): XmlNode {
  counters.nodes += 1;
  if (counters.nodes > maxNodes) throw new Error("SOURCE_TOO_MANY_XML_NODES");

  const namespaces = new Map(inheritedNamespaces);
  for (const [name, rawValue] of Object.entries(rawAttributes ?? {})) {
    if (name === "xmlns") {
      const namespaceUri = decodeXmlCharacterReferences(String(rawValue));
      validateNamespaceBinding("", namespaceUri);
      namespaces.set("", namespaceUri);
    } else if (name.startsWith("xmlns:")) {
      const declaredPrefix = name.slice(6);
      if (!XML_NCNAME.test(declaredPrefix)) throw new Error("SOURCE_XML_NAMESPACE_INVALID");
      const namespaceUri = decodeXmlCharacterReferences(String(rawValue));
      validateNamespaceBinding(declaredPrefix, namespaceUri);
      namespaces.set(declaredPrefix, namespaceUri);
    }
  }

  const attributes: XmlAttribute[] = [];
  const expandedAttributeNames = new Set<string>();
  for (const [name, rawValue] of Object.entries(rawAttributes ?? {})) {
    if (name === "xmlns" || name.startsWith("xmlns:")) continue;
    const { localName, prefix } = splitQualifiedName(name);
    if (prefix === "xmlns") throw new Error("SOURCE_XML_NAMESPACE_INVALID");
    if (prefix && prefix !== "xml" && !namespaces.has(prefix)) throw new Error("SOURCE_XML_NAMESPACE_UNBOUND");
    const namespaceUri = prefix === "xml" ? XML_NAMESPACE : prefix ? namespaces.get(prefix) ?? "" : "";
    const expandedAttributeName = `${namespaceUri}\u0000${localName}`;
    if (expandedAttributeNames.has(expandedAttributeName)) throw new Error("SOURCE_XML_NAMESPACE_INVALID");
    expandedAttributeNames.add(expandedAttributeName);
    attributes.push({
      localName,
      namespaceUri,
      qualifiedName: name,
      value: decodeXmlCharacterReferences(String(rawValue)),
    });
  }

  const { localName, prefix } = splitQualifiedName(qualifiedName);
  if (prefix === "xmlns") throw new Error("SOURCE_XML_NAMESPACE_INVALID");
  if (prefix && !namespaces.has(prefix)) throw new Error("SOURCE_XML_NAMESPACE_UNBOUND");
  const xmlBase = attributes.find((attribute) => attribute.namespaceUri === XML_NAMESPACE && attribute.localName === "base")?.value;
  const node: XmlNode = {
    attributes,
    baseUri: safeBase(xmlBase, inheritedBase),
    children: [],
    content: [],
    localName,
    namespaceUri: namespaces.get(prefix) ?? "",
    qualifiedName,
    textParts: [],
  };

  for (const rawChild of Array.isArray(rawChildren) ? rawChildren : []) {
    if (!rawChild || typeof rawChild !== "object") continue;
    const record = rawChild as OrderedRecord;
    for (const [name, value] of Object.entries(record)) {
      if (name === ":@") continue;
      if (name === "#text") {
        const textValue = decodeXmlCharacterReferences(String(value));
        node.textParts.push(textValue);
        node.content.push({ kind: "text", value: textValue });
        continue;
      }
      if (name === "#cdata") {
        for (const cdataPart of Array.isArray(value) ? value : []) {
          if (cdataPart && typeof cdataPart === "object" && "#text" in cdataPart) {
            const textValue = String((cdataPart as Record<string, unknown>)["#text"]);
            node.textParts.push(textValue);
            node.content.push({ kind: "text", value: textValue });
          }
        }
        continue;
      }
      if (name.startsWith("?") || name === "#comment") continue;
      const converted = convertElement(name, value, record[":@"], namespaces, node.baseUri, counters, maxNodes);
      node.children.push(converted);
      node.content.push({ kind: "element", value: converted });
    }
  }
  return node;
}

export function parseXmlDocument(source: string, input: { baseUri?: string; maxDepth: number; maxNodes: number }) {
  validateXmlCharacters(source);
  const markupOnlySource = source.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/gu, "");
  if (/<!DOCTYPE\b/i.test(markupOnlySource) || /<!ENTITY\b/i.test(markupOnlySource)) throw new Error("SOURCE_XML_DTD_FORBIDDEN");
  const parser = new XMLParser({
    attributeNamePrefix: "",
    cdataPropName: "#cdata",
    ignoreAttributes: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    maxNestedTags: input.maxDepth,
    parseAttributeValue: false,
    parseTagValue: false,
    preserveOrder: true,
    processEntities: false,
    trimValues: false,
  });
  const ordered = parser.parse(source, true) as OrderedRecord[];
  const documentElements = ordered.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    return Object.keys(value)
      .filter((name) => name !== ":@" && !name.startsWith("?") && !name.startsWith("#"))
      .map((name) => ({ name, record: value }));
  });
  if (!documentElements.length) throw new Error("SOURCE_XML_ROOT_MISSING");
  if (documentElements.length > 1) throw new Error("SOURCE_XML_MULTIPLE_ROOTS");
  const [{ name: rootName, record: rootRecord }] = documentElements;
  return convertElement(rootName, rootRecord[rootName], rootRecord[":@"], new Map([["xml", XML_NAMESPACE]]), input.baseUri, { nodes: 0 }, input.maxNodes);
}

export function children(node: XmlNode, localName: string, namespaceUri?: string) {
  return node.children.filter((child) => child.localName === localName && (namespaceUri === undefined || child.namespaceUri === namespaceUri));
}

export function child(node: XmlNode, localName: string, namespaceUri?: string) {
  return children(node, localName, namespaceUri)[0];
}

export function attribute(node: XmlNode, localName: string, namespaceUri = "") {
  return node.attributes.find((value) => value.localName === localName && value.namespaceUri === namespaceUri)?.value;
}

export function text(node: XmlNode | undefined): string {
  if (!node) return "";
  return rawText(node).trim();
}

export function rawText(node: XmlNode | undefined): string {
  if (!node) return "";
  return node.content.map((part) => part.kind === "text" ? part.value : rawText(part.value)).join("");
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function expandedName(localName: string, namespaceUri: string) {
  return namespaceUri ? `{${namespaceUri}}${localName}` : localName;
}

export function serializeChildrenAsStructuredXmlText(node: XmlNode) {
  const serialize = (value: XmlNode): string => {
    const name = expandedName(value.localName, value.namespaceUri);
    const attributes = value.attributes
      .map((item) => ` ${expandedName(item.localName, item.namespaceUri)}="${escapeHtml(item.value)}"`)
      .join("");
    if (value.content.length === 0) return `<${name}${attributes}/>`;
    const content = value.content
      .map((part) => part.kind === "text" ? escapeHtml(part.value) : serialize(part.value))
      .join("");
    return `<${name}${attributes}>${content}</${name}>`;
  };
  return node.content.map((part) => part.kind === "text" ? escapeHtml(part.value) : serialize(part.value)).join("");
}

export function serializeChildrenAsHtml(node: XmlNode) {
  const serialize = (value: XmlNode): string => {
    if (value.namespaceUri !== XHTML_NAMESPACE) return "";
    const attributes = value.attributes
      .filter((item) => item.namespaceUri !== XML_NAMESPACE || item.localName !== "base")
      .map((item) => {
        let attributeValue = item.value;
        if (["href", "src"].includes(item.localName) && value.baseUri) {
          try {
            attributeValue = new URL(attributeValue, value.baseUri).toString();
          } catch {}
        }
        return ` ${item.localName}="${escapeHtml(attributeValue)}"`;
      })
      .join("");
    const content = value.content.map((part) => part.kind === "text" ? escapeHtml(part.value) : serialize(part.value)).join("");
    return `<${value.localName}${attributes}>${content}</${value.localName}>`;
  };
  return node.content.map((part) => part.kind === "text" ? escapeHtml(part.value) : serialize(part.value)).join("");
}

export { ATOM_NAMESPACE, XHTML_NAMESPACE, XML_NAMESPACE };
