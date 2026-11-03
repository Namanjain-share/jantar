/**
 * v0.11 People (P2): her evening review (spec 3.10, O2).
 *
 * - Every outcome: done, skipped (with her reason), excused (rough day),
 *   moved (carried, or a to-do's due moved on), missed (open at send or
 *   close), gone (in `sentSteps` but removed, or a due to-do deleted), and
 *   a check-between as "3 of 5".
 * - Carry (hers) and ask-carry (his steps, one change request). A second
 *   send is 409 `sent`. "Also save to my journal" makes a review entry.
 * - His side: `full` is the same screen with her note and mood; `counts`
 *   names no title, note or mood; `off` is 404 (and a locked tile on
 *   Today). The "review sent" push names no note, and is dropped if review
 *   is off by the time it goes (C7).
 * - The 12:00 close stores `auto: true`, pushes nothing and counts nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JournalList, PersonAlert, PersonOwnToday, PlanView, ReviewView } from '@jantar/protocol/people';
import { makeFixture, type Fixture } from '../people/isolation-fixture.js';
import { EP, eventually, kit } from '../people/p2-kit.js';

let f: Fixture;
const k = kit(() => f);
beforeEach(async () => {
  f = await makeFixture();
}, 60_000);
afterEach(async () => {
  await f?.close();
});

const TODAY = '2026-11-03';
const TOMORROW = '2026-11-04';
const herPlan = async (day = TODAY) => (await k.her('GET', `/v1/p/plans/${day}`)).json() as PlanView;
const herReview = async (day = TODAY) => (await k.her('GET', `/v1/p/plans/${day}/review`)).json() as Extract<ReviewView, { level: 'full' }>;
const put = (body: object, day = TODAY) => k.him('PUT', `/v1/people/${f.asha.id}/plans/${day}`, { between: [], send: 'quiet', ...body });

/** A day with one of each: his steps (done, skipped, missed, removed after sending), her step (carried), a check-between and her to-dos. */
async function seedDay(): Promise<{ steps: Record<string, string>; todos: Record<'done' | 'skipped' | 'moved' | 'gone' | 'open', string> }> {
  await put({
    srev: 0,
    steps: [{ title: 'Mock' }, { title: 'Analysis' }, { title: 'Daily file' }, { title: 'Night check-in' }],
    between: [{ title: 'Check applications', every: 120, from: '10:00', to: '18:00' }],
  });
  const v = await herPlan();
  const by = Object.fromEntries((v.plan?.steps ?? []).map((s) => [s.title, s.id]));
  // He removes "Night check-in" after sending: it reads "gone", with the title she saw.
  const b = v.plan?.between[0];
  await put({
    srev: v.plan?.srev,
    steps: ['Mock', 'Analysis', 'Daily file'].map((t) => ({ id: by[t], title: t })),
    between: [{ id: b?.id, title: b?.title, every: b?.every, from: b?.from, to: b?.to }],
  });
  const hers = ((await k.her('POST', `/v1/p/plans/${TODAY}/steps`, { title: 'Log practice questions' })).json() as { id: string }).id;
  await k.her('POST', `/v1/p/plans/${TODAY}/steps/${by.Mock}/state`, { to: 'done', report: 'Went well' });
  await k.her('POST', `/v1/p/plans/${TODAY}/steps/${by.Analysis}/state`, { to: 'skipped', reason: 'Ran out of time' });
  const bid = v.plan?.between[0]?.id as string;
  await k.at(`${TODAY}T10:05:00.000Z`);
  await k.her('POST', `/v1/p/plans/${TODAY}/between/${bid}/tick`, { slot: '10:00', done: true });
  await k.at(`${TODAY}T12:05:00.000Z`);
  await k.her('POST', `/v1/p/plans/${TODAY}/between/${bid}/tick`, { slot: '12:00', done: true });
  await k.at(`${TODAY}T14:05:00.000Z`);
  await k.her('POST', `/v1/p/plans/${TODAY}/between/${bid}/tick`, { slot: '14:00', done: true });
  // Her to-dos due today: one done, one skipped, one moved to tomorrow, one deleted, one left open.
  const todo = async (title: string) => ((await k.her('POST', '/v1/p/todos', { title, due: { day: TODAY } })).json() as { id: string }).id;
  const todos = { done: await todo('Water plants'), skipped: await todo('Gym'), moved: await todo('Call bank'), gone: await todo('Old thing'), open: await todo('Read') };
  await k.her('POST', `/v1/p/todos/${todos.done}/done`, { done: true });
  await k.her('POST', `/v1/p/todos/${todos.skipped}/skip`, { reason: 'Not feeling well' });
  await k.her('PATCH', `/v1/p/todos/${todos.moved}`, { due: { day: TOMORROW } });
  await k.her('DELETE', `/v1/p/todos/${todos.gone}`);
  return { steps: { ...by, hers }, todos };
}

