// What a judge backend is: a model behind a CLI that answers one prompt with JSON of the given
// schema. The policy (policy.ts) asks one or two of these per case; judge-case.ts turns an answer
// into an Opinion. Backends never parse the answer themselves.
import type { BackendId } from "../cache";

export interface BackendRunInput {
  prompt: string;
  /** The JSON schema the answer must fit; the CLI enforces it, judge-case.ts re-checks it. */
  schema: object;
  /** The call is killed and fails once it runs this long. */
  timeoutMs: number;
}

/** What a backend reports next to its answer; all optional because each CLI tells a different subset. */
export interface BackendRunMeta {
  /** Input + output (+ cache) tokens the backend reported. */
  tokens?: number;
  /** Dollars the backend reported (Claude Code: total_cost_usd; Codex: none). */
  costUsd?: number;
  /** The model the backend said it ran, when its output said. */
  resolvedModel?: string;
}

export interface BackendRunOutput extends BackendRunMeta {
  /** The answer text: expected to be one JSON object of the schema. */
  raw: string;
}

export interface JudgeBackend {
  id: BackendId;
  /** The model asked for; "default" leaves the CLI's own configuration in charge. */
  model: string;
  /** Checks the CLI is installed and authenticated; throws an Error whose message says what to do. */
  preflight(): Promise<void>;
  /** One call. Throws BackendRunError (with whatever meta it got) when the CLI failed, timed out or wrote no answer. */
  run(input: BackendRunInput): Promise<BackendRunOutput>;
}

/** A failed call: the message says what happened; meta keeps tokens/cost the CLI still reported. */
export class BackendRunError extends Error {
  readonly meta: BackendRunMeta;
  constructor(message: string, meta: BackendRunMeta = {}) {
    super(message);
    this.name = "BackendRunError";
    this.meta = meta;
  }
}

/** A backend/model pair as the policy names it. */
export interface BackendSpec { backend: BackendId; model: string }

export const describeSpec = (spec: BackendSpec): string => `${spec.backend}/${spec.model}`;

const MAX_TAIL = 4_000;
/** The last part of a CLI's output, for error messages. */
export const outputTail = (text: string): string => text.trim().slice(-MAX_TAIL);
