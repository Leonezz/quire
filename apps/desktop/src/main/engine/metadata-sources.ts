import { parseHTML } from "linkedom";
import type { Creator, MaterialMeta } from "../../shared/contracts";

// What a page declares about itself, read from its <head>: Highwire citation_* tags (what
// Google Scholar reads), Dublin Core, JSON-LD, Open Graph and the plain author / lang
// attributes. Each source is returned as its own layer; metadata.ts decides precedence.

/** Hints for kind inference that are not fields of their own. */
export interface PageSignals {
  journal?: boolean;
  conference?: boolean;
  thesis?: boolean;
  report?: boolean;
  book?: boolean;
  news?: boolean;
  blog?: boolean;
  scholarly?: boolean;
}

export interface PageSources {
  /** In precedence order: Highwire, Dublin Core, JSON-LD, Open Graph, plain <meta>/<html lang>. */
  layers: MaterialMeta[];
  /** og:site_name; only a publication for web kinds, so it is kept apart. */
  siteName?: string;
  signals: PageSignals;
}

/** Only the head matters and JSON-LD sits near it; a huge page is not parsed whole. */
export const HEAD_BYTES = 256 * 1024;
const MAX_CREATORS = 50;
const JSON_LD_TYPES: Record<string, keyof PageSignals | "article"> = {
  Article: "article", BlogPosting: "blog", NewsArticle: "news", ScholarlyArticle: "scholarly", TechArticle: "article", Book: "book", Report: "report",
};

interface MetaTag { name: string; content: string }

function clean(value: string | null | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? text : undefined;
}

/** "Family, Given" becomes a structured name; anything else is kept as displayed. */
export function creatorOf(raw: string, role: Creator["role"] = "author"): Creator | undefined {
  const name = clean(raw);
  if (!name) return undefined;
  const comma = name.split(",");
  if (comma.length === 2) {
    const family = clean(comma[0]); const given = clean(comma[1]);
    if (family && given) return { role, name: `${given} ${family}`, given, family };
  }
  return { role, name };
}

function creatorsOf(values: readonly string[], role: Creator["role"] = "author"): Creator[] {
  return values.map((value) => creatorOf(value, role)).filter((c): c is Creator => c !== undefined).slice(0, MAX_CREATORS);
}

function compact(meta: MaterialMeta): MaterialMeta {
  return Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0))) as MaterialMeta;
}

function highwireOf(tags: readonly MetaTag[], signals: PageSignals): MaterialMeta {
  const all = (name: string) => tags.filter((tag) => tag.name === name).map((tag) => tag.content);
  const one = (...names: string[]) => names.map((name) => all(name)[0]).find((value) => value !== undefined);
  const journal = one("citation_journal_title"); const conference = one("citation_conference_title");
  const report = one("citation_technical_report_institution"); const thesis = one("citation_dissertation_institution");
  if (journal) signals.journal = true;
  if (conference) signals.conference = true;
  if (report) signals.report = true;
  if (thesis) signals.thesis = true;
  const first = one("citation_firstpage"); const last = one("citation_lastpage");
  return compact({
    title: one("citation_title"), creators: creatorsOf(all("citation_author")),
    date: one("citation_publication_date", "citation_date", "citation_online_date"),
    publication: journal ?? conference, volume: one("citation_volume"), issue: one("citation_issue"),
    pages: first ? (last ? `${first}-${last}` : first) : undefined,
    doi: one("citation_doi"), isbn: one("citation_isbn"), issn: one("citation_issn"),
    publisher: one("citation_publisher") ?? report ?? thesis, language: one("citation_language"),
    abstract: one("citation_abstract"), arxivId: one("citation_arxiv_id"),
  });
}

const DOI_IN_TEXT = /\b(10\.\d{4,9}\/\S+)/i;

