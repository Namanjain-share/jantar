/** v0.3 writer additions: SendJob.origin and the pane lock other parts borrow. */
import { describe, expect, it } from 'vitest';
import { PID, SID, advance, flush, makeRig } from './helpers.js';

const CLI = { kind: 'cli' } as const;
const PROMPT = 'Add a logout button to the synthetic header';

describe('writer v0.3', () => {
  it('copies the origin it is given onto the job and every progress event', async () => {
    const rig = makeRig();
    rig.takeOnEnter(1);
    const r = await rig.writer.submit({ sid: SID, text: PROMPT, onDraft: 'refuse', actor: CLI, origin: 'rewrite-edited' });
    if (!r.ok) throw new Error(r.reason);
    expect(r.job.origin).toBe('rewrite-edited');
    await advance(rig.clock, 40_000);
    expect(rig.writer.get(r.job.id)).toMatchObject({ stage: 'proven', origin: 'rewrite-edited' });
    expect(rig.progress.filter((j) => j.id === r.job.id).every((j) => j.origin === 'rewrite-edited')).toBe(true);
  });

  it('a typed prompt carries no origin', async () => {
    const rig = makeRig();
    const r = await rig.writer.submit({ sid: 'no-such-session', text: PROMPT, onDraft: 'refuse', actor: CLI });
    expect(r.ok).toBe(false);
    expect(r.ok ? r.job : r.job).not.toHaveProperty('origin');
  });

  it('withPaneLock waits for the send on that pane, then runs; another pane does not wait', async () => {
    const rig = makeRig();
    rig.takeOnEnter(1);
    const pane = await rig.terminal.findPane({ sid: SID, pid: PID });
    if (!pane) throw new Error('no pane');
    const r = await rig.writer.submit({ sid: SID, text: PROMPT, onDraft: 'refuse', actor: CLI });
    if (!r.ok) throw new Error(r.reason);
    const seen: string[] = [];
    const locked = rig.writer.withPaneLock(pane, async () => {
      seen.push(`same pane after ${rig.writer.get(r.job.id)?.stage}`);
      return 7;
    });
    const other = rig.writer.withPaneLock({ ...pane, tty: '/dev/ttys099' }, async () => {
      seen.push('other pane');
      return 8;
    });
    await flush();
    expect(seen).toEqual(['other pane']);
    await advance(rig.clock, 40_000);
    expect(await locked).toBe(7);
    expect(await other).toBe(8);
    expect(seen).toEqual(['other pane', 'same pane after proven']);
  });
});
