// The one citation syntax Quire's agent writes, wherever its words are shown: a material id in square
// brackets right after the claim it supports — `[0123456789abcdef]` — or several sources at once as
// `[id, id]`, `[id; id]` or `[id][id]`. The stored Markdown keeps the ids (they are what the agent reads
// back and what lineage checks), and every surface resolves them for the reader: the agent panel as
// titled pills (AgentMarkdown), an artifact as numbered references with a Sources list (ArtifactCitations).

/** A material id: 16 lowercase hex characters. */
export const MATERIAL_ID = /^[a-f0-9]{16}$/;
/** One citation run: bracketed ids, comma- or semicolon-separated inside a bracket, brackets back to back. */
export const CITATION_RUN_SOURCE = String.raw`(?:\[[a-f0-9]{16}(?:\s*[,;]\s*[a-f0-9]{16})*\])+`;
const CITATION_RUN = new RegExp(CITATION_RUN_SOURCE, "g");
const ID = /[a-f0-9]{16}/g;

/** The ids of a citation run, in order, without repeats. */
export function citationIds(run: string): string[] {
  return [...new Set(run.match(ID) ?? [])];
}

/** A passage in quotation marks that ends right before the citation (whitespace or a dash / comma / colon between). */
const QUOTE_BEFORE = /[“"]([^“”"\n]+)[”"][\s,;:—–-]*$/;
export const QUOTE_MIN = 12;

/**
 * The quoted passage a citation carries: text inside “ ” or " " that ends right before it in the same
 * run of text, at least QUOTE_MIN characters once inline markup is stripped; else undefined.
 */
export function quoteBefore(text: string, index: number): string | undefined {
  const match = QUOTE_BEFORE.exec(text.slice(0, index));
  const quote = match?.[1]?.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
  return quote && quote.length >= QUOTE_MIN ? quote : undefined;
}

export interface CitationToken {
  ids: string[];
  /** The passage the citation quotes, when one ends right before it. */
  quote?: string | undefined;
}

/** A run of text split into plain strings and citations; text without citations comes back as one string. */
export function splitCitations(text: string): Array<string | CitationToken> {
  const parts: Array<string | CitationToken> = [];
  let last = 0;
  for (const match of text.matchAll(CITATION_RUN)) {
    const start = match.index ?? 0;
    // Swallow the space before the mark, as a footnote marker sits against the word it supports.
    const textEnd = start > last && text[start - 1] === " " ? start - 1 : start;
    if (textEnd > last) parts.push(text.slice(last, textEnd));
    const quote = quoteBefore(text, start);
    parts.push({ ids: citationIds(match[0]), ...(quote ? { quote } : {}) });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Markdown without fenced and inline code, where an id is code rather than a citation. */
function withoutCode(markdown: string): string {
  return markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, "").replace(/`[^`\n]*`/g, "");
}

/** The ids a document cites, each once, in the order they first appear. */
export function citedIds(markdown: string): string[] {
  const order = new Set<string>();
  for (const match of withoutCode(markdown).matchAll(CITATION_RUN)) for (const id of citationIds(match[0])) order.add(id);
  return [...order];
}

/** One numbered entry of a document's source list. */
export interface CitationSource {
  id: string;
  number: number;
  /** Cited in the text (a numbered mark points at it), not only listed as a source. */
  cited: boolean;
  /** Listed among the document's sources (its lineage), so the agent retrieved it when writing. */
  listed: boolean;
}

/**
 * A document's sources, numbered: the ids its text cites in order of first appearance, then the
 * remaining lineage ids it drew on without citing them inline.
 */
export function numberSources(markdown: string, lineage: readonly string[] = []): CitationSource[] {
  const cited = citedIds(markdown);
  const listed = new Set(lineage);
  const order = [...cited, ...lineage.filter((id) => !cited.includes(id))];
  return order.map((id, index) => ({ id, number: index + 1, cited: index < cited.length, listed: listed.has(id) }));
}
