import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createMarkdownRepresentations, normalizeArticleCapture, type ContentMaterialization, type NormalizationProblem } from "@read/normalize";
import type { MaterialRecord, MaterialSummary, OpenUrlResult } from "../../shared/contracts";
import { FetchError, assertPublicHttpUrl, fetchPage } from "./fetch";

const BUDGET = { maxBytes: 8 * 1024 * 1024, maxDepth: 100, maxNodes: 100_000, maxOutputBytes: 8 * 1024 * 1024 };
const WORDS_PER_MINUTE = 240;

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function idFor(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function readingMinutes(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

function pick(materialization: ContentMaterialization) {
  const by = (schema: string) => materialization.representations.find((r) => r.schema === schema)?.content;
  const v2 = by("reader.document.v2");
  const v1 = by("reader.document.v1");
  const reader = v2 ? { schema: "reader.document.v2" as const, payload: v2 } : v1 ? { schema: "reader.document.v1" as const, payload: v1 } : undefined;
  return { reader, markdown: by("agent.gfm.v1"), plain: by("selection.text.v1") };
}

/** Materials on disk: one JSON per material, an index for lists. Enough for M0; SQLite arrives with M1. */
export class MaterialStore {
  constructor(private readonly root: string) {}

  private get dir() { return join(this.root, "materials"); }

  async openUrl(raw: string): Promise<OpenUrlResult> {
    try {
      const url = assertPublicHttpUrl(raw);
      const page = await fetchPage(url);
      const record = this.materialize(page.bytes, page.mediaType, page.finalUrl, raw);
      await this.save(record);
      return { ok: true, material: record };
    } catch (error) {
      if (error instanceof FetchError) return { ok: false, code: error.code, message: error.message };
      return { ok: false, code: "NORMALIZE_FAILED", message: error instanceof Error ? error.message : "Could not read this page." };
    }
  }

  private materialize(bytes: Uint8Array, mediaType: string, finalUrl: string, requestedUrl: string): MaterialRecord {
    const fetchedAt = new Date().toISOString();
    const base = { id: idFor(finalUrl), url: requestedUrl, finalUrl, mediaType, fetchedAt, origin: "web" as const };
    if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
      const outcome = normalizeArticleCapture({ budget: BUDGET, capture: { baseLocator: finalUrl, bytes, contentIdentity: sha256(bytes), mediaType } });
      if (!outcome.ok) {
        const plain = outcome.fallbackText ?? "";
        return { ...base, title: new URL(finalUrl).hostname, plain, readingMinutes: readingMinutes(plain), quality: degradedQuality(outcome.problems), problems: outcome.problems };
      }
      const { article } = outcome;
      const parts = pick(article.materialization);
      return {
        ...base,
        title: article.title,
        ...(article.byline ? { byline: article.byline } : {}),
        ...(article.publishedAt ? { publishedAt: article.publishedAt } : {}),
        ...(article.lang ? { lang: article.lang } : {}),
        ...(article.dir ? { dir: article.dir } : {}),
        ...(parts.reader ? { reader: parts.reader } : {}),
        ...(parts.markdown ? { markdown: parts.markdown } : {}),
        ...(parts.plain ? { plain: parts.plain } : {}),
        readingMinutes: readingMinutes(parts.plain ?? parts.markdown ?? ""),
        quality: article.materialization.quality,
        problems: outcome.problems,
      };
    }
    if (mediaType === "text/markdown" || mediaType === "text/plain" || mediaType === "text/x-markdown") {
      const content = new TextDecoder("utf-8").decode(bytes);
      const { representations } = createMarkdownRepresentations({ baseUri: finalUrl, content, maxDepth: BUDGET.maxDepth, maxNodes: BUDGET.maxNodes, maxOutputBytes: BUDGET.maxOutputBytes, outputBudgetErrorCode: "MARKDOWN_TOO_LARGE" });
      const by = (schema: string) => representations.find((r) => r.schema === schema)?.content;
      const v2 = by("reader.document.v2"); const v1 = by("reader.document.v1");
      const title = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? new URL(finalUrl).pathname.split("/").pop() ?? finalUrl;
      return {
        ...base, title,
        ...(v2 ? { reader: { schema: "reader.document.v2" as const, payload: v2 } } : v1 ? { reader: { schema: "reader.document.v1" as const, payload: v1 } } : {}),
        markdown: content, readingMinutes: readingMinutes(content),
        quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "derived", safety: "safe", warnings: [] },
        problems: [],
      };
    }
    throw new FetchError("UNSUPPORTED_TYPE", `This is ${mediaType}; only pages, Markdown and plain text can be read in M0.`);
  }

  private async save(record: MaterialRecord) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${record.id}.json`), JSON.stringify(record), "utf8");
  }

  async get(id: string): Promise<MaterialRecord | undefined> {
    if (!/^[a-f0-9]{16}$/.test(id)) return undefined;
    try { return JSON.parse(await readFile(join(this.dir, `${id}.json`), "utf8")) as MaterialRecord; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async list(): Promise<MaterialSummary[]> {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir)).filter((name) => name.endsWith(".json"));
    const records = await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(this.dir, name), "utf8")) as MaterialRecord));
    return records
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))
      .map(({ id, url, title, byline, publishedAt, fetchedAt, readingMinutes, origin, quality }) => ({ id, url, title, fetchedAt, readingMinutes, origin, quality, ...(byline ? { byline } : {}), ...(publishedAt ? { publishedAt } : {}) }));
  }
}

function degradedQuality(problems: NormalizationProblem[]) {
  return { completeness: "none" as const, conformance: "recoverable" as const, identityConfidence: "derived" as const, safety: "degraded_plaintext" as const, warnings: problems };
}
