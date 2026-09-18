import { Fragment, type ReactNode } from "react";
import { CitationPill } from "@read/ui";

// A deliberately small Markdown renderer for agent answers: headings, paragraphs, emphasis,
// inline code, fenced code, bullet and numbered lists, links, blockquotes. Anything else is a
// paragraph. `[0123456789abcdef]` (a 16-hex material id in brackets) becomes a citation pill —
// a verified one only when the turn's `sources` name it (or, for a stored turn without sources,
// when the id is in the library); otherwise an "unverified" pill that says the agent never
// retrieved it. Streaming text is rendered as it arrives, so an unterminated fence is still code.

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; lang: string; code: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string };

const FENCE = /^```\s*([\w-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  const take = (test: RegExp): string[] => {
    const out: string[] = [];
    while (index < lines.length) {
      const match = test.exec(lines[index] ?? "");
      if (!match) break;
      out.push(match[1] ?? "");
      index += 1;
    }
    return out;
  };
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) { index += 1; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index] ?? "")) { code.push(lines[index] ?? ""); index += 1; }
      index += 1;
      blocks.push({ kind: "code", lang: fence[1] ?? "", code: code.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ kind: "heading", level: (heading[1] ?? "#").length, text: heading[2] ?? "" }); index += 1; continue; }
    if (BULLET.test(line)) { blocks.push({ kind: "list", ordered: false, items: take(BULLET) }); continue; }
    if (NUMBERED.test(line)) { blocks.push({ kind: "list", ordered: true, items: take(NUMBERED) }); continue; }
    if (QUOTE.test(line)) { blocks.push({ kind: "quote", text: take(QUOTE).join(" ") }); continue; }
    const text: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (!current.trim() || FENCE.test(current) || HEADING.test(current) || BULLET.test(current) || NUMBERED.test(current) || QUOTE.test(current)) break;
      text.push(current.trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: text.join(" ") });
  }
  return blocks;
}

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[([^\]\n]+)\]\(([^)\s]+)\)|\[([a-f0-9]{16})\]|\*[^*\n]+\*|_[^_\n]+_)/g;
const CITATION = /^\[([a-f0-9]{16})\]$/;
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

export interface InlineHandlers {
  onOpenLink: (url: string) => void;
  onOpenMaterial: (id: string) => void;
  /** A title for a cited material id, when the caller knows one. */
  titleOf?: ((id: string) => string | undefined) | undefined;
  /**
   * The material ids the agent retrieved in this turn: a citation outside the list is unverified.
   * Undefined for a stored turn (no sources were kept): a citation is then verified when the library has it.
   */
  sources?: readonly string[] | undefined;
}

/** Whether a cited id can be trusted: strictly by `sources` for a live turn, by library membership otherwise. */
export function isVerifiedCitation(id: string, handlers: Pick<InlineHandlers, "sources" | "titleOf">): boolean {
  if (handlers.sources) return handlers.sources.includes(id);
  return handlers.titleOf?.(id) !== undefined;
}

const codeClass = "rounded-[4px] bg-fill px-1 py-px font-mono text-[12px] text-label";

export function renderInline(text: string, handlers: InlineHandlers): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    last = start + token.length;
    key += 1;
    const citation = CITATION.exec(token);
    const link = LINK.exec(token);
    if (citation?.[1]) {
      const id = citation[1];
      nodes.push(<CitationPill key={key} id={id} label={handlers.titleOf?.(id)} unverified={!isVerifiedCitation(id, handlers)} onPress={() => handlers.onOpenMaterial(id)} />);
    } else if (link?.[1] && link[2]) {
      const url = link[2];
      nodes.push(<a key={key} href={url} className="text-accent-text underline decoration-accent-text/40 underline-offset-2" onClick={(event) => { event.preventDefault(); handlers.onOpenLink(url); }}>{renderInline(link[1], handlers)}</a>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key} className="font-semibold">{renderInline(token.slice(2, -2), handlers)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={key} className={codeClass}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), handlers)}</em>);
    }
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function BlockView({ block, handlers }: { block: Block; handlers: InlineHandlers }) {
  switch (block.kind) {
    case "heading": {
      const size = block.level <= 2 ? "text-[14px]" : "text-[13.5px]";
      return <h4 className={`mb-1 mt-3 ${size} font-semibold leading-[19px] text-label first:mt-0`}>{renderInline(block.text, handlers)}</h4>;
    }
    case "code":
      return <pre className="my-2 max-w-full overflow-x-auto rounded-card bg-content-2 p-3 font-mono text-[12px] leading-[17px] text-label shadow-[inset_0_0_0_1px_var(--separator-soft)]" data-lang={block.lang || undefined}><code>{block.code}</code></pre>;
    case "list": {
      const items = block.items.map((item, index) => <li key={index} className="my-0.5 pl-0.5">{renderInline(item, handlers)}</li>);
      return block.ordered ? <ol className="my-1.5 list-decimal pl-5">{items}</ol> : <ul className="my-1.5 list-disc pl-5">{items}</ul>;
    }
    case "quote":
      return <blockquote className="my-2 border-l-2 border-separator pl-3 text-label-2">{renderInline(block.text, handlers)}</blockquote>;
    case "paragraph":
      return <p className="my-1.5 break-words first:mt-0 last:mb-0">{renderInline(block.text, handlers)}</p>;
  }
}

/** The agent's answer as Markdown. Links go through `onOpenLink`; `[material-id]` citations through `onOpenMaterial`. */
export function AgentMarkdown({ text, className, ...handlers }: { text: string; className?: string } & InlineHandlers) {
  const blocks = parseBlocks(text);
  return (
    <div className={`min-w-0 text-[13.5px] leading-[19px] text-label ${className ?? ""}`}>
      {blocks.map((block, index) => <Fragment key={index}><BlockView block={block} handlers={handlers} /></Fragment>)}
    </div>
  );
}
