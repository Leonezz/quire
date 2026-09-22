import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEncryptor } from "./secrets.testing";
import { SETTINGS_DEFAULTS, SettingsError, SettingsStore } from "./settings";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-settings-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const path = () => join(root, "settings.json");
const exists = (candidate: string) => candidate === "/opt/codex/bin/codex";

describe("SettingsStore", () => {
  it("starts from the defaults with the data directory, and persists validated updates", async () => {
    const store = new SettingsStore(path(), root, { exists });
    expect(store.get()).toEqual({ ...SETTINGS_DEFAULTS, dataDirectory: root, typesafeApiKeySet: false });
    const updated = store.update({ syncIntervalMinutes: 60, keepCapture: false, codexPath: " /opt/codex/bin/codex ", agentModel: " gpt-5-codex ", agentReasoningEffort: "high", checkUpdatesAutomatically: false });
    expect(updated).toEqual({ syncIntervalMinutes: 60, keepCapture: false, codexPath: "/opt/codex/bin/codex", agentModel: "gpt-5-codex", agentReasoningEffort: "high", checkUpdatesAutomatically: false, reflowJudge: "rules", dataDirectory: root, typesafeApiKeySet: false });
    expect(JSON.parse(await readFile(path(), "utf8"))).toEqual({ syncIntervalMinutes: 60, keepCapture: false, codexPath: "/opt/codex/bin/codex", agentModel: "gpt-5-codex", agentReasoningEffort: "high", checkUpdatesAutomatically: false, reflowJudge: "rules" });
    const reopened = new SettingsStore(path(), root, { exists });
    expect(reopened.get()).toEqual(updated);
    expect(reopened.update({ codexPath: "", agentReasoningEffort: "" }).codexPath).toBe("");
  });

  it("rejects every invalid field with the field named, and leaves the stored values alone", () => {
    const store = new SettingsStore(path(), root, { exists });
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ syncIntervalMinutes: 4 }, /syncIntervalMinutes .* between 5 and 1440/],
      [{ syncIntervalMinutes: 1441 }, /syncIntervalMinutes/],
      [{ syncIntervalMinutes: 7.5 }, /syncIntervalMinutes/],
      [{ syncIntervalMinutes: "30" }, /syncIntervalMinutes/],
      [{ keepCapture: "yes" }, /keepCapture must be true or false/],
      [{ checkUpdatesAutomatically: 1 }, /checkUpdatesAutomatically must be true or false/],
      [{ codexPath: "/nowhere/codex" }, /codexPath points to \/nowhere\/codex, which does not exist/],
      [{ codexPath: 3 }, /codexPath/],
      [{ agentModel: "m".repeat(65) }, /agentModel .* 64/],
      [{ agentReasoningEffort: "max" }, /agentReasoningEffort/],
      [{ reflowJudge: "llm" }, /reflowJudge must be "rules" or "jev"/],
      [{ reflowJudge: "jev" }, /reflowJudge "jev" needs a TypeSafe API key/],
      [{ typesafeApiKey: 42 }, /typesafeApiKey must be a string/],
      [{ typesafeApiKey: "k".repeat(513) }, /typesafeApiKey .* 512/],
      [{ dataDirectory: "/elsewhere" }, /read-only setting\(s\): dataDirectory/],
      [{ typesafeApiKeySet: true }, /read-only setting\(s\): typesafeApiKeySet/],
      [{ nope: 1 }, /Unknown .* nope/],
    ];
    for (const [patch, message] of bad) {
      let error: unknown;
      try { store.update(patch); } catch (e) { error = e; }
      expect(error, JSON.stringify(patch)).toBeInstanceOf(SettingsError);
      expect((error as Error).message).toMatch(message);
    }
    expect(store.get()).toEqual({ ...SETTINGS_DEFAULTS, dataDirectory: root, typesafeApiKeySet: false });
    expect(store.update({}).syncIntervalMinutes).toBe(30);
  });

  it("stores codexPath as what will run: whitespace trimmed, ~ expanded, a directory resolved to the codex binary in it", async () => {
    const home = "/home/reader";
    const has = (candidate: string) => candidate === "/home/reader/.local/bin/codex" || candidate === "/opt/codex/bin/codex";
    const store = new SettingsStore(path(), root, { exists: has, home });
    expect(store.update({ codexPath: " ~/.local/bin/codex " }).codexPath).toBe("/home/reader/.local/bin/codex");
    expect(store.update({ codexPath: "~/.local/bin" }).codexPath).toBe("/home/reader/.local/bin/codex");
    expect(store.update({ codexPath: "/opt/codex/bin" }).codexPath).toBe("/opt/codex/bin/codex");
    expect(JSON.parse(await readFile(path(), "utf8")).codexPath).toBe("/opt/codex/bin/codex");
    expect(new SettingsStore(path(), root, { exists: has, home }).get().codexPath).toBe("/opt/codex/bin/codex");
    expect(() => store.update({ codexPath: "~/nowhere/codex" })).toThrow("codexPath points to /home/reader/nowhere/codex, which does not exist. Leave it empty to auto-detect the codex binary.");
    expect(() => store.update({ codexPath: "/nowhere/codex" })).toThrow("codexPath points to /nowhere/codex, which does not exist. Leave it empty to auto-detect the codex binary.");
    expect(store.update({ codexPath: "   " }).codexPath).toBe("");
  });

  it("refuses a file that is not JSON, and reports a stored value that no longer validates instead of dropping it silently", async () => {
    await writeFile(path(), "{ not json");
    expect(() => new SettingsStore(path(), root)).toThrow(/settings\.json is not valid JSON/);
    await writeFile(path(), JSON.stringify({ syncIntervalMinutes: 15, codexPath: "/gone/codex", agentReasoningEffort: "medium", extra: true }));
    const warnings: string[] = [];
    const store = new SettingsStore(path(), root, { exists, warn: (m) => warnings.push(m) });
    expect(store.get()).toEqual({ ...SETTINGS_DEFAULTS, syncIntervalMinutes: 15, agentReasoningEffort: "medium", dataDirectory: root, typesafeApiKeySet: false });
    expect(warnings).toEqual(["Ignoring the stored setting codexPath (codexPath points to /gone/codex, which does not exist. Leave it empty to auto-detect the codex binary.) and using its default."]);
  });

  it("stores the TypeSafe key sealed, reports only that it is set, hands it to the engine decrypted, and removes it with \"\"", async () => {
    const store = new SettingsStore(path(), root, { exists, encryptor: fakeEncryptor() });
    expect(() => store.secret("typesafeApiKey")).toThrow(/No typesafeApiKey is stored/);
    const updated = store.update({ typesafeApiKey: "  sk-typesafe-1234  " });
    expect(updated.typesafeApiKeySet).toBe(true);
    expect(JSON.stringify(updated)).not.toContain("sk-typesafe");
    const file = await readFile(path(), "utf8");
    expect(file).not.toContain("sk-typesafe");
    expect(JSON.parse(file).typesafeApiKeyEncrypted).toEqual(expect.any(String));
    expect(store.secret("typesafeApiKey")).toBe("sk-typesafe-1234");
    const reopened = new SettingsStore(path(), root, { exists, encryptor: fakeEncryptor() });
    expect(reopened.get().typesafeApiKeySet).toBe(true);
    expect(reopened.secret("typesafeApiKey")).toBe("sk-typesafe-1234");
    expect(reopened.update({ reflowJudge: "jev" }).reflowJudge).toBe("jev");
    // Removing the key takes Jev with it: the judge cannot run without the key, and that is said, not hidden.
    const removed = reopened.update({ typesafeApiKey: "" });
    expect(removed).toMatchObject({ typesafeApiKeySet: false, reflowJudge: "rules" });
    expect(JSON.parse(await readFile(path(), "utf8"))).not.toHaveProperty("typesafeApiKeyEncrypted");
    expect(() => reopened.update({ reflowJudge: "jev" })).toThrow(SettingsError);
    // Key and judge in one patch: the key is stored first, so Jev is accepted.
    expect(reopened.update({ typesafeApiKey: "sk-2", reflowJudge: "jev" })).toMatchObject({ typesafeApiKeySet: true, reflowJudge: "jev" });
  });

  it("refuses to store the key when the machine cannot encrypt, and explains a stored key that no longer decrypts", async () => {
    const store = new SettingsStore(path(), root, { exists, encryptor: fakeEncryptor(false) });
    expect(() => store.update({ typesafeApiKey: "sk-1" })).toThrow(/cannot encrypt secrets/);
    expect(store.get().typesafeApiKeySet).toBe(false);
    await writeFile(path(), JSON.stringify({ typesafeApiKeyEncrypted: Buffer.from("foreign").toString("base64"), reflowJudge: "jev" }));
    const warnings: string[] = [];
    const reopened = new SettingsStore(path(), root, { exists, encryptor: fakeEncryptor(), warn: (m) => warnings.push(m) });
    expect(reopened.get()).toMatchObject({ typesafeApiKeySet: true, reflowJudge: "jev" });
    expect(warnings).toEqual([]);
    expect(() => reopened.secret("typesafeApiKey")).toThrow(/could not be decrypted/);
    await writeFile(path(), JSON.stringify({ reflowJudge: "jev" }));
    const orphaned = new SettingsStore(path(), root, { exists, warn: (m) => warnings.push(m) });
    expect(orphaned.get().reflowJudge).toBe("rules");
    expect(warnings).toEqual([expect.stringMatching(/Ignoring the stored setting reflowJudge \(reflowJudge "jev" needs a TypeSafe API key/)]);
  });
});
