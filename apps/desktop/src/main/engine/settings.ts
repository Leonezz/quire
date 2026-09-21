import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Settings, SettingsPatch } from "../../shared/contracts";
import { openSecret, sealSecret, type Encryptor } from "./secrets";

// One JSON file. Read into memory once; every consumer (scheduler, fetch, codex, the reflow)
// asks the store at the moment it needs a value, so a change applies without a restart.
// The TypeSafe key is the one secret: stored encrypted (secrets.ts), reported only as "set",
// and handed out decrypted only to the engine through secret().

export type { SettingsPatch } from "../../shared/contracts";
type Editable = Omit<Settings, "dataDirectory" | "typesafeApiKeySet">;
/** What the file holds: the editable settings plus the sealed key (absent when none is stored). */
type Stored = Editable & { typesafeApiKeyEncrypted?: string };

export const SETTINGS_DEFAULTS: Editable = { syncIntervalMinutes: 30, keepCapture: true, codexPath: "", agentModel: "", agentReasoningEffort: "", checkUpdatesAutomatically: true, reflowJudge: "rules" };
export const MIN_SYNC_MINUTES = 5;
export const MAX_SYNC_MINUTES = 1440;
export const MAX_MODEL_LENGTH = 64;
export const MAX_API_KEY_LENGTH = 512;
const MAX_PATH_LENGTH = 1024;
const EFFORTS: readonly Settings["agentReasoningEffort"][] = ["", "low", "medium", "high"];
const JUDGES: readonly Settings["reflowJudge"][] = ["rules", "jev"];
const KEYS: readonly (keyof Editable)[] = ["syncIntervalMinutes", "keepCapture", "codexPath", "agentModel", "agentReasoningEffort", "checkUpdatesAutomatically", "reflowJudge"];
const PATCH_KEYS: readonly string[] = [...KEYS, "typesafeApiKey"];
const SECRET_KEY = "typesafeApiKeyEncrypted";

export class SettingsError extends Error {
  constructor(message: string) { super(message); this.name = "SettingsError"; }
}

function validSyncInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_SYNC_MINUTES || value > MAX_SYNC_MINUTES) throw new SettingsError(`syncIntervalMinutes must be a whole number of minutes between ${MIN_SYNC_MINUTES} and ${MAX_SYNC_MINUTES}.`);
  return value;
}
function validFlag(name: "keepCapture" | "checkUpdatesAutomatically", value: unknown): boolean {
  if (typeof value !== "boolean") throw new SettingsError(`${name} must be true or false.`);
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
function validJudge(value: unknown): Settings["reflowJudge"] {
  if (!JUDGES.includes(value as Settings["reflowJudge"])) throw new SettingsError('reflowJudge must be "rules" or "jev".');
  return value as Settings["reflowJudge"];
}
function validApiKey(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_API_KEY_LENGTH) throw new SettingsError(`typesafeApiKey must be a string of at most ${MAX_API_KEY_LENGTH} characters, or empty to remove the stored key.`);
  return value.trim();
}

export interface SettingsStoreOptions {
  exists?: (path: string) => boolean;
  /** A stored value that no longer validates is reported here, never dropped silently. */
  warn?: (message: string) => void;
  /** Seals and opens the TypeSafe key; without one no key can be stored or read (an explicit error, not an empty key). */
  encryptor?: Encryptor;
}

const noEncryptor: Encryptor = {
  available: () => false,
  encrypt: () => { throw new SettingsError("No encryptor was configured for the settings store."); },
  decrypt: () => { throw new SettingsError("No encryptor was configured for the settings store."); },
};

export class SettingsStore {
  private current: Stored;
  private readonly exists: (path: string) => boolean;
  private readonly warn: (message: string) => void;
  private readonly encryptor: Encryptor;

