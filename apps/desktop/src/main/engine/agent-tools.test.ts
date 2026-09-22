import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAGE_CHARS, agentTools, createToolHandler, createTurnScope, type ToolDeps } from "./agent-tools";
import { AnnotationStore } from "./annotations";
import { openDatabase, type Database } from "./db";
import type { Fetcher } from "./fetch";
import { ItemStore } from "./items";
import { MaterialStore } from "./materials";

let root = "";
let db: Database;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-agent-tools-")); db = openDatabase(join(root, "quire.sqlite")); });
afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); });

const page = `<!doctype html><html><head><title>Imported page</title></head><body><article><h1>Imported page</h1>${"<p>Enough text for the extractor to accept the article as a real body of prose.</p>".repeat(10)}</article></body></html>`;
const fetcher: Fetcher = async (url) => ({ bytes: new TextEncoder().encode(page), mediaType: "text/html", finalUrl: url.toString() });

async function setup() {
  const store = new MaterialStore(root, fetcher);
  const annotations = new AnnotationStore(root);
  const items = new ItemStore(db);
  const saved = await store.openFile({ name: "momentum.md", mediaType: "", bytes: new TextEncoder().encode(`# Momentum, revisited\n\n${"Stochastic momentum keeps the direction of the last steps. ".repeat(600)}`) });
  if (!saved.ok) throw new Error(saved.message);
  items.upsert({ id: "src-a", title: "Systems Notes", kind: "feed" }, [
    { externalId: "1", title: "Momentum in optimizers", link: "https://example.test/momentum", publishedAt: "2026-09-10T00:00:00.000Z", gist: "A gist.", readingMinutes: 4, signals: {}, summaryOnly: true },
    { externalId: "2", title: "Unrelated post", link: "https://example.test/other", publishedAt: "2026-09-11T00:00:00.000Z", gist: "Other.", readingMinutes: 2, signals: {}, summaryOnly: true },
  ]);
  const changes: string[] = [];
  const deps: ToolDeps = { store, items, annotations, onChanged: () => changes.push("changed"), onMaterialized: (record) => changes.push(`materialized ${record.title}`) };
  // The turn is about the saved material, so it may be cited without a retrieval, as the AgentService seeds it.
  const scope = createTurnScope([saved.material.id]);
  return { store, annotations, items, deps, scope, handle: createToolHandler(deps).forTurn(scope), material: saved.material, changes };
}

const parse = (text: string) => JSON.parse(text) as Record<string, unknown>;

