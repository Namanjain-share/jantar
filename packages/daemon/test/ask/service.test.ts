/**
 * The Ask part's turns and queue (spec 4, 6; 12.2 "service"), on a fake
 * exec whose claude runs wait for the test:
 *
 * - One unfinished turn per device (409); one run at a time daemon-wide,
 *   oldest first; `kick()` never inside the send.
 * - A turn is its owner's: another device sees none of it (404).
 * - Cancel: a queued one leaves the queue, a running one is killed; a
 *   finished one stays as it is. Clear forgets this device's turns.
 * - The switch turning off kills the run and forgets every turn; stop()
 *   does the same and waits for the run (its audit row is written when
 *   stop() returns); a result that comes after Clear, the switch or stop()
 *   keeps nothing.
 * - Pruning: the newest 30 per device, and an older one while an item it
 *   added can still be undone; none older than 7 days; every hour too.
 * - Not ready: the sentences, in order, in the list and on send.
 * - Events: `life.changed {}` on each state change, never text.
 * - The run's own branches: work/ emptied, a run dir that can't be made,
 *   Cancel while it is made, a refused isolation option (one exec, nothing
 *   weaker), a run that throws, and an account pick that hangs (Cancel,
 *   stop() and the 90 s timeout end it; the queue goes on).
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASK_APPLY_WITHIN_MS, ASK_KEEP_DAYS, ASK_TEXT_MAX, ASK_TURNS_KEPT, type AccountId } from '@jantar/protocol';
import { ASK_SENTENCES } from '../../src/ask/answer.js';
import { ASK_SWEEP_MS, ASK_TIMEOUT_MS } from '../../src/ask/service.js';
import { PHONE, TABLET, account, answerText, cleanTemps, makeAskRig, send, type AskRig } from './helpers.js';

let rig: AskRig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
  cleanTemps();
});

const TODO = answerText([{ type: 'todo', title: 'Call the bank' }]);
const DAY_MS = 24 * 60 * 60_000;
const runRows = (r: AskRig) => r.ctx.db.audit.list().filter((a) => a.action === 'ask.run');
const outcomes = (r: AskRig) => runRows(r).map((a) => [a.target, (a.params as { outcome: string }).outcome]);
const turnsHeld = (r: AskRig) => (r.ask as unknown as { turns: Map<string, unknown[]> }).turns;
const lifeTicks = (r: AskRig) => {
  const all = r.ctx.store.replay(0);
  return (all.kind === 'events' ? all.events : []).filter((e) => e.type === 'life.changed').length;
};

describe('the queue', () => {
  it('runs after the send answers, one turn at a time, oldest first', async () => {
    rig = await makeAskRig();
    const r = rig;
    const a = send(r, 'todo add one', PHONE);
    // The run starts after the send has answered.
    expect(r.turn(a)?.state).toBe('queued');
    expect(r.held).toHaveLength(0);
    const b = send(r, 'todo add two', TABLET);
    await r.heldCount(1);
    expect(r.turn(a)?.state).toBe('running');
    expect(r.turn(b, TABLET)?.state).toBe('queued');
    // Nothing else starts while one runs.
    await new Promise((res) => setTimeout(res, 50));
    expect(r.held).toHaveLength(1);
    expect(r.held[0]?.call.opts.input).toContain('todo add one');
    r.held[0]?.answer(TODO);
    expect((await r.settled(a)).state).toBe('done');
    await r.heldCount(2);
    expect(r.held[1]?.call.opts.input).toContain('todo add two');
    r.held[1]?.answer(TODO);
    expect((await r.settled(b, TABLET)).state).toBe('done');
  });

  it('one unfinished turn per device: a second send is 409 until it ends', async () => {
    rig = await makeAskRig();
    const id = send(rig, 'todo add one');
    expect(rig.ask.send('todo add two', PHONE)).toEqual({ ok: false, code: 'conflict', reason: ASK_SENTENCES.busy });
    expect(rig.ask.send('todo add two', TABLET).ok).toBe(true);
    await rig.heldCount(1);
    expect(rig.ask.send('todo add two', PHONE)).toEqual({ ok: false, code: 'conflict', reason: ASK_SENTENCES.busy });
    rig.held[0]?.answer(TODO);
    await rig.settled(id);
    expect(rig.ask.send('todo add two', PHONE).ok).toBe(true);
  });

  it("a turn is its owner's: the other device's list, cancel, add and undo don't see it", async () => {
    rig = await makeAskRig();
    const id = send(rig, 'todo add one');
    await rig.heldCount(1);
    rig.held[0]?.answer(TODO);
    await rig.settled(id);
    const other = rig.ask.list(TABLET);
    expect(other.ok && other.value.turns).toEqual([]);
    expect(rig.ask.cancel(id, TABLET)).toEqual({ ok: false, code: 'not_found', reason: ASK_SENTENCES.noTurn });
    expect(rig.ask.skip(id, 0, TABLET)).toEqual({ ok: false, code: 'not_found', reason: ASK_SENTENCES.noTurn });
    const mine = rig.ask.list(PHONE);
    expect(mine.ok && mine.value.turns.map((t) => [t.text, t.state])).toEqual([['todo add one', 'done']]);
  });

  it('a turn: queued -> running -> done, a tick each time; the list is oldest first', async () => {
    rig = await makeAskRig();
    const r = rig;
    const before = lifeTicks(r);
    const id = send(r, 'todo add one');
    expect(lifeTicks(r)).toBe(before + 1);
    await r.heldCount(1);
    expect(lifeTicks(r)).toBe(before + 2);
    r.held[0]?.answer(TODO);
    const t = await r.settled(id);
    expect(lifeTicks(r)).toBe(before + 3);
    expect(t).toMatchObject({ id, text: 'todo add one', state: 'done', reply: 'Here you go.', dropped: 0, cards: [{ state: 'proposed', action: { type: 'todo', title: 'Call the bank' } }] });
    const second = send(r, 'todo add two');
    await r.heldCount(2);
    r.held[1]?.answer(TODO);
    await r.settled(second);
    const list = r.ask.list(PHONE);
    expect(list.ok && list.value.turns.map((x) => x.id)).toEqual([id, second]);
    // Every event is the text-free tick.
    const all = r.ctx.store.replay(0);
    expect((all.kind === 'events' ? all.events : []).filter((e) => e.type === 'life.changed').every((e) => JSON.stringify(e.data) === '{}')).toBe(true);
  });
});

describe('Cancel and Clear', () => {
  it('cancel: a running turn is killed, a queued one never runs, a finished one stays', async () => {
    rig = await makeAskRig();
    const r = rig;
    const running = send(r, 'todo add one');
    const queued = send(r, 'todo add two', TABLET);
    await r.heldCount(1);
    expect(r.ask.cancel(queued, TABLET)).toEqual({ ok: true, value: true });
    expect(r.turn(queued, TABLET)).toMatchObject({ state: 'cancelled', reason: ASK_SENTENCES.cancelled });
    expect(r.ask.cancel(running, PHONE)).toEqual({ ok: true, value: true });
    expect(r.held[0]?.call.opts.signal?.aborted).toBe(true);
    expect(r.turn(running)).toMatchObject({ state: 'cancelled', reason: ASK_SENTENCES.cancelled });
    // The queued one never ran; the next send of either device runs.
    await new Promise((res) => setTimeout(res, 50));
    expect(r.held).toHaveLength(1);
    const next = send(r, 'todo add three');
    await r.heldCount(2);
    r.held[1]?.answer(TODO);
    expect((await r.settled(next)).state).toBe('done');
    expect(r.ask.cancel(next, PHONE)).toEqual({ ok: true, value: true });
    expect(r.turn(next)?.state).toBe('done');
    const audit = r.ctx.db.audit.list().filter((a) => a.action === 'ask.run');
    expect(audit.map((a) => [a.target, (a.params as { outcome: string }).outcome, a.result])).toEqual([
      [running, 'cancelled', 'failed'],
      [next, 'ok', 'ok'],
    ]);
  });

  it("a result that comes after Cancel or Clear keeps nothing; Clear forgets this device's turns only", async () => {
    rig = await makeAskRig();
    const r = rig;
    const mine = send(r, 'todo add one');
    const theirs = send(r, 'todo add two', TABLET);
    await r.heldCount(1);
    expect(r.ask.clear(PHONE)).toEqual({ ok: true, value: true });
    expect(r.held[0]?.call.opts.signal?.aborted).toBe(true);
    // The killed process answers anyway: nothing is kept anywhere.
    r.held[0]?.answer(TODO);
    const list = r.ask.list(PHONE);
    expect(list.ok && list.value.turns).toEqual([]);
    await r.heldCount(2);
    r.held[1]?.answer(TODO);
    expect((await r.settled(theirs, TABLET)).state).toBe('done');
    expect(r.turn(mine)).toBeUndefined();
  });
});

describe('the switch and stop()', () => {
  it('the switch turning off kills the run, drops the queue and forgets every turn; a late answer keeps nothing', async () => {
    rig = await makeAskRig();
    const r = rig;
    const done = send(r, 'todo add one', TABLET);
    await r.heldCount(1);
    r.held[0]?.answer(TODO);
    await r.settled(done, TABLET);
    send(r, 'todo add two', PHONE);
    send(r, 'todo add three', TABLET);
    await r.heldCount(2);
    const ticks = lifeTicks(r);
    expect((await r.ctx.settings.patch({ ask: { enabled: false } })).ok).toBe(true);
    expect(r.held[1]?.call.opts.signal?.aborted).toBe(true);
    expect(lifeTicks(r)).toBe(ticks + 1);
    r.held[1]?.answer(TODO);
    expect((await r.ctx.settings.patch({ ask: { enabled: true } })).ok).toBe(true);
    for (const who of [PHONE, TABLET]) {
      const l = r.ask.list(who);
      expect(l.ok && l.value.turns).toEqual([]);
    }
    // The queued one never runs.
    await new Promise((res) => setTimeout(res, 50));
    expect(r.held).toHaveLength(2);
    expect(r.ctx.db.audit.list().filter((a) => a.action === 'ask.run').map((a) => (a.params as { outcome: string }).outcome)).toEqual(['ok', 'cancelled']);
  });

  it('stop() kills the run, forgets every turn and waits for the run: its audit row (stopped) is written when stop() returns', async () => {
    rig = await makeAskRig();
    const r = rig;
    const id = send(r, 'todo add one');
    await r.heldCount(1);
    await r.ask.stop();
    expect(r.held[0]?.call.opts.signal?.aborted).toBe(true);
    expect(outcomes(r)).toEqual([[id, 'stopped']]);
    expect(r.ctx.log.records.filter((l) => l.msg === 'ask: audit write failed')).toEqual([]);
    const l = r.ask.list(PHONE);
    expect(l.ok && l.value.turns).toEqual([]);
  });
});

describe('pruning', () => {
  it(`keeps the newest ${ASK_TURNS_KEPT} per device`, async () => {
    rig = await makeAskRig();
    const r = rig;
    const ids: string[] = [];
    for (let i = 0; i < ASK_TURNS_KEPT + 3; i++) {
      ids.push(send(r, `todo add task ${i}`));
      await r.heldCount(i + 1);
      r.held[i]?.answer(TODO);
      await r.settled(ids[i] as string);
    }
    const l = r.ask.list(PHONE);
    expect(l.ok && l.value.turns.map((t) => t.id)).toEqual(ids.slice(-ASK_TURNS_KEPT));
  });

  it(`an older turn stays while an item it added can still be undone (inside ${ASK_APPLY_WITHIN_MS / 3_600_000} h), and goes after`, async () => {
    rig = await makeAskRig();
    const r = rig;
    const answer = async (text: string) => {
      const id = send(r, text);
      await r.heldCount(r.held.length + 1);
      r.held.at(-1)?.answer(TODO);
      await r.settled(id);
      return id;
    };
    const added = await answer('todo add first');
    const skipped = await answer('todo add second');
    expect((await r.ask.add(added, 0, undefined, PHONE)).ok).toBe(true);
    expect(r.ask.skip(skipped, 0, PHONE).ok).toBe(true);
    const later: string[] = [];
    for (let i = 0; i < ASK_TURNS_KEPT; i++) later.push(await answer(`todo add task ${i}`));
    // The 31st and 32nd sends: the skipped one goes, the added one stays with its Undo.
    const l = r.ask.list(PHONE);
    expect(l.ok && l.value.turns.map((t) => t.id)).toEqual([added, ...later]);
    expect((await r.ask.undo(added, 0, PHONE)).ok).toBe(true);
    // Undone, it has nothing left to undo: past the newest 30, it goes.
    const after = r.ask.list(PHONE);
    expect(after.ok && after.value.turns.map((t) => t.id)).toEqual(later);
    // Added again and a day passes: Undo has ended, so it goes too.
    const again = await answer('todo add again');
    expect((await r.ask.add(again, 0, undefined, PHONE)).ok).toBe(true);
    for (let i = 0; i < ASK_TURNS_KEPT; i++) later.push(await answer(`todo add more ${i}`));
    expect(r.turn(again)).toBeDefined();
    r.ctx.clock.advance(ASK_APPLY_WITHIN_MS + 1);
    expect(r.turn(again)).toBeUndefined();
  });

  it(`every hour too: a turn past ${ASK_KEEP_DAYS} days leaves memory when nobody opens Ask`, async () => {
    rig = await makeAskRig();
    const r = rig;
    const id = send(r, 'todo add old');
    await r.heldCount(1);
    r.held[0]?.answer(TODO);
    await r.settled(id);
    expect(turnsHeld(r).size).toBe(1);
    // No send or list: the hourly sweep alone.
    r.ctx.clock.advance(ASK_KEEP_DAYS * DAY_MS + ASK_SWEEP_MS);
    expect(turnsHeld(r).size).toBe(0);
  });

  it(`none older than ${ASK_KEEP_DAYS} days, every device's (a revoked one's too)`, async () => {
    rig = await makeAskRig();
    const r = rig;
    const old = send(r, 'todo add old', TABLET);
    await r.heldCount(1);
    r.held[0]?.answer(TODO);
    await r.settled(old, TABLET);
    r.ctx.clock.advance(ASK_KEEP_DAYS * 24 * 60 * 60_000 - 1);
    expect(r.turn(old, TABLET)).toBeDefined();
    r.ctx.clock.advance(2);
    // The phone's list prunes every device's.
    r.ask.list(PHONE);
    expect((r.ask as unknown as { turns: Map<string, unknown> }).turns.size).toBe(0);
  });
});

describe('not ready', () => {
  it('read-only, then Life broken (503), then no runner, then no Life part on: in the list, and on send', async () => {
    const check = async (r: AskRig, code: string, reason: string) => {
      const l = r.ask.list(PHONE);
      expect(l.ok && l.value).toEqual({ ready: false, reason, turns: [] });
      expect(r.ask.send('todo add one', PHONE)).toEqual({ ok: false, code, reason });
      await r.close();
    };
    await check(await makeAskRig({ readOnly: true }), 'forbidden', ASK_SENTENCES.readOnly);
    const broken = await makeAskRig();
    broken.setBroken('Life data needs attention (synthetic).');
    await check(broken, 'life_unavailable', 'Life data needs attention (synthetic).');
    await check(await makeAskRig({ bins: { claude: null } }), 'conflict', ASK_SENTENCES.noRunner);
    await check(await makeAskRig({ mode: 'cswap', bins: { cswap: null } }), 'conflict', ASK_SENTENCES.noRunner);
    await check(await makeAskRig({ settings: { life: { todos: false, food: false, finance: false, medicines: false, posts: false, places: true } } }), 'conflict', ASK_SENTENCES.noModules);
    // Medicines alone are enough (show cards), and so are posts (v0.7).
    rig = await makeAskRig({ settings: { life: { todos: false, food: false, finance: false, medicines: true, posts: false } } });
    const l = rig.ask.list(PHONE);
    expect(l.ok && l.value).toEqual({ ready: true, turns: [] });
    await rig.close();
    rig = await makeAskRig({ settings: { life: { todos: false, food: false, finance: false, medicines: false, posts: true } } });
    const p = rig.ask.list(PHONE);
    expect(p.ok && p.value).toEqual({ ready: true, turns: [] });
  });

  it('an empty message and a long one are refused, each with its sentence; the text is kept trimmed', async () => {
    rig = await makeAskRig();
    expect(rig.ask.send('   ', PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: ASK_SENTENCES.noText });
    expect(rig.ask.send('x'.repeat(ASK_TEXT_MAX + 1), PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: ASK_SENTENCES.tooLong });
    expect(ASK_SENTENCES.tooLong).toBe('Keep a message to 1000 characters.');
    const id = send(rig, `  ${'x'.repeat(ASK_TEXT_MAX)} \n`);
    expect(rig.turn(id)?.text).toBe('x'.repeat(ASK_TEXT_MAX));
  });
});

describe("the run's own branches", () => {
  it('leftover files in work/ are emptied before claude starts', async () => {
    rig = await makeAskRig();
    const r = rig;
    const work = join(r.ctx.paths.askDir, 'work');
    mkdirSync(join(work, 'sub'), { recursive: true });
    writeFileSync(join(work, 'left.txt'), 'synthetic');
    writeFileSync(join(work, 'sub', 'deep.txt'), 'synthetic');
    const id = send(r, 'todo add one');
    await r.heldCount(1);
    expect(readdirSync(work)).toEqual([]);
    r.held[0]?.answer(TODO);
    expect((await r.settled(id)).state).toBe('done');
  });

  it('a run dir that cannot be made: "Claude couldn\'t answer.", nothing runs, the log has the code only', async () => {
    rig = await makeAskRig();
    const r = rig;
    // A file where the run dir goes.
    writeFileSync(r.ctx.paths.askDir, 'synthetic');
    const id = send(r, 'todo add one');
    expect(await r.settled(id)).toMatchObject({ state: 'failed', reason: ASK_SENTENCES.failed });
    expect(r.held).toEqual([]);
    const lines = r.ctx.log.records.filter((l) => l.msg === 'ask: a run could not start');
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]?.fields ?? {}).sort()).toEqual(['code', 'part']);
    expect(lines[0]?.fields?.code).toMatch(/^E[A-Z]+$/);
    expect(JSON.stringify(r.ctx.log.records)).not.toContain(r.ctx.paths.askDir);
    expect(outcomes(r)).toEqual([[id, 'failed']]);
  });

  it('Cancel while the run dir is made: nothing starts, the turn says Cancelled.', async () => {
    rig = await makeAskRig();
    const r = rig;
    let id = '';
    // The tick that says "running" comes just before the run dir is made.
    const off = r.ctx.store.subscribe(() => {
      if (id && r.turn(id)?.state === 'running') expect(r.ask.cancel(id, PHONE).ok).toBe(true);
    });
    id = send(r, 'todo add one');
    expect(await r.settled(id)).toMatchObject({ state: 'cancelled', reason: ASK_SENTENCES.cancelled });
    off();
    await vi.waitFor(() => expect(outcomes(r)).toEqual([[id, 'cancelled']]));
    expect(r.held).toEqual([]);
  });

  it('a refused isolation option (--tools): the turn fails after one exec, and nothing weaker runs', async () => {
    rig = await makeAskRig();
    const r = rig;
    const id = send(r, 'todo add one');
    await r.heldCount(1);
    expect(r.held[0]?.call.args).toContain('--tools');
    r.held[0]?.raw('', { code: 1, stderr: "error: unknown option '--tools'" });
    expect(await r.settled(id)).toMatchObject({ state: 'failed', reason: ASK_SENTENCES.failed });
    await new Promise((res) => setTimeout(res, 50));
    expect(r.held).toHaveLength(1);
    expect(r.ctx.log.records.filter((l) => l.msg === 'ask: claude refused an option').map((l) => l.fields)).toEqual([{ part: 'ask', option: '--tools', dropped: false }]);
    expect(outcomes(r)).toEqual([[id, 'failed']]);
    // The next run still has it.
    const next = send(r, 'todo add two');
    await r.heldCount(2);
    expect(r.held[1]?.call.args).toContain('--tools');
    r.held[1]?.answer(TODO);
    expect((await r.settled(next)).state).toBe('done');
  });

  it('a run that throws: the turn fails with the fixed sentence, the log has the error kind only, and the queue goes on', async () => {
    rig = await makeAskRig({ mode: 'cswap', accounts: [account(2 as AccountId, 10)] });
    const r = rig;
    vi.spyOn(r.usage, 'latest').mockImplementationOnce(() => {
      throw new Error('synthetic /secret/path');
    });
    const id = send(r, 'todo add one');
    const next = send(r, 'todo add two', TABLET);
    expect(await r.settled(id)).toMatchObject({ state: 'failed', reason: ASK_SENTENCES.failed });
    expect(r.ctx.log.records.filter((l) => l.msg === 'ask: a run failed').map((l) => l.fields)).toEqual([{ part: 'ask', error: 'Error' }]);
    expect(JSON.stringify(r.ctx.log.records)).not.toContain('/secret/path');
    await r.heldCount(1);
    r.held[0]?.answer(TODO);
    expect((await r.settled(next, TABLET)).state).toBe('done');
  });
});

describe("an account pick that hangs (ccw's hold list never read)", () => {
  let reads = 0;
  /** cswap with room on account 2, and ccw around: its first read of the hold list never ends. */
  async function hangingRig(): Promise<AskRig> {
    rig = await makeAskRig({ mode: 'cswap', accounts: [account(2 as AccountId, 10)] });
    const r = rig;
    r.ccwLegacy.isPresent = true;
    reads = 0;
    r.ccwLegacy.switchConfig = () => (++reads === 1 ? new Promise(() => {}) : Promise.resolve(null));
    return r;
  }
  /** The run is in the pick: the turn still queued, the hold list being read. */
  const picking = async (r: AskRig, id: string) => {
    await vi.waitFor(() => expect(reads).toBe(1));
    expect(r.turn(id)?.state).toBe('queued');
  };

  it('ends at 90 s: "Claude took too long to answer.", and the next turn runs', async () => {
    const r = await hangingRig();
    const id = send(r, 'todo add one');
    const next = send(r, 'todo add two', TABLET);
    await picking(r, id);
    r.ctx.clock.advance(ASK_TIMEOUT_MS);
    expect(await r.settled(id)).toMatchObject({ state: 'failed', reason: ASK_SENTENCES.timeout });
    await r.heldCount(1);
    r.held[0]?.answer(TODO);
    expect((await r.settled(next, TABLET)).state).toBe('done');
    expect(outcomes(r)).toEqual([
      [id, 'timeout'],
      [next, 'ok'],
    ]);
    expect(runRows(r)[0]?.params).toMatchObject({ account: null, ms: ASK_TIMEOUT_MS });
  });

  it('Cancel ends it at once: one cancelled row, no account, and the queue goes on', async () => {
    const r = await hangingRig();
    const id = send(r, 'todo add one');
    await picking(r, id);
    expect(r.ask.cancel(id, PHONE).ok).toBe(true);
    const next = send(r, 'todo add two');
    await r.heldCount(1);
    r.held[0]?.answer(TODO);
    expect((await r.settled(next)).state).toBe('done');
    expect(outcomes(r)).toEqual([
      [id, 'cancelled'],
      [next, 'ok'],
    ]);
    expect(runRows(r)[0]?.params).toMatchObject({ account: null, ms: 0 });
  });

  it('stop() ends it and returns, with a stopped row', async () => {
    const r = await hangingRig();
    const id = send(r, 'todo add one');
    await picking(r, id);
    await r.ask.stop();
    expect(outcomes(r)).toEqual([[id, 'stopped']]);
    expect(r.held).toEqual([]);
  });
});
