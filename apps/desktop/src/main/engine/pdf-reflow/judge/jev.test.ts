import { describe, expect, it, vi } from "vitest";
import { JevJudge, type FetchLike } from "./jev";
import { requestsOfPage, verdictsOfResponse } from "./jev-request";
import type { JudgeBlock, JudgePage } from "./types";

const block = (id: string, page: number, overrides: Partial<JudgeBlock> = {}): JudgeBlock => ({ id, page, column: 0, columns: 2, y: 0.5, sizeRatio: 1, bold: false, runIn: false, lines: 3, words: 30, head: `text of ${id}`, kind: "body", certain: true, ...overrides });

const pages: JudgePage[] = [
  { page: 1, blocks: [block("b0", 1, { certain: false, kind: "heading", words: 4 }), block("b1", 1), block("b2", 1, { certain: false, lines: 1, words: 5 }), block("b3", 1), block("b4", 1)] },
  { page: 2, blocks: [block("b5", 2, { certain: false, lines: 1, words: 8, y: 0.05 }), block("b6", 2)] },
  { page: 3, blocks: [block("b7", 3)] },
];

type Call = { url: string; body: { model: string; state: string; questions: Record<string, { type: string; instructions: string; criteria?: Record<string, string> }> }; headers: Record<string, string> };

/** A fetch that answers every question with the given choice, and remembers what it was asked. */
function fakeFetch(answer: (name: string) => { type: "choice"; choice: string; confidence: number } | { type: "noul"; noul: number } | undefined, statuses: number[] = []): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as Call["body"];
    calls.push({ url, body, headers: init.headers });
    const status = statuses.shift() ?? 200;
    if (status !== 200) return { ok: false, status, text: async () => `{"error":"status ${status}"}` };
    const answers = Object.fromEntries(Object.keys(body.questions).flatMap((name) => { const value = answer(name); return value ? [[name, value]] : []; }));
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 1000, output_tokens: 20 } }) };
  };
  return Object.assign(fetchImpl, { calls });
}

const choice = (name: string, kind: string, confidence = 0.9) => (name.endsWith("_kind") ? { type: "choice" as const, choice: kind, confidence } : { type: "noul" as const, noul: 0.1 });

describe("requestsOfPage", () => {
  it("lists the uncertain blocks with their neighbours as context and asks a kind and a continuation question per block", () => {
    const requests = requestsOfPage(pages[0]!, undefined);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.asked).toEqual(["b0", "b2"]);
    expect(request.body.model).toBe("jev-latest");
    expect(request.body.state).toContain("[b0 ?]");
    expect(request.body.state).toContain("[b1] ");
    expect(request.body.state).toContain("[b2 ?]");
    expect(request.body.state).toContain("[b3] ");
    expect(request.body.state).not.toContain("[b4]");
    expect(Object.keys(request.body.questions)).toEqual(["b0_kind", "b2_kind", "b2_continues"]);
    expect(request.body.questions.b0_kind).toMatchObject({ type: "choice", criteria: expect.objectContaining({ body: expect.any(String), furniture: expect.any(String), list_item: expect.any(String) }) });
    expect(request.body.questions.b2_continues).toMatchObject({ type: "noul", instructions: expect.stringContaining("[b1]") });
  });

  it("carries the previous page's last block as the context of a page's first block", () => {
    const [request] = requestsOfPage(pages[1]!, pages[0]!.blocks[4]);
    expect(request!.body.state).toContain("[b4] ");
    expect(request!.body.questions.b5_continues?.instructions).toContain("[b4]");
  });

  it("splits a page whose state would exceed the token budget", () => {
    const long: JudgePage = { page: 9, blocks: Array.from({ length: 8 }, (_, index) => block(`b${index}`, 9, { certain: false, head: "x".repeat(160) })) };
    const requests = requestsOfPage(long, undefined, 200);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.flatMap((request) => request.asked)).toEqual(long.blocks.map((entry) => entry.id));
  });

  it("refuses a response that lacks an answer or names an unknown kind", () => {
    expect(() => verdictsOfResponse({ answers: {} }, ["b0"])).toThrow(/b0_kind is missing/);
    expect(() => verdictsOfResponse({ answers: { b0_kind: { type: "choice", choice: "poem", confidence: 0.9 } } }, ["b0"])).toThrow(/unknown kind/);
    expect(() => verdictsOfResponse({ answers: { b0_kind: { type: "choice", choice: "body", confidence: 2 } } }, ["b0"])).toThrow(/between 0 and 1/);
    expect(verdictsOfResponse({ answers: { b0_kind: { type: "choice", choice: "body", confidence: 0.6 }, b0_continues: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 5, output_tokens: 1 } }, ["b0"])).toEqual({ verdicts: [{ id: "b0", kind: "body", confidence: 0.6, continues: 0.9 }], usage: { input_tokens: 5, output_tokens: 1 } });
  });
});

