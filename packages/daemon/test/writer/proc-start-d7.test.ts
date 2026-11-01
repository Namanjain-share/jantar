/**
 * v0.6 Fleet, lane L2 (D7): the writer's process check keeps failing closed
 * where a start time doesn't parse (what Claude writes as `procStart` on
 * Linux is unverified; busybox `ps` prints another format), now with one
 * fixed sentence that sends the user to `jantar doctor` on that machine.
 * procps' format, as the Mac's, still passes.
 */
import { describe, expect, it } from 'vitest';
import { createFakeExec, createTestContext, fixedProbe, onCommand } from '../../src/core/testing.js';
import { PROC_START_UNREAD, checkSessionProcess } from '../../src/writer/proc-start.js';

const PID = 4242;
const CLAUDE_WROTE = 'Sun Nov  1 09:00:00 2026';

function ctxWith(psOut: string, code = 0) {
  const exec = createFakeExec(onCommand('ps', { stdout: psOut, code }));
  return { ctx: createTestContext({ exec, proc: fixedProbe([PID]) }), exec };
}

describe('D7: an unparseable start time fails closed with the fixed sentence', () => {
  it('the sentence', () => {
    expect(PROC_START_UNREAD).toBe("Jantar can't confirm this Claude process on this machine (its start time doesn't parse); see jantar doctor there");
  });

  it('procps (Debian, Ubuntu) prints the Mac\'s format: the same process passes, another start is refused', async () => {
    expect(await checkSessionProcess(ctxWith(`${CLAUDE_WROTE}\n`).ctx, PID, CLAUDE_WROTE)).toEqual({ ok: true });
    expect(await checkSessionProcess(ctxWith('Sun Nov  1 09:05:00 2026\n').ctx, PID, CLAUDE_WROTE)).toEqual({ ok: false, reason: "the session's pid now belongs to another process" });
  });

  it('a procStart in a format nobody reads: refused before ps runs', async () => {
    const { ctx, exec } = ctxWith(`${CLAUDE_WROTE}\n`);
    for (const odd of ['', '2026/11/01 09:00', 'yesterday']) {
      expect(await checkSessionProcess(ctx, PID, odd), odd).toEqual({ ok: false, reason: PROC_START_UNREAD });
    }
    expect(exec.calls).toEqual([]);
  });

  it('busybox ps (Alpine) prints a time, not lstart: refused', async () => {
    expect(await checkSessionProcess(ctxWith('09:00\n').ctx, PID, CLAUDE_WROTE)).toEqual({ ok: false, reason: PROC_START_UNREAD });
  });
});
