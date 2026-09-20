// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../../shared/contracts";
import { flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead>, listeners: new Set<(state: UpdateState) => void>() }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { AboutSection, clipNotes } from "./AboutSection";
import { INSTALL_UNAVAILABLE_MESSAGE, updateStore } from "./updateStore";

const CURRENT = "0.1.0-alpha.1";
const available = (extra: Partial<Extract<UpdateState, { phase: "available" }>> = {}): UpdateState => ({ phase: "available", current: CURRENT, latest: "0.1.0-alpha.2", url: "https://example.test/v0.1.0-alpha.2", canInstall: false, checkedAt: "2026-09-20T10:00:00.000Z", ...extra });

function setup(initial: UpdateState, overrides: Partial<ReturnType<typeof mockRead>> = {}) {
  api.listeners.clear();
  api.read = mockRead({
    getUpdateState: vi.fn(async () => initial),
    checkForUpdates: vi.fn(async () => available()),
    installUpdate: vi.fn(async () => undefined),
    openReleasePage: vi.fn(async () => undefined),
    onUpdateState: (listener) => { api.listeners.add(listener); return () => { api.listeners.delete(listener); }; },
    ...overrides,
  });
}
const push = (state: UpdateState) => act(() => { for (const listener of api.listeners) listener(state); });

async function mount(initial: UpdateState, overrides: Partial<ReturnType<typeof mockRead>> = {}) {
  setup(initial, overrides);
  const onAutoCheck = vi.fn();
  await act(() => updateStore.start());
  render(<AboutSection version="test" autoCheck={true} disabled={false} onAutoCheck={onAutoCheck} onOpenLink={() => undefined} />);
  await act(flush);
  return { onAutoCheck };
}

afterEach(() => { cleanup(); updateStore.stop(); vi.restoreAllMocks(); });

describe("AboutSection", () => {
  it("shows the running version and checks on request, through checking to up to date", async () => {
    await mount({ phase: "idle", current: CURRENT }, { checkForUpdates: vi.fn(async (): Promise<UpdateState> => ({ phase: "up-to-date", current: CURRENT, checkedAt: "2026-09-20T10:00:00.000Z" })) });
    expect(screen.getByText(`Quire ${CURRENT}`)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Not checked yet.");
    push({ phase: "checking", current: CURRENT });
    expect(screen.getByRole("status").textContent).toContain("Checking…");
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
    push({ phase: "idle", current: CURRENT });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check for updates" })); await flush(); });
    expect(api.read.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("You're on the latest alpha.");
  });

  it("offers the download with the notes when the build cannot install, and the install when it can", async () => {
    await mount(available({ notes: "## What's new\n\n- Faster reader\n- **Updates**" }));
    expect(screen.getByRole("status").textContent).toContain("v0.1.0-alpha.2 is available");
    expect(screen.getByText("What's new")).toBeTruthy();
    expect(screen.getByText("Faster reader")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Release notes ↗" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Download" })); await flush(); });
    expect(api.read.openReleasePage).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Install and restart" })).toBeNull();
    push(available({ canInstall: true }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Install and restart" })); await flush(); });
    expect(api.read.installUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });

  it("shows the download percent, then Restart to update, which installs", async () => {
    await mount({ phase: "downloading", current: CURRENT, latest: "0.1.0-alpha.2", percent: 37.4 });
    expect(screen.getByRole("status").textContent).toContain("Downloading v0.1.0-alpha.2… 37%");
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
    push({ phase: "ready", current: CURRENT, latest: "0.1.0-alpha.2" });
    expect(screen.getByRole("status").textContent).toContain("Restart to update");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart to update" })); await flush(); });
    expect(api.read.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("shows an error in red with Retry, and a refused install under the state", async () => {
    await mount({ phase: "error", current: CURRENT, message: "No releases yet at https://github.com/Leonezz/quire/releases.", checkedAt: "2026-09-20T10:00:00.000Z" });
    const line = screen.getByText("No releases yet at https://github.com/Leonezz/quire/releases.");
    expect(line.className).toContain("text-red-text");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry" })); await flush(); });
    expect(api.read.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("v0.1.0-alpha.2 is available");
    push({ phase: "ready", current: CURRENT, latest: "0.1.0-alpha.2" });
    (api.read.installUpdate as ReturnType<typeof vi.fn>).mockImplementation(async () => { throw new Error("Error invoking remote method 'update:install': Error: UPDATE_INSTALL_UNAVAILABLE"); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart to update" })); await flush(); });
    expect(screen.getByRole("alert").textContent).toBe(INSTALL_UNAVAILABLE_MESSAGE);
  });

  it("saves the automatic-check switch through the sheet", async () => {
    const { onAutoCheck } = await mount({ phase: "idle", current: CURRENT });
    fireEvent.click(screen.getByRole("switch", { name: "Check for updates automatically" }));
    expect(onAutoCheck).toHaveBeenCalledWith(false);
  });

  it("clips the release notes to the first lines", () => {
    const notes = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(clipNotes(notes).split("\n")).toHaveLength(13);
    expect(clipNotes(notes).endsWith("…")).toBe(true);
    expect(clipNotes("one\ntwo")).toBe("one\ntwo");
  });
});
