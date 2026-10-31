/**
 * One FIFO queue per key (a pane). A task starts only after every earlier
 * task on the same key has settled, so a pane's lock is held for a job's
 * whole precheck -> type -> Enter -> proof sequence. Different keys run
 * independently.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** Run `task` after the key's earlier tasks. The returned promise settles with the task. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Keys with queued or running tasks. */
  busy(): string[] {
    return [...this.tails.keys()];
  }
}
