import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { StorageUsage } from "../../shared/contracts";
import { DATABASE_FILE } from "./db";

// What Settings › Storage shows: the bytes in the data directory, by what they hold, measured each
// time it is asked. The directories are the stores' own: MaterialStore, ImageCache and FigureStore.

/** In WAL mode SQLite keeps two files beside the database; they are the database too. */
const DATABASE_FILES = [DATABASE_FILE, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`];

export async function storageUsage(dataDirectory: string): Promise<StorageUsage> {
  const [materials, images, figures, database] = await Promise.all([
    directoryBytes(join(dataDirectory, "materials")),
    directoryBytes(join(dataDirectory, "images")),
    directoryBytes(join(dataDirectory, "figures")),
    Promise.all(DATABASE_FILES.map((name) => fileBytes(join(dataDirectory, name)))).then(sum),
  ]);
  return { materials, images, figures, database };
}

/** Every file below the directory; a directory that was never written holds nothing. */
async function directoryBytes(path: string): Promise<number> {
  let entries: Dirent[];
  try { entries = await readdir(path, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  const sizes = await Promise.all(entries.map((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return directoryBytes(child);
    return entry.isFile() ? fileBytes(child) : 0;
  }));
  return sum(sizes);
}

/** A file's size; one removed since it was listed (or never written) holds nothing. */
async function fileBytes(path: string): Promise<number> {
  try { return (await stat(path)).size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
