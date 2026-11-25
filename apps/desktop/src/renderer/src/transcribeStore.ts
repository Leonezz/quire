import { useSyncExternalStore } from "react";
import type { AsrProvider, TranscribeEvent, TranscribeJobSnapshot } from "../../shared/contracts";
import { read } from "./api";

export interface TranscribeStoreState {
  jobs: ReadonlyMap<string, TranscribeJobSnapshot>;
  errors: ReadonlyMap<string, string>;
  completedAt: ReadonlyMap<string, number>;
}

const EMPTY_STATE: TranscribeStoreState = {
  jobs: new Map(),
  errors: new Map(),
  completedAt: new Map(),
};

function createTranscribeStore() {
  let state: TranscribeStoreState = EMPTY_STATE;
  const listeners = new Set<() => void>();
  let unsubEvent: (() => void) | undefined;
  let seeded = false;

  const set = (next: TranscribeStoreState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const handleEvent = (event: TranscribeEvent) => {
    const jobs = new Map(state.jobs);
    const errors = new Map(state.errors);
    const completedAt = new Map(state.completedAt);

    switch (event.type) {
      case "preparing": {
        const prev = jobs.get(event.materialId);
        jobs.set(event.materialId, {
          jobId: event.jobId,
          materialId: event.materialId,
          provider: prev?.provider ?? "openai_compatible",
          phase: "preparing",
          completedChunks: 0,
          totalChunks: 0,
        });
        errors.delete(event.materialId);
        break;
      }
      case "progress": {
        const prev = jobs.get(event.materialId);
        jobs.set(event.materialId, {
          jobId: event.jobId,
          materialId: event.materialId,
          provider: prev?.provider ?? "openai_compatible",
          phase: "transcribing",
          completedChunks: event.completedChunks,
          totalChunks: event.totalChunks,
        });
        errors.delete(event.materialId);
        break;
      }
      case "completed": {
        jobs.delete(event.materialId);
        errors.delete(event.materialId);
        completedAt.set(event.materialId, (completedAt.get(event.materialId) ?? 0) + 1);
        break;
      }
      case "failed": {
        jobs.delete(event.materialId);
        errors.set(event.materialId, event.message);
        break;
      }
    }

    set({ jobs, errors, completedAt });
  };

  const ensureSubscribed = () => {
    if (!unsubEvent) {
      unsubEvent = read.onTranscribeEvent(handleEvent);
    }
    if (!seeded) {
      seeded = true;
      read.listTranscriptionJobs()
        .then((snapshot) => {
          if (!unsubEvent || snapshot.length === 0) return;
          const jobs = new Map(state.jobs);
          for (const entry of snapshot) {
            if (!jobs.has(entry.materialId)) jobs.set(entry.materialId, entry);
          }
          set({ ...state, jobs });
        })
        .catch(() => undefined);
    }
  };

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      ensureSubscribed();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: async (materialId: string, provider?: AsrProvider): Promise<TranscribeJobSnapshot | undefined> => {
      ensureSubscribed();
      const jobs = new Map(state.jobs);
      const errors = new Map(state.errors);
      errors.delete(materialId);
      jobs.set(materialId, {
        jobId: "starting",
        materialId,
        provider: provider ?? "openai_compatible",
        phase: "preparing",
        completedChunks: 0,
        totalChunks: 0,
      });
      set({ ...state, jobs, errors });

      try {
        const snapshot = await read.startTranscription(materialId, provider);
        const nextJobs = new Map(state.jobs);
        // Keep newer streamed progress if an event arrived while startTranscription resolved.
        const current = nextJobs.get(materialId);
        if (!current || current.jobId === "starting") {
          nextJobs.set(materialId, snapshot);
        }
        set({ ...state, jobs: nextJobs });
        return snapshot;
      } catch (cause: unknown) {
        const nextJobs = new Map(state.jobs);
        nextJobs.delete(materialId);
        const nextErrors = new Map(state.errors);
        nextErrors.set(
          materialId,
          cause instanceof Error ? cause.message : "Could not start transcription.",
        );
        set({ ...state, jobs: nextJobs, errors: nextErrors });
        return undefined;
      }
    },
    cancel: async (materialId: string): Promise<void> => {
      const jobs = new Map(state.jobs);
      jobs.delete(materialId);
      set({ ...state, jobs });
      await read.cancelTranscription(materialId).catch(() => undefined);
    },
    dismissError: (materialId: string) => {
      if (!state.errors.has(materialId)) return;
      const errors = new Map(state.errors);
      errors.delete(materialId);
      set({ ...state, errors });
    },
    stop: () => {
      unsubEvent?.();
      unsubEvent = undefined;
      seeded = false;
      set(EMPTY_STATE);
    },
  };
}

export const transcribeStore = createTranscribeStore();

export function useTranscriptionJob(materialId: string | undefined): {
  job: TranscribeJobSnapshot | undefined;
  error: string | undefined;
  completedNonce: number | undefined;
} {
  const job = useSyncExternalStore(
    transcribeStore.subscribe,
    () => (materialId ? transcribeStore.getState().jobs.get(materialId) : undefined),
    () => undefined,
  );
  const error = useSyncExternalStore(
    transcribeStore.subscribe,
    () => (materialId ? transcribeStore.getState().errors.get(materialId) : undefined),
    () => undefined,
  );
  const completedNonce = useSyncExternalStore(
    transcribeStore.subscribe,
    () => (materialId ? transcribeStore.getState().completedAt.get(materialId) : undefined),
    () => undefined,
  );
  return { job, error, completedNonce };
}
