import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Annotation } from "../../shared/contracts";
import { isMaterialViewId } from "./material-views";

const MAX_PER_MATERIAL = 2_000;
const MAX_TEXT = 20_000;

function validId(value: string) { return /^[a-f0-9]{16}$/.test(value); }

/** One JSON file per material under userData/annotations; every write rewrites the file atomically enough for a single-user app. */
export class AnnotationStore {
  constructor(private readonly root: string) {}

  private get dir() { return join(this.root, "annotations"); }
  private path(materialId: string) { return join(this.dir, `${materialId}.json`); }

  async list(materialId: string): Promise<Annotation[]> {
    if (!validId(materialId)) throw new Error("ANNOTATION_INVALID_MATERIAL");
    try { return (JSON.parse(await readFile(this.path(materialId), "utf8")) as { annotations: Annotation[] }).annotations; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  /** Inserts or replaces by id; timestamps are set here so the renderer cannot backdate. `view` names the rendering the locator belongs to. */
  async save(input: Annotation): Promise<Annotation> {
    if (!validId(input.materialId) || !validId(input.id)) throw new Error("ANNOTATION_INVALID_ID");
    if (input.view !== undefined && !isMaterialViewId(input.view)) throw new Error("ANNOTATION_INVALID_VIEW");
    if (typeof input.locator !== "string" || input.locator.length === 0 || input.locator.length > MAX_TEXT) throw new Error("ANNOTATION_INVALID_LOCATOR");
    if (typeof input.quote !== "string" || input.quote.length > MAX_TEXT || (input.note ?? "").length > MAX_TEXT) throw new Error("ANNOTATION_INVALID_TEXT");
    const existing = await this.list(input.materialId);
    const now = new Date().toISOString();
    const previous = existing.find((item) => item.id === input.id);
    if (!previous && existing.length >= MAX_PER_MATERIAL) throw new Error("ANNOTATION_LIMIT");
    const saved: Annotation = { ...input, createdAt: previous?.createdAt ?? now, updatedAt: now };
    const next = previous ? existing.map((item) => (item.id === saved.id ? saved : item)) : [...existing, saved];
    await this.write(input.materialId, next);
    return saved;
  }

  async delete(materialId: string, id: string): Promise<void> {
    const existing = await this.list(materialId);
    const next = existing.filter((item) => item.id !== id);
    if (next.length === existing.length) return;
    if (next.length === 0) { await rm(this.path(materialId), { force: true }); return; }
    await this.write(materialId, next);
  }

  /** Every annotation of a material, when the material is deleted. Unknown ids are a no-op. */
  async deleteAll(materialId: string): Promise<void> {
    if (!validId(materialId)) throw new Error("ANNOTATION_INVALID_MATERIAL");
    await rm(this.path(materialId), { force: true });
  }

  private async write(materialId: string, annotations: Annotation[]) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(materialId), JSON.stringify({ annotations }, null, 2), "utf8");
  }
}
