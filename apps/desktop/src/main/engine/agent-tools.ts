import type { Annotation, ItemRecord, MaterialRecord, MaterialSummary, OpenUrlResult } from "../../shared/contracts";
import type { DynamicTool, ToolCall, ToolReply } from "./codex-client";
import { itemHits, materialHits, mergeHits } from "./search";

// The agent's window onto the library. Every tool validates its arguments by hand (no zod in the
// main bundle), returns one JSON string, and never leaks paths or bytes to the model.

export interface ToolDeps {
  store: {
    list: () => Promise<MaterialSummary[]>;
    get: (id: string) => Promise<MaterialRecord | undefined>;
    openUrl: (url: string, origin: "web" | "feed") => Promise<OpenUrlResult>;
    saveArtifact: (input: { title: string; markdown: string; lineage: readonly string[] }) => Promise<MaterialRecord>;
  };
  items: { search: (query: string) => ItemRecord[]; inbox: () => ItemRecord[] };
  annotations: { list: (materialId: string) => Promise<Annotation[]> };
  /** The library changed (an import, an artifact); the renderer reloads through library:changed. */
  onChanged: () => void;
  /** A freshly materialized page: cache its pictures, as the openUrl handler does. */
  onMaterialized?: (record: MaterialRecord) => void;
}

export const PAGE_CHARS = 24_000;
const SEARCH_HITS = 20;
const DEFAULT_RECENT = 20;
const MAX_LIST = 100;
const MAX_TITLE = 200;
const MAX_MARKDOWN = 400_000;
const MAX_LINEAGE = 50;

const CITE = "Cite by material id and quote the material's exact words; never paraphrase inside quotation marks.";
const idSchema = { type: "string", pattern: "^[a-f0-9]{16}$", description: "A material id, 16 hex characters, as returned by library_search, library_recent or the conversation." };
const limitSchema = { type: "integer", minimum: 1, maximum: MAX_LIST };

export const agentTools: readonly DynamicTool[] = [
  { name: "library_search", description: `Find materials and inbox items whose title or byline contains every word of the query. Use it before claiming the library has or lacks something, and to find ids for material_read. Returns up to ${SEARCH_HITS} hits with id, kind (material or item), title, subtitle. ${CITE}`,
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 200 } }, required: ["query"], additionalProperties: false } },
  { name: "library_recent", description: "The newest materials in the library (id, title, byline, publishedAt, url, readingMinutes, origin). Use it to see what the reader has been reading, or when a question is about the library as a whole.",
    inputSchema: { type: "object", properties: { limit: { ...limitSchema, description: `How many, default ${DEFAULT_RECENT}.` } }, additionalProperties: false } },
  { name: "material_read", description: `Read a material's text as Markdown, ${PAGE_CHARS} characters per call. Start at offset 0 and continue with nextOffset until it is null; read before you summarise, verify or quote. ${CITE}`,
    inputSchema: { type: "object", properties: { id: idSchema, offset: { type: "integer", minimum: 0, description: "Character offset; use the previous call's nextOffset." } }, required: ["id"], additionalProperties: false } },
  { name: "material_annotations", description: "The reader's own highlights and notes on a material (quote, note, kind, color, createdAt). Use it to learn what the reader marked as important or asked about before answering about the material.",
    inputSchema: { type: "object", properties: { id: idSchema }, required: ["id"], additionalProperties: false } },
  { name: "inbox_list", description: "Undecided items from the reader's subscriptions (id, title, sourceTitle, gist, link, publishedAt): what arrived but has not been read, queued or dismissed. Use it for triage questions; read a full item by importing its link with library_import.",
    inputSchema: { type: "object", properties: { limit: { ...limitSchema, description: `How many, default ${DEFAULT_RECENT}.` } }, additionalProperties: false } },
  { name: "library_import", description: "Fetch a public http(s) page and add it to the library as a material, returning its id, title and readingMinutes. Use it only when the reader asked for an outside page or an inbox item's full text; then read it with material_read.",
    inputSchema: { type: "object", properties: { url: { type: "string", minLength: 8, maxLength: 4096 } }, required: ["url"], additionalProperties: false } },
  { name: "artifact_write", description: `Save a document you wrote (a synthesis, a summary) into the library as a Markdown material. \`sources\` must list the id of every material you drew on; unknown ids are rejected. Every claim in the markdown should carry [material-id] and exact quotes. Returns { id, title }; tell the reader the id. ${CITE}`,
    inputSchema: { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: MAX_TITLE }, markdown: { type: "string", minLength: 1, maxLength: MAX_MARKDOWN }, sources: { type: "array", items: idSchema, minItems: 1, maxItems: MAX_LINEAGE, uniqueItems: true } }, required: ["title", "markdown", "sources"], additionalProperties: false } },
];

class ArgumentError extends Error {}

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ArgumentError("Arguments must be a JSON object.");
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new ArgumentError(`Unknown argument(s): ${extra.join(", ")}. Allowed: ${allowed.join(", ")}.`);
  return value as Record<string, unknown>;
}
function text(args: Record<string, unknown>, key: string, max: number): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new ArgumentError(`"${key}" must be a non-empty string.`);
  if (value.length > max) throw new ArgumentError(`"${key}" is longer than ${max} characters.`);
  return value;
}
function materialId(args: Record<string, unknown>, key = "id"): string {
  const value = args[key];
  if (typeof value !== "string" || !/^[a-f0-9]{16}$/.test(value)) throw new ArgumentError(`"${key}" must be a 16-character hex material id.`);
  return value;
}
function integer(args: Record<string, unknown>, key: string, fallback: number, max: number, min = 0): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new ArgumentError(`"${key}" must be an integer between ${min} and ${max}.`);
  return value;
}

