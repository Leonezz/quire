import type { ArtifactType } from "../../shared/contracts";

// The editor's read of an artifact the agent just saved: the problems that make a piece less worth
// keeping, each said so the agent can fix it with artifact_update before it replies. These are notes,
// not errors; the artifact is already saved. They cover what a careful editor would flag first: a
// missing lead, headings that say nothing, filler, uncited or unquoted claims, a hand-written
// reference list, and colours that ignore the reader's theme.

const MAX_NOTES = 6;
const LONG_PARAGRAPH_WORDS = 170;
const SECTIONLESS_WORDS = 350;
const ID = /[a-f0-9]{16}/;
const CITATION = /\[[a-f0-9]{16}(?:\s*[,;]\s*[a-f0-9]{16})*\]/g;
const QUOTED_CITATION = /["“][^"”\n]{8,}["”]\s*\[[a-f0-9]{16}/g;
const GENERIC_TITLE = /^(summary|notes?|synthesis|overview|report|analysis|untitled|artifact|document|draft|总结|笔记|摘要|综述|报告|分析|草稿)$/i;
const GENERIC_HEADING = /^#{2,4}\s+(introduction|conclusions?|summary|overview|background|discussion|final thoughts|key points|引言|简介|结论|总结|概述|背景|讨论|小结)\s*$/im;
const REFERENCE_HEADING = /^#{1,6}\s+(references|sources|bibliography|works cited|citations|参考文献|参考资料|资料来源|来源|引用)\s*$/im;
const FILLER = [
  /\bit is (?:important|worth|crucial) (?:to note|noting|to remember)\b/i, /\bin conclusion\b/i, /\bin summary\b/i, /\bdelv(?:e|es|ing)\b/i,
  /\bin today's\b/i, /\bit should be noted\b/i, /\bplays? an? (?:crucial|vital|key|pivotal) role\b/i, /\ba testament to\b/i, /\bnavigat(?:e|ing) the (?:complex|ever)/i,
  /\bthis (?:document|artifact|report|summary) (?:will|aims to|explores)\b/i, /值得注意的是/, /总而言之/, /综上所述/, /总的来说/, /不难看出/, /众所周知/, /本文将/,
];
const EMOJI = /\p{Extended_Pictographic}/u;
const FIXED_TAILWIND = /\b(?:bg|text|border|from|to|via|fill|stroke|ring|divide)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/g;
const FIXED_COLOUR = /(?:color|background(?:-color)?|fill|stroke|border(?:-color)?)\s*[:=]\s*["'{]?\s*(?:#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|white\b|black\b)/gi;

function words(text: string): number {
  // CJK characters count one each; everything else by spaces.
  const cjk = text.match(/[㐀-鿿豈-﫿]/g)?.length ?? 0;
  return cjk + text.replace(/[㐀-鿿豈-﫿]/g, " ").split(/\s+/).filter(Boolean).length;
}

function first(text: string, max = 48): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function reviewMarkdown(source: string, lineage: readonly string[]): string[] {
  const notes: string[] = [];
  const body = source.replace(/^\s*#\s+[^\n]*\n/, "");
  const blocks = body.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const headings = blocks.filter((block) => /^#{2,6}\s/.test(block));
  const total = words(body);
  if (headings.length > 0 && blocks[0] && /^#{1,6}\s/.test(blocks[0])) notes.push("Open with a lead: one to three sentences under the title that give the answer or the main finding, before the first heading.");
  if (headings.length === 0 && total > SECTIONLESS_WORDS) notes.push(`It runs ${total} words without a heading; break it into sections whose headings state each section's point.`);
  const generic = GENERIC_HEADING.exec(body);
  if (generic) notes.push(`A heading like "${generic[1]}" says nothing; make each heading state its section's point (e.g. "Rerankers are the largest single gain").`);
  if (REFERENCE_HEADING.test(body)) notes.push("Remove the hand-written references section: Quire numbers the citations and appends the Sources list itself.");
  const citations = body.match(CITATION)?.length ?? 0;
  if (lineage.length > 0 && citations === 0) notes.push("No claim carries a citation: put the exact quote and [material-id] after every claim drawn from a source.");
  const quoted = body.match(QUOTED_CITATION)?.length ?? 0;
  if (citations >= 4 && quoted * 2 < citations) notes.push(`Only ${quoted} of ${citations} citations follow an exact quote; quote the words each claim rests on so the reader can jump to them.`);
  const bare = body.replace(CITATION, "").replace(/quire:material\/[a-f0-9]{16}/g, "");
  if (new RegExp(`(^|[^\\w])${ID.source}([^\\w]|$)`).test(bare)) notes.push("A material id appears outside a citation; cite only as [id] after the claim, and name materials by title in prose.");
  const filler = FILLER.map((pattern) => pattern.exec(body)?.[0]).filter((match): match is string => Boolean(match));
  if (filler.length > 0) notes.push(`Cut filler that adds nothing: ${filler.slice(0, 3).map((match) => `"${match}"`).join(", ")}.`);
  const long = blocks.find((block) => !/^(#|\||```|>|[-*+] |\d+\. )/.test(block) && words(block) > LONG_PARAGRAPH_WORDS);
  if (long) notes.push(`The paragraph starting "${first(long)}" runs ${words(long)} words; split or tighten it.`);
  if (EMOJI.test(body)) notes.push("Drop the emoji; let the headings and callouts carry the structure.");
  return notes;
}

function reviewCanvas(type: ArtifactType, source: string, lineage: readonly string[]): string[] {
  const notes: string[] = [];
  const fixed = [...new Set([...(source.match(FIXED_TAILWIND) ?? []), ...[...source.matchAll(FIXED_COLOUR)].map((match) => match[0].replace(/\s+/g, " "))])];
  if (fixed.length > 0) notes.push(`Fixed colours (${fixed.slice(0, 4).join(", ")}) will not follow the reader's light and dark themes; use ${type === "react" ? "the quire components and chart colours, or " : ""}the --quire-* variables.`);
  if (lineage.length > 0 && !/quire:material\/[a-f0-9]{16}/.test(source) && !(type === "react" && /<Cite\b/.test(source))) notes.push(`No claim links to its source; cite with ${type === "react" ? "<Cite id=\"ID\" quote=\"exact words\">" : "<a href=\"quire:material/ID\" data-quote=\"exact words\">"} so the reader can check it.`);
  if (EMOJI.test(source)) notes.push("Drop the emoji; use the icons (lucide-react) or plain labels.");
  return notes;
}

function reviewMermaid(source: string): string[] {
  const nodes = new Set(source.match(/\b[A-Za-z][\w-]*(?=\s*[[({>])/g) ?? []).size;
  return nodes > 30 ? [`The diagram has about ${nodes} nodes; split it, or keep only what carries the argument.`] : [];
}

/** What an editor would ask the agent to fix in this artifact; empty when nothing stands out. */
export function reviewArtifact(input: { type: ArtifactType; title: string; source: string; lineage: readonly string[] }): string[] {
  const { type, title, source, lineage } = input;
  const notes: string[] = [];
  if (GENERIC_TITLE.test(title.trim())) notes.push(`"${title}" is not a title a reader can find again; name the subject, and the finding when there is one.`);
  else if (title.length > 90) notes.push("Shorten the title to under 90 characters; move the detail into the lead.");
  if (type === "markdown") notes.push(...reviewMarkdown(source, lineage));
  else if (type === "html" || type === "react") notes.push(...reviewCanvas(type, source, lineage));
  else if (type === "mermaid") notes.push(...reviewMermaid(source));
  return notes.slice(0, MAX_NOTES);
}
