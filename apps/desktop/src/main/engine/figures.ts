import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Figure crops of the text view live under userData/figures/<materialId>/<n>.png and are named
// `quire-figure://<materialId>/<n>.png` in the text view, resolved like any other image (to the
// quire-image:// URL main serves the crop on; see images.ts).

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

  private pathOf(ref: FigureRef) { return join(this.dirOf(ref.materialId), `${ref.index}.png`); }

  /** Whether the crop is on disk. */
  async has(ref: FigureRef): Promise<boolean> {
    try { await access(this.pathOf(ref)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }

  /** The crop's PNG bytes for the protocol; undefined when the file is not there. */
  async bytes(ref: FigureRef): Promise<Uint8Array<ArrayBuffer> | undefined> {
    try { return await readFile(this.pathOf(ref)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  /** Removes every crop of a material (with the material, or before a rebuild). */
  async remove(materialId: string): Promise<void> {
    await rm(this.dirOf(materialId), { recursive: true, force: true });
  }
}
