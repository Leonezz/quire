import { parseHTML } from "linkedom";

// The captured page as text the agent can rebuild an article from: block boundaries kept as blank
// lines, headings as "#", list items as "- ", code verbatim in fences, links as [text](href).
// No extraction heuristics here; the agent decides what is the article and what is chrome.

const DROP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "IFRAME", "TEMPLATE", "HEAD"]);
const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV", "UL", "OL", "DL", "DT", "DD", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "FIGURE", "FIGCAPTION", "HR", "FORM", "FIELDSET", "DETAILS", "SUMMARY", "ADDRESS", "BODY", "HTML"]);
/** Containers whose whitespace-only text nodes are markup indentation, not content. */
const STRUCTURAL = new Set(["UL", "OL", "DL", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "SELECT"]);
const HEADING = /^H([1-6])$/;
const PLACEHOLDER = "\u0000";
const DOCUMENT_NODE = 9;
const HAS_BODY = /<body[\s>]/i;

interface DomNode { nodeType: number; data?: string; tagName?: string; childNodes: ArrayLike<DomNode>; getAttribute?: (name: string) => string | null }

function isHttp(value: string | null | undefined): value is string { return typeof value === "string" && /^https?:\/\//i.test(value); }

class Renderer {
  readonly pres: string[] = [];

  render(node: DomNode, inPre: boolean): string {
    if (node.nodeType === 3) return inPre ? (node.data ?? "") : (node.data ?? "").replace(/\s+/g, " ");
    if (node.nodeType === DOCUMENT_NODE) return this.children(node, inPre);
    if (node.nodeType !== 1 || !node.tagName) return "";
    const tag = node.tagName.toUpperCase();
    if (DROP.has(tag)) return "";
    if (tag === "BR") return "\n";
    if (tag === "PRE") {
      const code = this.children(node, true).replace(/^\n+|\n+$/g, "");
      this.pres.push(code);
      return `\n\n${PLACEHOLDER}${this.pres.length - 1}${PLACEHOLDER}\n\n`;
    }
    const inner = this.children(node, inPre);
    if (inPre) return inner;
    const heading = HEADING.exec(tag);
    if (heading) return `\n\n${"#".repeat(Number(heading[1]))} ${inner.trim()}\n\n`;
    if (tag === "LI") return `\n- ${inner.trim()}`;
    if (tag === "BLOCKQUOTE") return `\n\n${inner.trim().split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")}\n\n`;
    if (tag === "A") { const href = node.getAttribute?.("href"); const text = inner.trim(); return isHttp(href) && text ? `[${text}](${href})` : inner; }
    if (tag === "IMG") { const src = node.getAttribute?.("src"); return isHttp(src) ? `![${(node.getAttribute?.("alt") ?? "").trim()}](${src})` : ""; }
    if (tag === "TD" || tag === "TH") return `${inner.trim()} | `;
    if (BLOCK.has(tag)) return `\n\n${inner.trim()}\n\n`;
    return inner;
  }

  private children(node: DomNode, inPre: boolean): string {
    const structural = !inPre && STRUCTURAL.has(node.tagName?.toUpperCase() ?? "");
    return Array.from(node.childNodes, (child) => (structural && child.nodeType === 3 && /^\s*$/.test(child.data ?? "") ? "" : this.render(child, inPre))).join("");
  }
}

/** Readable text of a captured page, with the structure the agent needs to rebuild it. */
export function captureTextOf(html: string): string {
  const { document } = parseHTML(html);
  // linkedom synthesizes an empty <body> for fragments; without one, the document's own children are the content.
  const root = (HAS_BODY.test(html) ? document.body : document) as unknown as DomNode;
  const renderer = new Renderer();
  const raw = renderer.render(root, false);
  const tidy = raw.split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return tidy.replace(new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, "g"), (_, index: string) => `\`\`\`\n${renderer.pres[Number(index)] ?? ""}\n\`\`\``);
}
