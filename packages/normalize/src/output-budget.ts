const MAX_TRANSFORM_INPUT_BYTES = 16 * 1024 * 1024;
const TRANSFORM_INPUT_TO_OUTPUT_RATIO = 2;

function fail(errorCode: string): never {
  throw new Error(errorCode);
}

export function transformInputByteLimit(maxOutputBytes: number) {
  return Math.min(
    MAX_TRANSFORM_INPUT_BYTES,
    maxOutputBytes * TRANSFORM_INPUT_TO_OUTPUT_RATIO,
  );
}

export function utf8ByteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

const HTML_RAW_TEXT_ELEMENT_NAMES = new Set([
  "iframe",
  "noembed",
  "noframes",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);
const FOREIGN_RAW_TEXT_ELEMENT_NAMES = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);
const FALLBACK_VISIBLE_RAW_TEXT_ELEMENT_NAMES = new Set([
  "noembed",
  "noframes",
  "textarea",
  "title",
  "xmp",
]);
const VOID_ELEMENT_NAMES = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const FALLBACK_DROP_ELEMENT_NAMES = new Set([
  "canvas",
  "embed",
  "noscript",
  "object",
  "svg",
  "template",
]);
const SVG_HTML_INTEGRATION_POINT_NAMES = new Set(["desc", "foreignobject"]);
const MATHML_TEXT_INTEGRATION_POINT_NAMES = new Set([
  "mi",
  "mn",
  "mo",
  "ms",
  "mtext",
]);
const MATHML_TEXT_INTEGRATION_EXCEPTIONS = new Set([
  "malignmark",
  "mglyph",
]);
const P_ENDING_START_TAG_NAMES = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "search",
  "section",
  "table",
  "ul",
]);
const DESCRIPTION_TAG_NAMES = new Set(["dd", "dt"]);
const RUBY_TEXT_TAG_NAMES = new Set(["rp", "rt"]);
const TABLE_CELL_TAG_NAMES = new Set(["td", "th"]);
const TABLE_SECTION_TAG_NAMES = new Set(["tbody", "tfoot", "thead"]);
const DOCUMENT_CONTAINER_TAG_NAMES = new Set(["body", "html"]);
const ADOPTION_AGENCY_ELEMENT_NAMES = new Set([
  "a",
  "b",
  "big",
  "code",
  "em",
  "font",
  "i",
  "nobr",
  "s",
  "small",
  "strike",
  "strong",
  "tt",
  "u",
]);
// A list item follows the same ordinary block-boundary classification as a
// paragraph for this conservative recovery pass. `dl` and `table` are kept
// out because their parser repair rules depend on different insertion modes;
// treating them as ordinary boundaries could undercount the resulting DOM.
const LI_IMPLICIT_CLOSE_UNSAFE_TARGET_NAMES = new Set(["dl", "table"]);
// The HTML parser ignores an unmatched list-item end tag. Some generated
// table-of-contents blocks close an outer list before emitting a trailing
// `</li>`, so keeping this parse error fail-closed would reject an otherwise
// bounded document without allocating any additional DOM nodes.
const IGNORABLE_UNMATCHED_END_TAG_NAMES = new Set(["li"]);

type HtmlNamespace = "html" | "math" | "svg";
type OpenHtmlElement = {
  annotationHtml: boolean;
  name: string;
  namespace: HtmlNamespace;
};

function asciiLetter(codeUnit: number) {
  return (
    (codeUnit >= 0x41 && codeUnit <= 0x5a) ||
    (codeUnit >= 0x61 && codeUnit <= 0x7a)
  );
}

function asciiWhitespace(codeUnit: number) {
  return (
    codeUnit === 0x09 ||
    codeUnit === 0x0a ||
    codeUnit === 0x0c ||
    codeUnit === 0x0d ||
    codeUnit === 0x20
  );
}

function asciiCaseInsensitiveMatchAt(
  value: string,
  start: number,
  expected: string,
) {
  return value.slice(start, start + expected.length).toLowerCase() === expected;
}

function tagNameEnd(html: string, start: number) {
  let index = start;
  while (index < html.length) {
    const codeUnit = html.charCodeAt(index);
    if (asciiWhitespace(codeUnit) || codeUnit === 0x2f || codeUnit === 0x3e)
      break;
    index += 1;
  }
  return index;
}

