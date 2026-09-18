const DEFAULT_INTERVAL_MS = 15 * 60_000;
const DEFAULT_INITIAL_DELAY_MS = 10_000;

export interface SchedulerOptions {
  run: () => Promise<void>;
  /** Every failure of `run` lands here; the scheduler never swallows one. */
  report: (error: unknown) => void;
  intervalMs?: number;
  initialDelayMs?: number;
}

/** Runs one job periodically, never two at once: a tick that finds a run in flight is skipped, not queued. */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private initial: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly options: SchedulerOptions) {}

  start(): void {
    if (this.timer || this.initial) return;
    this.initial = setTimeout(() => { this.initial = undefined; void this.tick(); }, this.options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  stop(): void {
    if (this.initial) clearTimeout(this.initial);
    if (this.timer) clearInterval(this.timer);
    this.initial = undefined;
    this.timer = undefined;
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
