import { createHash } from "node:crypto";

import type {
  ContentMaterialization,
  FeedCaptureInput,
  FeedNormalizationOutcome,
  NormalizationProblem,
  NormalizedFeedEntry,
  ProducerDetection,
} from "./model";
import { detectProducer, rssDescriptionRole } from "./profiles";
import { hasValidIriReferenceLexicalForm } from "./iri";
import { createRepresentations, sha256Identity } from "./representations";
import {
  ATOM_NAMESPACE,
  attribute,
  child,
  children,
  decodeXmlBytes,
  parseXmlDocument,
  rawText,
  serializeChildrenAsStructuredXmlText,
  serializeChildrenAsHtml,
  text,
  type XmlNode,
} from "./xml";

export { normalizeArticleCapture } from "./article";
export { normalizePdfCapture } from "./pdf";
export { createMarkdownRepresentations } from "./representations";
export type {
  NormalizedPdf,
  PdfCaptureInput,
  PdfNormalizationFailure,
  PdfNormalizationOutcome,
  PdfNormalizationSuccess,
} from "./pdf";

const CONTENT_NAMESPACE = "http://purl.org/rss/1.0/modules/content/";
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const NO_LOCAL_ATTRIBUTES = new Set<string>();

type Candidate = {
  baseUri?: string;
  content: string;
  mediaType: string;
  role: "ambiguous" | "external" | "full" | "summary";
  sourcePath: string;
};

type CandidateResult = {
  conformant: boolean;
  values: Candidate[];
  warnings: NormalizationProblem[];
};

function problem(code: string, severity: NormalizationProblem["severity"], recoverBy: NormalizationProblem["recoverBy"], scope: NormalizationProblem["scope"]): NormalizationProblem {
  return { code, recoverBy, scope, severity };
}

function safeHttpUrl(value: string, baseUri: string | undefined) {
  if (!hasValidIriReferenceLexicalForm(value)) return "";
  try {
    const parsed = new URL(value, baseUri);
    if (!(["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function resolvedIriReference(value: string, baseUri: string | undefined) {
  if (!hasValidIriReferenceLexicalForm(value)) return "";
  try {
    return new URL(value, baseUri).toString();
  } catch {
    return /^[A-Za-z][A-Za-z\d+.-]*:/u.test(value) ? value : "";
  }
}

function normalizedDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}

function validCalendarDate(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function parseAtomDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return { valid: false } as const;
  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond, offsetSign, rawOffsetHour = "0", rawOffsetMinute = "0"] = match;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond, rawOffsetHour, rawOffsetMinute].map(Number);
  if (
    !validCalendarDate(year, month, day) ||
    hour > 23 ||
    minute > 59 ||
    second > 60 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) return { valid: false } as const;
  if (second === 60) {
    const declaredOffsetMinutes = (offsetSign === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute);
    const precedingUtcSecond = new Date(Date.UTC(year, month - 1, day, hour, minute, 59) - declaredOffsetMinutes * 60_000);
    const atLeapSecondBoundary = (
      precedingUtcSecond.getUTCHours() === 23 &&
      precedingUtcSecond.getUTCMinutes() === 59 &&
      precedingUtcSecond.getUTCSeconds() === 59 &&
      ((precedingUtcSecond.getUTCMonth() === 5 && precedingUtcSecond.getUTCDate() === 30) ||
        (precedingUtcSecond.getUTCMonth() === 11 && precedingUtcSecond.getUTCDate() === 31))
    );
    return atLeapSecondBoundary
      ? { normalized: new Date(precedingUtcSecond.valueOf() + 1_000).toISOString(), valid: true } as const
      : { valid: false } as const;
  }
  const normalized = normalizedDate(value);
  return normalized ? { normalized, valid: true } as const : { valid: false } as const;
}

function parseAtomDateConstruct(node: XmlNode | undefined) {
  if (!node || !atomCommonAttributesAreValid(node, NO_LOCAL_ATTRIBUTES) || node.children.length > 0) return { valid: false } as const;
  return parseAtomDate(rawText(node));
}

const RSS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function parseRssDate(value: string) {
  const match = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), )?(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}|\d{4}) (\d{2}):(\d{2})(?::(\d{2}))? (UT|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|[A-IK-Z]|[+-]\d{4})$/u.exec(value);
  if (!match) return { valid: false } as const;
  const [, rawDay, rawMonth, rawYear, rawHour, rawMinute, rawSecond = "0", zone] = match;
  const declaredYear = Number(rawYear);
  const year = rawYear.length === 2 ? (declaredYear < 50 ? 2_000 : 1_900) + declaredYear : declaredYear;
  const month = RSS_MONTHS.indexOf(rawMonth as (typeof RSS_MONTHS)[number]) + 1;
  const day = Number(rawDay);
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const second = Number(rawSecond);
  const numericZone = /^([+-])(\d{2})(\d{2})$/u.exec(zone);
  if (
    !validCalendarDate(year, month, day) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (numericZone && (Number(numericZone[2]) > 23 || Number(numericZone[3]) > 59))
  ) return { valid: false } as const;
  const namedOffsets = { UT: 0, GMT: 0, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420, Z: 0 };
  let offsetMinutes = namedOffsets[zone as keyof typeof namedOffsets];
  if (offsetMinutes === undefined && numericZone) {
    offsetMinutes = (numericZone[1] === "-" ? -1 : 1) * (Number(numericZone[2]) * 60 + Number(numericZone[3]));
  }
  if (offsetMinutes === undefined && /^[A-IK-M]$/u.test(zone)) {
    const code = zone.charCodeAt(0);
    offsetMinutes = (code <= 73 ? code - 64 : code - 65) * 60;
  }
  if (offsetMinutes === undefined && /^[N-Y]$/u.test(zone)) offsetMinutes = -(zone.charCodeAt(0) - 77) * 60;
  if (offsetMinutes === undefined) return { valid: false } as const;
  const normalized = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000).toISOString();
  return { normalized, valid: true } as const;
}

function isAbsoluteUri(value: string) {
  return hasValidIriReferenceLexicalForm(value) && /^[A-Za-z][A-Za-z\d+.-]*:/u.test(value);
}

function isMimeMediaType(value: string) {
  const token = "[!#$%&'*+.^_`|~\\w-]+";
  const mediaType = new RegExp(`^(${token})\/(${token})(?:\\s*;\\s*${token}\\s*=\\s*(?:${token}|\"[^\"\\r\\n]*\"))*$`, "u").exec(value);
  if (!mediaType) return false;
  return Boolean(mediaType);
}

