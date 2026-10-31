/**
 * Runs an async job one at a time. A call made while a run is in flight gets
 * one follow-up run that starts after it (any number of such calls share
 * that follow-up), so every caller sees a result computed after its call.
 */
export class Serial<T> {
  private inFlight: Promise<T> | null = null;
  private queued: Promise<T> | null = null;

  constructor(private readonly job: () => Promise<T>) {}

  run(): Promise<T> {
    if (!this.inFlight) {
      const p = this.job();
      this.inFlight = p;
      const clear = () => {
        if (this.inFlight === p) this.inFlight = null;
      };
      p.then(clear, clear);
      return p;
    }
    if (!this.queued) {
      const prev = this.inFlight;
      const next = prev
        .catch(() => undefined)
        .then(() => {
          this.queued = null;
          return this.run();
        });
      this.queued = next;
    }
    return this.queued;
  }

  /** Resolves when nothing is running or queued. */
  async idle(): Promise<void> {
    for (;;) {
      const p = this.queued ?? this.inFlight;
      if (!p) return;
      await p.catch(() => undefined);
    }
  }
}
