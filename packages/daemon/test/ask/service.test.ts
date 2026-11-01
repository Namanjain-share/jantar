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
 *   does the same; a result that comes after Clear, the switch or stop()
 *   keeps nothing.
 * - Pruning: the newest 30 per device, none older than 7 days.
 * - Not ready: the sentences, in order, in the list and on send.
 * - Events: `life.changed {}` on each state change, never text.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ASK_KEEP_DAYS, ASK_TURNS_KEPT } from '@jantar/protocol';
import { ASK_SENTENCES } from '../../src/ask/answer.js';
import { PHONE, TABLET, answerText, cleanTemps, makeAskRig, send, type AskRig } from './helpers.js';

let rig: AskRig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
  cleanTemps();
});

const TODO = answerText([{ type: 'todo', title: 'Call the bank' }]);
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

  it('stop() kills the run and forgets every turn; its audit row says stopped', async () => {
    rig = await makeAskRig();
    const r = rig;
    const id = send(r, 'todo add one');
    await r.heldCount(1);
    await r.ask.stop();
    expect(r.held[0]?.call.opts.signal?.aborted).toBe(true);
    const l = r.ask.list(PHONE);
    expect(l.ok && l.value.turns).toEqual([]);
    await new Promise((res) => setTimeout(res, 20));
    expect(r.ctx.db.audit.list().filter((a) => a.action === 'ask.run').map((a) => [a.target, (a.params as { outcome: string }).outcome])).toEqual([[id, 'stopped']]);
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
    await check(await makeAskRig({ settings: { life: { todos: false, food: false, finance: false, medicines: false, places: true } } }), 'conflict', ASK_SENTENCES.noModules);
    // Medicines alone are enough (show cards).
    rig = await makeAskRig({ settings: { life: { todos: false, food: false, finance: false, medicines: true } } });
    const l = rig.ask.list(PHONE);
    expect(l.ok && l.value).toEqual({ ready: true, turns: [] });
  });

  it('an empty message is refused; the text is kept trimmed', async () => {
    rig = await makeAskRig();
    expect(rig.ask.send('   ', PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: ASK_SENTENCES.noText });
    const id = send(rig, '  todo add milk \n');
    expect(rig.turn(id)?.text).toBe('todo add milk');
  });
});
