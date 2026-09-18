import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Settings } from "../../shared/contracts";

// One JSON file. Read into memory once; every consumer (scheduler, fetch, codex) asks the store
// at the moment it needs a value, so a change applies without a restart.

export type SettingsPatch = Partial<Omit<Settings, "dataDirectory">>;
type Stored = Omit<Settings, "dataDirectory">;

export const SETTINGS_DEFAULTS: Stored = { syncIntervalMinutes: 30, keepCapture: true, codexPath: "", agentModel: "", agentReasoningEffort: "" };
export const MIN_SYNC_MINUTES = 5;
export const MAX_SYNC_MINUTES = 1440;
export const MAX_MODEL_LENGTH = 64;
const MAX_PATH_LENGTH = 1024;
const EFFORTS: readonly Settings["agentReasoningEffort"][] = ["", "low", "medium", "high"];
const KEYS: readonly (keyof Stored)[] = ["syncIntervalMinutes", "keepCapture", "codexPath", "agentModel", "agentReasoningEffort"];

export class SettingsError extends Error {
  constructor(message: string) { super(message); this.name = "SettingsError"; }
}

function validSyncInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_SYNC_MINUTES || value > MAX_SYNC_MINUTES) throw new SettingsError(`syncIntervalMinutes must be a whole number of minutes between ${MIN_SYNC_MINUTES} and ${MAX_SYNC_MINUTES}.`);
  return value;
}
function validFlag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new SettingsError("keepCapture must be true or false.");
  return value;
}
function validModel(value: unknown): string {
  if (typeof value !== "string" || value.trim().length > MAX_MODEL_LENGTH) throw new SettingsError(`agentModel must be at most ${MAX_MODEL_LENGTH} characters, or empty for Codex's default.`);
  return value.trim();
}
function validEffort(value: unknown): Settings["agentReasoningEffort"] {
  if (!EFFORTS.includes(value as Settings["agentReasoningEffort"])) throw new SettingsError('agentReasoningEffort must be "", "low", "medium" or "high".');
  return value as Settings["agentReasoningEffort"];
}

export interface SettingsStoreOptions {
  exists?: (path: string) => boolean;
  /** A stored value that no longer validates is reported here, never dropped silently. */
  warn?: (message: string) => void;
}

export class SettingsStore {
  private current: Stored;
  private readonly exists: (path: string) => boolean;
  private readonly warn: (message: string) => void;

  constructor(private readonly path: string, private readonly dataDirectory: string, options: SettingsStoreOptions = {}) {
    this.exists = options.exists ?? existsSync;
    this.warn = options.warn ?? (() => {});
    this.current = this.load();
  }

  private load(): Stored {
    let text: string;
    try { text = readFileSync(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return SETTINGS_DEFAULTS; throw error; }
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch (error) { throw new SettingsError(`The settings file ${this.path} is not valid JSON (${(error as Error).message}). Fix or remove it.`); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new SettingsError(`The settings file ${this.path} must hold a JSON object. Fix or remove it.`);
    // A stored value that no longer validates (a codex binary that was uninstalled) falls back to its default, reported; the next update rewrites the file.
    const stored = parsed as Record<string, unknown>;
    return KEYS.reduce<Stored>((acc, key) => {
      try { return { ...acc, ...this.validated({ [key]: stored[key] }) }; }
      catch (error) { this.warn(`Ignoring the stored setting ${key} (${(error as Error).message}) and using its default.`); return acc; }
    }, SETTINGS_DEFAULTS);
  }

  get(): Settings {
    return { ...this.current, dataDirectory: this.dataDirectory };
  }

  /** Validates every field of the patch, merges, writes the file, returns the whole. Throws SettingsError with the field named. */
  update(patch: SettingsPatch): Settings {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new SettingsError("A settings patch must be an object.");
    const unknown = Object.keys(patch).filter((key) => !(KEYS as readonly string[]).includes(key));
    if (unknown.length > 0) throw new SettingsError(`Unknown or read-only setting(s): ${unknown.join(", ")}.`);
    this.current = { ...this.current, ...this.validated(patch as Record<string, unknown>) };
    this.write();
    return this.get();
  }

  private validated(patch: Record<string, unknown>): Partial<Stored> {
    const { syncIntervalMinutes, keepCapture, codexPath, agentModel, agentReasoningEffort } = patch;
    return {
      ...(syncIntervalMinutes !== undefined ? { syncIntervalMinutes: validSyncInterval(syncIntervalMinutes) } : {}),
      ...(keepCapture !== undefined ? { keepCapture: validFlag(keepCapture) } : {}),
      ...(codexPath !== undefined ? { codexPath: this.validCodexPath(codexPath) } : {}),
      ...(agentModel !== undefined ? { agentModel: validModel(agentModel) } : {}),
      ...(agentReasoningEffort !== undefined ? { agentReasoningEffort: validEffort(agentReasoningEffort) } : {}),
    };
  }

  private validCodexPath(value: unknown): string {
    if (typeof value !== "string" || value.length > MAX_PATH_LENGTH) throw new SettingsError(`codexPath must be a path of at most ${MAX_PATH_LENGTH} characters, or empty to auto-detect.`);
    const trimmed = value.trim();
    if (trimmed && !this.exists(trimmed)) throw new SettingsError(`codexPath points to ${trimmed}, which does not exist. Leave it empty to auto-detect the codex binary.`);
    return trimmed;
  }

  private write() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.current, null, 2), "utf8");
    renameSync(temp, this.path);
  }
}
