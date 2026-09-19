import { useSyncExternalStore } from "react";
import type { ReadApiUpdates, UpdateState } from "../../shared/contracts";
import { read } from "./api";

// The renderer's view of the update state: seeded from the bridge once, then following every
// `update:state` push. The About section and the sidebar banner are views of this one store, so a
// check started from either shows in both; dismissing the banner is per session and per version.

export interface UpdateStoreState {
  /** Undefined until the bridge answered the seed. */
  state: UpdateState | undefined;
  /** A bridge failure outside the state machine: the seed, or an action the main process refused. */
  actionError: string | undefined;
  /** The version whose banner was dismissed; a different version shows the banner again. */
  dismissed: string | undefined;
}

export type UpdateStoreApi = ReadApiUpdates;

const INITIAL: UpdateStoreState = { state: undefined, actionError: undefined, dismissed: undefined };
export const INSTALL_UNAVAILABLE_MESSAGE = "This build cannot install updates in place. Download the release from its page instead.";

function messageOf(cause: unknown, fallback: string): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  if (text.includes("UPDATE_INSTALL_UNAVAILABLE")) return INSTALL_UNAVAILABLE_MESSAGE;
  if (text.includes("UPDATE_NOT_AVAILABLE")) return "There is no update to install. Check for updates first.";
  return text.length > 0 ? text : fallback;
}

/** The version a banner would announce: the available or downloaded one. */
export function latestOf(state: UpdateState | undefined): string | undefined {
  return state && (state.phase === "available" || state.phase === "ready") ? state.latest : undefined;
}

export function createUpdateStore(api: UpdateStoreApi) {
  let state: UpdateStoreState = INITIAL;
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;

  const set = (next: UpdateStoreState) => { state = next; for (const listener of listeners) listener(); };
  const onState = (next: UpdateState) => set({ ...state, state: next, actionError: undefined });
  const fail = (cause: unknown, fallback: string) => set({ ...state, actionError: messageOf(cause, fallback) });

  return {
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Called once by the shell: follows the bridge, then seeds. Idempotent; a failed seed is shown, not thrown. */
    start: async () => {
      if (stop) return;
      stop = api.onUpdateState(onState);
      try { set({ ...state, state: await api.getUpdateState() }); }
      catch (cause: unknown) { fail(cause, "Could not read the update state."); }
    },
    /** Unsubscribes and forgets everything (tests, and a shell teardown). */
    stop: () => {
      stop?.(); stop = undefined;
      set(INITIAL);
    },
    check: async () => {
      set({ ...state, actionError: undefined });
      try { set({ ...state, state: await api.checkForUpdates() }); }
      catch (cause: unknown) { fail(cause, "Could not check for updates."); }
    },
    /** Downloads and restarts, or restarts when the download is done; a refusal shows under the state. */
    install: async () => {
      set({ ...state, actionError: undefined });
      try { await api.installUpdate(); }
      catch (cause: unknown) {
        // A download failure already arrived as an error state; only a refusal outside the machine needs a line of its own.
        if (state.state?.phase !== "error") fail(cause, "Could not install the update.");
      }
    },
    openReleasePage: async () => {
      try { await api.openReleasePage(); }
      catch (cause: unknown) { fail(cause, "Could not open the release page."); }
    },
    dismiss: () => {
      const latest = latestOf(state.state);
      if (latest !== undefined) set({ ...state, dismissed: latest });
    },
  };
}

export type UpdateStore = ReturnType<typeof createUpdateStore>;

/** The one store of the window. The bridge is read at call time, so a test's mocked `read` is honoured. */
export const updateStore: UpdateStore = createUpdateStore({
  getUpdateState: () => read.getUpdateState(),
  checkForUpdates: () => read.checkForUpdates(),
  installUpdate: () => read.installUpdate(),
  openReleasePage: () => read.openReleasePage(),
  onUpdateState: (listener) => read.onUpdateState(listener),
});

/** The whole store state (a stable reference between changes); derive in render, never return a fresh object here. */
export function useUpdateStore(): UpdateStoreState {
  return useSyncExternalStore(updateStore.subscribe, updateStore.getState, updateStore.getState);
}
