import type { Creator, CreatorRole, MaterialKind, MaterialMeta, MaterialSummary } from "../../shared/contracts";

// Pure helpers over the bibliographic model: labels, name and date handling, the citation line.
// No React, no API — the Info panel, the readers, the Library and the preview all read from here.

export const MATERIAL_KINDS: readonly MaterialKind[] = ["webpage", "blogPost", "newsletter", "newsArticle", "journalArticle", "preprint", "conferencePaper", "book", "bookSection", "report", "thesis", "document", "note"];

export const KIND_LABELS: Record<MaterialKind, string> = {
  webpage: "Web page", blogPost: "Blog post", newsletter: "Newsletter", newsArticle: "News article",
  journalArticle: "Journal article", preprint: "Preprint", conferencePaper: "Conference paper",
  book: "Book", bookSection: "Book section", report: "Report", thesis: "Thesis", document: "Document", note: "Note",
};

export const CREATOR_ROLES: readonly CreatorRole[] = ["author", "editor", "translator", "contributor"];
export const ROLE_LABELS: Record<CreatorRole, string> = { author: "Author", editor: "Editor", translator: "Translator", contributor: "Contributor" };

export function isMaterialKind(value: unknown): value is MaterialKind { return typeof value === "string" && (MATERIAL_KINDS as readonly string[]).includes(value); }
export function isCreatorRole(value: unknown): value is CreatorRole { return typeof value === "string" && (CREATOR_ROLES as readonly string[]).includes(value); }

/** What the `publication` field is called for a kind: the journal, the proceedings, the blog… */
export function publicationLabel(kind: MaterialKind | undefined): string {
  switch (kind) {
    case "journalArticle": return "Journal";
    case "conferencePaper": return "Proceedings";
    case "blogPost": return "Blog";
    case "newsletter": return "Newsletter";
    case "webpage": return "Site";
    case "bookSection": return "Book";
    default: return "Publication";
  }
}

export const FIELD_LABELS: Record<Exclude<keyof MaterialMeta, "publication">, string> = {
  kind: "Type", title: "Title", shortTitle: "Short title", creators: "Creators", abstract: "Abstract",
  volume: "Volume", issue: "Issue", pages: "Pages", publisher: "Publisher", place: "Place", edition: "Edition", series: "Series",
  date: "Date", accessed: "Accessed", language: "Language", doi: "DOI", arxivId: "arXiv", isbn: "ISBN", issn: "ISSN", url: "URL",
  tags: "Tags", note: "Note", extra: "Extra", related: "Related",
};
export function fieldLabel(field: keyof MaterialMeta, kind: MaterialKind | undefined): string {
  return field === "publication" ? publicationLabel(kind) : FIELD_LABELS[field];
}

const PARTIAL_DATE = /^(\d{4})(?:-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?)?$/;
export const DATE_RULE = "Use YYYY, YYYY-MM or YYYY-MM-DD.";

/** YYYY, YYYY-MM, YYYY-MM-DD, or a full ISO timestamp (what extraction stores). */
export function isValidDate(value: string): boolean {
  if (PARTIAL_DATE.test(value)) return true;
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

/** "2024-05-21T10:00:00Z" → "2024-05-21"; partial dates stay as they are. */
export function dateFieldValue(value: string | undefined): string {
  if (!value) return "";
  return /^\d{4}-\d{2}-\d{2}T/.test(value) ? value.slice(0, 10) : value;
}

/** A date for reading: "21 May 2024", "May 2024" or "2024", from whatever precision the field has. */
export function displayDate(value: string | undefined): string {
  if (!value) return "";
  const match = PARTIAL_DATE.exec(dateFieldValue(value));
  if (!match) return value;
  const [, year, month, day] = match;
  if (!month) return year!;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day ?? "1")));
  return date.toLocaleDateString(undefined, { timeZone: "UTC", year: "numeric", month: "short", ...(day ? { day: "numeric" } : {}) });
}
export function yearOf(value: string | undefined): string { return value ? value.slice(0, 4) : ""; }

/** "Family, Given" → structured; anything else is a display name only. */
export function parseCreatorName(text: string, role: CreatorRole): Creator {
  const name = text.replace(/\s+/g, " ").trim();
  const comma = name.indexOf(",");
  if (comma > 0 && comma < name.length - 1) {
    const family = name.slice(0, comma).trim();
    const given = name.slice(comma + 1).trim();
    if (family && given) return { role, name, given, family };
  }
  return { role, name };
}

/** The names, in order, joined for a header or a row. */
export function creatorsText(creators: readonly Creator[] | undefined): string {
  return (creators ?? []).map((creator) => creator.name).filter(Boolean).join(", ");
}

/** Names as a citation reads them: "Given Family" when structured, the display name otherwise; "et al." past three. */
function citationNames(creators: readonly Creator[]): string {
  const authors = creators.filter((creator) => creator.role === "author");
  const names = (authors.length ? authors : creators).map((creator) => (creator.given && creator.family ? `${creator.given} ${creator.family}` : creator.name)).filter(Boolean);
  if (names.length === 0) return "";
  if (names.length > 3) return `${names[0]} et al.`;
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A Markdown citation line: `Names (Year). *Title*. Publication. <url>` — whatever parts exist. */
export function citationMarkdown(meta: MaterialMeta, fallback: { title: string; url: string }): string {
  const names = citationNames(meta.creators ?? []);
  const year = yearOf(meta.date);
  const title = (meta.title ?? fallback.title).trim();
  const head = [names, year ? `(${year})` : ""].filter(Boolean).join(" ");
  const sentence = (text: string) => (text.endsWith(".") ? text : `${text}.`);
  const parts = [head ? sentence(head) : "", `*${title}*.`, meta.publication ? sentence(meta.publication) : ""].filter(Boolean);
  const url = meta.url ?? fallback.url;
  return `${parts.join(" ")}${url ? ` <${url}>` : ""}`;
}

/** The header line under a title: creators · publication · date. */
export function headerParts(meta: MaterialMeta): string[] {
  return [creatorsText(meta.creators), meta.publication ?? "", displayDate(meta.date)].filter(Boolean);
}

/** The "extracted: …" text for a field, or undefined when nothing was extracted. */
export function extractedText(extracted: MaterialMeta, field: keyof MaterialMeta): string | undefined {
  const value = extracted[field];
  if (value === undefined) return undefined;
  if (field === "creators") return creatorsText(value as Creator[]) || undefined;
  if (Array.isArray(value)) return value.length ? value.join(", ") : undefined;
  if (field === "kind") return KIND_LABELS[value as MaterialKind];
  return String(value) || undefined;
}

/** Whether the effective value of a field comes from an override that differs from what was extracted. */
export function isOverridden(extracted: MaterialMeta, overrides: MaterialMeta | undefined, field: keyof MaterialMeta): boolean {
  if (!overrides || overrides[field] === undefined) return false;
  return JSON.stringify(overrides[field]) !== JSON.stringify(extracted[field]);
}

export function doiUrl(doi: string): string { return `https://doi.org/${doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:/i, "").trim()}`; }
export function arxivUrl(id: string): string { return `https://arxiv.org/abs/${id.replace(/^arxiv:/i, "").trim()}`; }

/** A summary that may carry the effective publication once the contract exposes it; the row reads it when present. */
export type SummaryWithPublication = MaterialSummary & { publication?: string };
export function publicationOf(summary: MaterialSummary): string | undefined {
  const value = (summary as SummaryWithPublication).publication;
  return typeof value === "string" && value ? value : undefined;
}
