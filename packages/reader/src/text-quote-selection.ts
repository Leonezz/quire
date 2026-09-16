export type TextQuoteCapture = Readonly<{
  locator: string;
  quote: string;
}>;

export type TextQuoteSelection =
  | Readonly<{ kind: "capture"; capture: TextQuoteCapture }>
  | Readonly<{ kind: "blocked"; reason: string }>;

export type TextQuoteLocatorHint = Readonly<{
  occurrence: number;
  position?: number;
  prefix: string;
  section?: string;
  suffix: string;
}>;

function canonicalText(value: string) {
  return value.replace(/\s+/g, "");
}

export function decodeTextQuoteLocator(locator: string) {
  const match = /^text-quote:v(?:1|2):([A-Za-z0-9+/]+={0,2})$/.exec(locator);
  if (!match) return undefined;
  try {
    const binary = globalThis.atob(match[1]);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<TextQuoteLocatorHint>;
    if (
      !Number.isSafeInteger(parsed.occurrence) ||
      (parsed.occurrence ?? -1) < 0 ||
      (parsed.position !== undefined &&
        (!Number.isSafeInteger(parsed.position) || parsed.position < 0)) ||
      typeof parsed.prefix !== "string" ||
      typeof parsed.suffix !== "string" ||
      parsed.prefix.length > 512 ||
      parsed.suffix.length > 512 ||
      (parsed.section !== undefined &&
        (typeof parsed.section !== "string" ||
          !parsed.section.trim() ||
          parsed.section.length > 256))
    )
      return undefined;
    return parsed as TextQuoteLocatorHint;
  } catch {
    return undefined;
  }
}

type TextPosition = Readonly<{ node: Text; offset: number }>;
const READER_TEXT_EXCLUSION_SELECTOR =
  "[data-footnote-ref], [data-footnote-backref], [data-reader-footnote-ref], [data-reader-footnote-backref], [data-footnotes] > h2, .reader-footnotes-heading";
const READER_TEXT_BLOCK_SELECTOR =
  "p, li, blockquote, pre, h1, h2, h3, h4, h5, h6, tr, th, td";

function semanticRangeText(range: Range) {
  const fragment = range.cloneContents();
  fragment
    .querySelectorAll(READER_TEXT_EXCLUSION_SELECTOR)
    .forEach((element) => element.remove());
  fragment
    .querySelectorAll(READER_TEXT_BLOCK_SELECTOR)
    .forEach((element) => element.append(" "));
  return fragment.textContent ?? "";
}

function isInsideReaderTextExclusion(node: Node, root: HTMLElement) {
  let element = node instanceof Element ? node : node.parentElement;
  while (element && element !== root) {
    if (element.matches(READER_TEXT_EXCLUSION_SELECTOR)) return true;
    element = element.parentElement;
  }
  return false;
}

function isReaderTextNode(node: Text, root: HTMLElement) {
  let element = node.parentElement;
  while (element && element !== root) {
    if (
      /^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(element.tagName) ||
      element.getAttribute("aria-hidden") === "true" ||
      element.matches(READER_TEXT_EXCLUSION_SELECTOR)
    )
      return false;
    element = element.parentElement;
  }
  return true;
}

/** Resolves a quote locator against the currently rendered reader DOM. */
export function resolveTextQuoteRange(
  root: HTMLElement,
  locator: string,
  quote: string,
) {
  const hint = decodeTextQuoteLocator(locator);
  const target = canonicalText(quote);
  if (!hint || !target) return undefined;
  const positions: TextPosition[] = [];
  let rendered = "";
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || !isReaderTextNode(node, root)) continue;
    const value = node.data;
    for (let offset = 0; offset < value.length; offset += 1) {
      const character = value[offset] ?? "";
      if (/\s/.test(character)) continue;
      rendered += character;
      positions.push({ node, offset });
    }
  }
  const matches: number[] = [];
  let cursor = 0;
  while ((cursor = rendered.indexOf(target, cursor)) >= 0) {
    matches.push(cursor);
    cursor += Math.max(1, target.length);
  }
  if (!matches.length) return undefined;
  const prefix = canonicalText(hint.prefix);
  const suffix = canonicalText(hint.suffix);
  const contextMatches = matches.filter((start) => {
    const before = rendered.slice(Math.max(0, start - prefix.length), start);
    const after = rendered.slice(start + target.length, start + target.length + suffix.length);
    return (!prefix || before === prefix) && (!suffix || after === suffix);
  });
  const start = matches[hint.occurrence] ??
    (contextMatches.length === 1 ? contextMatches[0] : undefined);
  if (start === undefined) return undefined;
  const end = start + target.length - 1;
  const startPosition = positions[start];
  const endPosition = positions[end];
  if (!startPosition || !endPosition) return undefined;
  const range = root.ownerDocument.createRange();
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset + 1);
  return range;
}