function dublinCoreOf(tags: readonly MetaTag[]): MaterialMeta {
  const dc = tags.flatMap((tag) => { const match = /^(?:dc|dcterms)\.(\w+)$/.exec(tag.name); return match ? [{ name: match[1]!, content: tag.content }] : []; });
  const all = (name: string) => dc.filter((tag) => tag.name === name).map((tag) => tag.content);
  const one = (...names: string[]) => names.map((name) => all(name)[0]).find((value) => value !== undefined);
  const doi = all("identifier").map((value) => DOI_IN_TEXT.exec(value)?.[1]).find((value) => value !== undefined);
  return compact({
    title: one("title"), creators: creatorsOf(all("creator")), date: one("date", "issued", "created"),
    publisher: one("publisher"), language: one("language"), abstract: one("abstract"), doi,
  });
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Every node of a JSON-LD document: top-level arrays and @graph members, in order. */
function nodesOf(value: unknown): Json[] {
  if (Array.isArray(value)) return value.flatMap(nodesOf);
  if (!isObject(value)) return [];
  const graph = value["@graph"];
  return [value, ...(Array.isArray(graph) ? graph.flatMap(nodesOf) : [])];
}

function typesOf(node: Json): string[] {
  const type = node["@type"];
  return (Array.isArray(type) ? type : [type]).filter((t): t is string => typeof t === "string");
}

function nameOf(value: unknown): string | undefined {
  if (typeof value === "string") return clean(value);
  return isObject(value) ? clean(typeof value.name === "string" ? value.name : undefined) : undefined;
}

function creatorsOfJsonLd(value: unknown): Creator[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries.flatMap((entry): Creator[] => {
    if (typeof entry === "string") { const creator = creatorOf(entry); return creator ? [creator] : []; }
    if (!isObject(entry)) return [];
    const given = clean(typeof entry.givenName === "string" ? entry.givenName : undefined);
    const family = clean(typeof entry.familyName === "string" ? entry.familyName : undefined);
    const name = nameOf(entry) ?? (given && family ? `${given} ${family}` : undefined);
    if (!name) return [];
    return [{ role: "author", name, ...(given ? { given } : {}), ...(family ? { family } : {}) }];
  }).slice(0, MAX_CREATORS);
}

function jsonLdOf(scripts: readonly string[], signals: PageSignals): MaterialMeta {
  for (const script of scripts) {
    let parsed: unknown;
    try { parsed = JSON.parse(script); } catch { continue; }
    for (const node of nodesOf(parsed)) {
      const kinds = typesOf(node).map((type) => JSON_LD_TYPES[type]).filter((kind): kind is NonNullable<typeof kind> => kind !== undefined);
      if (kinds.length === 0) continue;
      for (const kind of kinds) if (kind !== "article") signals[kind] = true;
      const publisher = nameOf(node.publisher);
      const partOf = nameOf(node.isPartOf) ?? nameOf(node.publication);
      return compact({
        title: clean(typeof node.headline === "string" ? node.headline : typeof node.name === "string" ? node.name : undefined),
        creators: creatorsOfJsonLd(node.author), date: clean(typeof node.datePublished === "string" ? node.datePublished : undefined),
        publisher, publication: partOf, language: clean(typeof node.inLanguage === "string" ? node.inLanguage : undefined),
        abstract: kinds.includes("scholarly") && typeof node.description === "string" ? clean(node.description) : undefined,
      });
    }
  }
  return {};
}

function openGraphOf(tags: readonly MetaTag[]): { layer: MaterialMeta; siteName?: string } {
  const all = (name: string) => tags.filter((tag) => tag.name === name).map((tag) => tag.content);
  const authors = all("article:author").filter((value) => !/^https?:\/\//i.test(value));
  const siteName = all("og:site_name")[0];
  const locale = all("og:locale")[0]?.replace("_", "-");
  return {
    layer: compact({ title: all("og:title")[0], creators: creatorsOf(authors), date: all("article:published_time")[0], language: locale }),
    ...(siteName ? { siteName } : {}),
  };
}

interface Parsed { tags: MetaTag[]; scripts: string[]; lang?: string }

interface DomElement { getAttribute: (name: string) => string | null; textContent: string | null }

function parseHead(html: string): Parsed {
  const { document } = parseHTML(html.slice(0, HEAD_BYTES));
  const tags: MetaTag[] = [];
  for (const element of Array.from(document.querySelectorAll("meta")) as unknown as DomElement[]) {
    const name = clean(element.getAttribute("name") ?? element.getAttribute("property"))?.toLowerCase();
    const content = clean(element.getAttribute("content"));
    if (name && content) tags.push({ name, content });
  }
  const scripts = (Array.from(document.querySelectorAll('script[type="application/ld+json"]')) as unknown as DomElement[]).map((element) => element.textContent ?? "");
  const lang = clean((document.documentElement as unknown as DomElement | null)?.getAttribute("lang"));
  return { tags, scripts, ...(lang ? { lang } : {}) };
}

/** The declared metadata of a page, one layer per source, most authoritative first. */
export function readPageSources(html: string): PageSources {
  const { tags, scripts, lang } = parseHead(html);
  const signals: PageSignals = {};
  const highwire = highwireOf(tags, signals);
  const dublinCore = dublinCoreOf(tags);
  const jsonLd = jsonLdOf(scripts, signals);
  const openGraph = openGraphOf(tags);
  const plain = compact({ creators: creatorsOf(tags.filter((tag) => tag.name === "author").map((tag) => tag.content)), language: lang });
  return { layers: [highwire, dublinCore, jsonLd, openGraph.layer, plain], ...(openGraph.siteName ? { siteName: openGraph.siteName } : {}), signals };
}
