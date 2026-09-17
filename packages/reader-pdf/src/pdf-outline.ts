/**
 * Reads a PDF's outline (bookmarks) as flat data so the host can render its own
 * table-of-contents rail. `level` 1 is a top-level entry; children nest deeper.
 * `page` is 1-based.
 */
export type PdfOutlineEntry = Readonly<{
  id: string;
  title: string;
  page: number;
  level: number;
}>;

type PdfOutlineNode = Readonly<{
  title: string;
  dest: string | readonly unknown[] | null;
  items: readonly PdfOutlineNode[];
}>;

/** The subset of `PDFDocumentProxy` the outline reader needs. */
export type PdfOutlineSource = Readonly<{
  getOutline(): Promise<readonly PdfOutlineNode[] | null>;
  getDestination(id: string): Promise<readonly unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}>;

type FlatOutlineNode = Readonly<{
  id: string;
  level: number;
  node: PdfOutlineNode;
}>;

function flattenOutline(
  nodes: readonly PdfOutlineNode[],
  level: number,
  idPrefix: string,
): readonly FlatOutlineNode[] {
  return nodes.flatMap((node, index) => {
    const id = `${idPrefix}${index}`;
    return [
      { id, level, node },
      ...flattenOutline(node.items ?? [], level + 1, `${id}.`),
    ];
  });
}

async function destinationArray(
  pdf: PdfOutlineSource,
  dest: PdfOutlineNode["dest"],
): Promise<readonly unknown[] | null> {
  if (typeof dest === "string") return await pdf.getDestination(dest);
  return Array.isArray(dest) ? dest : null;
}

async function resolveOutlinePage(
  pdf: PdfOutlineSource,
  dest: PdfOutlineNode["dest"],
): Promise<number | undefined> {
  const destination = await destinationArray(pdf, dest);
  const pageRef = destination?.[0];
  if (pageRef === null || pageRef === undefined) return undefined;
  // pdf.js resolves an explicit page-number destination array too (`[3, …]`),
  // but the common case is an indirect reference the document must look up.
  return (await pdf.getPageIndex(pageRef)) + 1;
}

async function outlineEntryFor(
  pdf: PdfOutlineSource,
  flat: FlatOutlineNode,
): Promise<PdfOutlineEntry | undefined> {
  let page: number | undefined;
  try {
    page = await resolveOutlinePage(pdf, flat.node.dest);
  } catch {
    // Broken PDFs routinely carry outline items whose destinations point at
    // objects that no longer exist. Skipping such an item is the deliberate
    // behaviour: the rest of the outline stays usable.
    return undefined;
  }
  if (page === undefined || !Number.isSafeInteger(page) || page < 1)
    return undefined;
  return { id: flat.id, level: flat.level, page, title: flat.node.title };
}

/**
 * Flattens the outline depth-first and resolves every item to a page.
 * Items with no resolvable page are skipped. `isCancelled` lets the caller
 * abandon the read when the document changes mid-flight.
 */
export async function readPdfOutline(
  pdf: PdfOutlineSource,
  isCancelled: () => boolean = () => false,
): Promise<readonly PdfOutlineEntry[]> {
  const nodes = (await pdf.getOutline()) ?? [];
  if (isCancelled()) return [];
  const resolved = await Promise.all(
    flattenOutline(nodes, 1, "outline:").map((item) =>
      outlineEntryFor(pdf, item),
    ),
  );
  if (isCancelled()) return [];
  return resolved.filter(
    (entry): entry is PdfOutlineEntry => entry !== undefined,
  );
}