function isCompositeMimeMediaType(value: string) {
  const topLevelType = mimeEssence(value).split("/", 1)[0];
  return topLevelType === "message" || topLevelType === "multipart";
}

function isXmlMediaType(value: string) {
  const essence = mimeEssence(value);
  const subtype = essence.split("/")[1] ?? "";
  return subtype === "xml" || subtype.endsWith("+xml");
}

function mimeEssence(value: string) {
  return value.split(";", 1)[0].trim().toLowerCase();
}

function externalId(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function atomLink(entry: XmlNode) {
  for (const value of children(entry, "link", ATOM_NAMESPACE)) {
    const rel = attribute(value, "rel") ?? "alternate";
    if (rel !== "alternate") continue;
    const declaredHref = attribute(value, "href") ?? "";
    const href = safeHttpUrl(declaredHref, value.baseUri ?? entry.baseUri);
    if (href) return href;
  }
  return "";
}

function hasAtomAlternateLink(entry: XmlNode) {
  return children(entry, "link", ATOM_NAMESPACE).some((value) => {
    if ((attribute(value, "rel") ?? "alternate") !== "alternate") return false;
    const href = attribute(value, "href") ?? "";
    return hasValidIriReferenceLexicalForm(href);
  });
}

function atomAlternateLinksAreUnique(node: XmlNode) {
  const seen = new Set<string>();
  for (const link of children(node, "link", ATOM_NAMESPACE)) {
    if ((attribute(link, "rel") ?? "alternate") !== "alternate") continue;
    const key = `${(attribute(link, "type") ?? "").trim().toLowerCase()}\0${(attribute(link, "hreflang") ?? "").trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function atomRelationIsValid(value: string) {
  if (value === "" || !hasValidIriReferenceLexicalForm(value)) return false;
  if (isAbsoluteUri(value)) return true;
  for (let index = 0; index < value.length;) {
    if (value[index] === "%") {
      index += 3;
      continue;
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) return false;
    const character = String.fromCodePoint(codePoint);
    const isAsciiIsegmentCharacter = /^[A-Za-z0-9._~!$&'()*+,;=@-]$/u.test(character);
    const isUcsChar = (
      (codePoint >= 0x00a0 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xf900 && codePoint <= 0xfdcf) ||
      (codePoint >= 0xfdf0 && codePoint <= 0xffef) ||
      (codePoint >= 0x10000 && codePoint <= 0x1fffd) ||
      (codePoint >= 0x20000 && codePoint <= 0x2fffd) ||
      (codePoint >= 0x30000 && codePoint <= 0x3fffd) ||
      (codePoint >= 0x40000 && codePoint <= 0x4fffd) ||
      (codePoint >= 0x50000 && codePoint <= 0x5fffd) ||
      (codePoint >= 0x60000 && codePoint <= 0x6fffd) ||
      (codePoint >= 0x70000 && codePoint <= 0x7fffd) ||
      (codePoint >= 0x80000 && codePoint <= 0x8fffd) ||
      (codePoint >= 0x90000 && codePoint <= 0x9fffd) ||
      (codePoint >= 0xa0000 && codePoint <= 0xafffd) ||
      (codePoint >= 0xb0000 && codePoint <= 0xbfffd) ||
      (codePoint >= 0xc0000 && codePoint <= 0xcfffd) ||
      (codePoint >= 0xd0000 && codePoint <= 0xdfffd) ||
      (codePoint >= 0xe1000 && codePoint <= 0xefffd)
    );
    if (!isAsciiIsegmentCharacter && !isUcsChar) return false;
    index += character.length;
  }
  return true;
}

function atomLanguageTagIsValid(value: string) {
  return /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(value);
}

function atomCommonAttributesAreValid(node: XmlNode, allowedLocalAttributes: ReadonlySet<string>) {
  return node.attributes.every((value) => {
    if (value.namespaceUri === "") return allowedLocalAttributes.has(value.localName);
    if (value.namespaceUri === XML_NAMESPACE && value.localName === "lang") return value.value === "" || atomLanguageTagIsValid(value.value);
    return true;
  });
}

function atomLinksAreValid(node: XmlNode) {
  return children(node, "link", ATOM_NAMESPACE).every((link) => {
    const href = attribute(link, "href");
    const rel = attribute(link, "rel");
    const type = attribute(link, "type");
    const hreflang = attribute(link, "hreflang");
    return (
      atomCommonAttributesAreValid(link, new Set(["href", "hreflang", "length", "rel", "title", "type"])) &&
      href !== undefined && hasValidIriReferenceLexicalForm(href) &&
      (rel === undefined || atomRelationIsValid(rel)) &&
      (type === undefined || (type !== "" && isMimeMediaType(type))) &&
      (hreflang === undefined || atomLanguageTagIsValid(hreflang)) &&
      link.children.every((value) => value.namespaceUri !== ATOM_NAMESPACE)
    );
  });
}

function rssLink(entry: XmlNode) {
  const declaredLink = text(child(entry, "link", ""));
  if (declaredLink) return safeHttpUrl(declaredLink, entry.baseUri);
  const guid = child(entry, "guid", "");
  if (!guid || (attribute(guid, "isPermaLink") ?? "true").toLowerCase() === "false") return "";
  return safeHttpUrl(text(guid), guid.baseUri ?? entry.baseUri);
}

function hasOnlyOneXhtmlDiv(node: XmlNode) {
  const divs = children(node, "div", XHTML_NAMESPACE);
  const hasOtherElements = node.children.some((value) => value !== divs[0]);
  const hasNonWhitespaceText = node.content.some((part) => part.kind === "text" && part.value.trim() !== "");
  const onlyXhtmlDescendants = (value: XmlNode): boolean => value.children.every((descendant) => (
    descendant.namespaceUri === XHTML_NAMESPACE && onlyXhtmlDescendants(descendant)
  ));
  return divs.length === 1 && !hasOtherElements && !hasNonWhitespaceText && onlyXhtmlDescendants(divs[0]) ? divs[0] : undefined;
}

function atomTextCandidate(node: XmlNode, role: "full" | "summary", sourcePath: string): { candidate?: Candidate; valid: boolean } {
  const type = attribute(node, "type") ?? "text";
  if (!atomCommonAttributesAreValid(node, new Set(["type"]))) return { valid: false };
  if (type === "xhtml") {
    const wrapper = hasOnlyOneXhtmlDiv(node);
    const content = wrapper ? serializeChildrenAsHtml(wrapper) : "";
    if (!wrapper) return { valid: false };
    return content.trim()
      ? { candidate: { baseUri: wrapper.baseUri ?? node.baseUri, content, mediaType: "text/html", role, sourcePath }, valid: true }
      : { valid: true };
  }
  if (type !== "text" && type !== "html") return { valid: false };
  if (node.children.length > 0) return { valid: false };
  const content = text(node);
  if (!content) return { valid: true };
  return {
    candidate: { baseUri: node.baseUri, content, mediaType: type === "text" ? "text/plain" : "text/html", role, sourcePath },
    valid: true,
  };
}

function hasExactlyOneNonEmptyChild(node: XmlNode, localName: string, namespaceUri: string) {
  const values = children(node, localName, namespaceUri);
  return values.length === 1 && text(values[0]) !== "";
}

function atomIdConstructIsValid(node: XmlNode | undefined) {
  if (!node || !atomCommonAttributesAreValid(node, NO_LOCAL_ATTRIBUTES) || node.children.length > 0) return false;
  const value = rawText(node);
  return value !== "" && value === value.trim() && isAbsoluteUri(value);
}

function atomTextConstructIsValid(node: XmlNode | undefined) {
  if (!node || !atomCommonAttributesAreValid(node, new Set(["type"]))) return false;
  const type = attribute(node, "type") ?? "text";
  if (type === "xhtml") return Boolean(hasOnlyOneXhtmlDiv(node));
  return (type === "text" || type === "html") && node.children.length === 0;
}

function atomIriConstructIsValid(node: XmlNode | undefined) {
  if (!node || !atomCommonAttributesAreValid(node, NO_LOCAL_ATTRIBUTES) || node.children.length > 0) return false;
  const value = rawText(node);
  return value === value.trim() && hasValidIriReferenceLexicalForm(value);
}

function atomGeneratorIsValid(node: XmlNode | undefined) {
  if (!node || !atomCommonAttributesAreValid(node, new Set(["uri", "version"])) || node.children.length > 0) return false;
  const uri = attribute(node, "uri");
  return rawText(node).trim() !== "" && (uri === undefined || hasValidIriReferenceLexicalForm(uri));
}

function onlyAllowedAtomChildren(node: XmlNode, allowedLocalNames: ReadonlySet<string>) {
  return node.children.every((value) => value.namespaceUri !== ATOM_NAMESPACE || allowedLocalNames.has(value.localName));
}

function atomFeedEntriesFollowMetadata(feed: XmlNode) {
  let sawEntry = false;
  for (const part of feed.content) {
    if (part.kind !== "element") continue;
    const isEntry = part.value.namespaceUri === ATOM_NAMESPACE && part.value.localName === "entry";
    if (isEntry) {
      sawEntry = true;
    } else if (sawEntry) {
      return false;
    }
  }
  return true;
}

function hasOnlyWhitespaceDirectText(node: XmlNode) {
  return node.content.every((part) => part.kind === "element" || /^[\u0009\u000a\u000d\u0020]*$/u.test(part.value));
}

function atomCategoryIsValid(node: XmlNode) {
  const term = attribute(node, "term");
  const scheme = attribute(node, "scheme");
  return atomCommonAttributesAreValid(node, new Set(["label", "scheme", "term"])) &&
    term !== undefined && (scheme === undefined || isAbsoluteUri(scheme)) &&
    node.children.every((value) => value.namespaceUri !== ATOM_NAMESPACE);
}

function atomSourceIsValid(source: XmlNode) {
  const allowedChildren = new Set(["author", "category", "contributor", "generator", "icon", "id", "link", "logo", "rights", "subtitle", "title", "updated"]);
  const singletonNames = ["generator", "icon", "id", "logo", "rights", "subtitle", "title", "updated"];
  if (singletonNames.some((name) => children(source, name, ATOM_NAMESPACE).length > 1)) return false;
  const id = child(source, "id", ATOM_NAMESPACE);
  const updated = child(source, "updated", ATOM_NAMESPACE);
  const generator = child(source, "generator", ATOM_NAMESPACE);
  const icon = child(source, "icon", ATOM_NAMESPACE);
  const logo = child(source, "logo", ATOM_NAMESPACE);
  const textConstructs = ["rights", "subtitle", "title"].map((name) => child(source, name, ATOM_NAMESPACE)).filter(Boolean);
  return (
    atomCommonAttributesAreValid(source, NO_LOCAL_ATTRIBUTES) &&
    onlyAllowedAtomChildren(source, allowedChildren) &&
    (!id || atomIdConstructIsValid(id)) &&
    (!updated || parseAtomDateConstruct(updated).valid) &&
    (!generator || atomGeneratorIsValid(generator)) &&
    (!icon || atomIriConstructIsValid(icon)) &&
    (!logo || atomIriConstructIsValid(logo)) &&
    textConstructs.every(atomTextConstructIsValid) &&
    atomLinksAreValid(source) &&
    children(source, "category", ATOM_NAMESPACE).every(atomCategoryIsValid) &&
    children(source, "author", ATOM_NAMESPACE).every(atomAuthorIsValid) &&
    children(source, "contributor", ATOM_NAMESPACE).every(atomAuthorIsValid)
  );
}

function atomAuthorIsValid(node: XmlNode) {
  const names = children(node, "name", ATOM_NAMESPACE);
  const uris = children(node, "uri", ATOM_NAMESPACE);
  const emails = children(node, "email", ATOM_NAMESPACE);
  const name = names[0];
  const uri = uris[0];
  const email = emails[0];
  return (
    atomCommonAttributesAreValid(node, NO_LOCAL_ATTRIBUTES) &&
    onlyAllowedAtomChildren(node, new Set(["email", "name", "uri"])) &&
    names.length === 1 &&
    atomCommonAttributesAreValid(name, NO_LOCAL_ATTRIBUTES) &&
    name.children.length === 0 &&
    text(name) !== "" &&
    uris.length <= 1 &&
    (!uri || (atomCommonAttributesAreValid(uri, NO_LOCAL_ATTRIBUTES) && uri.children.length === 0 && hasValidIriReferenceLexicalForm(rawText(uri)))) &&
    emails.length <= 1 &&
    (!email || (atomCommonAttributesAreValid(email, NO_LOCAL_ATTRIBUTES) && email.children.length === 0 && isEmailAddrSpec(rawText(email))))
  );
}

function isEmailAddrSpec(value: string) {
  const atom = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
  const dotAtom = new RegExp(`^${atom}(?:\\.${atom})*`, "u");
  const quotedLocalPart = /^"(?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\[\x00-\x7f])*"/u;
  const domainLiteral = /^\[(?:[^\[\]\\\r\n]|\\[\x00-\x7f])+\]/u;

  let cursor = consumeEmailCfws(value, 0);
  if (cursor === undefined) return false;
  const localPart = (value[cursor] === "\"" ? quotedLocalPart : dotAtom).exec(value.slice(cursor));
  if (!localPart) return false;
  cursor = consumeEmailCfws(value, cursor + localPart[0].length);
  if (cursor === undefined || value[cursor] !== "@") return false;

  cursor = consumeEmailCfws(value, cursor + 1);
  if (cursor === undefined) return false;
  const domain = (value[cursor] === "[" ? domainLiteral : dotAtom).exec(value.slice(cursor));
  if (!domain) return false;
  cursor = consumeEmailCfws(value, cursor + domain[0].length);
  return cursor === value.length;
}

function consumeEmailCfws(value: string, start: number): number | undefined {
  let cursor = start;
  while (cursor < value.length) {
    if (value[cursor] === " " || value[cursor] === "\t") {
      cursor += 1;
      continue;
    }
    if (value[cursor] === "\n") {
      if (value[cursor + 1] !== " " && value[cursor + 1] !== "\t") return undefined;
      cursor += 1;
      continue;
    }
    if (value[cursor] !== "(") break;
    const afterComment = consumeEmailComment(value, cursor);
    if (afterComment === undefined) return undefined;
    cursor = afterComment;
  }
  return cursor;
}

function consumeEmailComment(value: string, start: number): number | undefined {
  let cursor = start + 1;
  let depth = 1;
  while (cursor < value.length) {
    const character = value[cursor];
    if (character === "\\") {
      const escaped = value.charCodeAt(cursor + 1);
      if (cursor + 1 >= value.length || escaped === 0x0a || escaped === 0x0d || escaped > 0x7f) return undefined;
      cursor += 2;
      continue;
    }
    if (character === "(") {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      cursor += 1;
      if (depth === 0) return cursor;
      continue;
    }
    if (character === "\n") {
      if (value[cursor + 1] !== " " && value[cursor + 1] !== "\t") return undefined;
      cursor += 1;
      continue;
    }
    const codePoint = value.charCodeAt(cursor);
    if (character !== "\t" && (codePoint < 0x20 || codePoint > 0x7e)) return undefined;
    cursor += 1;
  }
  return undefined;
}

function isBase64Content(value: string) {
  const trimmed = value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, "");
  if (/[\t\r ]/u.test(trimmed) || /\n{2}/u.test(trimmed)) return false;
  const compact = trimmed.replaceAll("\n", "");
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(compact);
}

function feedConformance(feed: XmlNode, dialect: "atom" | "rss", documentRoot: XmlNode) {
  if (dialect === "rss") {
    const links = children(feed, "link", "");
    return (
      attribute(documentRoot, "version") === "2.0" &&
      ["title", "link", "description"].every((name) => hasExactlyOneNonEmptyChild(feed, name, "")) &&
      links.length === 1 &&
      safeHttpUrl(text(links[0]), undefined) !== ""
    );
  }
  const updated = children(feed, "updated", ATOM_NAMESPACE);
  const authors = children(feed, "author", ATOM_NAMESPACE);
  const feedEntries = children(feed, "entry", ATOM_NAMESPACE);
  const singletonNames = ["generator", "icon", "logo", "rights", "subtitle"];
  const allowedChildren = new Set(["author", "category", "contributor", "entry", "generator", "icon", "id", "link", "logo", "rights", "subtitle", "title", "updated"]);
  const everyEntryHasOwnAuthor = feedEntries.every((entry) => {
    const entryAuthors = children(entry, "author", ATOM_NAMESPACE);
    return entryAuthors.length > 0 && entryAuthors.every(atomAuthorIsValid);
  });
  return (
    atomCommonAttributesAreValid(feed, NO_LOCAL_ATTRIBUTES) &&
    hasOnlyWhitespaceDirectText(feed) &&
    onlyAllowedAtomChildren(feed, allowedChildren) &&
    atomFeedEntriesFollowMetadata(feed) &&
    children(feed, "id", ATOM_NAMESPACE).length === 1 &&
    atomIdConstructIsValid(child(feed, "id", ATOM_NAMESPACE)) &&
    children(feed, "title", ATOM_NAMESPACE).length === 1 &&
      updated.length === 1 &&
      parseAtomDateConstruct(updated[0]).valid &&
      atomTextConstructIsValid(child(feed, "title", ATOM_NAMESPACE)) &&
      singletonNames.every((name) => children(feed, name, ATOM_NAMESPACE).length <= 1) &&
      (!child(feed, "generator", ATOM_NAMESPACE) || atomGeneratorIsValid(child(feed, "generator", ATOM_NAMESPACE))) &&
      (!child(feed, "icon", ATOM_NAMESPACE) || atomIriConstructIsValid(child(feed, "icon", ATOM_NAMESPACE))) &&
      (!child(feed, "logo", ATOM_NAMESPACE) || atomIriConstructIsValid(child(feed, "logo", ATOM_NAMESPACE))) &&
      [child(feed, "rights", ATOM_NAMESPACE), child(feed, "subtitle", ATOM_NAMESPACE)].filter(Boolean).every(atomTextConstructIsValid) &&
      atomLinksAreValid(feed) &&
      atomAlternateLinksAreUnique(feed) &&
      children(feed, "category", ATOM_NAMESPACE).every(atomCategoryIsValid) &&
      children(feed, "contributor", ATOM_NAMESPACE).every(atomAuthorIsValid) &&
      authors.every(atomAuthorIsValid) &&
      (authors.length > 0 || everyEntryHasOwnAuthor)
  );
}

function entryConformance(input: {
  candidateResult: CandidateResult;
  dialect: "atom" | "rss";
  entry: XmlNode;
  feedConformant: boolean;
  feedHasAuthor: boolean;
}) {
  const { candidateResult, dialect, entry, feedConformant, feedHasAuthor } = input;
  if (!feedConformant) return false;
  if (dialect === "rss") {
    const hasRequiredItemText = text(child(entry, "title", "")) !== "" || text(child(entry, "description", "")) !== "";
    const pubDates = children(entry, "pubDate", "");
    const links = children(entry, "link", "");
    const guids = children(entry, "guid", "");
    const guid = guids[0];
    const permalinkDeclaration = guid ? attribute(guid, "isPermaLink") : undefined;
    const permalinkValid = !guid || (
      text(guid) !== "" &&
      (permalinkDeclaration === undefined || permalinkDeclaration === "true" || permalinkDeclaration === "false") &&
      (permalinkDeclaration === "false" || safeHttpUrl(text(guid), undefined) !== "")
    );
    return (
      hasRequiredItemText &&
      pubDates.length <= 1 &&
      (!pubDates.length || parseRssDate(text(pubDates[0])).valid) &&
      links.length <= 1 &&
      (!links.length || safeHttpUrl(text(links[0]), undefined) !== "") &&
      guids.length <= 1 &&
      permalinkValid
    );
  }
  const updated = children(entry, "updated", ATOM_NAMESPACE);
  const published = children(entry, "published", ATOM_NAMESPACE);
  const entryAuthors = children(entry, "author", ATOM_NAMESPACE);
  const source = child(entry, "source", ATOM_NAMESPACE);
  const sources = children(entry, "source", ATOM_NAMESPACE);
  const rights = children(entry, "rights", ATOM_NAMESPACE);
  const sourceAuthors = source ? children(source, "author", ATOM_NAMESPACE) : [];
  const contentNodes = children(entry, "content", ATOM_NAMESPACE);
  const content = contentNodes[0];
  const summaries = children(entry, "summary", ATOM_NAMESPACE);
  const contentType = content ? attribute(content, "type") ?? "text" : "";
  const requiresSummary = Boolean(content && (
    attribute(content, "src") !== undefined ||
    (isMimeMediaType(contentType) && !mimeEssence(contentType).startsWith("text/") && !isXmlMediaType(contentType))
  ));
  const allowedChildren = new Set(["author", "category", "content", "contributor", "id", "link", "published", "rights", "source", "summary", "title", "updated"]);
  return (
    candidateResult.conformant &&
    atomCommonAttributesAreValid(entry, NO_LOCAL_ATTRIBUTES) &&
    hasOnlyWhitespaceDirectText(entry) &&
    onlyAllowedAtomChildren(entry, allowedChildren) &&
    atomLinksAreValid(entry) &&
    atomAlternateLinksAreUnique(entry) &&
    contentNodes.length <= 1 &&
    (contentNodes.length > 0 || hasAtomAlternateLink(entry)) &&
    (!requiresSummary || summaries.length === 1) &&
    children(entry, "id", ATOM_NAMESPACE).length === 1 &&
    atomIdConstructIsValid(child(entry, "id", ATOM_NAMESPACE)) &&
    children(entry, "title", ATOM_NAMESPACE).length === 1 &&
    atomTextConstructIsValid(child(entry, "title", ATOM_NAMESPACE)) &&
    updated.length === 1 &&
    parseAtomDateConstruct(updated[0]).valid &&
    published.length <= 1 &&
    (!published.length || parseAtomDateConstruct(published[0]).valid) &&
    sources.length <= 1 &&
    (!source || atomSourceIsValid(source)) &&
    rights.length <= 1 &&
    rights.every(atomTextConstructIsValid) &&
    children(entry, "category", ATOM_NAMESPACE).every(atomCategoryIsValid) &&
    children(entry, "contributor", ATOM_NAMESPACE).every(atomAuthorIsValid) &&
    entryAuthors.every(atomAuthorIsValid) &&
    sourceAuthors.every(atomAuthorIsValid) &&
    (entryAuthors.length > 0 || sourceAuthors.length > 0 || feedHasAuthor)
  );
}

function contentCandidates(entry: XmlNode, dialect: "atom" | "rss", producer: ProducerDetection, link: string): CandidateResult {
  if (dialect === "rss") {
    const values: Candidate[] = [];
    const full = child(entry, "encoded", CONTENT_NAMESPACE);
    if (full && text(full)) values.push({ baseUri: link || entry.baseUri, content: text(full), mediaType: "text/html", role: "full", sourcePath: "rss.channel.item.content:encoded" });
    const description = child(entry, "description", "");
    if (description && text(description)) {
      values.push({
        baseUri: link || entry.baseUri,
        content: text(description),
        mediaType: "text/html",
        role: rssDescriptionRole(producer.key),
        sourcePath: "rss.channel.item.description",
      });
    }
    if (link) values.push({ baseUri: link, content: link, mediaType: "text/uri-list", role: "external", sourcePath: "rss.channel.item.link" });
    return { conformant: true, values, warnings: [] };
  }

  const values: Candidate[] = [];
  const warnings: NormalizationProblem[] = [];
  let conformant = true;
  const contentNodes = children(entry, "content", ATOM_NAMESPACE);
  if (contentNodes.length > 1) {
    conformant = false;
    warnings.push(problem("SOURCE_ATOM_CONTENT_INVALID", "warning", "generic-fallback", "candidate"));
  }
  const content = contentNodes[0];
  if (content) {
    if (!atomCommonAttributesAreValid(content, new Set(["src", "type"]))) {
      conformant = false;
      warnings.push(problem("SOURCE_ATOM_CONTENT_INVALID", "warning", "generic-fallback", "candidate"));
    }
    const sourceAttribute = attribute(content, "src");
    const declaredSource = sourceAttribute ?? "";
    const validSourceReference = sourceAttribute === undefined || hasValidIriReferenceLexicalForm(declaredSource);
    const resolvedSource = sourceAttribute !== undefined ? resolvedIriReference(declaredSource, content.baseUri ?? entry.baseUri) : "";
    const source = resolvedSource ? safeHttpUrl(resolvedSource, undefined) : "";
    if (sourceAttribute !== undefined) {
      const hasInlinePayload = content.content.some((part) => part.kind === "element" || part.value.length > 0);
      const declaredType = attribute(content, "type");
      const validType = declaredType === undefined || (
        declaredType !== "" && isMimeMediaType(declaredType) && !isCompositeMimeMediaType(declaredType)
      );
      if (validSourceReference && !hasInlinePayload && validType) {
        if (source) {
          values.push({ baseUri: source, content: source, mediaType: declaredType ?? "application/octet-stream", role: "external", sourcePath: "atom.feed.entry.content@src" });
        } else {
          warnings.push(problem("SOURCE_ATOM_CONTENT_UNSUPPORTED", "warning", "acquire-linked-source", "candidate"));
        }
      } else {
        conformant = false;
        warnings.push(problem("SOURCE_ATOM_CONTENT_INVALID", "warning", "generic-fallback", "candidate"));
      }
    } else {
      const type = attribute(content, "type") ?? "text";
      if (["text", "html", "xhtml"].includes(type)) {
        const parsed = atomTextCandidate(content, "full", "atom.feed.entry.content");
        if (parsed.candidate) values.push({ ...parsed.candidate, baseUri: parsed.candidate.baseUri ?? link });
        if (!parsed.valid) {
          conformant = false;
          warnings.push(problem("SOURCE_ATOM_CONTENT_INVALID", "warning", "generic-fallback", "candidate"));
        }
      } else if (isMimeMediaType(type) && isXmlMediaType(type)) {
        const value = serializeChildrenAsStructuredXmlText(content).trim();
        if (value) {
          values.push({ baseUri: content.baseUri ?? link, content: value, mediaType: "text/plain", role: "full", sourcePath: "atom.feed.entry.content" });
        }
      } else if (isMimeMediaType(type) && mimeEssence(type).startsWith("text/")) {
        const value = text(content);
        if (content.children.length > 0) {
          conformant = false;
          warnings.push(problem("SOURCE_ATOM_CONTENT_INVALID", "warning", "generic-fallback", "candidate"));
        } else if (value) {
          values.push({
            baseUri: content.baseUri ?? link,
            content: value,
            mediaType: mimeEssence(type) === "text/html" ? "text/html" : "text/plain",
            role: "full",
            sourcePath: "atom.feed.entry.content",
          });
        }
      } else if (isMimeMediaType(type) && !isCompositeMimeMediaType(type)) {
        if (content.children.length > 0 || !isBase64Content(rawText(content))) {
          conformant = false;
          warnings.push(problem("SOURCE_ATOM_CONTENT_INVALID", "warning", "generic-fallback", "candidate"));
        } else {
          warnings.push(problem("SOURCE_ATOM_CONTENT_UNSUPPORTED", "warning", "acquire-linked-source", "candidate"));
        }
      } else {
        conformant = false;
        warnings.push(problem("SOURCE_ATOM_CONTENT_INVALID", "warning", "generic-fallback", "candidate"));
      }
    }
  }
  const summaries = children(entry, "summary", ATOM_NAMESPACE);
  if (summaries.length > 1) {
    conformant = false;
    warnings.push(problem("SOURCE_ATOM_SUMMARY_INVALID", "warning", "generic-fallback", "candidate"));
  }
  const summary = summaries[0];
  if (summary) {
    const parsed = atomTextCandidate(summary, "summary", "atom.feed.entry.summary");
    if (parsed.candidate) values.push({ ...parsed.candidate, baseUri: parsed.candidate.baseUri ?? link });
    if (!parsed.valid) {
      conformant = false;
      warnings.push(problem("SOURCE_ATOM_SUMMARY_INVALID", "warning", "generic-fallback", "candidate"));
    }
  }
  if (link) values.push({ baseUri: link, content: link, mediaType: "text/uri-list", role: "external", sourcePath: "atom.feed.entry.link[rel=alternate]" });
  return { conformant, values, warnings };
}

function rankedCandidates(values: Candidate[]) {
  const rank: Record<Candidate["role"], number> = { full: 4, ambiguous: 3, summary: 2, external: 1 };
  return [...values].sort((left, right) => rank[right.role] - rank[left.role]);
}

function serializedBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function representationProblem(error: unknown) {
  const knownCodes = new Set([
    "SOURCE_ENTRY_OUTPUT_BUDGET_EXCEEDED",
    "SOURCE_REPRESENTATION_BUDGET_EXCEEDED",
    "SOURCE_SAFE_REPRESENTATION_MISSING",
  ]);
  const code = error instanceof Error && knownCodes.has(error.message)
    ? error.message
    : "SOURCE_ENTRY_NORMALIZATION_FAILED";
  return problem(code, "warning", "plain-text-fallback", "representation");
}

function normalizeEntry(input: {
  captureIdentity: `sha256:${string}`;
  dialect: "atom" | "rss";
  entry: XmlNode;
  feedConformant: boolean;
  feedHasAuthor: boolean;
  maxDepth: number;
  maxEntryOutputBytes: number;
  maxNodes: number;
  producer: ProducerDetection;
}): NormalizedFeedEntry {
  const { captureIdentity, dialect, entry, feedConformant, feedHasAuthor, maxDepth, maxEntryOutputBytes, maxNodes, producer } = input;
  const titleNode = child(entry, "title", dialect === "atom" ? ATOM_NAMESPACE : "");
  const title = (text(titleNode) || "Untitled entry").slice(0, 500);
  const link = dialect === "atom" ? atomLink(entry) : rssLink(entry);
  const identityNode = dialect === "atom" ? child(entry, "id", ATOM_NAMESPACE) : child(entry, "guid", "");
  const declaredIdentity = dialect === "atom"
    ? atomIdConstructIsValid(identityNode) ? rawText(identityNode) : ""
    : text(identityNode);
  const atomPublishedNode = dialect === "atom" ? child(entry, "published", ATOM_NAMESPACE) ?? child(entry, "updated", ATOM_NAMESPACE) : undefined;
  const publishedAt = dialect === "atom"
    ? parseAtomDateConstruct(atomPublishedNode).normalized
    : parseRssDate(text(child(entry, "pubDate", ""))).normalized;
  const candidateResult = contentCandidates(entry, dialect, producer, link);
  const fallbackCandidate: Candidate = {
    baseUri: link || entry.baseUri,
    content: title,
    mediaType: "text/plain",
    role: "summary",
    sourcePath: "fallback.title",
  };
  const candidates = [...rankedCandidates(candidateResult.values), fallbackCandidate];
  const candidateWarnings: NormalizationProblem[] = [];

  const buildEntry = (
    selectedCandidate: Candidate,
    representationResult: ReturnType<typeof createRepresentations>,
    degradedProblem: NormalizationProblem | undefined,
  ): NormalizedFeedEntry => {
    const identityKind = declaredIdentity ? (dialect === "atom" ? "atom:id" : "rss:guid") : link ? "link" : "derived";
    const fallbackIdentity = `${title}\n${publishedAt ?? ""}\n${selectedCandidate.content}`;
    const rawIdentity = declaredIdentity || link || externalId(fallbackIdentity);
    const sourceIdentity = sha256Identity(`${identityKind}\0${rawIdentity}`);
    const sourceFingerprint = sha256Identity(JSON.stringify({
      candidate: {
        baseUri: selectedCandidate.baseUri ?? null,
        content: selectedCandidate.content,
        mediaType: selectedCandidate.mediaType,
        sourcePath: selectedCandidate.sourcePath,
      },
      dialect,
      link,
      publishedAt: publishedAt ?? null,
      sourceIdentity,
      title,
    }));
    const canonicalExternalId = externalId(rawIdentity);
    const legacyExternalIds = [rawIdentity];
    if (!declaredIdentity && !link) {
      const oldDerived = externalId(fallbackIdentity);
      if (!legacyExternalIds.includes(oldDerived)) legacyExternalIds.push(oldDerived);
    }
    const conforms = entryConformance({ candidateResult, dialect, entry, feedConformant, feedHasAuthor });
    const warnings: NormalizationProblem[] = [...candidateResult.warnings, ...candidateWarnings];
    if (selectedCandidate.role === "ambiguous") warnings.push(problem("SOURCE_CONTENT_COMPLETENESS_AMBIGUOUS", "warning", "acquire-linked-source", "candidate"));
    if (selectedCandidate.role === "external") warnings.push(problem("SOURCE_CONTENT_EXTERNAL", "warning", "acquire-linked-source", "candidate"));
    if (!declaredIdentity && !link) warnings.push(problem("SOURCE_IDENTITY_DERIVED", "warning", "none", "candidate"));
    if (!conforms && dialect === "atom") warnings.push(problem("SOURCE_ATOM_ENTRY_NONCONFORMANT", "warning", "generic-fallback", "candidate"));
    if (!conforms && dialect === "rss") warnings.push(problem("SOURCE_RSS_ITEM_NONCONFORMANT", "warning", "generic-fallback", "candidate"));
    if (degradedProblem) warnings.push(degradedProblem);
    const quality: ContentMaterialization["quality"] = {
      completeness: degradedProblem ? "none" : selectedCandidate.role === "full" ? "declared_full" : selectedCandidate.role,
      conformance: conforms ? "conformant" : "nonconformant",
      identityConfidence: declaredIdentity ? "strong" : link ? "medium" : "derived",
      safety: degradedProblem ? "degraded_plaintext" : "safe",
      warnings,
    };
    const provenance: ContentMaterialization["provenance"] = {
      captureIdentity,
      producer,
      rulesApplied: representationResult.rulesApplied,
      selectedCandidate: {
        mediaType: selectedCandidate.mediaType,
        role: selectedCandidate.role,
        sourcePath: selectedCandidate.sourcePath,
      },
    };
    const materializationBasis = JSON.stringify({
      normalizationVersion: "1",
      producer,
      quality,
      representations: representationResult.representations.map(({ contentIdentity, purpose, schema }) => ({ contentIdentity, purpose, schema })),
      rulesApplied: representationResult.rulesApplied,
      selectedCandidate: provenance.selectedCandidate,
      sourceFingerprint,
      sourceIdentity,
    });
    const materialization: ContentMaterialization = {
      identity: sha256Identity(materializationBasis),
      provenance,
      quality,
      representations: representationResult.representations,
      sourceIdentity,
    };
    return { externalId: canonicalExternalId, legacyExternalIds, link, materialization, publishedAt, sourceFingerprint, sourceIdentity, title };
  };

  let lastError: unknown = new Error("SOURCE_SAFE_REPRESENTATION_MISSING");
  for (const selectedCandidate of candidates) {
    try {
      const representationResult = createRepresentations({
        baseUri: selectedCandidate.baseUri,
        content: selectedCandidate.mediaType === "text/uri-list" ? "" : selectedCandidate.content,
        maxDepth,
        maxNodes,
        maxOutputBytes: maxEntryOutputBytes,
        mediaType: selectedCandidate.mediaType === "text/uri-list" ? "text/plain" : selectedCandidate.mediaType,
        outputBudgetErrorCode: "SOURCE_ENTRY_OUTPUT_BUDGET_EXCEEDED",
        producerEntryId: declaredIdentity || undefined,
        producerKey: producer.key,
        title,
      });
      const selection = representationResult.representations.find((value) => value.purpose === "selection");
      if (selectedCandidate.role !== "external" && selectedCandidate.sourcePath !== "fallback.title" && !selection?.content.trim()) {
        candidateWarnings.push(problem("SOURCE_CONTENT_CANDIDATE_EMPTY", "warning", "generic-fallback", "candidate"));
        continue;
      }
      const normalized = buildEntry(selectedCandidate, representationResult, undefined);
      if (serializedBytes(normalized) <= maxEntryOutputBytes) return normalized;
      lastError = new Error("SOURCE_ENTRY_OUTPUT_BUDGET_EXCEEDED");
      candidateWarnings.push(problem("SOURCE_CONTENT_CANDIDATE_REJECTED", "warning", "generic-fallback", "representation"));
      continue;
    } catch (error) {
      lastError = error;
      candidateWarnings.push(problem("SOURCE_CONTENT_CANDIDATE_REJECTED", "warning", "generic-fallback", "representation"));
      continue;
    }
  }

  const selectedCandidate = candidates[0] ?? fallbackCandidate;
  const degradedProblem = representationProblem(lastError);
  const representationResult = createRepresentations({
    content: "This item exceeded safe rendering limits. Open the source to read it.",
    maxDepth,
    maxNodes,
    maxOutputBytes: maxEntryOutputBytes,
    mediaType: "text/plain",
    outputBudgetErrorCode: "SOURCE_ENTRY_OUTPUT_BUDGET_EXCEEDED",
    producerKey: "generic",
    title,
  });
  representationResult.rulesApplied.push("generic.plain-text-fallback");
  const normalized = buildEntry(selectedCandidate, representationResult, degradedProblem);
  if (serializedBytes(normalized) <= maxEntryOutputBytes) return normalized;
  throw new Error("SOURCE_ENTRY_OUTPUT_BUDGET_EXCEEDED");
}

export function normalizeFeedCapture(input: FeedCaptureInput): FeedNormalizationOutcome {
  const budgetValues = [
    input.budget.maxBytes,
    input.budget.maxDepth,
    input.budget.maxEntries,
    input.budget.maxEntryOutputBytes,
    input.budget.maxNodes,
    input.budget.maxTotalOutputBytes,
  ];
  if (!budgetValues.every((value) => Number.isSafeInteger(value) && value > 0)) {
    return { ok: false, problems: [problem("SOURCE_BUDGET_INVALID", "fatal", "none", "capture")] };
  }
  if (input.budget.maxTotalOutputBytes < 512) {
    return { ok: false, problems: [problem("SOURCE_OUTPUT_BUDGET_INVALID", "fatal", "none", "capture")] };
  }
  const byteLength = input.capture.bytes.byteLength;
  if (!Number.isSafeInteger(byteLength) || byteLength > input.budget.maxBytes) {
    return { ok: false, problems: [problem("SOURCE_FEED_TOO_LARGE", "fatal", "none", "capture")] };
  }
  if (sha256Identity(input.capture.bytes) !== input.capture.contentIdentity) {
    return { ok: false, problems: [problem("SOURCE_CAPTURE_IDENTITY_MISMATCH", "fatal", "none", "capture")] };
  }
  try {
    const source = decodeXmlBytes(input.capture.bytes);
    const root = parseXmlDocument(source, {
      baseUri: input.capture.baseLocator,
      maxDepth: input.budget.maxDepth,
      maxNodes: input.budget.maxNodes,
    });
    const rssChannels = root.localName === "rss" && root.namespaceUri === "" ? children(root, "channel", "") : [];
    if (rssChannels.length > 1) return { ok: false, problems: [problem("SOURCE_RSS_CHANNEL_MULTIPLE", "fatal", "none", "capture")] };
    const rssChannel = rssChannels[0];
    const atomFeed = root.localName === "feed" && root.namespaceUri === ATOM_NAMESPACE ? root : undefined;
    const feed = rssChannel ?? atomFeed;
    if (!feed) return { ok: false, problems: [problem("SOURCE_UNSUPPORTED_FEED", "fatal", "none", "capture")] };
    const dialect = rssChannel ? "rss" as const : "atom" as const;
    const producer = detectProducer(feed, dialect);
    const conformsAtFeedLevel = feedConformance(feed, dialect, root);
    const feedHasAuthor = dialect === "atom" && children(feed, "author", ATOM_NAMESPACE).some(atomAuthorIsValid);
    const feedTitle = (text(child(feed, "title", dialect === "rss" ? "" : ATOM_NAMESPACE)) || new URL(input.capture.baseLocator ?? "https://invalid.local").hostname).slice(0, 500);
    const rawEntries = children(feed, dialect === "rss" ? "item" : "entry", dialect === "rss" ? "" : ATOM_NAMESPACE);
    if (rawEntries.length > input.budget.maxEntries) {
      return { ok: false, problems: [problem("SOURCE_TOO_MANY_ENTRIES", "fatal", "none", "capture")] };
    }
    if (!rawEntries.length) {
      const feedProblems = conformsAtFeedLevel ? [] : [problem(
        dialect === "atom" ? "SOURCE_ATOM_FEED_NONCONFORMANT" : "SOURCE_RSS_FEED_NONCONFORMANT",
        "warning",
        "generic-fallback",
        "capture",
      )];
      const outcome: FeedNormalizationOutcome = { feed: { entries: [], producer, title: feedTitle }, ok: true, problems: feedProblems };
      return serializedBytes(outcome) <= input.budget.maxTotalOutputBytes
        ? outcome
        : { ok: false, problems: [problem("SOURCE_FEED_OUTPUT_BUDGET_EXCEEDED", "fatal", "none", "capture")] };
    }
    const entries: NormalizedFeedEntry[] = [];
    const entryProblems: NormalizationProblem[] = [];
    const appendProblemOnce = (value: NormalizationProblem) => {
      if (!entryProblems.some((existing) => existing.code === value.code)) entryProblems.push(value);
    };
    for (const entry of rawEntries) {
      try {
        const normalized = normalizeEntry({
          captureIdentity: input.capture.contentIdentity,
          dialect,
          entry,
          feedConformant: conformsAtFeedLevel,
          feedHasAuthor,
          maxDepth: input.budget.maxDepth,
          maxEntryOutputBytes: input.budget.maxEntryOutputBytes,
          maxNodes: input.budget.maxNodes,
          producer,
        });
        entries.push(normalized);
      } catch {
        appendProblemOnce(problem("SOURCE_ENTRY_REJECTED", "warning", "acquire-linked-source", "representation"));
      }
    }
    let droppedForTotalBudget = false;
    while (entries.length) {
      const problems = droppedForTotalBudget
        ? [...entryProblems, problem("SOURCE_FEED_OUTPUT_BUDGET_EXCEEDED", "warning", "acquire-linked-source", "representation")]
        : entryProblems;
      const outcome: FeedNormalizationOutcome = { feed: { entries, producer, title: feedTitle }, ok: true, problems };
      if (serializedBytes(outcome) <= input.budget.maxTotalOutputBytes) return outcome;
      entries.pop();
      droppedForTotalBudget = true;
    }
    const failureProblems = [
      ...entryProblems,
      ...(droppedForTotalBudget ? [problem("SOURCE_FEED_OUTPUT_BUDGET_EXCEEDED", "warning", "acquire-linked-source", "representation")] : []),
      problem("SOURCE_NO_USABLE_ENTRIES", "fatal", "none", "capture"),
    ];
    const failure: FeedNormalizationOutcome = { ok: false, problems: failureProblems };
    if (serializedBytes(failure) <= input.budget.maxTotalOutputBytes) return failure;
    return { ok: false, problems: [problem("SOURCE_NO_USABLE_ENTRIES", "fatal", "none", "capture")] };
  } catch (error) {
    const code = error instanceof Error && /^SOURCE_[A-Z0-9_]+$/.test(error.message) ? error.message : "SOURCE_FEED_INVALID";
    return { ok: false, problems: [problem(code, "fatal", "none", "capture")] };
  }
}

export type {
  ArticleCaptureInput,
  ArticleNormalizationOutcome,
  ContentMaterialization,
  FeedCaptureInput,
  FeedNormalizationOutcome,
  NormalizationProblem,
  NormalizedFeedEntry,
  ProducerDetection,
} from "./model";
