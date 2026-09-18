import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "./scheduler";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("Scheduler", () => {
  it("runs once after the initial delay, then every interval, and stops cleanly", async () => {
    let runs = 0;
    const scheduler = new Scheduler({ run: async () => { runs += 1; }, report: () => { throw new Error("unexpected"); }, intervalMs: 1000, initialDelayMs: 100 });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(99);
    expect(runs).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(2);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toBe(2);
  });

  it("never overlaps: a tick during a run is skipped and shares the in-flight promise", async () => {
    let started = 0;
    let release: () => void = () => {};
    const run = () => { started += 1; return started === 1 ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve(); };
    const scheduler = new Scheduler({ run, report: () => {}, intervalMs: 100, initialDelayMs: 0 });
    const first = scheduler.tick();
    expect(scheduler.running).toBe(true);
    const second = scheduler.tick();
    expect(second).toBe(first);
    expect(started).toBe(1);
    release();
    await first;
    expect(scheduler.running).toBe(false);
    await scheduler.tick();
    expect(started).toBe(2);
  });

  it("reads a function interval before every wait, so a changed setting applies from the next tick", async () => {
    let runs = 0;
    let interval = 1000;
    const scheduler = new Scheduler({ run: async () => { runs += 1; }, report: () => {}, intervalMs: () => interval, initialDelayMs: 0 });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    interval = 200;
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(runs).toBe(3);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(3);
  });

  it("reports every failure and keeps going", async () => {
    const reported: unknown[] = [];
    let calls = 0;
    const scheduler = new Scheduler({ run: async () => { calls += 1; if (calls === 1) throw new Error("boom"); }, report: (error) => reported.push(error), intervalMs: 100, initialDelayMs: 0 });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reported).toHaveLength(1);
    expect((reported[0] as Error).message).toBe("boom");
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
    expect(reported).toHaveLength(1);
    scheduler.stop();
  });
});
