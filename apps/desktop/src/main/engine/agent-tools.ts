import type { Annotation, ArtifactType, ItemRecord, MaterialKind, MaterialRecord, MaterialSummary, OpenUrlResult } from "../../shared/contracts";
import type { DynamicTool, ToolCall, ToolReply } from "./codex-client";
import { ARTIFACT_TYPES, MAX_ARTIFACT_SOURCE, isArtifactType } from "./artifacts";
import { RUNTIME_MODULES } from "../artifact-runtime";
import { itemHits, materialHits, mergeHits, searchWords } from "./search";

// The agent's window onto the library. Every tool validates its arguments by hand (no zod in the
// main bundle), returns one JSON string, and never leaks paths or bytes to the model.

/** Material ids the model retrieved during one turn; the only ids an artifact may cite. One per turn, never shared. */
export interface TurnScope { readonly seen: Set<string> }
/** A fresh scope; `seed` is what the turn may cite without retrieving it (the material the conversation is about). */
export function createTurnScope(seed: readonly string[] = []): TurnScope {
  return { seen: new Set(seed) };
}

export type ToolHandler = (call: ToolCall) => Promise<ToolReply>;
/** Built once with the library's dependencies; `forTurn` gives every turn its own handler, queue and cache. */
export interface ToolHandlerFactory { forTurn: (scope: TurnScope) => ToolHandler }

