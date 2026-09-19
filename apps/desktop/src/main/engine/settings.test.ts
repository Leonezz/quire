import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETTINGS_DEFAULTS, SettingsError, SettingsStore } from "./settings";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-settings-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const path = () => join(root, "settings.json");
const exists = (candidate: string) => candidate === "/opt/codex/bin/codex";

describe("SettingsStore", () => {
  it("starts from the defaults with the data directory, and persists validated updates", async () => {
    const store = new SettingsStore(path(), root, { exists });
    expect(store.get()).toEqual({ ...SETTINGS_DEFAULTS, dataDirectory: root });
    const updated = store.update({ syncIntervalMinutes: 60, keepCapture: false, codexPath: " /opt/codex/bin/codex ", agentModel: " gpt-5-codex ", agentReasoningEffort: "high", checkUpdatesAutomatically: false });
    expect(updated).toEqual({ syncIntervalMinutes: 60, keepCapture: false, codexPath: "/opt/codex/bin/codex", agentModel: "gpt-5-codex", agentReasoningEffort: "high", checkUpdatesAutomatically: false, dataDirectory: root });
    expect(JSON.parse(await readFile(path(), "utf8"))).toEqual({ syncIntervalMinutes: 60, keepCapture: false, codexPath: "/opt/codex/bin/codex", agentModel: "gpt-5-codex", agentReasoningEffort: "high", checkUpdatesAutomatically: false });
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
      [{ dataDirectory: "/elsewhere" }, /read-only setting\(s\): dataDirectory/],
      [{ nope: 1 }, /Unknown .* nope/],
    ];
    for (const [patch, message] of bad) {
      let error: unknown;
      try { store.update(patch); } catch (e) { error = e; }
      expect(error, JSON.stringify(patch)).toBeInstanceOf(SettingsError);
      expect((error as Error).message).toMatch(message);
    }
    expect(store.get()).toEqual({ ...SETTINGS_DEFAULTS, dataDirectory: root });
    expect(store.update({}).syncIntervalMinutes).toBe(30);
  });

  it("refuses a file that is not JSON, and reports a stored value that no longer validates instead of dropping it silently", async () => {
    await writeFile(path(), "{ not json");
    expect(() => new SettingsStore(path(), root)).toThrow(/settings\.json is not valid JSON/);
    await writeFile(path(), JSON.stringify({ syncIntervalMinutes: 15, codexPath: "/gone/codex", agentReasoningEffort: "medium", extra: true }));
    const warnings: string[] = [];
    const store = new SettingsStore(path(), root, { exists, warn: (m) => warnings.push(m) });
    expect(store.get()).toEqual({ ...SETTINGS_DEFAULTS, syncIntervalMinutes: 15, agentReasoningEffort: "medium", dataDirectory: root });
    expect(warnings).toEqual(["Ignoring the stored setting codexPath (codexPath points to /gone/codex, which does not exist. Leave it empty to auto-detect the codex binary.) and using its default."]);
  });
});