describe('outcomes (spec 3.10)', () => {
  it('lists every step as sent, each check-between and her to-dos due; live until sent, stored after', async () => {
    const { steps, todos } = await seedDay();
    const live = await herReview();
    expect(live).toMatchObject({ level: 'full', sent: false });
    const outcome = (ref: string) => live.items.find((i) => i.ref === ref)?.outcome;
    expect(outcome(steps.Mock as string)).toBe('done');
    expect(live.items.find((i) => i.ref === steps.Mock)?.report).toBe('Went well');
    expect(outcome(steps.Analysis as string)).toBe('skipped');
    expect(live.items.find((i) => i.ref === steps.Analysis)?.reason).toBe('Ran out of time');
    expect(outcome(steps['Night check-in'] as string)).toBe('gone');
    expect(live.items.find((i) => i.ref === steps['Night check-in'])?.title).toBe('Night check-in');
    // Open things have no outcome until the review is sent or closes.
    expect(outcome(steps['Daily file'] as string)).toBeUndefined();
    expect(outcome(steps.hers as string)).toBeUndefined();
    expect(live.items.find((i) => i.kind === 'between')).toMatchObject({ title: 'Check applications', ticks: { done: 3, of: 5 } });
    expect(outcome(todos.done)).toBe('done');
    expect(outcome(todos.skipped)).toBe('skipped');
    expect(live.items.find((i) => i.ref === todos.moved)).toMatchObject({ outcome: 'moved', movedTo: TOMORROW });
    expect(outcome(todos.gone)).toBe('gone');
    expect(outcome(todos.open)).toBeUndefined();

    // Send: her step carries to tomorrow, his open one goes to him as an ask, the rest is missed.
    await k.subscribeAll();
    const send = await k.her('POST', `/v1/p/plans/${TODAY}/review`, { carry: [steps.hers], askCarry: [steps['Daily file']], note: 'A long day.', mood: 3, toJournal: true });
    expect(send.statusCode, send.body).toBe(200);
    const stored = await herReview();
    expect(stored).toMatchObject({ sent: true, note: 'A long day.', mood: 3 });
    const out = (ref: string) => stored.items.find((i) => i.ref === ref)?.outcome;
    expect(stored.items.find((i) => i.ref === steps.hers)).toMatchObject({ outcome: 'moved', movedTo: TOMORROW });
    expect(out(steps['Daily file'] as string)).toBe('missed');
    expect(out(todos.open)).toBe('missed');
    expect(stored.counts).toEqual({ done: 2, skipped: 2, excused: 0, moved: 2, missed: 2, gone: 2 });
    expect(stored.line).toBe('2 done · 2 skipped · 2 moved · 2 missed · 2 gone');
    // The carried copy waits tomorrow; his step became one change request to him.
    expect((await herPlan(TOMORROW)).plan?.steps.map((s) => [s.title, s.carriedFrom?.stepId])).toEqual([['Log practice questions', steps.hers]]);
    const alerts = ((await k.him('GET', `/v1/people/alerts?with=${f.asha.id}`)).json() as { alerts: PersonAlert[] }).alerts;
    expect(alerts.find((a) => a.kind === 'change_request')).toMatchObject({ from: f.asha.id, to: '', text: 'Asks to carry 1 step to Wed', carry: { day: TODAY, to: TOMORROW, steps: [steps['Daily file']] } });
    // Once a day.
    const again = await k.her('POST', `/v1/p/plans/${TODAY}/review`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe("That day's review was already sent.");
    // "Also save to my journal": a review entry with the same note and mood.
    const j = (await k.her('GET', '/v1/p/journal')).json() as JournalList;
    expect(j.entries.map((e) => [e.kind, e.text, e.mood, e.day])).toEqual([['review', 'A long day.', 3, TODAY]]);
    // His push: no note text anywhere, a link to the review.
    await eventually(() => expect(k.to(EP.sam).some((p) => /evening review/.test(p.body))).toBe(true));
    const push = k.to(EP.sam).find((p) => /evening review/.test(p.body));
    expect(push).toMatchObject({ body: 'Asha sent the evening review.', url: `/people/${f.asha.id}?tab=today&day=${TODAY}&review=1` });
    expect(JSON.stringify(k.sent())).not.toContain('A long day');
  });

  it('a rough day reads "excused"; his carry moves his open steps (and hers with editHers.plan)', async () => {
    await put({ srev: 0, steps: [{ title: 'One' }, { title: 'Two' }] });
    const hers = ((await k.her('POST', `/v1/p/plans/${TODAY}/steps`, { title: 'Mine' })).json() as { id: string }).id;
    await k.her('POST', `/v1/p/plans/${TODAY}/rough`, {});
    expect((await herReview()).items.filter((i) => i.kind === 'step').map((i) => i.outcome)).toEqual(['excused', 'excused', 'excused']);
    await k.her('DELETE', `/v1/p/plans/${TODAY}/rough`);
    const [one] = (await herPlan()).plan?.steps ?? [];
    const c = await k.him('POST', `/v1/people/${f.asha.id}/plans/${TODAY}/review/carry`, { steps: [one?.id, hers] });
    expect(c.statusCode, c.body).toBe(200);
    expect((await herPlan(TOMORROW)).plan?.steps.map((s) => s.title)).toEqual(['One', 'Mine']);
    // Without editHers.plan, only his own move.
    await put({ srev: 0, steps: [{ title: 'Three' }] }, '2026-11-05');
    const hers2 = ((await k.her('POST', '/v1/p/plans/2026-11-05/steps', { title: 'Mine too' })).json() as { id: string }).id;
    await k.her('POST', '/v1/p/agreement/narrow', { editHers: { plan: false } });
    expect((await k.him('POST', `/v1/people/${f.asha.id}/plans/2026-11-05/review/carry`, { steps: [hers2] })).statusCode).toBe(404);
    // Each carry is in her Activity.
    const act = ((await k.her('GET', '/v1/p/activity')).json() as { activity: { action: string; title?: string }[] }).activity;
    expect(act.filter((a) => a.action === 'step.carried').map((a) => a.title).sort()).toEqual(['Mine', 'One']);
  });
});

describe('his levels (see.review)', () => {
  it('full: the same DTO as her mirror; counts: no title, note or mood; off: 404 and a locked tile', async () => {
    await put({ srev: 0, steps: [{ title: 'SECRET-step-title' }] });
    await k.her('POST', `/v1/p/plans/${TODAY}/review`, { note: 'SECRET-review-note', mood: 2 });
    const full = await k.him('GET', `/v1/people/${f.asha.id}/plans/${TODAY}/review`);
    expect(full.statusCode).toBe(200);
    expect(full.json()).toEqual((await k.her('GET', '/v1/p/mirror/review?day=2026-11-03')).json());
    expect(full.json()).toMatchObject({ level: 'full', note: 'SECRET-review-note', mood: 2 });
    await k.her('POST', '/v1/p/agreement/narrow', { see: { review: 'counts' } });
    const counts = await k.him('GET', `/v1/people/${f.asha.id}/plans/${TODAY}/review`);
    expect(counts.json()).toMatchObject({ level: 'counts', sent: true, line: '1 missed' });
    expect(counts.body).not.toMatch(/SECRET|mood|items/);
    const today = await k.him('GET', `/v1/people/${f.asha.id}/today`);
    expect(today.body).not.toMatch(/SECRET-review/);
    await k.her('POST', '/v1/p/agreement/narrow', { see: { review: 'off' } });
    const off = await k.him('GET', `/v1/people/${f.asha.id}/plans/${TODAY}/review`);
    const unknown = await k.him('GET', `/v1/people/01JZZZZZZZZZZZZZZZZZZZZZZZ/plans/${TODAY}/review`);
    expect([off.statusCode, off.body]).toEqual([unknown.statusCode, unknown.body]);
    await k.at(`${TODAY}T21:30:00.000Z`);
    expect(((await k.him('GET', `/v1/people/${f.asha.id}/today`)).json() as { review: unknown }).review).toEqual({ locked: true });
  });

  it('M5 / T10: with see.todos off the review holds none of her to-dos, at full and at counts, live and sent', async () => {
    await put({ srev: 0, steps: [{ title: 'Walk' }] });
    const todo = async (title: string) => ((await k.her('POST', '/v1/p/todos', { title, due: { day: TODAY } })).json() as { id: string }).id;
    const a = await todo('CANARY-PRIVATE-TODO-A');
    const b = await todo('CANARY-PRIVATE-TODO-B');
    await k.her('POST', `/v1/p/todos/${a}/done`, { done: true, report: 'CANARY-PRIVATE-REPORT' });
    await k.her('POST', `/v1/p/todos/${b}/skip`, { reason: 'CANARY-PRIVATE-SKIP-REASON' });
    const canary = /CANARY-PRIVATE/;
    const url = `/v1/people/${f.asha.id}/plans/${TODAY}/review`;
    // On: he sees them, as she does.
    expect((await k.him('GET', url)).body).toMatch(canary);
    await k.her('POST', '/v1/p/agreement/narrow', { see: { todos: false } });
    const check = async (level: 'full' | 'counts') => {
      const his = await k.him('GET', url);
      expect(his.statusCode).toBe(200);
      expect(his.body).not.toMatch(canary);
      const v = his.json() as ReviewView;
      expect(v.level).toBe(level);
      // Her to-dos are no part of his counts either: only the step.
      expect(v.counts.done + v.counts.skipped).toBe(0);
      if (v.level === 'full') expect(v.items.map((i) => i.kind)).toEqual(['step']);
      // Her mirror shows what he sees; her own review still has them.
      expect(his.json()).toEqual((await k.her('GET', `/v1/p/mirror/review?day=${TODAY}`)).json());
      await k.at(`${TODAY}T21:30:00.000Z`).catch(() => undefined);
      expect((await k.him('GET', `/v1/people/${f.asha.id}/today?day=${TODAY}`)).body).not.toMatch(canary);
    };
    await check('full');
    expect(JSON.stringify(await herReview())).toMatch(canary);
    // Sent: the stored outcomes are filtered when read.
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/review`, {})).statusCode).toBe(200);
    await check('full');
    await k.her('POST', '/v1/p/agreement/narrow', { see: { review: 'counts' } });
    await check('counts');
    expect((await herReview()).items.filter((i) => i.kind === 'todo')).toHaveLength(2);
  });

  it('the "review sent" push is dropped when review is off by the time it is sent (C7)', async () => {
    await k.subscribeAll();
    await k.him('PATCH', '/v1/people/prefs', { quiet: { from: '08:00', to: '10:00' } });
    await put({ srev: 0, steps: [{ title: 'One' }] });
    await k.her('POST', `/v1/p/plans/${TODAY}/review`, {});
    // Held by his quiet hours; she switches review off before it ends.
    await k.her('POST', '/v1/p/agreement/narrow', { see: { review: 'off' } });
    await k.at(`${TODAY}T10:05:00.000Z`);
    expect(k.to(EP.sam).filter((p) => /evening review/.test(p.body))).toEqual([]);
  });
});

describe('the card, the prompt and the 12:00 close', () => {
  it("shows from her review time, rings once (standard), and an unsent review closes at 12:00 the next day with auto and no push", async () => {
    await k.subscribeAll();
    await put({ srev: 0, steps: [{ title: 'One' }, { title: 'Two' }] });
    const [one] = (await herPlan()).plan?.steps ?? [];
    await k.her('POST', `/v1/p/plans/${TODAY}/steps/${one?.id}/state`, { to: 'done' });
    expect(((await k.her('GET', '/v1/p/today')).json() as PersonOwnToday).review).toBeNull();
    k.clearPushes();
    await k.at(`${TODAY}T21:01:00.000Z`);
    await eventually(() => expect(k.to(EP.asha)).toHaveLength(1));
    expect(k.to(EP.asha)[0]).toMatchObject({ title: 'Evening review', body: 'How did today go? 1 done · 1 open', url: '/p?review=1' });
    expect(((await k.her('GET', '/v1/p/today')).json() as PersonOwnToday).review).toMatchObject({ day: TODAY, line: '1 done · 1 open', yesterday: false });
    // The next morning it is "Yesterday's review", until 12:00.
    await k.at(`${TOMORROW}T09:00:00.000Z`);
    expect(((await k.her('GET', '/v1/p/today')).json() as PersonOwnToday).review).toMatchObject({ day: TODAY, yesterday: true });
    k.clearPushes();
    await k.at(`${TOMORROW}T12:01:00.000Z`);
    const closed = await herReview();
    expect(closed).toMatchObject({ sent: true, auto: true });
    expect(closed.note).toBeUndefined();
    expect(closed.counts).toMatchObject({ done: 1, missed: 1 });
    expect(((await k.her('GET', '/v1/p/today')).json() as PersonOwnToday).review).toBeNull();
    expect(k.sent()).toEqual([]);
    // A closed review can't be sent any more.
    expect((await k.her('POST', `/v1/p/plans/${TODAY}/review`, {})).statusCode).toBe(409);
  });

  it('the prompt is standard: dropped while she is paused or in quiet hours, never rung later', async () => {
    await k.subscribeAll();
    await put({ srev: 0, steps: [{ title: 'One' }] });
    await k.her('PATCH', '/v1/p/prefs', { quiet: { from: '20:30', to: '22:00' } });
    await k.at(`${TODAY}T23:00:00.000Z`);
    expect(k.to(EP.asha).filter((p) => p.title === 'Evening review')).toEqual([]);
    // But the card is there either way.
    expect(((await k.her('GET', '/v1/p/today')).json() as PersonOwnToday).review).not.toBeNull();
  });
});
