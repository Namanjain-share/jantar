/**
 * v0.12 People (P2): alerts both ways (spec 6, M22 in the daemon).
 *
 * - Caps belong to the recipient (D18, C29), set within their ranges; over
 *   a cap an alert is saved with no push. Urgent is held to at most 2 an
 *   hour. Nudges keep their per-item gap and their daily count.
 * - Her quiet hours hold normal alerts; Urgent breaks through unless she
 *   switched that off; one release summary when the hours end, nothing
 *   re-sent one by one.
 * - Her pause holds even Urgent (D14). Her alerts to him follow his own
 *   prefs. Kinds keep their direction.
 * - Seen only on open or reply; reply buttons close after 24 hours.
 * - "asleep" shows to him only with see.sleep; otherwise "quiet time".
 * - No alert text in the audit, the logs or Activity (kind only).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AlertsResponse, PersonActivityResponse, PersonAlert } from '@jantar/protocol/people';
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
const send = (body: object) => k.him('POST', '/v1/people/alerts', { to: f.asha.id, ...body });
const hers = (body: object) => k.her('POST', '/v1/p/alerts', body);
const hisList = async () => (await k.him('GET', `/v1/people/alerts?with=${f.asha.id}`)).json() as AlertsResponse;
const herList = async () => (await k.her('GET', '/v1/p/alerts')).json() as AlertsResponse;
const prefs = (body: object) => k.her('PATCH', '/v1/p/prefs', body);

describe('sending, seen and replies (spec 6.1, 6.4)', () => {
  it('his alert pushes her (alert text hidden by default); seen only on open; a reply reaches him; replies close after 24 h', async () => {
    await k.subscribeAll();
    const r = await send({ kind: 'check_in', text: 'CANARY-ALERT-TEXT' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ delivery: 'sent' });
    const id = (r.json() as { id: string }).id;
    expect(k.to(EP.asha)).toHaveLength(1);
    expect(k.to(EP.asha)[0]).toMatchObject({ title: 'Jantar', body: 'Alert from Sam', url: `/p/alerts?id=${id}` });
    expect(k.to(EP.sam)).toEqual([]);
    expect(k.to(EP.bea)).toEqual([]);

    // Delivered is not seen.
    let mine = await herList();
    expect(mine.unseen).toBe(1);
    expect(mine.alerts[0]).toMatchObject({ id, from: '', to: f.asha.id, kind: 'check_in', text: 'CANARY-ALERT-TEXT' });
    expect(mine.alerts[0]?.seenAt).toBeUndefined();
    expect((await k.her('POST', `/v1/p/alerts/${id}/seen`)).statusCode).toBe(200);
    expect((await hisList()).alerts[0]?.seenAt).toBe(`${TODAY}T09:00:00.000Z`);

    // A reply that doesn't fit the kind is refused; one that fits pushes him.
    expect((await k.her('POST', `/v1/p/alerts/${id}/reply`, { kind: 'heart' })).statusCode).toBe(400);
    expect((await k.her('POST', `/v1/p/alerts/${id}/reply`, { kind: 'cant_now_safe', note: 'On a call' })).statusCode).toBe(200);
    await eventually(() => expect(k.to(EP.sam)).toHaveLength(1));
    expect(k.to(EP.sam)[0]).toMatchObject({ title: 'Jantar', body: 'Reply from Asha' });
    expect((await hisList()).alerts[0]?.reply).toMatchObject({ kind: 'cant_now_safe', note: 'On a call' });

    // She can't mark seen or reply to her own; he can't to his own.
    const own = ((await hers({ kind: 'running_late' })).json() as { id: string }).id;
    expect((await k.her('POST', `/v1/p/alerts/${own}/reply`, { kind: 'ok' })).statusCode).toBe(404);
    expect((await k.him('POST', `/v1/people/alerts/${id}/seen`)).statusCode).toBe(404);

    // 24 hours on, the reply buttons are closed: "Expired", with no blame.
    const later = ((await send({ kind: 'call_me' })).json() as { id: string }).id;
    await k.advance(24 * 3_600_000 + 60_000);
    const late = await k.her('POST', `/v1/p/alerts/${later}/reply`, { kind: 'on_my_way' });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.message).toBe('This alert has expired.');
    mine = await herList();
    expect(mine.alerts.find((a) => a.id === later)?.expiresAt).toBe(`${TODAY}T09:00:00.000Z`.replace('03T09', '04T09'));
  });

  it('her lock screen choice: "Show everything" carries the label and note', async () => {
    await k.subscribeAll();
    expect((await prefs({ lockScreen: 'all' })).statusCode).toBe(200);
    await send({ kind: 'check_in', text: "Call when you're out" });
    expect(k.to(EP.asha)[0]).toMatchObject({ title: 'Sam', body: "Check in, please. Call when you're out" });
    await send({ kind: 'urgent' });
    expect(k.to(EP.asha)[1]).toMatchObject({ title: 'Sam', body: 'Urgent: need you now' });
  });

  it('kinds keep their direction; a custom alert needs text; a nudge needs an item he can see', async () => {
    expect((await send({ kind: 'running_late' })).statusCode).toBe(400);
    expect((await send({ kind: 'change_request' })).statusCode).toBe(400);
    expect((await hers({ kind: 'nudge', ref: { type: 'todo', id: '01JZZZZZZZZZZZZZZZZZZZZZZZ' } })).statusCode).toBe(400);
    expect((await send({ kind: 'custom' })).statusCode).toBe(400);
    expect((await send({ kind: 'nudge' })).statusCode).toBe(400);
    expect((await send({ kind: 'nudge', ref: { type: 'todo', id: '01JZZZZZZZZZZZZZZZZZZZZZZZ' } })).statusCode).toBe(404);
    // An alert to someone he doesn't share with: the one not_found.
    expect((await k.him('POST', '/v1/people/alerts', { to: f.eli.id, kind: 'check_in' })).statusCode).toBe(404);
    expect((await k.him('POST', '/v1/people/alerts', { to: '01JZZZZZZZZZZZZZZZZZZZZZZZ', kind: 'check_in' })).statusCode).toBe(404);
    // Custom: gentle or normal, never urgent by a body.
    expect((await send({ kind: 'custom', text: 'Hi', urgency: 'urgent' })).statusCode).toBe(400);
    expect((await send({ kind: 'custom', text: 'Hi', urgency: 'gentle' })).json()).toMatchObject({ delivery: 'sent' });
  });
});

describe('caps belong to the recipient (C29, D18)', () => {
  it('she sets them within their ranges; over a cap an alert is saved with no push; the sheet counts', async () => {
    await k.subscribeAll();
    for (const bad of [{ hour: 13 }, { hour: 0 }, { day: 41 }, { urgentDay: 7 }, { nudgeGapMin: 15 }, { nudgeDay: 16 }]) {
      const caps = { hour: 6, day: 20, urgentDay: 4, nudgeGapMin: 60, nudgeDay: 8, ...bad };
      expect((await prefs({ alertCaps: caps })).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await prefs({ alertCaps: { hour: 2, day: 3, urgentDay: 1, nudgeGapMin: 30, nudgeDay: 0 } })).statusCode).toBe(200);
    expect((await send({ kind: 'thinking_of_you' })).json()).toMatchObject({ delivery: 'sent' });
    expect((await send({ kind: 'check_in' })).json()).toMatchObject({ delivery: 'sent' });
    expect((await send({ kind: 'call_me' })).json()).toMatchObject({ delivery: 'capped' });
    expect(k.to(EP.asha)).toHaveLength(2);
    const sheet = (await hisList()).sheet;
    expect(sheet.caps).toMatchObject({ hour: 2, day: 3, urgentDay: 1 });
    expect(sheet.sent).toMatchObject({ hour: 2, day: 2 });
    expect(sheet.hold).toBe("You've sent 2 of the 2 alerts Asha allows an hour.");
    // Urgent has its own count: one a day here.
    expect((await send({ kind: 'urgent' })).json()).toMatchObject({ delivery: 'sent' });
    expect((await send({ kind: 'urgent' })).json()).toMatchObject({ delivery: 'capped' });
    // An hour on, the hour cap frees up, and the day cap (3) still holds.
    await k.advance(3_600_000 + 1_000);
    expect((await send({ kind: 'good_night' })).json()).toMatchObject({ delivery: 'sent' });
    expect((await send({ kind: 'good_night' })).json()).toMatchObject({ delivery: 'capped' });
    // Capped alerts are kept (she sees them on her Alerts page) but never pushed.
    const list = await herList();
    expect(list.alerts.filter((a) => a.delivery === 'capped')).toHaveLength(3);
    expect(k.to(EP.asha)).toHaveLength(4);
  });

  it('Urgent is held to 2 an hour even under her day cap; nudges keep their per-item gap and daily count', async () => {
    await k.subscribeAll();
    expect((await send({ kind: 'urgent' })).json()).toMatchObject({ delivery: 'sent' });
    expect((await send({ kind: 'urgent' })).json()).toMatchObject({ delivery: 'sent' });
    expect((await send({ kind: 'urgent' })).json()).toMatchObject({ delivery: 'capped' });
    await k.advance(3_600_000 + 1_000);
    expect((await send({ kind: 'urgent' })).json()).toMatchObject({ delivery: 'sent' });

    const todo = ((await k.him('POST', `/v1/people/${f.asha.id}/todos`, { title: 'Call the bank' })).json() as { id: string }).id;
    const nudge = () => send({ kind: 'nudge', ref: { type: 'todo', id: todo } });
    const first = await nudge();
    expect(first.json()).toMatchObject({ delivery: 'sent' });
    expect(k.to(EP.asha).at(-1)).toMatchObject({ body: 'Alert from Sam' });
    expect((await herList()).alerts[0]).toMatchObject({ kind: 'nudge', ref: { type: 'todo', id: todo, title: 'Call the bank' } });
    expect((await nudge()).json()).toMatchObject({ delivery: 'capped' });
    // She allows one per 30 minutes.
    await prefs({ alertCaps: { hour: 6, day: 20, urgentDay: 4, nudgeGapMin: 30, nudgeDay: 2 } });
    await k.advance(31 * 60_000);
    expect((await nudge()).json()).toMatchObject({ delivery: 'sent' });
    await k.advance(31 * 60_000);
    // Two nudges today is her daily count.
    expect((await nudge()).json()).toMatchObject({ delivery: 'capped' });
    // A done item can't be nudged.
    await k.her('POST', `/v1/p/todos/${todo}/done`, { done: true });
    expect((await nudge()).statusCode).toBe(404);
  });
});

describe('holds and the release summary (spec 6.3)', () => {
  it('quiet hours hold normal alerts; Urgent breaks through (her switch); one summary when they end', async () => {
    await k.subscribeAll();
    expect((await prefs({ quiet: { from: '08:00', to: '10:00' } })).statusCode).toBe(200);
    expect((await send({ kind: 'check_in' })).json()).toMatchObject({ delivery: 'held_quiet' });
    expect((await hisList()).sheet.hold).toBe('Asha is in quiet hours until 10:00. Urgent still goes through.');
    expect((await send({ kind: 'urgent', text: 'Call me' })).json()).toMatchObject({ delivery: 'sent' });
    expect(k.to(EP.asha)).toHaveLength(1);
    expect(k.to(EP.asha)[0]).toMatchObject({ body: 'Urgent alert from Sam', urgent: true });
    await prefs({ urgentBreaksQuiet: false });
    expect((await hisList()).sheet.hold).toBe('Asha is in quiet hours until 10:00. Urgent waits too.');
    expect((await send({ kind: 'urgent' })).json()).toMatchObject({ delivery: 'held_quiet' });
    expect(k.to(EP.asha)).toHaveLength(1);
    await k.at(`${TODAY}T10:00:02.000Z`);
    await eventually(() => expect(k.to(EP.asha)).toHaveLength(2));
    expect(k.to(EP.asha)[1]).toMatchObject({ title: 'Jantar', body: '2 alerts from Sam while you were in quiet hours.', url: '/p/alerts' });
    expect((await herList()).alerts.filter((a) => a.delivery === 'released')).toHaveLength(2);
    // Nothing is re-sent one by one, and nothing repeats.
    await k.advance(3 * 3_600_000);
    expect(k.to(EP.asha)).toHaveLength(2);
  });

  it('her pause holds even Urgent (D14), and resuming releases one summary', async () => {
    await k.subscribeAll();
    expect((await k.her('POST', '/v1/p/pause', {})).statusCode).toBe(200);
    k.clearPushes();
    expect((await send({ kind: 'urgent' })).json()).toMatchObject({ delivery: 'held_pause' });
    expect((await hisList()).sheet.hold).toBe('Asha has paused and will see this after resuming. In an emergency, phone Asha.');
    expect(k.to(EP.asha)).toEqual([]);
    // Her own alerts to him are never held by her pause.
    expect((await hers({ kind: 'running_late' })).json()).toMatchObject({ delivery: 'sent' });
    expect((await k.her('POST', '/v1/p/resume', {})).statusCode).toBe(200);
    await k.advance(3_600_000 + 2_000);
    await eventually(() => expect(k.to(EP.asha).filter((p) => /while you were paused/.test(p.body))).toHaveLength(1));
    expect(k.to(EP.asha).find((p) => /while you were paused/.test(p.body))?.body).toBe('1 alert from Sam while you were paused.');
  });

  it('her alerts to him follow his own prefs: quiet hours, caps and mute', async () => {
    await k.subscribeAll();
    const p = await k.him('PATCH', '/v1/people/prefs', { quiet: { from: '08:00', to: '10:00' }, alertCaps: { hour: 1, day: 3, urgentDay: 1, nudgeGapMin: 60, nudgeDay: 8 } });
    expect(p.statusCode, p.body).toBe(200);
    expect((await hers({ kind: 'running_late' })).json()).toMatchObject({ delivery: 'held_quiet' });
    expect((await herList()).sheet.hold).toBe('Sam is in quiet hours until 10:00. Urgent still goes through.');
    expect((await hers({ kind: 'call_me' })).json()).toMatchObject({ delivery: 'capped' });
    expect((await hers({ kind: 'urgent' })).json()).toMatchObject({ delivery: 'sent' });
    expect(k.to(EP.sam)).toHaveLength(1);
    expect(k.to(EP.sam)[0]).toMatchObject({ body: 'Urgent alert from Asha', url: expect.stringMatching(`^/people/${f.asha.id}\\?tab=alerts&id=`) });
    await k.at(`${TODAY}T10:00:02.000Z`);
    await eventually(() => expect(k.to(EP.sam)).toHaveLength(2));
    expect(k.to(EP.sam)[1]?.body).toBe('1 alert from Asha while you were in quiet hours.');
    expect(k.to(EP.asha)).toEqual([]);
    // His prefs body is strict and his caps keep their ranges.
    expect((await k.him('PATCH', '/v1/people/prefs', { alertCaps: { hour: 99, day: 3, urgentDay: 1, nudgeGapMin: 60, nudgeDay: 8 } })).statusCode).toBe(400);
    expect((await k.him('PATCH', '/v1/people/prefs', { focus: true })).statusCode).toBe(400);
  });

  it('"asleep" reaches him only with see.sleep; otherwise it reads "quiet time"; Woke up releases', async () => {
    await k.subscribeAll();
    expect((await k.her('POST', '/v1/p/sleep/start', { clientId: 'night-0001' })).statusCode).toBe(200);
    expect((await send({ kind: 'check_in' })).json()).toMatchObject({ delivery: 'held_sleep' });
    expect((await hisList()).sheet.hold).toBe('Asha is asleep (since 09:00). Only Urgent goes through.');
    expect((await send({ kind: 'urgent' })).json()).toMatchObject({ delivery: 'sent' });
    expect((await k.her('POST', '/v1/p/agreement/narrow', { see: { sleep: false } })).statusCode).toBe(200);
    const blind = await send({ kind: 'good_morning' });
    expect(blind.json()).toMatchObject({ delivery: 'held_quiet' });
    const list = await hisList();
    expect(list.sheet.hold).toBe('Asha has quiet time on. Only Urgent goes through.');
    expect(list.alerts.map((a) => a.delivery)).not.toContain('held_sleep');
    expect(JSON.stringify(list)).not.toMatch(/asleep|held_sleep/);
    // Her own list says what it was.
    expect((await herList()).alerts.filter((a) => a.delivery === 'held_sleep')).toHaveLength(2);
    await k.advance(7 * 3_600_000);
    expect((await k.her('POST', '/v1/p/sleep/wake', { clientId: 'wake-00001' })).statusCode).toBe(200);
    await k.advance(2_000);
    await eventually(() => expect(k.to(EP.asha)).toHaveLength(2));
    expect(k.to(EP.asha)[1]?.body).toBe('2 alerts from Sam while you were asleep.');
  });

  it('"Hold alerts while I sleep" off: an open night holds nothing', async () => {
    await k.subscribeAll();
    await prefs({ sleepHolds: false });
    await k.her('POST', '/v1/p/sleep/start', { clientId: 'night-0002' });
    expect((await send({ kind: 'check_in' })).json()).toMatchObject({ delivery: 'sent' });
  });
});

describe('records (O15, C8)', () => {
  it('no alert text in the audit, the logs or Activity (the kind only)', async () => {
    f.api.ctx.log.records.length = 0;
    await send({ kind: 'custom', text: 'CANARY-ALERT-HIS' });
    await hers({ kind: 'custom', text: 'CANARY-ALERT-HERS' });
    const id = (await herList()).alerts.find((a) => a.from === '')?.id as string;
    await k.her('POST', `/v1/p/alerts/${id}/reply`, { kind: 'ok', note: 'CANARY-ALERT-REPLY' });
    const audit = JSON.stringify(f.api.ctx.db.audit.list({ limit: 1000 }));
    const logs = JSON.stringify(f.api.ctx.log.records);
    for (const text of [audit, logs]) expect(text).not.toMatch(/CANARY-ALERT/);
    const act = (await k.her('GET', '/v1/p/activity')).json() as PersonActivityResponse;
    expect(JSON.stringify(act)).not.toMatch(/CANARY-ALERT/);
    expect(act.activity.find((a) => a.action === 'alert.sent')).toMatchObject({ fields: ['custom'] });
    // Bea sees none of it.
    expect(((await k.her('GET', '/v1/p/alerts', undefined, f.bea.full)).json() as AlertsResponse).alerts).toEqual([]);
  });

  it('alerts are kept 90 days (the daily sweep prunes older ones)', async () => {
    await send({ kind: 'check_in' });
    const core = f.life.people.openCore();
    if (!core) throw new Error('life closed');
    const count = () => (core.db.prepare("SELECT COUNT(*) AS n FROM person_alerts WHERE to_person = ? AND from_person = ''").get(f.asha.id) as { n: number }).n;
    // Back-date the row rather than run 90 days of timers.
    const backdate = (days: number) =>
      core.db.prepare("UPDATE person_alerts SET at = ? WHERE to_person = ? AND from_person = ''").run(new Date(f.api.ctx.clock.now() - days * 86_400_000).toISOString(), f.asha.id);
    backdate(89);
    f.life.people.alerts?.prune();
    expect(count()).toBe(1);
    backdate(91);
    f.life.people.alerts?.prune();
    expect(count()).toBe(0);
  });
});
