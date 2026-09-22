// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings, SettingsPatch, TextViewReport } from "../../shared/contracts";
import { flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { agentStore } from "./agentStore";
import { JEV_PRIVACY_NOTE, SettingsSheet } from "./SettingsSheet";
import { textViewReportText } from "./TextViewBanner";

const base: Settings = { syncIntervalMinutes: 30, keepCapture: true, codexPath: "", agentModel: "", agentReasoningEffort: "", dataDirectory: "/data", checkUpdatesAutomatically: false, reflowJudge: "rules", typesafeApiKeySet: false };

/** A settings engine in memory: the key is stored as a flag, Jev is refused without it, removing the key resets Jev. */
function engine(initial: Settings) {
  let current = initial;
  const updateSettings = vi.fn(async (patch: SettingsPatch) => {
    const { typesafeApiKey, ...rest } = patch;
    if (rest.reflowJudge === "jev" && !current.typesafeApiKeySet && !typesafeApiKey) throw new Error('reflowJudge "jev" needs a TypeSafe API key: store the key first (Settings › Agent), then choose Jev.');
    const keyPatch = typesafeApiKey !== undefined ? { typesafeApiKeySet: typesafeApiKey.length > 0, ...(typesafeApiKey.length === 0 && current.reflowJudge === "jev" ? { reflowJudge: "rules" as const } : {}) } : {};
    current = { ...current, ...rest, ...keyPatch };
    return current;
  });
  api.read = mockRead({
    getSettings: vi.fn(async () => current), updateSettings,
    agentStatus: vi.fn(async () => ({ available: false, reason: "Codex is not installed.", running: 0 })),
    getUpdateState: vi.fn(async () => ({ phase: "idle" as const, current: "0.1.0" })),
  });
  return { updateSettings };
}

async function mount(initial: Settings) {
  const handles = engine(initial);
  render(<SettingsSheet open onClose={() => undefined} section="agent" onOpenLink={() => undefined} />);
  await act(flush);
  return handles;
}

afterEach(() => { cleanup(); agentStore.stop(); vi.restoreAllMocks(); });

describe("SettingsSheet › Agent › status", () => {
  it("reads the agent's status again after the Codex path is saved, so the line flips without reopening", async () => {
    const { updateSettings } = await mount(base);
    expect(screen.getByText("Codex is not installed.")).toBeTruthy();
    api.read.agentStatus = vi.fn(async () => ({ available: true, running: 0, version: "0.9", account: "me@example.org" }));
    const field = screen.getByLabelText("Codex path") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "/opt/codex/bin/codex" } });
    await act(async () => { fireEvent.keyDown(field, { key: "Enter" }); await flush(); });
    expect(updateSettings).toHaveBeenCalledWith({ codexPath: "/opt/codex/bin/codex" });
    expect(api.read.agentStatus).toHaveBeenCalled();
    expect(screen.getByText("Codex 0.9 · me@example.org")).toBeTruthy();
    expect(agentStore.getState().status?.available).toBe(true);
  });

  it("follows the bridge's own change notice while open", async () => {
    let notify: (() => void) | undefined;
    api.read = mockRead({
      getSettings: vi.fn(async () => base), updateSettings: vi.fn(async () => base),
      agentStatus: vi.fn(async () => ({ available: false, reason: "Codex is not installed.", running: 0 })),
      getUpdateState: vi.fn(async () => ({ phase: "idle" as const, current: "0.1.0" })),
      listAgentRuns: vi.fn(async () => []),
      onAgentStatusChanged: (listener: () => void) => { notify = listener; return () => { notify = undefined; }; },
    } as Partial<ReturnType<typeof mockRead>>);
    await act(() => agentStore.start());
    render(<SettingsSheet open onClose={() => undefined} section="agent" onOpenLink={() => undefined} />);
    await act(flush);
    expect(screen.getByText("Codex is not installed.")).toBeTruthy();
    api.read.agentStatus = vi.fn(async () => ({ available: true, running: 0, version: "0.9" }));
    await act(async () => { notify?.(); await flush(); });
    expect(screen.getByText("Codex 0.9")).toBeTruthy();
  });
});