function htmlNamespaceForStartTag(
  name: string,
  parent: OpenHtmlElement | undefined,
): HtmlNamespace {
  const namespaceFromHtml = () => {
    if (name === "math") return "math" as const;
    if (name === "svg") return "svg" as const;
    return "html" as const;
  };
  if (!parent || parent.namespace === "html") return namespaceFromHtml();
  if (
    parent.namespace === "svg" &&
    SVG_HTML_INTEGRATION_POINT_NAMES.has(parent.name)
  )
    return namespaceFromHtml();
  if (
    parent.namespace === "math" &&
    (parent.annotationHtml ||
      (MATHML_TEXT_INTEGRATION_POINT_NAMES.has(parent.name) &&
        !MATHML_TEXT_INTEGRATION_EXCEPTIONS.has(name)))
  )
    return namespaceFromHtml();
  return parent.namespace;
}

function closeCurrentOpenElement(
  openElements: OpenHtmlElement[],
  names: ReadonlySet<string> | string,
) {
  const current = openElements.at(-1);
  if (
    current?.namespace === "html" &&
    (typeof names === "string"
      ? current.name === names
      : names.has(current.name))
  )
    openElements.pop();
}

function applyImpliedEndTags(
  openElements: OpenHtmlElement[],
  startTagName: string,
) {
  if (startTagName === "li")
    closeCurrentOpenElement(openElements, "li");
  if (DESCRIPTION_TAG_NAMES.has(startTagName))
    closeCurrentOpenElement(openElements, DESCRIPTION_TAG_NAMES);
  if (RUBY_TEXT_TAG_NAMES.has(startTagName))
    closeCurrentOpenElement(openElements, RUBY_TEXT_TAG_NAMES);
  if (P_ENDING_START_TAG_NAMES.has(startTagName))
    closeCurrentOpenElement(openElements, "p");
  if (startTagName === "option")
    closeCurrentOpenElement(openElements, "option");
  if (startTagName === "optgroup") {
    closeCurrentOpenElement(openElements, "option");
    closeCurrentOpenElement(openElements, "optgroup");
  }
  if (startTagName === "tr") {
    closeCurrentOpenElement(openElements, TABLE_CELL_TAG_NAMES);
    closeCurrentOpenElement(openElements, "tr");
  }
  if (startTagName === "td")
    closeCurrentOpenElement(openElements, TABLE_CELL_TAG_NAMES);
  if (startTagName === "th")
    closeCurrentOpenElement(openElements, "th");
  // Do not imply section or colgroup closes here. Linkedom deliberately keeps
  // several malformed combinations nested (including tfoot -> tbody and
  // repeated colgroup), even inside a table. Retaining them is the safe upper
  // bound for the DOM this application's parser will allocate.
  if (startTagName === "button")
    closeCurrentOpenElement(openElements, "button");
}

function canCloseCurrentBeforeEndTag(currentName: string, endTagName: string) {
  if (currentName === "li")
    return (
      P_ENDING_START_TAG_NAMES.has(endTagName) &&
      !LI_IMPLICIT_CLOSE_UNSAFE_TARGET_NAMES.has(endTagName)
    );
  if (DESCRIPTION_TAG_NAMES.has(currentName)) return endTagName === "dl";
  if (RUBY_TEXT_TAG_NAMES.has(currentName)) return endTagName === "ruby";
  if (currentName === "p")
    return (
      P_ENDING_START_TAG_NAMES.has(endTagName) ||
      DOCUMENT_CONTAINER_TAG_NAMES.has(endTagName)
    );
  if (currentName === "option")
    return endTagName === "optgroup" || endTagName === "select";
  if (currentName === "optgroup") return endTagName === "select";
  if (TABLE_CELL_TAG_NAMES.has(currentName))
    return (
      endTagName === "tr" ||
      endTagName === "table" ||
      TABLE_SECTION_TAG_NAMES.has(endTagName)
    );
  if (currentName === "tr")
    return endTagName === "table" || TABLE_SECTION_TAG_NAMES.has(endTagName);
  if (TABLE_SECTION_TAG_NAMES.has(currentName)) return endTagName === "table";
  if (currentName === "colgroup") return endTagName === "table";
  return false;
}

