// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../../shared/contracts";
import { flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead>, listeners: new Set<(state: UpdateState) => void>() }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { UpdateBanner } from "./UpdateBanner";
import { updateStore } from "./updateStore";

const CURRENT = "0.1.0-alpha.1";
const available = (latest: string, canInstall: boolean): UpdateState => ({ phase: "available", current: CURRENT, latest, url: `https://example.test/${latest}`, canInstall, checkedAt: "2026-09-20T10:00:00.000Z" });
const push = (state: UpdateState) => act(() => { for (const listener of api.listeners) listener(state); });

async function mount(initial: UpdateState) {
  api.listeners.clear();
  api.read = mockRead({
    getUpdateState: vi.fn(async () => initial),
    installUpdate: vi.fn(async () => undefined),
    openReleasePage: vi.fn(async () => undefined),
    onUpdateState: (listener) => { api.listeners.add(listener); return () => { api.listeners.delete(listener); }; },
  });
  await act(() => updateStore.start());
  render(<UpdateBanner />);
  await act(flush);
}

afterEach(() => { cleanup(); updateStore.stop(); vi.restoreAllMocks(); });

describe("UpdateBanner", () => {
  it("stays hidden until a release is available, offers the download or the install, and dismisses per version", async () => {
    await mount({ phase: "idle", current: CURRENT });
    expect(screen.queryByRole("status")).toBeNull();
    push(available("0.1.0-alpha.2", false));
    expect(screen.getByRole("status", { name: "Update v0.1.0-alpha.2" }).textContent).toContain("v0.1.0-alpha.2 available");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Download" })); await flush(); });
    expect(api.read.openReleasePage).toHaveBeenCalledTimes(1);
    push(available("0.1.0-alpha.2", true));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Install" })); await flush(); });
    expect(api.read.installUpdate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
    expect(screen.queryByRole("status")).toBeNull();
    // The same version stays dismissed through the download; a different one shows again.
    push({ phase: "ready", current: CURRENT, latest: "0.1.0-alpha.2" });
    expect(screen.queryByRole("status")).toBeNull();
    push(available("0.1.0-alpha.3", false));
    expect(screen.getByRole("status", { name: "Update v0.1.0-alpha.3" })).toBeTruthy();
  });

  it("offers the restart once the download is done", async () => {
    await mount({ phase: "ready", current: CURRENT, latest: "0.1.0-alpha.2" });
    expect(screen.getByRole("status").textContent).toContain("v0.1.0-alpha.2 downloaded");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart to update" })); await flush(); });
    expect(api.read.installUpdate).toHaveBeenCalledTimes(1);
  });
});
