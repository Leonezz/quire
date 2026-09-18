const DEFAULT_INTERVAL_MS = 15 * 60_000;
const DEFAULT_INITIAL_DELAY_MS = 10_000;

export interface SchedulerOptions {
  run: () => Promise<void>;
  /** Every failure of `run` lands here; the scheduler never swallows one. */
  report: (error: unknown) => void;
  /** A function is read before every wait, so a changed setting applies from the next tick on. */
  intervalMs?: number | (() => number);
  initialDelayMs?: number;
}

/** Runs one job periodically, never two at once: a tick that finds a run in flight is skipped, not queued. */
export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly options: SchedulerOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.arm(this.options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.started = false;
  }

  private intervalMs(): number {
    const { intervalMs } = this.options;
    return typeof intervalMs === "function" ? intervalMs() : intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  private arm(delayMs: number) {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().finally(() => { if (this.started && !this.timer) this.arm(this.intervalMs()); });
    }, delayMs);
  }

  /** Runs now unless a run is already in flight; resolves when the (possibly pre-existing) run ends. */
  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.options.run()
      .catch((error: unknown) => { this.options.report(error); })
      .finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  get running(): boolean { return this.inFlight !== undefined; }
}
