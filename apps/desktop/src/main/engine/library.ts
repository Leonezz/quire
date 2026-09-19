import type { LibraryFilter, MaterialSummary } from "../../shared/contracts";
import { searchWords } from "./search";

// The Library view: filter and sort over the summaries MaterialStore lists. Pure, so the
// renderer's every click is one call with no store access of its own.

type Kind = NonNullable<LibraryFilter["kind"]>;

const KINDS: Record<Kind, (material: MaterialSummary) => boolean> = {
  all: () => true,
  /** Text materials that are not the agent's artifacts. */
  articles: (material) => material.mediaType !== "application/pdf" && material.origin !== "agent",
  pdf: (material) => material.mediaType === "application/pdf",
  artifact: (material) => material.origin === "agent",
  feed: (material) => material.origin === "feed",
};

const byFetched = (a: MaterialSummary, b: MaterialSummary) => b.fetchedAt.localeCompare(a.fetchedAt);
const byTitle = (a: MaterialSummary, b: MaterialSummary) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }) || byFetched(a, b);
/** Newest published first; materials without a date come last, newest fetched first among them. */
function byPublished(a: MaterialSummary, b: MaterialSummary): number {
  if (a.publishedAt && b.publishedAt) return b.publishedAt.localeCompare(a.publishedAt) || byFetched(a, b);
  if (a.publishedAt) return -1;
  if (b.publishedAt) return 1;
  return byFetched(a, b);
}

function matchesQuery(material: MaterialSummary, words: readonly string[]): boolean {
  const haystack = `${material.title} ${material.byline ?? ""} ${material.tags.join(" ")}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function queryLibrary(summaries: readonly MaterialSummary[], filter: LibraryFilter): MaterialSummary[] {
  const kind = KINDS[filter.kind ?? "all"];
  const tag = filter.tag?.trim().toLowerCase();
  const words = searchWords(filter.query ?? "");
  const compare = filter.sort === "published" ? byPublished : filter.sort === "title" ? byTitle : byFetched;
  return summaries
    .filter((material) => kind(material))
    .filter((material) => !filter.materialKind || material.kind === filter.materialKind)
    .filter((material) => !tag || material.tags.some((candidate) => candidate.toLowerCase() === tag))
    .filter((material) => words.length === 0 || matchesQuery(material, words))
    .sort(compare);
}

export interface DeleteDeps {
  store: { delete: (ids: readonly string[]) => Promise<number> };
  annotations: { deleteAll: (materialId: string) => Promise<void> };
  items: { unlinkMaterial: (materialId: string) => number };
}

/** Removes the records and their bytes, their annotations and overrides, and unlinks the items that were read as them. */
export async function deleteMaterials(ids: readonly string[], deps: DeleteDeps): Promise<{ deleted: number; unlinkedItems: number }> {
  const deleted = await deps.store.delete(ids);
  await Promise.all(ids.map((id) => deps.annotations.deleteAll(id)));
  const unlinkedItems = ids.reduce((sum, id) => sum + deps.items.unlinkMaterial(id), 0);
  return { deleted, unlinkedItems };
}
