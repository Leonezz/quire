import { parseHTML } from "linkedom";

const DECORATION_CLASSES = new Set([
  "code",
  "highlight",
  "highlighttable",
  "line",
  "notranslate",
  "sourcecode",
]);

function classNames(element: Element) {
  return Array.from(element.classList, (value) => value.toLowerCase());
}

function languageFrom(element: Element, pre: Element) {
  for (const candidate of [pre, element]) {
    for (const value of classNames(candidate)) {
      const match = /^(?:lang|language)-(.+)$/u.exec(value);
      if (match?.[1]) return match[1];
    }
  }
  const candidates = classNames(element).filter(
    (value) =>
      !DECORATION_CLASSES.has(value) && /^[a-z][a-z0-9_+-]{0,31}$/u.test(value),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function textWithBreaks(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeType === 1 && (node as Element).tagName.toLowerCase() === "br")
    return "\n";
  return Array.from(node.childNodes, (child) => textWithBreaks(child)).join("");
}

function codeText(pre: Element) {
  const lines = Array.from(pre.children).filter((child) =>
    child.classList.contains("line"),
  );
  const value = lines.length
    ? lines.map((line) => line.textContent ?? "").join("\n")
    : textWithBreaks(pre);
  return value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) =>
      line.replace(/^[\t \u00a0]+/u, (indentation) =>
        indentation.replaceAll("\u00a0", " "),
      ),
    )
    .join("\n")
    .replace(/\n$/u, "");
}

export function normalizeSyntaxHighlightingHtml(html: string) {
  const document = parseHTML(`<html><body>${html}</body></html>`).document;
  let replacements = 0;

  for (const wrapper of Array.from(
    document.body.querySelectorAll("figure.highlight, div.highlight"),
  )) {
    const tables = Array.from(wrapper.querySelectorAll("table"));
    if (tables.length !== 1) continue;
    const table = tables[0];
    const captions = Array.from(wrapper.children).filter(
      (child) => child.tagName.toLowerCase() === "figcaption",
    );
    if (
      captions.length > 1 ||
      Array.from(wrapper.children).some(
        (child) => child !== table && !captions.includes(child),
      )
    )
      continue;

    const cells = Array.from(table.querySelectorAll("td, th"));
    const codeCells = cells.filter((cell) => cell.classList.contains("code"));
    if (
      codeCells.length !== 1 ||
      cells.some(
        (cell) => cell !== codeCells[0] && !cell.classList.contains("gutter"),
      )
    )
      continue;

    const preElements = Array.from(codeCells[0].querySelectorAll("pre"));
    if (preElements.length !== 1) continue;
    const source = codeText(preElements[0]);
    if (!source.trim()) continue;

    const pre = document.createElement("pre");
    const code = document.createElement("code");
    const language = languageFrom(wrapper, preElements[0]);
    if (language) code.classList.add(`language-${language}`);
    code.textContent = source;
    pre.append(code);
    if (captions.length) table.replaceWith(pre);
    else wrapper.replaceWith(pre);
    replacements += 1;
  }

  return {
    html: replacements > 0 ? document.body.innerHTML : html,
    replacements,
  };
}