describe("SettingsSheet › Agent › TypeSafe key and reflow judge", () => {
  it("offers a password field without a stored key, keeps Jev disabled, and shows the privacy note", async () => {
    await mount(base);
    const field = screen.getByLabelText("TypeSafe API key") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(screen.queryByText("Key stored")).toBeNull();
    const jev = screen.getByRole("radio", { name: "Jev" });
    expect(jev.getAttribute("aria-disabled") === "true" || (jev as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("radio", { name: "Rules" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(JEV_PRIVACY_NOTE)).toBeTruthy();
    expect(screen.getByText("Jev needs a stored TypeSafe API key.")).toBeTruthy();
  });

  it("stores the key on Enter without echoing it, then enables Jev and saves the choice", async () => {
    const { updateSettings } = await mount(base);
    const field = screen.getByLabelText("TypeSafe API key") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "sk-typesafe-1" } });
    await act(async () => { fireEvent.keyDown(field, { key: "Enter" }); await flush(); });
    expect(updateSettings).toHaveBeenCalledWith({ typesafeApiKey: "sk-typesafe-1" });
    expect(screen.getByText("Key stored")).toBeTruthy();
    expect(screen.queryByLabelText("TypeSafe API key")).toBeNull();
    expect(document.body.textContent).not.toContain("sk-typesafe-1");
    const jev = screen.getByRole("radio", { name: "Jev" });
    expect(jev.getAttribute("aria-disabled")).not.toBe("true");
    await act(async () => { fireEvent.click(jev); await flush(); });
    expect(updateSettings).toHaveBeenLastCalledWith({ reflowJudge: "jev" });
    expect(screen.getByRole("radio", { name: "Jev" }).getAttribute("aria-checked")).toBe("true");
  });

  it("removes the key with one press and shows the judge back on the rules", async () => {
    const { updateSettings } = await mount({ ...base, typesafeApiKeySet: true, reflowJudge: "jev" });
    expect(screen.getByRole("radio", { name: "Jev" }).getAttribute("aria-checked")).toBe("true");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remove" })); await flush(); });
    expect(updateSettings).toHaveBeenCalledWith({ typesafeApiKey: "" });
    expect(screen.getByLabelText("TypeSafe API key")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Rules" }).getAttribute("aria-checked")).toBe("true");
  });

  it("shows the engine's refusal under the judge control and keeps the rules selected", async () => {
    await mount({ ...base, typesafeApiKeySet: true });
    api.read.updateSettings = vi.fn(async () => { throw new Error("The stored typesafeApiKey could not be decrypted. Remove it and enter it again."); });
    await act(async () => { fireEvent.click(screen.getByRole("radio", { name: "Jev" })); await flush(); });
    expect(screen.getByRole("alert").textContent).toBe("The stored typesafeApiKey could not be decrypted. Remove it and enter it again.");
    expect(screen.getByRole("radio", { name: "Rules" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("textViewReportText", () => {
  const report: TextViewReport = { pages: 3, columns: 2, furnitureLines: 4, headings: 5, paragraphs: 20, figures: 1, degradedPages: [] };
  it("says how the judge refined the reflow, or why it could not", () => {
    expect(textViewReportText(report)).toBe("3 pages · 2 columns · 4 furniture lines dropped · 5 headings · 20 paragraphs · 1 figure · no degraded pages");
    expect(textViewReportText({ ...report, judged: { provider: "jev", asked: 12, changed: 3 } })).toContain(" · refined by Jev · 12 asked · 3 changed");
    expect(textViewReportText({ ...report, judged: { provider: "jev", asked: 12, changed: 0, error: "Jev answered HTTP 503" } })).toMatch(/refined by Jev · 12 asked · 0 changed · Jev answered HTTP 503$/);
  });
});
