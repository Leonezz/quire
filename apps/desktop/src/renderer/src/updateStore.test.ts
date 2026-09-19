// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../../shared/contracts";
import { INSTALL_UNAVAILABLE_MESSAGE, createUpdateStore, latestOf, type UpdateStoreApi } from "./updateStore";

const idle: UpdateState = { phase: "idle", current: "0.1.0-alpha.1" };
const available = (latest: string, canInstall = false): UpdateState => ({ phase: "available", current: "0.1.0-alpha.1", latest, url: `https://example.test/${latest}`, canInstall, checkedAt: "2026-09-20T10:00:00.000Z" });

function harness(overrides: Partial<UpdateStoreApi> = {}) {
  const listeners = new Set<(state: UpdateState) => void>();
  const api: UpdateStoreApi = {
    getUpdateState: vi.fn(async () => idle),
    checkForUpdates: vi.fn(async () => available("0.1.0-alpha.2")),
    installUpdate: vi.fn(async () => undefined),
    openReleasePage: vi.fn(async () => undefined),
    onUpdateState: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ...overrides,
  };
  const store = createUpdateStore(api);
  const emit = (state: UpdateState) => { for (const listener of listeners) listener(state); };
  return { store, api, emit, listeners };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("updateStore", () => {
  it("seeds from the bridge, follows pushed states, and starts once", async () => {
    const { store, api, emit, listeners } = harness();
    const changes = vi.fn();
    const unsubscribe = store.subscribe(changes);
    expect(store.getState()).toEqual({ state: undefined, actionError: undefined, dismissed: undefined });
    await store.start();
    await store.start();
    expect(api.getUpdateState).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);
    expect(store.getState().state).toEqual(idle);
    emit({ phase: "checking", current: "0.1.0-alpha.1" });
    expect(store.getState().state).toEqual({ phase: "checking", current: "0.1.0-alpha.1" });
    expect(changes).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.stop();
    expect(listeners.size).toBe(0);
    expect(store.getState().state).toBeUndefined();
  });

  it("shows a failed seed instead of throwing, and clears it when a state arrives", async () => {
    const { store, emit } = harness({ getUpdateState: vi.fn(async () => { throw new Error("Error invoking remote method 'update:state': boom"); }) });
    await store.start();
    expect(store.getState()).toEqual({ state: undefined, actionError: "Error invoking remote method 'update:state': boom", dismissed: undefined });
    emit(idle);
    expect(store.getState().actionError).toBeUndefined();
  });

  it("check takes the bridge's answer; a refused check is shown", async () => {
    const { store } = harness();
    await store.start();
    await store.check();
    expect(store.getState().state).toEqual(available("0.1.0-alpha.2"));
    const refused = harness({ checkForUpdates: vi.fn(async () => { throw new Error("IPC down"); }) });
    await refused.store.start();
    await refused.store.check();
    expect(refused.store.getState()).toMatchObject({ state: idle, actionError: "IPC down" });
  });

  it("install maps the unavailable code to a sentence, and defers to an error state the bridge pushed", async () => {
    const { store, emit } = harness({ installUpdate: vi.fn(async () => { throw new Error("Error invoking remote method 'update:install': Error: UPDATE_INSTALL_UNAVAILABLE"); }) });
    await store.start();
    await store.install();
    expect(store.getState().actionError).toBe(INSTALL_UNAVAILABLE_MESSAGE);
    // The main process pushes the error state before the call rejects: the state carries the failure, no second line.
    const failed = harness({ installUpdate: vi.fn(async () => { failed.emit({ phase: "error", current: "0.1.0-alpha.1", message: "Code signature did not pass validation", checkedAt: "2026-09-20T10:00:00.000Z" }); throw new Error("Code signature did not pass validation"); }) });
    await failed.store.start();
    await failed.store.install();
    expect(failed.store.getState().state).toMatchObject({ phase: "error", message: "Code signature did not pass validation" });
    expect(failed.store.getState().actionError).toBeUndefined();
  });

  it("dismisses the banner for the announced version only", async () => {
    const { store, emit } = harness();
    await store.start();
    store.dismiss();
    expect(store.getState().dismissed).toBeUndefined();
    emit(available("0.1.0-alpha.2"));
    store.dismiss();
    expect(store.getState().dismissed).toBe("0.1.0-alpha.2");
    emit({ phase: "ready", current: "0.1.0-alpha.1", latest: "0.1.0-alpha.3" });
    expect(latestOf(store.getState().state)).toBe("0.1.0-alpha.3");
    expect(store.getState().dismissed).toBe("0.1.0-alpha.2");
    expect(latestOf(idle)).toBeUndefined();
  });
});
