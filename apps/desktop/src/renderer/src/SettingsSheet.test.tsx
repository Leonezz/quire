// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RenderingFeedback, Settings, SettingsPatch, TextViewReport } from "../../shared/contracts";
import { flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { agentStore } from "./agentStore";
import { FEEDBACK_EMPTY_MESSAGE } from "./FeedbackSection";
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
    feedbackList: vi.fn(async () => []),
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

describe("SettingsSheet › Feedback", () => {
  const quality: RenderingFeedback["quality"] = { completeness: "declared_full", conformance: "recoverable", identityConfidence: "strong", safety: "safe", warnings: [] };
  const report = (id: string, createdAt: string, extra: Partial<RenderingFeedback> = {}): RenderingFeedback => ({
    id, createdAt, materialId: "m1", url: "https://example.org/post", title: `Post ${id}`, view: "web", kinds: ["tables", "images"], note: "",
    app: { version: "0.1.0", platform: "darwin", normalize: "0.1" }, quality, problems: [], capture: { included: true, byteLength: 10, mediaType: "text/html" }, bundleDir: `/data/feedback/${id}`, ...extra,
  });
  const older = report("old", "2026-09-20T09:00:00.000Z");
  const newer = report("new", "2026-09-22T09:00:00.000Z", { issueUrl: "https://github.com/Leonezz/quire/issues/7" });

  it("lists the reports newest first with their kinds and the filed mark, and opens the filed issue through the link opener", async () => {
    engine(base);
    api.read.feedbackList = vi.fn(async () => [older, newer]);
    api.read.feedbackOpenIssue = vi.fn(async () => undefined);
    const onOpenLink = vi.fn();
    render(<SettingsSheet open onClose={() => undefined} section="feedback" onOpenLink={onOpenLink} />);
    await act(flush);
    const list = screen.getByRole("list", { name: "Rendering reports" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByText(/^Post /).textContent)).toEqual(["Post new", "Post old"]);
    expect(within(rows[0]!).getByText("Issue filed")).toBeTruthy();
    expect(within(rows[0]!).getByText("Tables mangled")).toBeTruthy();
    expect(within(rows[0]!).getByText("Figures missing or wrong")).toBeTruthy();
    expect(within(rows[1]!).queryByText("Issue filed")).toBeNull();
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Open filed issue" }));
    expect(onOpenLink).toHaveBeenCalledWith("https://github.com/Leonezz/quire/issues/7");
    await act(async () => { fireEvent.click(within(rows[1]!).getByRole("button", { name: "Open issue" })); await flush(); });
    expect(api.read.feedbackOpenIssue).toHaveBeenCalledWith("old");
  });

  it("shows the empty state, and follows the bridge's change notice", async () => {
    engine(base);
    let notify: (() => void) | undefined;
    api.read.onFeedbackChanged = (listener: () => void) => { notify = listener; return () => { notify = undefined; }; };
    render(<SettingsSheet open onClose={() => undefined} section="feedback" onOpenLink={() => undefined} />);
    await act(flush);
    expect(screen.getByText(FEEDBACK_EMPTY_MESSAGE)).toBeTruthy();
    api.read.feedbackList = vi.fn(async () => [older]);
    await act(async () => { notify?.(); await flush(); });
    expect(screen.getByText("Post old")).toBeTruthy();
  });

  it("deletes a report after confirming, and shows a refusal inside the confirm sheet", async () => {
    engine(base);
    api.read.feedbackList = vi.fn(async () => [older, newer]);
    api.read.feedbackDelete = vi.fn(async () => { throw new Error("EPERM: operation not permitted"); });
    render(<SettingsSheet open onClose={() => undefined} section="feedback" onOpenLink={() => undefined} />);
    await act(flush);
    const rows = within(screen.getByRole("list", { name: "Rendering reports" })).getAllByRole("listitem");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete this report?" });
    expect(confirm.textContent).toContain("Post old");
    await act(async () => { fireEvent.click(within(confirm).getByRole("button", { name: "Delete" })); await flush(); });
    expect(within(confirm).getByRole("alert").textContent).toBe("EPERM: operation not permitted");
    api.read.feedbackDelete = vi.fn(async () => undefined);
    await act(async () => { fireEvent.click(within(confirm).getByRole("button", { name: "Delete" })); await flush(); });
    expect(api.read.feedbackDelete).toHaveBeenCalledWith("old");
    expect(screen.queryByRole("dialog", { name: "Delete this report?" })).toBeNull();
    expect(screen.queryByText("Post old")).toBeNull();
    expect(screen.getByText("Post new")).toBeTruthy();
  });

  it("shows a failed load as an alert", async () => {
    engine(base);
    api.read.feedbackList = vi.fn(async () => { throw new Error("feedback.db is locked"); });
    render(<SettingsSheet open onClose={() => undefined} section="feedback" onOpenLink={() => undefined} />);
    await act(flush);
    expect(screen.getByRole("alert").textContent).toBe("feedback.db is locked");
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