function recentOf(material: MaterialSummary) {
  const { id, title, byline, publishedAt, url, readingMinutes, origin } = material;
  return { id, title, url, readingMinutes, origin, ...(byline ? { byline } : {}), ...(publishedAt ? { publishedAt } : {}) };
}
function inboxOf(item: ItemRecord) {
  const { id, title, sourceTitle, gist, link, publishedAt } = item;
  return { id, title, sourceTitle, gist, link, publishedAt };
}
function quoteOf(query: string) { return `"${query.length > 40 ? `${query.slice(0, 39)}…` : query}"`; }

interface Outcome { value: unknown; summary: string }

async function execute(tool: string, raw: unknown, deps: ToolDeps): Promise<Outcome> {
  if (tool === "library_search") {
    const args = record(raw, ["query"]);
    const query = text(args, "query", 200);
    const hits = mergeHits(materialHits(query, await deps.store.list()), itemHits(deps.items.search(query))).slice(0, SEARCH_HITS);
    return { value: { hits }, summary: `library_search ${quoteOf(query)} → ${hits.length} hit${hits.length === 1 ? "" : "s"}` };
  }
  if (tool === "library_recent") {
    const limit = integer(record(raw, ["limit"]), "limit", DEFAULT_RECENT, MAX_LIST, 1);
    const materials = (await deps.store.list()).slice(0, limit).map(recentOf);
    return { value: { materials }, summary: `library_recent → ${materials.length} material${materials.length === 1 ? "" : "s"}` };
  }
  if (tool === "material_read") {
    const args = record(raw, ["id", "offset"]);
    const id = materialId(args);
    const offset = integer(args, "offset", 0, Number.MAX_SAFE_INTEGER);
    const material = await deps.store.get(id);
    if (!material) throw new Error(`Material ${id} is not in the library. Find ids with library_search or library_recent.`);
    const content = material.markdown ?? material.plain;
    if (content === undefined) throw new Error(`Material ${id} (${material.title}) has no text to read; it is probably a scanned PDF.`);
    if (offset > content.length) throw new Error(`Offset ${offset} is past the end of the text (${content.length} characters).`);
    const end = Math.min(content.length, offset + PAGE_CHARS);
    const value = { id, title: material.title, ...(material.byline ? { byline: material.byline } : {}), url: material.url, content: content.slice(offset, end), offset, nextOffset: end < content.length ? end : null, totalCharacters: content.length };
    return { value, summary: `material_read ${id} @${offset} → ${quoteOf(material.title)}` };
  }
  if (tool === "material_annotations") {
    const id = materialId(record(raw, ["id"]));
    if (!(await deps.store.get(id))) throw new Error(`Material ${id} is not in the library.`);
    const annotations = (await deps.annotations.list(id)).map(({ quote, note, kind, color, createdAt }) => ({ quote, kind, color, createdAt, ...(note ? { note } : {}) }));
    return { value: { annotations }, summary: `material_annotations ${id} → ${annotations.length}` };
  }
  if (tool === "inbox_list") {
    const limit = integer(record(raw, ["limit"]), "limit", DEFAULT_RECENT, MAX_LIST, 1);
    const items = deps.items.inbox().slice(0, limit).map(inboxOf);
    return { value: { items }, summary: `inbox_list → ${items.length} item${items.length === 1 ? "" : "s"}` };
  }
  if (tool === "library_import") {
    const url = text(record(raw, ["url"]), "url", 4096);
    const result = await deps.store.openUrl(url, "web");
    if (!result.ok) throw new Error(`Could not import ${url}: ${result.message} (${result.code})`);
    deps.onMaterialized?.(result.material);
    deps.onChanged();
    const { id, title, readingMinutes } = result.material;
    return { value: { id, title, readingMinutes }, summary: `library_import → ${quoteOf(title)}` };
  }
  if (tool === "artifact_write") {
    const args = record(raw, ["title", "markdown", "sources"]);
    const title = text(args, "title", MAX_TITLE);
    const markdown = text(args, "markdown", MAX_MARKDOWN);
    const sources = args.sources;
    if (!Array.isArray(sources) || sources.length === 0 || sources.length > MAX_LINEAGE || !sources.every((id) => typeof id === "string" && /^[a-f0-9]{16}$/.test(id))) throw new ArgumentError(`"sources" must be 1 to ${MAX_LINEAGE} material ids.`);
    const saved = await deps.store.saveArtifact({ title, markdown, lineage: sources as string[] });
    deps.onChanged();
    return { value: { id: saved.id, title: saved.title }, summary: `artifact_write ${quoteOf(saved.title)} → ${saved.id}` };
  }
  throw new Error(`Unknown tool ${tool}. Available: ${agentTools.map((t) => t.name).join(", ")}.`);
}

/** One handler per turn; calls run one after another so imports and writes have a clear order. */
export function createToolHandler(deps: ToolDeps): (call: ToolCall) => Promise<ToolReply> {
  let queue: Promise<unknown> = Promise.resolve();
  return (call) => {
    const run = queue.then(async (): Promise<ToolReply> => {
      try {
        const outcome = await execute(call.tool, call.arguments, deps);
        return { success: true, text: JSON.stringify({ ok: true, ...(outcome.value as Record<string, unknown>) }), summary: outcome.summary };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const prefix = error instanceof ArgumentError ? "Invalid arguments: " : "";
        return { success: false, text: JSON.stringify({ ok: false, error: `${prefix}${message}` }), summary: `${call.tool} failed: ${message}` };
      }
    });
    queue = run.then(() => undefined);
    return run;
  };
}