export interface ToolDeps {
  store: {
    list: () => Promise<MaterialSummary[]>;
    /** Materials whose title, byline, tags or body contain every word of the query. */
    search: (query: string) => Promise<MaterialSummary[]>;
    get: (id: string) => Promise<MaterialRecord | undefined>;
    openUrl: (url: string, origin: "web" | "feed") => Promise<OpenUrlResult>;
    saveArtifact: (input: { title: string; type: ArtifactType; source: string; language?: string; lineage: readonly string[] }) => Promise<MaterialRecord>;
    /** A new revision of an agent artifact: the source replaced, or one passage of it edited. */
    updateArtifact: (id: string, change: { source?: string; edit?: { oldText: string; newText: string }; title?: string; lineage?: readonly string[] }) => Promise<MaterialRecord>;
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
const MAX_LINEAGE = 50;

const CITE = "Cite by writing the material id in square brackets right after the claim or quote it supports, e.g. \"exact words\" [0123456789abcdef]; quote the material's exact words, never paraphrase inside quotation marks, and never print an id bare.";
/** What a non-Markdown artifact may rely on; shared by artifact_write and artifact_rewrite. */
const ARTIFACT_RULES = "Every artifact but markdown and code runs offline in a sandbox, sized to its content: fetch and remote URLs are blocked, and nothing can be loaded from the web. "
  + "An html artifact is one self-contained document with inline <style> and <script>; it follows the reader's light or dark theme through the CSS variables --quire-bg, --quire-fg, --quire-muted, --quire-accent, --quire-border and --quire-font (use them instead of fixed colours), and may load Quire's own copies of libraries with <script src=\"quire-artifact://runtime/NAME.js\"></script>, NAME one of d3 (window.d3), lodash (window._), mermaid (window.mermaid) or tailwind (Tailwind utility classes). "
  + `A react artifact is one component file (JSX or TSX) that \`export default\`s its component, which renders with no props; it may import only ${RUNTIME_MODULES}, styles with Tailwind utility classes, and keeps its state in React (no localStorage). `
  + "A mermaid artifact is the diagram's Mermaid source alone (flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, pie, mindmap, timeline…), drawn in the reader's theme. "
  + "To cite inside html or react, link the claim: <a href=\"quire:material/ID\" data-quote=\"exact words\">…</a> opens that material at the quote. An svg artifact is one <svg> element with a viewBox, drawn as a static image (no scripts).";
const idSchema = { type: "string", pattern: "^[a-f0-9]{16}$", description: "A material id, 16 hex characters, as returned by library_search, library_recent or the conversation." };
const limitSchema = { type: "integer", minimum: 1, maximum: MAX_LIST };

export const agentTools: readonly DynamicTool[] = [
  { name: "library_search", description: `Find materials (title, byline, tags or body text) and inbox items (title, source) containing every word of the query; at most 8 words are used. Use it before claiming the library has or lacks something, and to find ids for material_read. Returns up to ${SEARCH_HITS} hits with id, kind (material or item), title, subtitle, and for materials their materialKind, creators, publication, date, doi and arxivId when known. ${CITE}`,
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 200 } }, required: ["query"], additionalProperties: false } },
  { name: "library_recent", description: "The newest materials in the library (id, title, kind, creators, publication, date, doi, arxivId, byline, publishedAt, url, readingMinutes, origin). Use it to see what the reader has been reading, or when a question is about the library as a whole.",
    inputSchema: { type: "object", properties: { limit: { ...limitSchema, description: `How many, default ${DEFAULT_RECENT}.` } }, additionalProperties: false } },
  { name: "material_read", description: `Read a material's text as Markdown (an artifact as its source: Markdown, code, HTML, React, Mermaid or SVG), ${PAGE_CHARS} characters per call. Start at offset 0 and continue with nextOffset until it is null; read before you summarise, verify or quote. ${CITE}`,
    inputSchema: { type: "object", properties: { id: idSchema, offset: { type: "integer", minimum: 0, description: "Character offset; use the previous call's nextOffset." } }, required: ["id"], additionalProperties: false } },
  { name: "material_annotations", description: "The reader's own highlights and notes on a material (quote, note, kind, color, createdAt). Use it to learn what the reader marked as important or asked about before answering about the material.",
    inputSchema: { type: "object", properties: { id: idSchema }, required: ["id"], additionalProperties: false } },
  { name: "inbox_list", description: "Undecided items from the reader's subscriptions (id, title, sourceTitle, gist, link, publishedAt): what arrived but has not been read, queued or dismissed. Use it for triage questions; read a full item by importing its link with library_import.",
    inputSchema: { type: "object", properties: { limit: { ...limitSchema, description: `How many, default ${DEFAULT_RECENT}.` } }, additionalProperties: false } },
  { name: "library_import", description: "Fetch a public http(s) page and add it to the library as a material, returning its id, title and readingMinutes. Use it only when the reader asked for an outside page or an inbox item's full text; then read it with material_read, and cite the new material as [id] after its title.",
    inputSchema: { type: "object", properties: { url: { type: "string", minLength: 8, maxLength: 4096 } }, required: ["url"], additionalProperties: false } },
  { name: "material_source", description: `The captured raw page of a material as readable text with its structure (blank lines between blocks, # headings, - list items, fenced code, [text](href) links), ${PAGE_CHARS} characters per call, navigation and chrome included. Use it for a rebuild when the extracted text is broken; page with nextOffset until it is null. Only materials fetched with capture on have it.`,
    inputSchema: { type: "object", properties: { id: idSchema, offset: { type: "integer", minimum: 0, description: "Character offset; use the previous call's nextOffset." } }, required: ["id"], additionalProperties: false } },
  { name: "artifact_write", description: `Save a document you made into the library as an artifact the reader can open, keep and cite. \`type\` says what it is: "markdown" (the default: a synthesis, a summary, notes, a rebuilt article), "code" (one source file; give \`language\`), "html" (a page that needs layout or interaction), "react" (an interactive component: a chart with recharts, a calculator, a dashboard, a sortable or filterable table, a quiz), "mermaid" (a flowchart, sequence, timeline, mind map or other diagram from text), or "svg" (a drawn figure). ${ARTIFACT_RULES} \`sources\` must list the id of every material you drew on; only ids you retrieved in this turn (library_search, library_recent, material_read, material_source, material_annotations, library_import) or the material the conversation is about are accepted. Every claim should carry [material-id] (several as [id, id]) after its exact quote. Quire renders each citation as a numbered reference and appends a Sources list built from \`sources\`, so do not write a references, bibliography or sources section, and do not mention ids in the prose. Returns { id, title, type, version }; cite it as [id] after a one-line summary of what you saved. ${CITE}`,
    inputSchema: { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: MAX_TITLE }, type: { type: "string", enum: [...ARTIFACT_TYPES], description: "What the artifact is; markdown when omitted." }, language: { type: "string", maxLength: 40, description: "code artifacts: the source's language, e.g. python." }, content: { type: "string", minLength: 1, maxLength: MAX_ARTIFACT_SOURCE, description: "The whole artifact: Markdown, the code, a complete HTML document, a React component file, Mermaid source, or an <svg> element." }, sources: { type: "array", items: idSchema, minItems: 1, maxItems: MAX_LINEAGE, uniqueItems: true } }, required: ["title", "content", "sources"], additionalProperties: false } },
  { name: "artifact_update", description: "Edit an artifact you or an earlier turn wrote, without writing it again: replace one exact passage of its source (old_str, which must occur exactly once; copy it from material_read, whitespace included) with new_str. Use it for every change smaller than the whole artifact, one call per change. The artifact keeps its id; each edit makes a new version and the old one is kept. `sources` adds materials the edit draws on (retrieved this turn). Returns { id, title, type, version }.",
    inputSchema: { type: "object", properties: { id: idSchema, old_str: { type: "string", minLength: 1, maxLength: MAX_ARTIFACT_SOURCE }, new_str: { type: "string", maxLength: MAX_ARTIFACT_SOURCE }, sources: { type: "array", items: idSchema, maxItems: MAX_LINEAGE, uniqueItems: true } }, required: ["id", "old_str", "new_str"], additionalProperties: false } },
  { name: "artifact_rewrite", description: `Replace the whole source of an artifact (same type) when most of it changes; for smaller changes use artifact_update. The artifact keeps its id and gets a new version; the old one is kept. ${ARTIFACT_RULES} Returns { id, title, type, version }.`,
    inputSchema: { type: "object", properties: { id: idSchema, content: { type: "string", minLength: 1, maxLength: MAX_ARTIFACT_SOURCE }, title: { type: "string", minLength: 1, maxLength: MAX_TITLE }, sources: { type: "array", items: idSchema, maxItems: MAX_LINEAGE, uniqueItems: true } }, required: ["id", "content"], additionalProperties: false } },
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

