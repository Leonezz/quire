import type { Annotation, ItemRecord, MaterialKind, MaterialRecord, MaterialSummary, OpenUrlResult } from "../../shared/contracts";
import type { DynamicTool, ToolCall, ToolReply } from "./codex-client";
import { itemHits, materialHits, mergeHits, searchWords } from "./search";

// The agent's window onto the library. Every tool validates its arguments by hand (no zod in the
// main bundle), returns one JSON string, and never leaks paths or bytes to the model.

/** Material ids the model retrieved during the running turn; the only ids an artifact may cite. */
export interface TurnScope { seen: Set<string>; reset: (seed?: readonly string[]) => void }
export function createTurnScope(): TurnScope {
  const seen = new Set<string>();
  return { seen, reset: (seed = []) => { seen.clear(); for (const id of seed) seen.add(id); } };
}

export interface ToolDeps {
  /** Shared with the AgentService, which resets it at the start of every turn. */
  scope?: TurnScope;
  store: {
    list: () => Promise<MaterialSummary[]>;
    /** Materials whose title, byline, tags or body contain every word of the query. */
    search: (query: string) => Promise<MaterialSummary[]>;
    get: (id: string) => Promise<MaterialRecord | undefined>;
    openUrl: (url: string, origin: "web" | "feed") => Promise<OpenUrlResult>;
    saveArtifact: (input: { title: string; markdown: string; lineage: readonly string[] }) => Promise<MaterialRecord>;
    /** The captured page as structured text; undefined when the material has no capture. */
    captureText: (id: string) => Promise<string | undefined>;
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
  { name: "library_search", description: `Find materials (title, byline, tags or body text) and inbox items (title, source) containing every word of the query; at most 8 words are used. Use it before claiming the library has or lacks something, and to find ids for material_read. Returns up to ${SEARCH_HITS} hits with id, kind (material or item), title, subtitle, and for materials their materialKind, creators, publication, date, doi and arxivId when known. ${CITE}`,
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 200 } }, required: ["query"], additionalProperties: false } },
  { name: "library_recent", description: "The newest materials in the library (id, title, kind, creators, publication, date, doi, arxivId, byline, publishedAt, url, readingMinutes, origin). Use it to see what the reader has been reading, or when a question is about the library as a whole.",
    inputSchema: { type: "object", properties: { limit: { ...limitSchema, description: `How many, default ${DEFAULT_RECENT}.` } }, additionalProperties: false } },
  { name: "material_read", description: `Read a material's text as Markdown, ${PAGE_CHARS} characters per call. Start at offset 0 and continue with nextOffset until it is null; read before you summarise, verify or quote. ${CITE}`,
    inputSchema: { type: "object", properties: { id: idSchema, offset: { type: "integer", minimum: 0, description: "Character offset; use the previous call's nextOffset." } }, required: ["id"], additionalProperties: false } },
  { name: "material_annotations", description: "The reader's own highlights and notes on a material (quote, note, kind, color, createdAt). Use it to learn what the reader marked as important or asked about before answering about the material.",
    inputSchema: { type: "object", properties: { id: idSchema }, required: ["id"], additionalProperties: false } },
  { name: "inbox_list", description: "Undecided items from the reader's subscriptions (id, title, sourceTitle, gist, link, publishedAt): what arrived but has not been read, queued or dismissed. Use it for triage questions; read a full item by importing its link with library_import.",
    inputSchema: { type: "object", properties: { limit: { ...limitSchema, description: `How many, default ${DEFAULT_RECENT}.` } }, additionalProperties: false } },
  { name: "library_import", description: "Fetch a public http(s) page and add it to the library as a material, returning its id, title and readingMinutes. Use it only when the reader asked for an outside page or an inbox item's full text; then read it with material_read.",
    inputSchema: { type: "object", properties: { url: { type: "string", minLength: 8, maxLength: 4096 } }, required: ["url"], additionalProperties: false } },
  { name: "material_source", description: `The captured raw page of a material as readable text with its structure (blank lines between blocks, # headings, - list items, fenced code, [text](href) links), ${PAGE_CHARS} characters per call, navigation and chrome included. Use it for a rebuild when the extracted text is broken; page with nextOffset until it is null. Only materials fetched with capture on have it.`,
    inputSchema: { type: "object", properties: { id: idSchema, offset: { type: "integer", minimum: 0, description: "Character offset; use the previous call's nextOffset." } }, required: ["id"], additionalProperties: false } },
  { name: "artifact_write", description: `Save a document you wrote (a synthesis, a summary) into the library as a Markdown material. \`sources\` must list the id of every material you drew on; only ids you retrieved in this turn (library_search, library_recent, material_read, material_source, material_annotations, library_import) or the material the conversation is about are accepted. Every claim in the markdown should carry [material-id] and exact quotes. Returns { id, title }; tell the reader the id. ${CITE}`,
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

interface Bib { kind?: MaterialKind; creators?: string[]; publication?: string; date?: string; doi?: string; arxivId?: string }

/** The bibliographic fields worth showing the model: the kind, who wrote it, where, when, and its identifiers. */
function bibOf(material: MaterialRecord | undefined): Bib {
  if (!material) return {};
  const { kind, meta } = material;
  const creators = (meta.creators ?? []).map((c) => c.name);
  return {
    kind, ...(creators.length > 0 ? { creators } : {}), ...(meta.publication ? { publication: meta.publication } : {}), ...(meta.date ? { date: meta.date } : {}),
    ...(meta.doi ? { doi: meta.doi } : {}), ...(meta.arxivId ? { arxivId: meta.arxivId } : {}),
  };
}
/** A search hit's `kind` already says material or item, so the bibliographic kind travels as materialKind. */
function withMaterialKind({ kind, ...bib }: Bib) {
  return { ...(kind ? { materialKind: kind } : {}), ...bib };
}
function recentOf(material: MaterialSummary, record: MaterialRecord | undefined) {
  const { id, title, byline, publishedAt, url, readingMinutes, origin, kind } = material;
  return { id, title, url, readingMinutes, origin, kind, ...(byline ? { byline } : {}), ...(publishedAt ? { publishedAt } : {}), ...bibOf(record) };
}
function inboxOf(item: ItemRecord) {
  const { id, title, sourceTitle, gist, link, publishedAt } = item;
  return { id, title, sourceTitle, gist, link, publishedAt };
}
function quoteOf(query: string) { return `"${query.length > 40 ? `${query.slice(0, 39)}…` : query}"`; }

interface Outcome { value: unknown; summary: string }

/** One page of `content` from `offset`, with the cursor for the next call. */
function page(content: string, offset: number) {
  if (offset > content.length) throw new Error(`Offset ${offset} is past the end of the text (${content.length} characters).`);
  const end = Math.min(content.length, offset + PAGE_CHARS);
  return { content: content.slice(offset, end), offset, nextOffset: end < content.length ? end : null, totalCharacters: content.length };
}

/** The last capture rendered, so paging through one page does not parse it again per call. */
interface CaptureCache { id?: string; text?: string }

async function captureOf(id: string, title: string, deps: ToolDeps, cache: CaptureCache): Promise<string> {
  if (cache.id === id && cache.text !== undefined) return cache.text;
  const text = await deps.store.captureText(id);
  if (text === undefined) throw new Error(`Material ${id} (${title}) has a capture record but its page file is missing; fetch it again with capture on.`);
  cache.id = id; cache.text = text;
  return text;
}

async function execute(tool: string, raw: unknown, deps: ToolDeps, cache: CaptureCache): Promise<Outcome> {
  if (tool === "library_search") {
    const args = record(raw, ["query"]);
    const query = text(args, "query", 200);
    const words = searchWords(query);
    const merged = mergeHits(materialHits(query, await deps.store.search(query)), itemHits(deps.items.search(query))).slice(0, SEARCH_HITS);
    const hits = await Promise.all(merged.map(async (hit) => (hit.kind === "material" ? { ...hit, ...withMaterialKind(bibOf(await deps.store.get(hit.id))) } : hit)));
    for (const hit of hits) if (hit.kind === "material") deps.scope?.seen.add(hit.id);
    const truncated = query.trim().split(/\s+/).filter(Boolean).length > words.length;
    return { value: { hits, ...(truncated ? { note: `Only the first ${words.length} words of the query were used.` } : {}) }, summary: `library_search ${quoteOf(query)} → ${hits.length} hit${hits.length === 1 ? "" : "s"}` };
  }
  if (tool === "library_recent") {
    const limit = integer(record(raw, ["limit"]), "limit", DEFAULT_RECENT, MAX_LIST, 1);
    const materials = await Promise.all((await deps.store.list()).slice(0, limit).map(async (summary) => recentOf(summary, await deps.store.get(summary.id))));
    for (const material of materials) deps.scope?.seen.add(material.id);
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
    deps.scope?.seen.add(id);
    const value = { id, title: material.title, ...(material.byline ? { byline: material.byline } : {}), url: material.url, ...bibOf(material), ...page(content, offset) };
    return { value, summary: `material_read ${id} @${offset} → ${quoteOf(material.title)}` };
  }
  if (tool === "material_source") {
    const args = record(raw, ["id", "offset"]);
    const id = materialId(args);
    const offset = integer(args, "offset", 0, Number.MAX_SAFE_INTEGER);
    const material = await deps.store.get(id);
    if (!material) throw new Error(`Material ${id} is not in the library. Find ids with library_search or library_recent.`);
    if (!material.capture) throw new Error(`Material ${id} (${material.title}) has no captured page: it was fetched with capture off, dropped as a file, or is a PDF or an artifact. There is nothing to rebuild from; read it with material_read instead.`);
    deps.scope?.seen.add(id);
    const value = { id, title: material.title, url: material.url, ...page(await captureOf(id, material.title, deps, cache), offset) };
    return { value, summary: `material_source ${id} @${offset} → ${quoteOf(material.title)}` };
  }
  if (tool === "material_annotations") {
    const id = materialId(record(raw, ["id"]));
    if (!(await deps.store.get(id))) throw new Error(`Material ${id} is not in the library.`);
    deps.scope?.seen.add(id);
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
    deps.scope?.seen.add(id);
    return { value: { id, title, readingMinutes }, summary: `library_import → ${quoteOf(title)}` };
  }
  if (tool === "artifact_write") {
    const args = record(raw, ["title", "markdown", "sources"]);
    const title = text(args, "title", MAX_TITLE);
    const markdown = text(args, "markdown", MAX_MARKDOWN);
    const sources = args.sources;
    if (!Array.isArray(sources) || sources.length === 0 || sources.length > MAX_LINEAGE || !sources.every((id) => typeof id === "string" && /^[a-f0-9]{16}$/.test(id))) throw new ArgumentError(`"sources" must be 1 to ${MAX_LINEAGE} material ids.`);
    const scope = deps.scope;
    const unseen = scope ? (sources as string[]).filter((id) => !scope.seen.has(id)) : [];
    if (unseen.length > 0) throw new Error(`These sources were not retrieved during this turn, so they cannot be cited: ${unseen.join(", ")}. Read them with material_read (or find them with library_search) first.`);
    const saved = await deps.store.saveArtifact({ title, markdown, lineage: sources as string[] });
    scope?.seen.add(saved.id);
    deps.onChanged();
    return { value: { id: saved.id, title: saved.title }, summary: `artifact_write ${quoteOf(saved.title)} → ${saved.id}` };
  }
  throw new Error(`Unknown tool ${tool}. Available: ${agentTools.map((t) => t.name).join(", ")}.`);
}

/** One handler per turn; calls run one after another so imports and writes have a clear order. */
export function createToolHandler(deps: ToolDeps): (call: ToolCall) => Promise<ToolReply> {
  let queue: Promise<unknown> = Promise.resolve();
  const cache: CaptureCache = {};
  return (call) => {
    const run = queue.then(async (): Promise<ToolReply> => {
      try {
        const outcome = await execute(call.tool, call.arguments, deps, cache);
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
