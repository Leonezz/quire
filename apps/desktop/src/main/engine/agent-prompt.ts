import type { AgentRequest, AgentTask, MaterialRecord, MaterialSummary } from "../../shared/contracts";
import { PAGE_CHARS } from "./agent-tools";

// The turn's preamble: who the agent is, what the question is about, and the canned task.
// Pure text assembly; the stores are read by the service and handed in.

const INDEX_SIZE = 40;

const TASKS: Record<Exclude<AgentTask, "ask">, string> = {
  explain: "Explain the selected passage (or, without a selection, this material) in plain terms. Keep the author's meaning; quote the exact words you rely on.",
  verify: "Check the claims in the passage: which are supported by the material itself, which need outside evidence. Do not invent sources; say plainly what you cannot verify.",
  related: "Find related material in the library with library_search and library_recent. For each related material give one line on how it relates, with its id.",
  summary: "Summarise this material: the thesis, the argument in order, the evidence, and what the author concedes. Quote sparingly and exactly.",
  synthesis: "Write a synthesis across the materials the reader names, or that library_search finds for the topic. Every claim carries [material-id] and exact quotes. Then save it with artifact_write, listing every material id you used in sources, and reply with the artifact id.",
  rebuild: "The extractor could not recover this page cleanly. Read the captured page text with material_source (page through it fully), then rewrite the article as faithful Markdown: title line, byline and date if present, the body in order with headings, paragraphs, lists, quotes, code blocks and links; leave out navigation, related-post cards, comments, share and subscribe blocks; never invent or summarise. Save it with artifact_write using lineage [<id>] (its `sources` argument) and reply with only the artifact id.",
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

export function buildPrompt(request: AgentRequest, context: PromptContext): string {
  const parts = ["You are Quire's reading agent. You answer from the reader's library, cite materials by id and quote their exact words. You have tools to search, read and import material and to save what you write."];
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
