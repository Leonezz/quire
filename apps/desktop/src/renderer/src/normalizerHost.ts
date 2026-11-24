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
let inFlight = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleIdleShutdown() {
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  if (inFlight > 0) return;
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if (inFlight === 0 && worker) {
      worker.terminate();
      worker = undefined;
    }
  }, IDLE_TERMINATE_MS);
}

function ensureWorker(): Worker {
  if (idleTimer !== undefined) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  if (!worker) {
    worker = new NormalizerWorker();
    worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
      inFlight = Math.max(0, inFlight - 1);
      scheduleIdleShutdown();
      void invoke("normalizer_reply", { reply: event.data });
    });
    worker.addEventListener("error", (event) => {
      console.error("[normalizer.worker]", event.message);
    });
  }
  return worker;
}

let started = false;

export function startNormalizerHost(): void {
  if (started) return;
  started = true;
  void listen<BridgeRequest>("normalizer:request", (event) => {
    inFlight += 1;
    ensureWorker().postMessage(event.payload);
  });
}
