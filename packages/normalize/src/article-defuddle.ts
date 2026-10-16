import { DefuddleClass } from "defuddle/node";

/**
 * The private image clean-ups of Defuddle 0.19.3 that Quire narrows. Defuddle
 * is pinned, and article-defuddle.test.ts fails if an upgrade renames them.
 */
type DefuddleImageCleanups = Pick<DefuddleClass, "parse"> & {
  _keepBestImage(group: Element[]): void;
  _removeCoverImage(body: Element, metadataImage: string): string | undefined;
};

// Defuddle declares these methods `private`, so a direct subclass does not typecheck.
const DefuddleBase = DefuddleClass as unknown as new (
  ...args: ConstructorParameters<typeof DefuddleClass>
) => DefuddleImageCleanups;

const FILE_EXTENSION = /\.[a-z][a-z0-9]{0,4}$/u;
// Resized-copy markers: "-1024x768", "@2x", Hugo's "_hu_<hash>", ".w800".
const RESIZE_SUFFIX = /(?:-\d+x\d+|@\d+(?:\.\d+)?x|_hu_[0-9a-f]+|\.w\d+)+$/u;

/** The image's file name without extension or resize suffixes: copies of one image share it, distinct images do not. */
export function imagePathStem(src: string) {
  const path = src.split(/[?#]/u, 1)[0] ?? "";
  const fileName = path.split("/").filter(Boolean).at(-1) ?? "";
  return fileName.toLowerCase().replace(FILE_EXTENSION, "").replace(RESIZE_SUFFIX, "");
}

function imagesByStem(images: readonly Element[]) {
  const groups = new Map<string, Element[]>();
  for (const image of images) {
    const stem = imagePathStem(image.getAttribute("src") ?? "");
    groups.set(stem, [...(groups.get(stem) ?? []), image]);
  }
  return groups;
}

/**
 * Defuddle with the two image clean-ups that delete article images narrowed:
 * - the body image matching og:image stays, since Quire never shows Defuddle's
 *   separate `result.image` and the image would simply be gone;
 * - images in one figure collapse only when they are copies of one image (same
 *   path stem), not because they share alt text: every empty-alt panel of a
 *   multi-image figure shares one alt group.
 */
export class QuireDefuddle extends DefuddleBase {
  override _removeCoverImage() {
    return undefined;
  }

  override _keepBestImage(group: Element[]) {
    // Only the per-figure pass groups figure images; the adjacency pass skips them.
    if (!group.every((image) => image.closest("figure") !== null)) {
      super._keepBestImage(group);
      return;
    }
    for (const copies of imagesByStem(group).values()) {
      if (copies.length > 1) super._keepBestImage(copies);
    }
  }
}