describe("JevJudge", () => {
  it("sends one request per page with uncertain blocks, bearer-authenticated, and returns every verdict with the usage", async () => {
    const fetchImpl = fakeFetch((name) => choice(name, "furniture", 0.95));
    const judge = new JevJudge(fetchImpl, "sk-test", { concurrency: 2 });
    const outcome = await judge.judge(pages);
    expect(fetchImpl.calls).toHaveLength(2);
    expect(fetchImpl.calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(fetchImpl.calls[0]!.headers.authorization).toBe("Bearer sk-test");
    expect(outcome.error).toBeUndefined();
    expect(outcome.verdicts.map((verdict) => verdict.id)).toEqual(["b0", "b2", "b5"]);
    expect(outcome.verdicts[1]).toEqual({ id: "b2", kind: "furniture", confidence: 0.95, continues: 0.1 });
    expect(outcome.usage).toEqual({ requests: 2, inputTokens: 2000, outputTokens: 40, latencyMs: expect.any(Number) });
  });

  it("retries once on 503 and 429 with a backoff, then gives up on that page and says so; other pages still count", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = fakeFetch((name) => choice(name, "heading"), [503, 200, 429, 429]);
    const outcome = await new JevJudge(fetchImpl, "sk-test", { concurrency: 1, sleep, retryDelayMs: 1500 }).judge(pages);
    expect(fetchImpl.calls).toHaveLength(4);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1500);
    expect(outcome.verdicts.map((verdict) => verdict.id)).toEqual(["b0", "b2"]);
    expect(outcome.error).toMatch(/^Jev failed on 1 of 2 requests \(page 2\); those pages keep the rules' result\. Jev answered HTTP 429: \{"error":"status 429"\}$/);
    expect(outcome.usage?.requests).toBe(1);
  });

  it("does not retry a 401, and reports a malformed answer without dropping the run", async () => {
    const fetchImpl = fakeFetch((name) => choice(name, "body"), [401]);
    const outcome = await new JevJudge(fetchImpl, "sk-test", { concurrency: 1, sleep: async () => undefined }).judge(pages);
    expect(fetchImpl.calls).toHaveLength(2);
    expect(outcome.error).toMatch(/Jev failed on 1 of 2 requests \(page 1\).*HTTP 401/);
    expect(outcome.verdicts.map((verdict) => verdict.id)).toEqual(["b5"]);
    const partial = fakeFetch((name) => (name === "b2_kind" ? undefined : choice(name, "body")));
    const second = await new JevJudge(partial, "sk-test", { sleep: async () => undefined }).judge(pages);
    expect(second.error).toMatch(/b2_kind is missing/);
  });

  it("gives up on a request that does not answer within the timeout", async () => {
    const fetchImpl: FetchLike = (_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener("abort", () => reject(new Error("aborted"))); });
    const outcome = await new JevJudge(fetchImpl, "sk-test", { timeoutMs: 5, sleep: async () => undefined }).judge([pages[0]!]);
    expect(outcome.verdicts).toEqual([]);
    expect(outcome.error).toMatch(/did not answer within 0 s/);
  });

  it("needs a key", () => {
    expect(() => new JevJudge(fakeFetch(() => undefined), "")).toThrow(/needs a TypeSafe API key/);
  });
});
