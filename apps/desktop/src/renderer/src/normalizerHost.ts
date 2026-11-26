import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import NormalizerWorker from "./normalizer.worker?worker";

// Ephemeral normalizer worker host: spawns the heavy AST / pdfjs / sucrase worker ONLY when
// Rust emits a `normalizer:request` job, and terminates it after 10s of idle so steady-state
// reading holds 0 MB of worker heap.

const IDLE_TERMINATE_MS = 10_000;

interface BridgeRequest {
  requestId: number;
  op: string;
  payload: Record<string, unknown>;
}

interface WorkerReply {
  requestId: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

let worker: Worker | undefined;
const pendingIds = new Set<number>();
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleIdleShutdown() {
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  if (pendingIds.size > 0) return;
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if (pendingIds.size === 0 && worker) {
      worker.terminate();
      worker = undefined;
    }
  }, IDLE_TERMINATE_MS);
}

function failAllPending(message: string) {
  const ids = [...pendingIds];
  pendingIds.clear();
  if (worker) {
    worker.terminate();
    worker = undefined;
  }
  for (const requestId of ids) {
    void invoke("normalizer_reply", {
      reply: {
        requestId,
        ok: false,
        error: message,
      },
    });
  }
}

function ensureWorker(): Worker {
  if (idleTimer !== undefined) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  if (!worker) {
    worker = new NormalizerWorker();
    worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
      pendingIds.delete(event.data.requestId);
      scheduleIdleShutdown();
      void invoke("normalizer_reply", { reply: event.data });
    });
    worker.addEventListener("error", (event) => {
      const detail = event.message || "Normalizer worker crashed.";
      console.error("[normalizer.worker]", detail);
      failAllPending(`Normalizer worker error: ${detail}`);
    });
    worker.addEventListener("messageerror", () => {
      failAllPending("Normalizer worker message deserialization failed.");
    });
  }
  return worker;
}

let started = false;

export function startNormalizerHost(): void {
  if (started) return;
  started = true;
  void listen<BridgeRequest>("normalizer:request", (event) => {
    pendingIds.add(event.payload.requestId);
    try {
      ensureWorker().postMessage(event.payload);
    } catch (err: unknown) {
      pendingIds.delete(event.payload.requestId);
      const message = err instanceof Error ? err.message : String(err);
      void invoke("normalizer_reply", {
        reply: {
          requestId: event.payload.requestId,
          ok: false,
          error: message,
        },
      });
    }
  });
}