describe("agentTools", () => {
  it("declares closed object schemas and tells the model to cite by id and exact quote", () => {
    for (const tool of agentTools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    expect(agentTools.map((t) => t.name)).toEqual(["library_search", "library_recent", "material_read", "material_annotations", "inbox_list", "library_import", "material_source", "artifact_write"]);
    expect(agentTools.find((t) => t.name === "material_read")?.description).toMatch(/exact words/);
    expect(agentTools.find((t) => t.name === "material_read")?.description).toMatch(/\[0123456789abcdef\]/);
    const artifact = agentTools.find((t) => t.name === "artifact_write")?.description ?? "";
    expect(artifact).toContain("cite it as [id] after a one-line summary");
    expect(artifact).not.toContain("tell the reader the id");
    expect(agentTools.find((t) => t.name === "library_import")?.description).toContain("cite the new material as [id]");
  });
});

describe("createToolHandler", () => {
  it("searches materials and items, and lists the newest materials", async () => {
    const { handle, material } = await setup();
    const search = await handle({ tool: "library_search", arguments: { query: "momentum" }, callId: "c1" });
    expect(search.success).toBe(true);
    expect(search.summary).toBe('library_search "momentum" → 2 hits');
    expect(parse(search.text)).toMatchObject({ ok: true, hits: [{ kind: "material", materialKind: "webpage", id: material.id, title: "Momentum, revisited" }, { kind: "item", title: "Momentum in optimizers" }] });
    expect((parse(search.text).hits as Record<string, unknown>[])[1]).not.toHaveProperty("materialKind");
    const recent = await handle({ tool: "library_recent", arguments: {}, callId: "c2" });
    expect(parse(recent.text)).toMatchObject({ ok: true, materials: [{ id: material.id, title: "Momentum, revisited", origin: "file", kind: "webpage", readingMinutes: material.readingMinutes }] });
    expect(recent.summary).toBe("library_recent → 1 material");
  });

  it("shows the model the bibliographic fields of a material: kind, creators, publication, date and identifiers", async () => {
    const { handle } = await setup();
    const tagged =`<!doctype html><html><head><title>Paper</title><meta name="citation_title" content="Calibrated Abstention"><meta name="citation_author" content="Lindqvist, Mara"><meta name="citation_journal_title" content="Journal of Retrieval"><meta name="citation_publication_date" content="2026/05/12"><meta name="citation_doi" content="10.1234/jr.1"></head><body><article><h1>Paper</h1>${"<p>Enough text for the extractor to accept the article as a real body of prose.</p>".repeat(10)}</article></body></html>`;
    const journal = new MaterialStore(root, async (url) => ({ bytes: new TextEncoder().encode(tagged), mediaType: "text/html", finalUrl: url.toString() }));
    const opened = await journal.openUrl("https://journal.example.test/1");
    if (!opened.ok) throw new Error(opened.message);
    const bib = { kind: "journalArticle", creators: ["Mara Lindqvist"], publication: "Journal of Retrieval", date: "2026-05-12", doi: "10.1234/jr.1" };
    expect(parse((await handle({ tool: "material_read", arguments: { id: opened.material.id }, callId: "c1" })).text)).toMatchObject({ ok: true, title: "Calibrated Abstention", byline: "Mara Lindqvist", ...bib });
    expect(parse((await handle({ tool: "library_recent", arguments: {}, callId: "c2" })).text)).toMatchObject({ materials: [{ id: opened.material.id, ...bib }, { kind: "webpage" }] });
    expect(parse((await handle({ tool: "library_search", arguments: { query: "lindqvist" }, callId: "c3" })).text)).toMatchObject({ hits: [{ kind: "material", id: opened.material.id, materialKind: "journalArticle", creators: ["Mara Lindqvist"], doi: "10.1234/jr.1" }] });
  });

  it("pages a material's markdown and refuses unknown ids and bad offsets", async () => {
    const { handle, material } = await setup();
    const first = parse((await handle({ tool: "material_read", arguments: { id: material.id }, callId: "c1" })).text);
    expect(first).toMatchObject({ ok: true, id: material.id, title: "Momentum, revisited", offset: 0, nextOffset: PAGE_CHARS, totalCharacters: material.markdown!.length });
    expect((first.content as string).length).toBe(PAGE_CHARS);
    const second = parse((await handle({ tool: "material_read", arguments: { id: material.id, offset: PAGE_CHARS }, callId: "c2" })).text);
    expect(second).toMatchObject({ offset: PAGE_CHARS, nextOffset: null });
    expect((first.content as string) + (second.content as string)).toBe(material.markdown);
    const unknown = await handle({ tool: "material_read", arguments: { id: "0123456789abcdef" }, callId: "c3" });
    expect(unknown.success).toBe(false);
    expect(parse(unknown.text)).toMatchObject({ ok: false, error: /not in the library/ });
    const invalid = await handle({ tool: "material_read", arguments: { id: "nope", extra: 1 }, callId: "c4" });
    expect(parse(invalid.text).error).toMatch(/Invalid arguments: Unknown argument\(s\): extra/);
    const past = await handle({ tool: "material_read", arguments: { id: material.id, offset: 10_000_000 }, callId: "c5" });
    expect(parse(past.text).error).toMatch(/past the end/);
  });

  it("returns the reader's annotations and the undecided inbox", async () => {
    const { handle, material, annotations } = await setup();
    await annotations.save({ id: "a1a1a1a1a1a1a1a1", materialId: material.id, locator: "loc", quote: "keeps the direction", note: "why?", kind: "comment", color: "#ffd400", createdAt: "", updatedAt: "" });
    const marks = parse((await handle({ tool: "material_annotations", arguments: { id: material.id }, callId: "c1" })).text);
    expect(marks).toMatchObject({ ok: true, annotations: [{ quote: "keeps the direction", note: "why?", kind: "comment", color: "#ffd400" }] });
    expect((marks.annotations as unknown[]).length).toBe(1);
    const inbox = await handle({ tool: "inbox_list", arguments: { limit: 1 }, callId: "c2" });
    expect(parse(inbox.text)).toMatchObject({ ok: true, items: [{ title: "Unrelated post", sourceTitle: "Systems Notes", link: "https://example.test/other" }] });
    expect(inbox.summary).toBe("inbox_list → 1 item");
    expect(parse((await handle({ tool: "inbox_list", arguments: { limit: 0 }, callId: "c3" })).text).error).toMatch(/between 1 and 100/);
  });

  it("imports a page, notifies the library and prefetches its images", async () => {
    const { handle, store, changes } = await setup();
    const reply = await handle({ tool: "library_import", arguments: { url: "https://example.test/new-page" }, callId: "c1" });
    expect(reply.success).toBe(true);
    const value = parse(reply.text);
    expect(value).toMatchObject({ ok: true, title: "Imported page" });
    expect(await store.get(value.id as string)).toMatchObject({ origin: "web" });
    expect(changes).toEqual(["materialized Imported page", "changed"]);
    const refused = await handle({ tool: "library_import", arguments: { url: "http://localhost/x" }, callId: "c2" });
    expect(refused.success).toBe(false);
    expect(parse(refused.text).error).toMatch(/URL_PRIVATE/);
    expect(changes).toHaveLength(2);
  });

  it("writes an artifact with its lineage and rejects sources the turn did not retrieve", async () => {
    const { handle, store, material, changes, scope, deps } = await setup();
    const reply = await handle({ tool: "artifact_write", arguments: { title: "On momentum", markdown: "# On momentum\n\nSee [" + material.id + "]: \"keeps the direction\".", sources: [material.id] }, callId: "c1" });
    expect(reply.success).toBe(true);
    const { id } = parse(reply.text) as { id: string };
    const saved = await store.get(id);
    expect(saved).toMatchObject({ origin: "agent", lineage: [material.id], title: "On momentum", mediaType: "text/markdown", url: `quire://artifact/${id}` });
    expect(saved?.reader?.schema).toBe("reader.document.v2");
    expect(saved?.quality).toMatchObject({ completeness: "declared_full", identityConfidence: "derived" });
    expect((await store.list()).find((m) => m.id === id)?.lineage).toEqual([material.id]);
    expect(changes).toEqual(["changed"]);
    expect(scope.seen.has(id)).toBe(true);
    const bad = await handle({ tool: "artifact_write", arguments: { title: "x", markdown: "y", sources: [material.id, "0123456789abcdef"] }, callId: "c2" });
    expect(bad.success).toBe(false);
    expect(parse(bad.text).error).toMatch(/not retrieved during this turn, so they cannot be cited: 0123456789abcdef/);
    // A scope that vouches for an id the library does not have still fails, at the store.
    const vouched = createToolHandler(deps).forTurn(createTurnScope([material.id, "0123456789abcdef"]));
    expect(parse((await vouched({ tool: "artifact_write", arguments: { title: "x", markdown: "y", sources: [material.id, "0123456789abcdef"] }, callId: "c3" })).text).error).toMatch(/Unknown material ids in lineage: 0123456789abcdef/);
    // A fresh turn about nothing in particular may not cite even the first turn's material until it reads it.
    const other = createTurnScope();
    const fresh = createToolHandler(deps).forTurn(other);
    expect(parse((await fresh({ tool: "artifact_write", arguments: { title: "x", markdown: "y", sources: [material.id] }, callId: "c4" })).text).error).toMatch(/not retrieved during this turn/);
    await fresh({ tool: "material_read", arguments: { id: material.id }, callId: "c5" });
    expect([...other.seen]).toEqual([material.id]);
    expect(scope.seen.has(material.id)).toBe(true);
    expect((await fresh({ tool: "artifact_write", arguments: { title: "z", markdown: "y", sources: [material.id] }, callId: "c6" })).success).toBe(true);
    expect(changes).toHaveLength(2);
  });

  it("gives every turn its own queue: a slow call in one turn does not hold up another", async () => {
    const { deps, store } = await setup();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowStore: ToolDeps["store"] = {
      list: async () => { await gate; return store.list(); }, search: (query) => store.search(query), get: (id) => store.get(id),
      openUrl: (url, origin) => store.openUrl(url, origin), saveArtifact: (input) => store.saveArtifact(input), captureText: (id) => store.captureText(id),
    };
    const factory = createToolHandler({ ...deps, store: slowStore });
    const first = factory.forTurn(createTurnScope());
    const second = factory.forTurn(createTurnScope());
    const order: string[] = [];
    const slow = first({ tool: "library_recent", arguments: {}, callId: "c1" }).then((reply) => { order.push(`first:${reply.summary}`); });
    const queued = first({ tool: "inbox_list", arguments: {}, callId: "c2" }).then((reply) => { order.push(`first:${reply.summary}`); });
    await second({ tool: "inbox_list", arguments: {}, callId: "c3" }).then((reply) => { order.push(`second:${reply.summary}`); });
    expect(order).toEqual(["second:inbox_list → 2 items"]);
    release();
    await Promise.all([slow, queued]);
    expect(order).toEqual(["second:inbox_list → 2 items", "first:library_recent → 1 material", "first:inbox_list → 2 items"]);
  });

  it("pages the captured page through material_source and refuses materials without a capture", async () => {
    const { handle, store, material } = await setup();
    const long = `<!doctype html><html><head><title>Long page</title></head><body><nav>Menu</nav><article><h1>Long page</h1>${"<p>A paragraph of the captured page, kept verbatim for the rebuild.</p>".repeat(500)}</article></body></html>`;
    const captured = await new MaterialStore(root, async (url) => ({ bytes: new TextEncoder().encode(long), mediaType: "text/html", finalUrl: url.toString() })).openUrl("https://example.test/long");
    if (!captured.ok) throw new Error(captured.message);
    const text = (await store.captureText(captured.material.id))!;
    expect(text.length).toBeGreaterThan(PAGE_CHARS);
    const first = parse((await handle({ tool: "material_source", arguments: { id: captured.material.id }, callId: "c1" })).text);
    expect(first).toMatchObject({ ok: true, id: captured.material.id, title: "Long page", offset: 0, nextOffset: PAGE_CHARS, totalCharacters: text.length });
    expect((first.content as string).startsWith("Menu\n\n# Long page")).toBe(true);
    const second = parse((await handle({ tool: "material_source", arguments: { id: captured.material.id, offset: PAGE_CHARS }, callId: "c2" })).text);
    expect(second).toMatchObject({ offset: PAGE_CHARS, nextOffset: null });
    expect((first.content as string) + (second.content as string)).toBe(text);

    const noCapture = await handle({ tool: "material_source", arguments: { id: material.id }, callId: "c3" });
    expect(noCapture.success).toBe(false);
    expect(parse(noCapture.text).error).toMatch(/has no captured page: .* nothing to rebuild from; read it with material_read instead/);
    const unknown = await handle({ tool: "material_source", arguments: { id: "0123456789abcdef" }, callId: "c4" });
    expect(parse(unknown.text).error).toMatch(/not in the library/);
    expect(parse((await handle({ tool: "material_source", arguments: { id: captured.material.id, offset: 10_000_000 }, callId: "c5" })).text).error).toMatch(/past the end/);
  });

  it("names an unknown tool and the tools that exist", async () => {
    const { handle } = await setup();
    const reply = await handle({ tool: "delete_everything", arguments: {}, callId: "c1" });
    expect(reply.success).toBe(false);
    expect(parse(reply.text).error).toMatch(/Unknown tool delete_everything\. Available: library_search/);
  });
});
