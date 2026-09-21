import { DEFAULT_MAX_STATE_TOKENS, JevResponseError, requestsOfPage, verdictsOfResponse, type JevRequest } from "./jev-request";
import type { BlockJudge, JudgeOutcome, JudgePage, JudgeUsage, JudgeVerdict } from "./types";

// TypeSafe's Jev over the network: one request per page (jev-request.ts), a few pages in flight,
// 20 s per request, one retry on 5xx / 429. A page that still fails keeps the rules' result and
// the failure is reported in the outcome; the build never breaks because of the judge.

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_RETRY_DELAY_MS = 1_500;
const MAX_ERROR_BODY_CHARS = 200;

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface JevJudgeOptions {
  endpoint?: string;
  timeoutMs?: number;
  concurrency?: number;
  maxStateTokens?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class JevHttpError extends Error {
  constructor(public readonly status: number, body: string) {
    super(`Jev answered HTTP ${status}${body ? `: ${body.slice(0, MAX_ERROR_BODY_CHARS)}` : ""}`);
    this.name = "JevHttpError";
  }
  get retryable(): boolean { return this.status === 429 || this.status >= 500; }
}

interface RequestResult { verdicts: JudgeVerdict[]; usage: JudgeUsage }

const emptyUsage = (): JudgeUsage => ({ requests: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 });
const addUsage = (a: JudgeUsage, b: JudgeUsage): JudgeUsage => ({ requests: a.requests + b.requests, inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, latencyMs: a.latencyMs + b.latencyMs });

export class JevJudge implements BlockJudge {
  readonly provider = "jev" as const;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly maxStateTokens: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly fetchImpl: FetchLike, private readonly key: string, options: JevJudgeOptions = {}) {
    if (!key) throw new Error("JevJudge needs a TypeSafe API key.");
    this.endpoint = options.endpoint ?? JEV_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.maxStateTokens = options.maxStateTokens ?? DEFAULT_MAX_STATE_TOKENS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  async judge(pages: readonly JudgePage[]): Promise<JudgeOutcome> {
    const requests = pages.flatMap((page, index) => {
      const previous = pages[index - 1];
      return requestsOfPage(page, previous?.blocks[previous.blocks.length - 1], this.maxStateTokens);
    });
    const results = await this.inParallel(requests);
    const failures = results.flatMap((result, index) => ("error" in result ? [{ page: requests[index]!.page, message: result.error }] : []));
    const usage = results.reduce((sum, result) => ("error" in result ? sum : addUsage(sum, result.usage)), emptyUsage());
    const verdicts = results.flatMap((result) => ("error" in result ? [] : result.verdicts));
    return { verdicts, usage, ...(failures.length > 0 ? { error: errorSummary(failures, requests.length) } : {}) };
  }

  private async inParallel(requests: readonly JevRequest[]): Promise<(RequestResult | { error: string })[]> {
    const results = new Array<RequestResult | { error: string }>(requests.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < requests.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await this.withRetry(requests[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, requests.length) }, worker));
    return results;
  }

  private async withRetry(request: JevRequest): Promise<RequestResult | { error: string }> {
    try { return await this.send(request); }
    catch (first) {
      if (!(first instanceof JevHttpError && first.retryable)) return { error: messageOf(first) };
      await this.sleep(this.retryDelayMs);
      try { return await this.send(request); }
      catch (second) { return { error: messageOf(second) }; }
    }
  }

  private async send(request: JevRequest): Promise<RequestResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = this.now();
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new JevHttpError(response.status, text);
      let parsed: unknown;
      try { parsed = JSON.parse(text); }
      catch { throw new JevResponseError("Jev's response is not JSON."); }
      const { verdicts, usage } = verdictsOfResponse(parsed, request.asked);
      return { verdicts, usage: { requests: 1, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, latencyMs: this.now() - started } };
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`Jev did not answer within ${Math.round(this.timeoutMs / 1000)} s.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorSummary(failures: readonly { page: number; message: string }[], total: number): string {
  const pages = [...new Set(failures.map((failure) => failure.page))];
  const first = failures[0]!.message;
  return `Jev failed on ${failures.length} of ${total} request${total === 1 ? "" : "s"} (page${pages.length === 1 ? "" : "s"} ${pages.join(", ")}); those pages keep the rules' result. ${first}`;
}
