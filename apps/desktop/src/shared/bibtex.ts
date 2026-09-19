import type { Creator, MaterialKind, MaterialMeta } from "./contracts";

// One BibTeX entry from a material's effective metadata. Pure and dependency-free: the main
// process exports with it and the renderer can preview with it.

type EntryType = "article" | "inproceedings" | "book" | "incollection" | "techreport" | "phdthesis" | "misc";

const ENTRY_TYPES: Record<MaterialKind, EntryType> = {
  journalArticle: "article", conferencePaper: "inproceedings", book: "book", bookSection: "incollection", report: "techreport", thesis: "phdthesis",
  preprint: "misc", webpage: "misc", blogPost: "misc", newsletter: "misc", newsArticle: "misc", document: "misc", note: "misc",
};
const WEB_KINDS: ReadonlySet<MaterialKind> = new Set(["webpage", "blogPost", "newsletter", "newsArticle", "document", "note"]);
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The characters BibTeX/LaTeX would otherwise read as markup. */
export function escapeBibtex(value: string): string {
  return value.replace(/[{}&%#_$]/g, (char) => `\\${char}`);
}

function ascii(value: string): string {
  return value.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function firstWord(value: string | undefined): string {
  return value?.trim().split(/\s+/)[0] ?? "";
}

function familyOf(creator: Creator): string {
  return creator.family ?? creator.name.trim().split(/\s+/).pop() ?? creator.name;
}

/** "lindqvist2026retrieval": first author's family (or the title's first word), the year, the title's first word. */
export function bibtexKeyOf(meta: MaterialMeta, fallbackKey: string): string {
  const authors = (meta.creators ?? []).filter((c) => c.role === "author");
  const head = ascii(authors[0] ? familyOf(authors[0]) : firstWord(meta.title));
  const year = meta.date?.slice(0, 4) ?? "";
  // A CJK-only author or title leaves nothing ASCII: a bare year is not a key, so fall back to the material id.
  if (!head) return `${ascii(fallbackKey) || "quire"}${year}`;
  return `${head}${year}${authors[0] ? ascii(firstWord(meta.title)) : ""}`;
}

function formatCreator(creator: Creator): string {
  return creator.family && creator.given ? `${creator.family}, ${creator.given}` : creator.name;
}

function names(creators: readonly Creator[] | undefined, role: Creator["role"]): string | undefined {
  const matching = (creators ?? []).filter((c) => c.role === role);
  return matching.length > 0 ? matching.map(formatCreator).join(" and ") : undefined;
}

function monthOf(date: string | undefined): string | undefined {
  const month = date ? Number(date.slice(5, 7)) : NaN;
  return month >= 1 && month <= 12 ? MONTHS[month - 1] : undefined;
}

/** "cs.CL" from a Zotero-style extra line "arXiv: 2409.12345 [cs.CL]". */
function primaryClassOf(extra: string | undefined): string | undefined {
  return extra ? /arxiv:[^\n]*\[([\w.-]+)\]/i.exec(extra)?.[1] : undefined;
}

type Field = [name: string, value: string | undefined, raw?: boolean];

function fieldsOf(meta: MaterialMeta, kind: MaterialKind): Field[] {
  const pages = meta.pages?.replace(/(\d)\s*[-–]\s*(\d)/, "$1--$2");
  const byType: Record<EntryType, Field[]> = {
    article: [["journal", meta.publication], ["volume", meta.volume], ["number", meta.issue], ["pages", pages], ["issn", meta.issn]],
    inproceedings: [["booktitle", meta.publication], ["pages", pages], ["publisher", meta.publisher], ["address", meta.place], ["isbn", meta.isbn]],
    book: [["publisher", meta.publisher], ["address", meta.place], ["edition", meta.edition], ["series", meta.series], ["isbn", meta.isbn]],
    incollection: [["booktitle", meta.publication], ["pages", pages], ["publisher", meta.publisher], ["address", meta.place], ["edition", meta.edition], ["isbn", meta.isbn]],
    techreport: [["institution", meta.publisher], ["address", meta.place], ["number", meta.series]],
    phdthesis: [["school", meta.publisher], ["address", meta.place]],
    misc: kind === "preprint"
      ? [["eprint", meta.arxivId], ["archivePrefix", meta.arxivId ? "arXiv" : undefined], ["primaryClass", meta.arxivId ? primaryClassOf(meta.extra) : undefined], ["publisher", meta.publisher]]
      : [["howpublished", meta.url ? `\\url{${meta.url}}` : undefined, true], ["publisher", meta.publisher]],
  };
  const accessed = meta.accessed?.slice(0, 10);
  return [
    ["author", names(meta.creators, "author")], ["editor", names(meta.creators, "editor")],
    ["title", meta.title ? `{${escapeBibtex(meta.title)}}` : undefined, true],
    ...byType[ENTRY_TYPES[kind]],
    ["year", meta.date?.slice(0, 4)], ["month", monthOf(meta.date), true],
    ["doi", meta.doi], ["url", meta.url], ["urldate", accessed],
    ["note", WEB_KINDS.has(kind) && accessed ? `Accessed ${accessed}` : undefined],
  ];
}

/** The entry for one material; `fallbackKey` names it when neither an author nor a title is known. */
export function bibtexOf(meta: MaterialMeta, fallbackKey: string): string {
  const kind = meta.kind ?? "webpage";
  const lines = fieldsOf(meta, kind)
    .filter((field): field is [string, string, boolean?] => typeof field[1] === "string" && field[1].length > 0)
    .map(([name, value, raw]) => (name === "month" ? `  ${name} = ${value}` : `  ${name} = {${raw ? value : escapeBibtex(value)}}`));
  return `@${ENTRY_TYPES[kind]}{${bibtexKeyOf(meta, fallbackKey)},\n${lines.join(",\n")}\n}`;
}