  constructor(private readonly path: string, private readonly dataDirectory: string, options: SettingsStoreOptions = {}) {
    this.exists = options.exists ?? existsSync;
    this.warn = options.warn ?? (() => {});
    this.encryptor = options.encryptor ?? noEncryptor;
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
    const sealed = stored[SECRET_KEY];
    if (sealed !== undefined && (typeof sealed !== "string" || sealed.length === 0)) this.warn(`Ignoring the stored ${SECRET_KEY} (not a non-empty string).`);
    const withSecret: Stored = typeof sealed === "string" && sealed.length > 0 ? { ...SETTINGS_DEFAULTS, typesafeApiKeyEncrypted: sealed } : SETTINGS_DEFAULTS;
    return KEYS.reduce<Stored>((acc, key) => {
      try { return { ...acc, ...this.validated({ [key]: stored[key] }, acc) }; }
      catch (error) { this.warn(`Ignoring the stored setting ${key} (${(error as Error).message}) and using its default.`); return acc; }
    }, withSecret);
  }

  get(): Settings {
    const { typesafeApiKeyEncrypted, ...editable } = this.current;
    return { ...editable, dataDirectory: this.dataDirectory, typesafeApiKeySet: typesafeApiKeyEncrypted !== undefined };
  }

  /**
   * Validates every field of the patch, merges, writes the file, returns the whole. Throws SettingsError with the
   * field named. `typesafeApiKey` is write-only: a value stores it sealed, "" removes it (and, because Jev cannot run
   * without it, sets the reflow judge back to the rules).
   */
  update(patch: SettingsPatch): Settings {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new SettingsError("A settings patch must be an object.");
    const unknown = Object.keys(patch).filter((key) => !PATCH_KEYS.includes(key));
    if (unknown.length > 0) throw new SettingsError(`Unknown or read-only setting(s): ${unknown.join(", ")}.`);
    const { typesafeApiKey, ...rest } = patch as Record<string, unknown> & { typesafeApiKey?: unknown };
    const base = typesafeApiKey !== undefined ? this.withSecret(validApiKey(typesafeApiKey)) : this.current;
    this.current = { ...base, ...this.validated(rest, base) };
    this.write();
    return this.get();
  }

  /** The decrypted TypeSafe key, for the engine only; throws when none is stored or it cannot be opened. */
  secret(name: "typesafeApiKey"): string {
    const sealed = this.current.typesafeApiKeyEncrypted;
    if (sealed === undefined) throw new SettingsError(`No ${name} is stored. Enter the TypeSafe API key in Settings › Agent.`);
    return openSecret(this.encryptor, sealed, name);
  }

  /** The current settings with the key stored (sealed) or, for "", removed together with a Jev choice that depended on it. */
  private withSecret(key: string): Stored {
    if (key.length > 0) return { ...this.current, typesafeApiKeyEncrypted: sealSecret(this.encryptor, key) };
    const { typesafeApiKeyEncrypted: _dropped, ...withoutSecret } = this.current;
    return this.current.reflowJudge === "jev" ? { ...withoutSecret, reflowJudge: "rules" } : withoutSecret;
  }

  private validated(patch: Record<string, unknown>, against: Stored): Partial<Editable> {
    const { syncIntervalMinutes, keepCapture, codexPath, agentModel, agentReasoningEffort, checkUpdatesAutomatically, reflowJudge } = patch;
    return {
      ...(syncIntervalMinutes !== undefined ? { syncIntervalMinutes: validSyncInterval(syncIntervalMinutes) } : {}),
      ...(keepCapture !== undefined ? { keepCapture: validFlag("keepCapture", keepCapture) } : {}),
      ...(codexPath !== undefined ? { codexPath: this.validCodexPath(codexPath) } : {}),
      ...(agentModel !== undefined ? { agentModel: validModel(agentModel) } : {}),
      ...(agentReasoningEffort !== undefined ? { agentReasoningEffort: validEffort(agentReasoningEffort) } : {}),
      ...(checkUpdatesAutomatically !== undefined ? { checkUpdatesAutomatically: validFlag("checkUpdatesAutomatically", checkUpdatesAutomatically) } : {}),
      ...(reflowJudge !== undefined ? { reflowJudge: validReflowJudge(reflowJudge, against) } : {}),
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

function validReflowJudge(value: unknown, against: Stored): Settings["reflowJudge"] {
  const judge = validJudge(value);
  if (judge === "jev" && against.typesafeApiKeyEncrypted === undefined) throw new SettingsError('reflowJudge "jev" needs a TypeSafe API key: store the key first (Settings › Agent), then choose Jev.');
  return judge;
}
