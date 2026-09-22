import { join } from "node:path";

// What a configured Codex path means, shared by the settings' validation and the client's resolution
// so that whatever validates is exactly what runs: whitespace trimmed, a leading "~" expanded against
// the home directory, and a directory that holds a codex binary resolved to that binary.

/** Trims `raw` and expands a leading "~" or "~/" against `home`; an empty value stays "". */
export function expandCodexPath(raw: string, home: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return join(home, trimmed.slice(2));
  return trimmed;
}

/**
 * The binary a path names: `<path>/codex` when the path is a directory holding one, else the path
 * itself when it exists (a binary, or the npm shim). Undefined when neither exists; "" is never a binary.
 */
export function codexBinaryAt(path: string, exists: (candidate: string) => boolean): string | undefined {
  if (path.length === 0) return undefined;
  const inDirectory = join(path, "codex");
  if (exists(inDirectory)) return inDirectory;
  return exists(path) ? path : undefined;
}
