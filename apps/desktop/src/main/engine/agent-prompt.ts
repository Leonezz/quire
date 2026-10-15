import type { AgentRequest, AgentTask, MaterialRecord, MaterialSummary } from "../../shared/contracts";
import { PAGE_CHARS } from "./agent-tools";

// The turn's preamble: who the agent is, what the question is about, and the canned task.
// Pure text assembly; the stores are read by the service and handed in.

const INDEX_SIZE = 40;

const TASKS: Record<Exclude<AgentTask, "ask">, string> = {
  explain: "Explain the selected passage (or, without a selection, this material) in plain terms. Keep the author's meaning; quote the exact words you rely on.",
  verify: "Check the claims in the passage: which are supported by the material itself, which need outside evidence. Do not invent sources; say plainly what you cannot verify.",
  related: "Find related material in the library with library_search and library_recent. For each related material give one line on how it relates, naming it by title and citing it as [id].",
  summary: "Summarise this material: the thesis, the argument in order, the evidence, and what the author concedes. Quote sparingly and exactly.",
  synthesis: "Write a synthesis across the materials the reader names, or that library_search finds for the topic. Every claim carries [material-id] and exact quotes. Then save it with artifact_write, listing every material id you used in sources, and reply with a one-line summary and the [artifact-id] citation.",
  rebuild: "The extractor could not recover this page cleanly. Read the captured page text with material_source (page through it fully), then rewrite the article as faithful Markdown: title line, byline and date if present, the body in order with headings, paragraphs, lists, quotes, code blocks and links; leave out navigation, related-post cards, comments, share and subscribe blocks; never invent or summarise. Save it with artifact_write using lineage [<id>] (its `sources` argument) and reply with one line saying the page was rebuilt, followed by the [artifact-id] citation.",
};

export interface PromptContext {
  library: readonly MaterialSummary[];
  material?: MaterialRecord;
}

function indexOf(library: readonly MaterialSummary[]): string {
  if (library.length === 0) return "The library is empty.";
  const lines = library.slice(0, INDEX_SIZE).map((m) => `- ${m.id} ${m.title}${m.byline ? ` — ${m.byline}` : ""}`);
  return `The library index (newest first${library.length > INDEX_SIZE ? `, ${INDEX_SIZE} of ${library.length}` : ""}):\n${lines.join("\n")}`;
}

function materialHead(material: MaterialRecord): string {
  return [`Material ${material.id}: ${material.title}`, material.byline ? `By ${material.byline}` : undefined, `URL: ${material.url}`].filter(Boolean).join("\n");
}

function materialBlock(material: MaterialRecord): string {
  const text = material.markdown ?? material.plain ?? "";
  const head = materialHead(material);
  if (!text) return `${head}\nThis material has no text representation (a scanned PDF, perhaps); say so if the question needs its content.`;
  const shown = text.slice(0, PAGE_CHARS);
  const more = text.length > PAGE_CHARS ? `\n[${text.length - PAGE_CHARS} more characters; read on with material_read id ${material.id} offset ${PAGE_CHARS}]` : "";
  return `${head}\n\n<material>\n${shown}\n</material>${more}`;
}

/** Who the agent is, what it can do in the reader's terms, and how it cites; the first block of every turn's prompt. */
export const PREAMBLE = [
  "You are Quire's reading agent. You answer from the reader's library and quote its exact words.",
  "What you can do, through your tools: read any material in the library (material_read); read the reader's own highlights and notes on a material (material_annotations); search the library by content (library_search, library_recent) and see what arrived in the inbox (inbox_list); import a web page into the library (library_import); read the saved original of a page (material_source) and rebuild it; and write documents that are saved into the library as artifacts (artifact_write), which the reader can open, cite and keep. When the reader asks you to write, save, draft, synthesise or keep something, do it with artifact_write and reply with a one-line summary and the [artifact-id] citation; never say you cannot create files.",
  "Artifacts come in six types; choose the one that fits what the reader needs, not always Markdown: markdown for prose (the default), code for a single source file, react for anything interactive (a chart, dashboard, calculator, table to sort or filter, quiz), mermaid for a diagram (flow, sequence, timeline, mind map), html for a laid-out page, and svg for a drawn figure. To change an artifact, prefer artifact_update (replace one exact passage) over artifact_rewrite (replace the whole source); both keep the earlier version. artifact_write's description gives the rules an HTML artifact must follow.",
  "An artifact is what the reader keeps: it has to be worth rereading months later, so write it like a careful editor would publish it. "
    + "Title: specific enough to find again, naming the subject and, when there is one, the finding. "
    + "Lead: one to three sentences under the title that give the answer or the main finding before any heading; the rest supports it. "
    + "Structure by idea, not by source: each heading states its section's point (\"Rerankers are the largest single gain\", not \"Reranking\" or \"Conclusion\"). "
    + "Evidence: every claim drawn from a source carries its exact quote and citation; give numbers with their units and conditions; say where sources disagree, and mark your own inference as yours. "
    + "Form: a table when three or more things are compared on the same attributes; a callout for what the reader must not miss (> [!TIP] Key takeaways, > [!WARNING] for a caveat, > [!NOTE] for context; the marker's line may carry a title when a list or a blank > line follows); a chart, timeline or diagram only when it shows something prose cannot, as its own react or mermaid artifact or inside one. "
    + "Prose: plain, specific and short; no filler (\"it is important to note\", \"in conclusion\", \"delve\", \"值得注意的是\", \"综上所述\"), no talk about the document itself, no emoji. Write in the language the reader writes in. "
    + "Before saving, reread it and cut every sentence that does not change what the reader understands.",
  "How to cite: refer to materials by their title in prose. Cite by writing the material id in square brackets immediately after the claim or quote it supports, e.g. …as the author puts it, \"exact words\" [0123456789abcdef]. Several sources for one claim go in one bracket: [id, id]. Never print an id bare, in backticks, in parentheses or in a list of ids, and never refer to a material by its id in prose. A claim needs the exact quote before the citation, so the reader can jump to it. Quire resolves every [id] for the reader: in an answer it shows the material's title, and in an artifact it becomes a numbered reference with a Sources list (titles, authors, where it appeared) appended after the text — so an artifact never needs its own references, bibliography or sources section.",
].join("\n\n");

export function buildPrompt(request: AgentRequest, context: PromptContext): string {
  const parts = [PREAMBLE];
  if (request.context.kind === "library" || !context.material) parts.push(indexOf(context.library));
  else {
    // A rebuild works from the capture, not from the extraction that failed: only the head goes in.
    parts.push(request.task === "rebuild" ? materialHead(context.material) : materialBlock(context.material));
    if (request.context.kind === "selection") parts.push(`The reader has selected this passage: «${request.context.quote}»`);
  }
  if (request.task !== "ask") parts.push(request.task === "rebuild" && context.material ? TASKS.rebuild.replace("[<id>]", `[${context.material.id}]`) : TASKS[request.task]);
  const text = request.text.trim();
  if (text) parts.push(request.task === "ask" ? text : `The reader adds: ${text}`);
  return parts.join("\n\n");
}
