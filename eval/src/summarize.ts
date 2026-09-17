// Structure summary of one normalized article: the shape a reviewer checks against the page.
import type { ArticleNormalizationOutcome } from "@read/normalize";

export interface ElementCounts {
  headings: Record<string, number>;
  paragraphs: number;
  words: number;
  codeBlocks: number;
  inlineCode: number;
  mathBlocks: number;
  mathInline: number;
  tables: number;
  images: number;
  figures: number;
  blockquotes: number;
  lists: number;
  footnotes: number;
  links: number;
}

export interface Summary {
  ok: boolean;
  title: string;
  byline: string | null;
  publishedAt: string | null;
  lang: string | null;
  extractor: string;
  quality: { completeness: string; conformance: string; safety: string };
  problems: string[];
  losses: number;
  counts: ElementCounts;
  headings: string[];
  first: string;
  last: string;
}

type Node = Record<string, unknown> & { type: string };
const CHILD_KEYS = ["children", "caption", "credit", "media", "bodies", "head", "foot"] as const;

function* walk(node: Node): Generator<Node> {
  yield node;
  for (const key of CHILD_KEYS) {
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) yield* walk(child as Node);
    else if (value && typeof value === "object") yield* walk(value as Node);
  }
}

function textOf(node: Node): string {
  if (node.type === "text" || node.type === "inlineCode") return String(node.value ?? "");
  const children = node.children;
  return Array.isArray(children) ? children.map((child) => textOf(child as Node)).join("") : "";
}

/** Words for Latin scripts, characters for CJK: both count toward "how much text is there". */
function wordCount(text: string): number {
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
  const latin = text.replace(/[㐀-鿿豈-﫿]/g, " ").split(/\s+/).filter(Boolean).length;
  return cjk + latin;
}

const clip = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 90);

export function summarize(outcome: ArticleNormalizationOutcome): Summary {
  const empty: ElementCounts = { headings: {}, paragraphs: 0, words: 0, codeBlocks: 0, inlineCode: 0, mathBlocks: 0, mathInline: 0, tables: 0, images: 0, figures: 0, blockquotes: 0, lists: 0, footnotes: 0, links: 0 };
  if (!outcome.ok) {
    return { ok: false, title: "", byline: null, publishedAt: null, lang: null, extractor: "", quality: { completeness: "none", conformance: "nonconformant", safety: "rejected" }, problems: outcome.problems.map((p) => p.code), losses: 0, counts: empty, headings: [], first: clip(outcome.fallbackText ?? ""), last: "" };
  }
  const { article } = outcome;
  const v2 = article.materialization.representations.find((r) => r.schema === "reader.document.v2");
  const root = v2 ? (JSON.parse(v2.content) as Node & { losses?: unknown[] }) : ({ type: "root", children: [] } as Node);
  const counts: ElementCounts = { ...empty, headings: {} };
  const headings: string[] = [];
  const paragraphs: string[] = [];
  for (const node of walk(root)) {
    switch (node.type) {
      case "heading": { const key = `h${String(node.depth)}`; counts.headings[key] = (counts.headings[key] ?? 0) + 1; headings.push(clip(textOf(node))); break; }
      case "paragraph": { counts.paragraphs += 1; const text = textOf(node); counts.words += wordCount(text); if (text.trim()) paragraphs.push(text); break; }
      case "code": counts.codeBlocks += 1; break;
      case "inlineCode": counts.inlineCode += 1; break;
      case "math": if (node.display) counts.mathBlocks += 1; else counts.mathInline += 1; break;
      case "table": counts.tables += 1; break;
      case "image": counts.images += 1; break;
      case "figure": counts.figures += 1; break;
      case "blockquote": counts.blockquotes += 1; break;
      case "list": counts.lists += 1; break;
      case "footnoteDefinition": counts.footnotes += 1; break;
      case "link": counts.links += 1; break;
      default: break;
    }
  }
  const rules = article.materialization.provenance.rulesApplied;
  const extractor = rules.find((rule) => rule.startsWith("article.site-adapter")) ?? rules.find((rule) => rule.startsWith("article.extractor")) ?? article.materialization.provenance.selectedCandidate.sourcePath;
  const q = article.materialization.quality;
  return {
    ok: true,
    title: article.title,
    byline: article.byline ?? null,
    publishedAt: article.publishedAt ?? null,
    lang: article.lang ?? null,
    extractor,
    quality: { completeness: q.completeness, conformance: q.conformance, safety: q.safety },
    problems: outcome.problems.map((p) => p.code),
    losses: Array.isArray(root.losses) ? root.losses.length : 0,
    counts,
    headings: headings.slice(0, 40),
    first: clip(paragraphs[0] ?? ""),
    last: clip(paragraphs.at(-1) ?? ""),
  };
}

/** Heuristic review flags: what a human would look at first. Empty means "looks like an article". */
export function reviewFlags(summary: Summary, tags: readonly string[]): string[] {
  const flags: string[] = [];
  if (!summary.ok) return [`P0 extraction failed: ${summary.problems.join(", ") || "no problem code"}`];
  if (summary.quality.safety !== "safe") flags.push(`P0 safety ${summary.quality.safety}`);
  if (summary.counts.words < 150) flags.push(`P0 body too short (${summary.counts.words} words)`);
  if (!summary.title) flags.push("no title");
  if (!summary.publishedAt) flags.push("no date");
  if (!summary.byline) flags.push("no byline");
  const noise = /^(share|subscribe|comments?|related|sign in|log in|menu|newsletter|search|table of contents|footer|discussion)/i;
  const noisy = summary.headings.filter((h) => noise.test(h));
  if (noisy.length) flags.push(`nav-like headings: ${noisy.slice(0, 3).join(" | ")}`);
  if (summary.counts.paragraphs > 0 && summary.counts.links / summary.counts.paragraphs > 3) flags.push("link-dense (nav residue?)");
  if (tags.includes("code") && summary.counts.codeBlocks === 0) flags.push("expected code blocks, found none");
  if (tags.includes("math") && summary.counts.mathBlocks + summary.counts.mathInline === 0) flags.push("expected math, found none");
  if (tags.includes("tables") && summary.counts.tables === 0) flags.push("expected tables, found none");
  if (tags.includes("images") && summary.counts.images + summary.counts.figures === 0) flags.push("expected images, found none");
  if (tags.includes("footnotes") && summary.counts.footnotes === 0) flags.push("expected footnotes, found none");
  if (summary.losses > 0) flags.push(`${summary.losses} lossy conversions`);
  return flags;
}

/** Field-level diff between a golden and the current summary; empty means identical. */
export function diffSummaries(golden: Summary, current: Summary): string[] {
  const out: string[] = [];
  const scalar = (key: keyof Summary) => { if (JSON.stringify(golden[key]) !== JSON.stringify(current[key])) out.push(`${key}: ${JSON.stringify(golden[key])} → ${JSON.stringify(current[key])}`); };
  (["ok", "title", "byline", "publishedAt", "lang", "extractor", "quality", "problems", "losses", "first", "last"] as const).forEach(scalar);
  for (const key of Object.keys({ ...golden.counts, ...current.counts }) as (keyof ElementCounts)[]) {
    if (JSON.stringify(golden.counts[key]) !== JSON.stringify(current.counts[key])) out.push(`counts.${key}: ${JSON.stringify(golden.counts[key])} → ${JSON.stringify(current.counts[key])}`);
  }
  if (JSON.stringify(golden.headings) !== JSON.stringify(current.headings)) out.push(`headings: ${golden.headings.length} → ${current.headings.length}`);
  return out;
}