function applyConservativeEndTag(
  openElements: OpenHtmlElement[],
  endTagName: string,
) {
  if (openElements.at(-1)?.name === endTagName) {
    openElements.pop();
    return true;
  }
  let targetIndex = -1;
  for (let index = openElements.length - 1; index >= 0; index -= 1) {
    if (openElements[index]?.name === endTagName) {
      targetIndex = index;
      break;
    }
  }
  // An end tag with nothing to close is a parse error that HTML parsers ignore;
  // real pages carry stray </div> and </p> all the time. This scanner is only a
  // pre-parse estimate: the DOM built afterwards is measured again by
  // assertDocumentBudget, so an approximate stack here cannot let an oversized
  // document through.
  if (targetIndex < 0) return true;
  while (
    openElements.length - 1 > targetIndex &&
    openElements.at(-1)?.namespace === "html" &&
    canCloseCurrentBeforeEndTag(openElements.at(-1)!.name, endTagName)
  )
    openElements.pop();
  if (openElements.at(-1)?.name !== endTagName) {
    // A formatting element closed across an element it cannot close triggers
    // the adoption agency algorithm, which clones formatting elements and can
    // grow the DOM past this estimate: that one case still fails closed.
    if (ADOPTION_AGENCY_ELEMENT_NAMES.has(endTagName)) return false;
    // Anything else is closed the way the tree builder generates implied end
    // tags before honouring the close.
    openElements.length = targetIndex;
    return true;
  }
  openElements.pop();
  return true;
}

function tagEnd(html: string, start: number) {
  let quote = 0;
  for (let index = start; index < html.length; index += 1) {
    const codeUnit = html.charCodeAt(index);
    if (quote !== 0) {
      if (codeUnit === quote) quote = 0;
      continue;
    }
    if (codeUnit === 0x22 || codeUnit === 0x27) {
      quote = codeUnit;
      continue;
    }
    if (codeUnit === 0x3e) return index;
  }
  return html.length - 1;
}

function commentEnd(html: string, start: number) {
  if (html.charCodeAt(start) === 0x3e) return start + 1;
  if (html.startsWith("->", start)) return start + 2;
  let searchFrom = start;
  while (searchFrom < html.length) {
    const hyphens = html.indexOf("--", searchFrom);
    if (hyphens < 0) return html.length;
    if (html.charCodeAt(hyphens + 2) === 0x3e) return hyphens + 3;
    if (html.startsWith("!>", hyphens + 2)) return hyphens + 4;
    searchFrom = hyphens + 2;
  }
  return html.length;
}

function declarationEnd(
  html: string,
  opening: number,
  parentIsForeign: boolean,
) {
  const declarationStart = opening + 2;
  if (asciiCaseInsensitiveMatchAt(html, declarationStart, "doctype")) {
    const delimiter = html.charCodeAt(declarationStart + 7);
    if (asciiWhitespace(delimiter) || delimiter === 0x3e)
      return tagEnd(html, declarationStart + 7) + 1;
  }
  if (parentIsForeign && html.startsWith("[CDATA[", declarationStart)) {
    const closing = html.indexOf("]]>", declarationStart + 7);
    return closing < 0 ? html.length : closing + 3;
  }
  const closing = html.indexOf(">", declarationStart);
  return closing < 0 ? html.length : closing + 1;
}

function rawTextRange(html: string, start: number, name: string) {
  let searchFrom = start;
  while (searchFrom < html.length) {
    const candidate = html.indexOf("</", searchFrom);
    if (candidate < 0)
      return { contentEnd: html.length, nextCursor: html.length };
    const nameStart = candidate + 2;
    const candidateName = html
      .slice(nameStart, nameStart + name.length)
      .toLowerCase();
    const delimiter = html.charCodeAt(nameStart + name.length);
    if (
      candidateName === name &&
      (delimiter === 0x3e ||
        delimiter === 0x2f ||
        delimiter === 0x09 ||
        delimiter === 0x0a ||
        delimiter === 0x0c ||
        delimiter === 0x0d ||
        delimiter === 0x20)
    ) {
      return {
        contentEnd: candidate,
        nextCursor: tagEnd(html, nameStart + name.length) + 1,
      };
    }
    searchFrom = candidate + 2;
  }
  return { contentEnd: html.length, nextCursor: html.length };
}

function appendBoundedFallbackText(
  parts: string[],
  value: string,
  state: { bytes: number },
  maxBytes: number,
) {
  if (state.bytes >= maxBytes) return;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return;
  if (parts.length > 0 && state.bytes < maxBytes) {
    parts.push(" ");
    state.bytes += 1;
  }
  for (const character of normalized) {
    const bytes = utf8ByteLength(character);
    if (state.bytes + bytes > maxBytes) break;
    parts.push(character);
    state.bytes += bytes;
  }
}

