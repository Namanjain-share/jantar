/**
 * The read queue on its own (spec 2.4), with a fake clock and runs the
 * test ends by hand: one row per item in the job list (a Retry or Read
 * again replaces the old row, a Delete drops it), a link saved while
 * `stopAll` waits still starts, a deleted waiting job gives today's read
 * back, and a stop that comes after Claude answered keeps the saved line.
 */
import { describe, expect, it } from 'vitest';
import { INTEL_READ_LIMITS, INTEL_READ_REASONS } from '@jantar/protocol';
import { FakeClock } from '../../src/core/clock.js';
import { memoryLogger } from '../../src/core/log.js';
import { ReadQueue, type Job, type JobSpec } from '../../src/intel/read/queue.js';
import type { CaptureLine } from '../../src/intel/read/store.js';
import { until } from './read-env.js';

const RID_A = '01JC0000000000000000000001';
const RID_B = '01JC0000000000000000000002';

function spec(rid: string, depth: JobSpec['depth'] = 'standard'): JobSpec {
  const base: CaptureLine = { id: rid, captured_at: '2026-01-15T10:00:00.000Z', title: 'example.test/a-post', read: { state: 'queued', depth } };
  return { rid, link: 'https://www.example.test/a-post', kind: { platform: 'web', type: 'link', post: null }, depth, title: 'example.test/a-post', note: null, base, userTags: [] };
}

function lineOf(job: Job, state: 'saved' | 'failed', reason?: string): CaptureLine {
  return { id: job.rid, captured_at: '2026-01-15T10:00:00.000Z', title: 'A synthetic read', read: { state, depth: job.depth, ...(reason ? { reason } : {}) } };
}

/** A queue whose runs wait until the test settles them. */
function setup() {
  const clock = new FakeClock();
  const written: CaptureLine[] = [];
  const ran: string[] = [];
  const pending = new Map<string, (line: CaptureLine | null) => void>();
  const queue = new ReadQueue({
    clock,
    log: memoryLogger(),
    run: (job) =>
      new Promise<CaptureLine | null>((resolve) => {
        ran.push(job.rid);
        pending.set(job.rid, resolve);
      }),
    write: async (line) => {
      written.push(line);
    },
    failedLine: (job, reason) => lineOf(job, 'failed', reason),
    changed: () => {},
  });
  /** End the run of `rid` with `line` and wait for the queue to take it. */
  async function settle(rid: string, line: (job: Job) => CaptureLine | null): Promise<void> {
    const resolve = await until(() => pending.get(rid), 2_000, `the run of ${rid}`);
    pending.delete(rid);
    const job = { rid, depth: 'standard' } as Job;
    resolve(line(job));
    await until(() => !queue.busy(rid), 2_000, 'the run to end');
  }
  return { clock, queue, written, ran, pending, settle };
}

describe('the read queue', () => {
  it('a Retry after a failed read: one row for the item, the new one', async () => {
    const t = setup();
    t.queue.push(spec(RID_A));
    await t.settle(RID_A, (j) => lineOf(j, 'failed', 'nope'));
    expect(t.queue.list()).toMatchObject([{ id: `captures:${RID_A}`, state: 'failed', reason: 'nope' }]);
    t.queue.push(spec(RID_A));
    expect(t.queue.list()).toMatchObject([{ id: `captures:${RID_A}`, state: 'queued' }]);
    await t.settle(RID_A, (j) => lineOf(j, 'saved'));
    const list = t.queue.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: `captures:${RID_A}`, state: 'saved' });
  });

  it('a Delete after a failed read: the item has no row left', async () => {
    const t = setup();
    t.queue.push(spec(RID_A));
    t.queue.push(spec(RID_B));
    await t.settle(RID_A, (j) => lineOf(j, 'failed', 'nope'));
    t.queue.cancel(RID_A);
    expect(t.queue.list().map((j) => j.id)).toEqual([`captures:${RID_B}`]);
  });

  it('a link saved while stopAll waits for the running job still starts', async () => {
    const t = setup();
    t.queue.push(spec(RID_A));
    await until(() => t.pending.get(RID_A), 2_000, 'A to run');
    const stopping = t.queue.stopAll();
    t.queue.push(spec(RID_B));
    // The running job ends on its abort.
    t.pending.get(RID_A)?.(null);
    t.pending.delete(RID_A);
    await stopping;
    await until(() => t.ran.includes(RID_B), 2_000, 'B to start');
    expect(t.queue.counts()).toEqual({ waiting: 0, running: 1 });
  });

  it("a deleted waiting job gives today's read back", async () => {
    const t = setup();
    t.queue.push(spec(RID_A));
    t.queue.push(spec(RID_B, 'full'));
    expect(t.queue.today()).toEqual({ reads: 2, full: 1 });
    t.queue.cancel(RID_B);
    expect(t.queue.today()).toEqual({ reads: 1, full: 0 });
    // The running one was started: it still counts.
    t.queue.cancel(RID_A);
    expect(t.queue.today()).toEqual({ reads: 1, full: 0 });
  });

  it('past the hard stop: a run that still gave back a saved line keeps it; one that did not ends "The read took too long."', async () => {
    const t = setup();
    t.queue.push(spec(RID_A));
    await until(() => t.pending.get(RID_A), 2_000, 'A to run');
    t.clock.advance(INTEL_READ_LIMITS.jobMs);
    await t.settle(RID_A, (j) => lineOf(j, 'saved'));
    expect(t.written.at(-1)).toMatchObject({ id: RID_A, read: { state: 'saved' } });
    expect(t.queue.list()).toMatchObject([{ id: `captures:${RID_A}`, state: 'saved' }]);

    t.queue.push(spec(RID_B));
    await until(() => t.pending.get(RID_B), 2_000, 'B to run');
    t.clock.advance(INTEL_READ_LIMITS.jobMs);
    await t.settle(RID_B, () => null);
    expect(t.written.at(-1)).toMatchObject({ id: RID_B, read: { state: 'failed', reason: INTEL_READ_REASONS.tooLong } });
    expect(t.queue.list()[0]).toMatchObject({ id: `captures:${RID_B}`, state: 'failed', reason: INTEL_READ_REASONS.tooLong });
  });
});
