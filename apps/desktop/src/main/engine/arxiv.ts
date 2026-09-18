import type { ItemInput } from "./items";
import type { ParsedFeed } from "./feeds";

const ARCHIVES = new Set(["cs", "math", "stat", "physics", "q-bio", "q-fin", "econ", "eess", "astro-ph", "cond-mat", "gr-qc", "hep-ex", "hep-lat", "hep-ph", "hep-th", "math-ph", "nlin", "nucl-ex", "nucl-th", "quant-ph"]);
const CATEGORY = /^([a-z-]+)(\.[A-Z]{2})?$/;
const MAX_RESULTS = 50;
const READING_MINUTES = 20;

/** "cs.CL", "math.PR", "hep-th": an archive from the known list, optionally with a two-letter subject class. */
export function isArxivCategory(value: string): boolean {
  const match = CATEGORY.exec(value);
  return match !== null && ARCHIVES.has(match[1]!);
}

/**
 * The category a pasted string names: "cs.CL", "arxiv:cs.CL", "https://arxiv.org/list/cs.CL/recent",
 * "https://arxiv.org/list/cs.CL/new". Anything else (an abstract URL, a search) is not a subscription.
 */
export function arxivCategoryFromInput(input: string): string | undefined {
  const value = input.trim();
  const bare = /^(?:arxiv:)?([A-Za-z.-]+)$/i.exec(value)?.[1];
  if (bare && isArxivCategory(bare)) return bare;
  const list = /^https?:\/\/(?:www\.)?arxiv\.org\/list\/([A-Za-z.-]+)(?:\/(?:recent|new|current|pastweek|\d{4}|\d{2}))?\/?(?:[?#].*)?$/.exec(value)?.[1];
  if (list && isArxivCategory(list)) return list;
  return undefined;
}

export function arxivQueryUrl(category: string): string {
  return `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(category)}&sortBy=submittedDate&sortOrder=descending&max_results=${MAX_RESULTS}`;
}

export function arxivSourceTitle(category: string): string {
  return `arXiv ${category}`;
}

/** "2409.12345" from an abs / pdf / html URL or an Atom id, with any version suffix removed. */
export function arxivIdOf(link: string): string | undefined {
  const match = /arxiv\.org\/(?:abs|pdf|html)\/([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i.exec(link);
  return match?.[1];
}

export function arxivAbsUrl(id: string): string { return `https://arxiv.org/abs/${id}`; }
export function arxivHtmlUrl(id: string): string { return `https://arxiv.org/html/${id}`; }
export function arxivPdfUrl(id: string): string { return `https://arxiv.org/pdf/${id}`; }

/** The API answers Atom; parseFeed maps it and this turns each entry into a paper. */
export function arxivItemsOf(feed: ParsedFeed): ItemInput[] {
  return feed.items.map((item) => {
    const id = arxivIdOf(item.link) ?? arxivIdOf(item.externalId);
    return {
      externalId: id ?? item.externalId,
      title: item.title,
      link: id ? arxivAbsUrl(id) : item.link,
      publishedAt: item.publishedAt,
      gist: item.gist,
      readingMinutes: READING_MINUTES,
      signals: { math: true },
      summaryOnly: false,
    };
  });
}