export function encodeTextQuoteV2Locator(hint: TextQuoteLocatorHint) {
  const section = hint.section?.replace(/\s+/g, " ").trim().slice(0, 256);
  const normalizedHint = {
    occurrence: hint.occurrence,
    ...(Number.isSafeInteger(hint.position) && (hint.position ?? -1) >= 0
      ? { position: hint.position }
      : {}),
    prefix: hint.prefix,
    ...(section ? { section } : {}),
    suffix: hint.suffix,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(normalizedHint));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `text-quote:v2:${globalThis.btoa(binary)}`;
}

function textQuoteCapture(
  quote: string,
  beforeValue: string,
  afterValue: string,
  section?: string,
): TextQuoteCapture {
  const target = canonicalText(quote);
  const before = canonicalText(beforeValue);
  const after = canonicalText(afterValue);
  let occurrence = 0;
  let cursor = 0;
  while ((cursor = before.indexOf(target, cursor)) >= 0) {
    occurrence += 1;
    cursor += Math.max(1, target.length);
  }
  return {
    locator: encodeTextQuoteV2Locator({
      occurrence,
      position: before.length,
      prefix: before.slice(-32),
      ...(section ? { section } : {}),
      suffix: after.slice(0, 32),
    }),
    quote,
  };
}

function selectedSection(root: HTMLElement, range: Range) {
  const start = range.startContainer;
  const headings = Array.from(
    root.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6"),
  );
  const path: Array<{ label: string; level: number }> = [];
  for (const heading of headings) {
    const relation = heading.compareDocumentPosition(start);
    const precedesOrContains =
      heading === start ||
      heading.contains(start) ||
      Boolean(relation & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!precedesOrContains) break;
    const clone = heading.cloneNode(true) as HTMLHeadingElement;
    clone
      .querySelectorAll(READER_TEXT_EXCLUSION_SELECTOR)
      .forEach((element) => element.remove());
    const label = clone.textContent?.replace(/\s+/g, " ").trim().slice(0, 96);
    if (!label) continue;
    const level = Number(heading.tagName.slice(1));
    while (path.at(-1) && path.at(-1)!.level >= level) path.pop();
    path.push({ label, level });
  }
  const section = path
    .slice(-3)
    .map(({ label }) => label)
    .join(" › ")
    .slice(0, 256);
  return section || undefined;
}

/** Captures a stable quote locator from the current rendered reader selection. */
export function renderedTextQuoteSelection(
  root: HTMLElement,
  selection: Selection | null,
): TextQuoteSelection {
  const blocked = (reason: string): TextQuoteSelection => ({
    kind: "blocked",
    reason,
  });
  if (!selection?.rangeCount || selection.isCollapsed)
    return blocked("Select text in this revision before capturing it.");

  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer))
    return blocked("Select text in this revision before capturing it.");
  if (isInsideReaderTextExclusion(range.commonAncestorContainer, root))
    return blocked("Select source text rather than a footnote control.");

  const quote = semanticRangeText(range).replace(/\s+/g, " ").trim();
  if (!quote)
    return blocked("Select source text in this revision before capturing it.");

  const beforeRange = root.ownerDocument.createRange();
  beforeRange.selectNodeContents(root);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const afterRange = root.ownerDocument.createRange();
  afterRange.selectNodeContents(root);
  afterRange.setStart(range.endContainer, range.endOffset);
  return {
    kind: "capture",
    capture: textQuoteCapture(
      quote,
      semanticRangeText(beforeRange),
      semanticRangeText(afterRange),
      selectedSection(root, range),
    ),
  };
}

export function textInputSelectionCapture(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null,
  context: Readonly<{ before: string; after: string; section?: string }> = {
    before: "",
    after: "",
  },
): TextQuoteCapture | undefined {
  if (
    selectionStart === null ||
    selectionEnd === null ||
    selectionStart < 0 ||
    selectionEnd <= selectionStart ||
    selectionEnd > value.length
  )
    return undefined;
  const selected = value.slice(selectionStart, selectionEnd);
  const quote = selected.trim();
  if (!quote) return undefined;
  const leadingWhitespace = selected.length - selected.trimStart().length;
  const trailingWhitespace = selected.length - selected.trimEnd().length;
  const quoteStart = selectionStart + leadingWhitespace;
  const quoteEnd = selectionEnd - trailingWhitespace;
  return textQuoteCapture(
    quote,
    `${context.before}${value.slice(0, quoteStart)}`,
    `${value.slice(quoteEnd)}${context.after}`,
    context.section,
  );
}