/** Material ids a write cites: each one retrieved in this turn (or the conversation's material). */
function sourceIds(value: unknown, min: number, scope: TurnScope): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > MAX_LINEAGE || !value.every((id) => typeof id === "string" && /^[a-f0-9]{16}$/.test(id))) throw new ArgumentError(`"sources" must be ${min} to ${MAX_LINEAGE} material ids.`);
  const unseen = (value as string[]).filter((id) => !scope.seen.has(id));
  if (unseen.length > 0) throw new Error(`These sources were not retrieved during this turn, so they cannot be cited: ${unseen.join(", ")}. Read them with material_read (or find them with library_search) first.`);
  return value as string[];
}

function artifactValue(saved: MaterialRecord) {
  return { id: saved.id, title: saved.title, type: saved.artifact?.type ?? "markdown", version: saved.artifact?.version ?? 1 };
}

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

async function execute(tool: string, raw: unknown, deps: ToolDeps, scope: TurnScope, cache: CaptureCache): Promise<Outcome> {
  if (tool === "library_search") {
    const args = record(raw, ["query"]);
    const query = text(args, "query", 200);
    const words = searchWords(query);
    const merged = mergeHits(materialHits(query, await deps.store.search(query)), itemHits(deps.items.search(query))).slice(0, SEARCH_HITS);
    const hits = await Promise.all(merged.map(async (hit) => (hit.kind === "material" ? { ...hit, ...withMaterialKind(bibOf(await deps.store.get(hit.id))) } : hit)));
    for (const hit of hits) if (hit.kind === "material") scope.seen.add(hit.id);
    const truncated = query.trim().split(/\s+/).filter(Boolean).length > words.length;
    return { value: { hits, ...(truncated ? { note: `Only the first ${words.length} words of the query were used.` } : {}) }, summary: `library_search ${quoteOf(query)} → ${hits.length} hit${hits.length === 1 ? "" : "s"}` };
  }
  if (tool === "library_recent") {
    const limit = integer(record(raw, ["limit"]), "limit", DEFAULT_RECENT, MAX_LIST, 1);
    const materials = await Promise.all((await deps.store.list()).slice(0, limit).map(async (summary) => recentOf(summary, await deps.store.get(summary.id))));
    for (const material of materials) scope.seen.add(material.id);
    return { value: { materials }, summary: `library_recent → ${materials.length} material${materials.length === 1 ? "" : "s"}` };
  }
  if (tool === "material_read") {
    const args = record(raw, ["id", "offset"]);
    const id = materialId(args);
    const offset = integer(args, "offset", 0, Number.MAX_SAFE_INTEGER);
    const material = await deps.store.get(id);
    if (!material) throw new Error(`Material ${id} is not in the library. Find ids with library_search or library_recent.`);
    // An artifact reads as its source, so an update can copy a passage of it exactly.
    const content = material.artifactSource ?? material.markdown ?? material.plain;
    if (content === undefined) throw new Error(`Material ${id} (${material.title}) has no text to read; it is probably a scanned PDF.`);
    scope.seen.add(id);
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
    scope.seen.add(id);
    const value = { id, title: material.title, url: material.url, ...page(await captureOf(id, material.title, deps, cache), offset) };
    return { value, summary: `material_source ${id} @${offset} → ${quoteOf(material.title)}` };
  }
  if (tool === "material_annotations") {
    const id = materialId(record(raw, ["id"]));
    if (!(await deps.store.get(id))) throw new Error(`Material ${id} is not in the library.`);
    scope.seen.add(id);
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
    scope.seen.add(id);
    return { value: { id, title, readingMinutes }, summary: `library_import → ${quoteOf(title)}` };
  }
  if (tool === "artifact_write") {
    const args = record(raw, ["title", "type", "language", "content", "markdown", "sources"]);
    const title = text(args, "title", MAX_TITLE);
    // `markdown` is the argument's name from before artifacts had types; a resumed thread may still send it.
    const source = text(args, args.content === undefined && args.markdown !== undefined ? "markdown" : "content", MAX_ARTIFACT_SOURCE);
    const type = args.type ?? "markdown";
    if (!isArtifactType(type)) throw new ArgumentError(`"type" must be one of ${ARTIFACT_TYPES.join(", ")}.`);
    const language = args.language === undefined ? undefined : text(args, "language", 40);
    const sources = sourceIds(args.sources, 1, scope);
    const saved = await deps.store.saveArtifact({ title, type, source, lineage: sources, ...(language ? { language } : {}) });
    scope.seen.add(saved.id);
    deps.onChanged();
    return { value: artifactValue(saved), summary: `artifact_write ${quoteOf(saved.title)} → ${saved.id}` };
  }
  if (tool === "artifact_update" || tool === "artifact_rewrite") {
    const update = tool === "artifact_update";
    const args = record(raw, update ? ["id", "old_str", "new_str", "sources"] : ["id", "content", "title", "sources"]);
    const id = materialId(args);
    const sources = args.sources === undefined ? undefined : sourceIds(args.sources, 0, scope);
    let change: Parameters<ToolDeps["store"]["updateArtifact"]>[1];
    if (update) {
      const newText = args.new_str;
      if (typeof newText !== "string" || newText.length > MAX_ARTIFACT_SOURCE) throw new ArgumentError(`"new_str" must be a string of at most ${MAX_ARTIFACT_SOURCE} characters.`);
      change = { edit: { oldText: text(args, "old_str", MAX_ARTIFACT_SOURCE), newText } };
    } else {
      change = { source: text(args, "content", MAX_ARTIFACT_SOURCE), ...(args.title !== undefined ? { title: text(args, "title", MAX_TITLE) } : {}) };
    }
    const saved = await deps.store.updateArtifact(id, { ...change, ...(sources ? { lineage: sources } : {}) });
    scope.seen.add(saved.id);
    deps.onChanged();
    return { value: artifactValue(saved), summary: `${tool} ${quoteOf(saved.title)} → ${saved.id} v${saved.artifact?.version ?? 1}` };
  }
  throw new Error(`Unknown tool ${tool}. Available: ${agentTools.map((t) => t.name).join(", ")}.`);
}

/** One handler per turn: its calls run one after another so imports and writes have a clear order, and its capture cache is its own. */
function turnHandler(deps: ToolDeps, scope: TurnScope): ToolHandler {
  let queue: Promise<unknown> = Promise.resolve();
  const cache: CaptureCache = {};
  return (call) => {
    const run = queue.then(async (): Promise<ToolReply> => {
      try {
        const outcome = await execute(call.tool, call.arguments, deps, scope, cache);
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

/** The tools' handler factory; turns on different threads get independent handlers and never wait on each other. */
export function createToolHandler(deps: ToolDeps): ToolHandlerFactory {
  return { forTurn: (scope) => turnHandler(deps, scope) };
}