export function inspectHtmlStructureBeforeParse(
  html: string,
  maxDepth: number,
  maxNodes: number,
  maxFallbackTextBytes = 0,
) {
  let cursor = 0;
  let nodes = 0;
  let structureWithinBudget = true;
  const openElements: OpenHtmlElement[] = [];
  const fallbackParts: string[] = [];
  const fallbackState = { bytes: 0 };
  const suppressedCounts = new Map<string, number>();
  let suppressedElements = 0;
  const rejectStructure = () => {
    structureWithinBudget = false;
    openElements.length = 0;
  };
  const consumeNode = (depth: number) => {
    nodes += 1;
    if (
      structureWithinBudget &&
      (nodes > maxNodes || depth > maxDepth)
    )
      rejectStructure();
  };
  const pushImplicitHtmlElement = (name: string) => {
    consumeNode(openElements.length + 1);
    if (structureWithinBudget)
      openElements.push({ annotationHtml: false, name, namespace: "html" });
  };
  const insertImplicitTableParents = (startTagName: string) => {
    const current = openElements.at(-1);
    if (current?.namespace !== "html") return;
    if (
      current.name === "table" &&
      (startTagName === "tr" || TABLE_CELL_TAG_NAMES.has(startTagName))
    )
      pushImplicitHtmlElement("tbody");
    if (
      TABLE_CELL_TAG_NAMES.has(startTagName) &&
      TABLE_SECTION_TAG_NAMES.has(openElements.at(-1)?.name ?? "")
    )
      pushImplicitHtmlElement("tr");
    if (current.name === "table" && startTagName === "col")
      pushImplicitHtmlElement("colgroup");
  };
  while (cursor < html.length) {
    const opening = html.indexOf("<", cursor);
    const textEnd = opening < 0 ? html.length : opening;
    if (textEnd > cursor) consumeNode(openElements.length + 1);
    if (suppressedElements === 0)
      appendBoundedFallbackText(
        fallbackParts,
        html.slice(cursor, textEnd),
        fallbackState,
        maxFallbackTextBytes,
      );
    if (opening < 0) break;
    if (html.startsWith("<!--", opening)) {
      consumeNode(openElements.length + 1);
      cursor = commentEnd(html, opening + 4);
      continue;
    }
    const marker = html.charCodeAt(opening + 1);
    if (marker === 0x21) {
      consumeNode(openElements.length + 1);
      cursor = declarationEnd(
        html,
        opening,
        openElements.length > 0 && openElements.at(-1)?.namespace !== "html",
      );
      continue;
    }
    if (marker === 0x3f) {
      consumeNode(openElements.length + 1);
      const closing = html.indexOf(">", opening + 2);
      cursor = closing < 0 ? html.length : closing + 1;
      continue;
    }
    if (marker === 0x2f) {
      const nameStart = opening + 2;
      const nameEnd = tagNameEnd(html, nameStart);
      const name = html.slice(nameStart, nameEnd).toLowerCase();
      const suppressedCount = suppressedCounts.get(name) ?? 0;
      if (suppressedCount > 0) {
        if (suppressedCount === 1) suppressedCounts.delete(name);
        else suppressedCounts.set(name, suppressedCount - 1);
        suppressedElements -= 1;
      }
      if (
        structureWithinBudget &&
        !applyConservativeEndTag(openElements, name)
      )
        rejectStructure();
      cursor = tagEnd(html, nameEnd) + 1;
      continue;
    }
    if (!asciiLetter(marker)) {
      consumeNode(openElements.length + 1);
      cursor = opening + 1;
      continue;
    }
    const nameEnd = tagNameEnd(html, opening + 1);
    const name = html.slice(opening + 1, nameEnd).toLowerCase();
    const end = tagEnd(html, nameEnd);
    if (
      structureWithinBudget &&
      htmlNamespaceForStartTag(name, openElements.at(-1)) === "html"
    )
      applyImpliedEndTags(openElements, name);
    const namespace = htmlNamespaceForStartTag(name, openElements.at(-1));
    if (structureWithinBudget && namespace === "html")
      insertImplicitTableParents(name);
    consumeNode(openElements.length + 1);
    const isRawText =
      (namespace === "html"
        ? HTML_RAW_TEXT_ELEMENT_NAMES
        : FOREIGN_RAW_TEXT_ELEMENT_NAMES
      ).has(name);
    if (isRawText) {
      const range = rawTextRange(html, end + 1, name);
      if (range.contentEnd > end + 1)
        consumeNode(openElements.length + 2);
      if (
        suppressedElements === 0 &&
        FALLBACK_VISIBLE_RAW_TEXT_ELEMENT_NAMES.has(name)
      )
        appendBoundedFallbackText(
          fallbackParts,
          html.slice(end + 1, range.contentEnd),
          fallbackState,
          maxFallbackTextBytes,
        );
      cursor = range.nextCursor;
      continue;
    }
    let attributeEnd = end - 1;
    while (
      attributeEnd >= nameEnd &&
      asciiWhitespace(html.charCodeAt(attributeEnd))
    )
      attributeEnd -= 1;
    const selfClosing = html.charCodeAt(attributeEnd) === 0x2f;
    const remainsOpen =
      !VOID_ELEMENT_NAMES.has(name) && !(namespace !== "html" && selfClosing);
    if (remainsOpen && FALLBACK_DROP_ELEMENT_NAMES.has(name)) {
      suppressedCounts.set(name, (suppressedCounts.get(name) ?? 0) + 1);
      suppressedElements += 1;
    }
    if (structureWithinBudget && remainsOpen) {
      openElements.push({
        // Linkedom parses annotation-xml descendants as HTML regardless of
        // encoding. Treating the entire integration point conservatively as
        // HTML also avoids an entity-decoding discrepancy before DOM creation.
        annotationHtml: namespace === "math" && name === "annotation-xml",
        name,
        namespace,
      });
    }
    cursor = end + 1;
  }
  return {
    fallbackText: fallbackParts.join("").trim(),
    withinBudget: structureWithinBudget,
  };
}

