import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Figure crops of the text view live under userData/figures/<materialId>/<n>.png and reach the
// renderer through `quire-figure://<materialId>/<n>.png`, resolved like any other image.

export const FIGURE_PROTOCOL = "quire-figure:";
const FIGURE_URL = /^quire-figure:\/\/([a-f0-9]{16})\/([1-9]\d{0,3})\.png$/;

export interface FigureRef { materialId: string; index: number }

export function figureUrl(materialId: string, index: number): string {
  return `${FIGURE_PROTOCOL}//${materialId}/${index}.png`;
}

/** The material and crop a figure URL names; undefined for anything else (including malformed ids). */
export function parseFigureUrl(url: string): FigureRef | undefined {
  const match = FIGURE_URL.exec(url);
  return match ? { materialId: match[1]!, index: Number(match[2]) } : undefined;
}

export class FigureStore {
  constructor(private readonly root: string) {}

  private dirOf(materialId: string) { return join(this.root, "figures", materialId); }

  async write(materialId: string, index: number, png: Uint8Array): Promise<string> {
    await mkdir(this.dirOf(materialId), { recursive: true });
    await writeFile(join(this.dirOf(materialId), `${index}.png`), png);
    return figureUrl(materialId, index);
  }

  /** The crop as a data: URL; undefined when the URL is not a figure URL or the file is not there. */
  async read(url: string): Promise<string | undefined> {
    const ref = parseFigureUrl(url);
    if (!ref) return undefined;
    try {
      const bytes = await readFile(join(this.dirOf(ref.materialId), `${ref.index}.png`));
      return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** Removes every crop of a material (with the material, or before a rebuild). */
  async remove(materialId: string): Promise<void> {
    await rm(this.dirOf(materialId), { recursive: true, force: true });
  }
}