export function htmlStructureWithinBudget(
  html: string,
  maxDepth: number,
  maxNodes: number,
) {
  return inspectHtmlStructureBeforeParse(html, maxDepth, maxNodes).withinBudget;
}

function jsonStringByteLength(value: string) {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c || codeUnit === 0x08 || codeUnit === 0x09 || codeUnit === 0x0a || codeUnit === 0x0c || codeUnit === 0x0d) {
      bytes += 2;
      continue;
    }
    if (codeUnit < 0x20) {
      bytes += 6;
      continue;
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      bytes += 6;
      continue;
    }
    if (codeUnit < 0x80) bytes += 1;
    else if (codeUnit < 0x800) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

function consumeJsonValue(value: unknown, budget: Utf8Budget): void {
  if (value === null) {
    budget.consumeBytes(4);
    return;
  }
  if (typeof value === "string") {
    budget.consumeBytes(jsonStringByteLength(value));
    return;
  }
  if (typeof value === "boolean") {
    budget.consumeBytes(value ? 4 : 5);
    return;
  }
  if (typeof value === "number") {
    budget.consumeBytes(Number.isFinite(value) ? String(value).length : 4);
    return;
  }
  if (Array.isArray(value)) {
    budget.consumeBytes(2 + Math.max(0, value.length - 1));
    for (const item of value) {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") budget.consumeBytes(4);
      else consumeJsonValue(item, budget);
    }
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined && typeof item !== "function" && typeof item !== "symbol");
    budget.consumeBytes(2 + Math.max(0, entries.length - 1));
    for (const [key, item] of entries) {
      budget.consumeBytes(jsonStringByteLength(key) + 1);
      consumeJsonValue(item, budget);
    }
    return;
  }
  fail(budget.errorCode);
}

export function jsonByteLengthWithin(value: unknown, maxBytes: number, errorCode: string) {
  const budget = new Utf8Budget(maxBytes, errorCode);
  consumeJsonValue(value, budget);
  return budget.usedBytes;
}

export class Utf8Budget {
  readonly errorCode: string;
  readonly maxBytes: number;
  private consumedBytes = 0;

  constructor(maxBytes: number, errorCode: string) {
    this.maxBytes = maxBytes;
    this.errorCode = errorCode;
  }

  get remainingBytes() {
    return this.maxBytes - this.consumedBytes;
  }

  get usedBytes() {
    return this.consumedBytes;
  }

  consumeBytes(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.remainingBytes) fail(this.errorCode);
    this.consumedBytes += bytes;
  }

  consumeJson(value: unknown) {
    this.consumeBytes(jsonByteLengthWithin(value, this.remainingBytes, this.errorCode));
  }

  consumeString(value: string) {
    this.consumeBytes(utf8ByteLength(value));
    return value;
  }
}
