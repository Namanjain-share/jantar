/**
 * Reading Claude's answer (spec 2.1, 2.2, 3.4; 12.2 "answer" and the due
 * rules' pure part): every row of the model form and its card form, the
 * four day-and-time steps (FakeClock-free: `now` is a scope value here),
 * no_time over the whole answer, project matching, amounts to hundredths,
 * category mapping, a part that is off, the cap of ten, an unreadable
 * answer, nothing visible, and the reply cut to 500 with its "…".
 * checkWrite runs the same rules at Add.
 */
import { describe, expect, it } from 'vitest';
import { ASK_REPLY_MAX, AskTurnSchema, type AskTodoAction } from '@jantar/protocol';
import { ASK_SENTENCES, asksReminder, checkWrite, matchCategory, matchProject, parseAnswer, readAction, replyOf, settleDue, type AskScope } from '../../src/ask/answer.js';

const ID_A = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const ID_B = '01JFZ8X8Y3T0V5G9WQK2M4N6PS';
const ID_C = '01JFZ8X8Y3T0V5G9WQK2M4N6PT';
const TODAY = '2026-11-01';
const TOMORROW = '2026-11-02';

const scope = (over: Partial<AskScope> = {}): AskScope => ({
  today: TODAY,
  now: '14:05',
  modules: { todos: true, food: true, finance: true, medicines: true },
  projects: [
    { id: ID_A, name: 'Jantar', status: 'done' },
    { id: ID_B, name: ' jantar ', status: 'active' },
    { id: ID_C, name: 'Acme site', status: 'paused' },
  ],
  remind: false,
  ...over,
});

const one = (raw: unknown, s = scope()) => readAction(raw, s);
const answer = (actions: unknown[], reply = 'ok') => JSON.stringify({ reply, actions });

describe('the answer', () => {
  it('one JSON object, or inside one code fence; actions left out or null are none; other keys ignored', () => {
    expect(parseAnswer(answer([{ type: 'todo', title: 'Call the bank' }]), scope())).toEqual({
      reply: 'ok',
      cards: [{ action: { type: 'todo', title: 'Call the bank' }, state: 'proposed' }],
      dropped: 0,
    });
    expect(parseAnswer('```json\n{"reply":"hi","actions":[]}\n```', scope())).toEqual({ reply: 'hi', cards: [], dropped: 0 });
    expect(parseAnswer('  {"reply":"hi","mood":"good"}  ', scope())).toEqual({ reply: 'hi', cards: [], dropped: 0 });
    expect(parseAnswer('{"reply":"Nothing to add.","actions":null}', scope())).toEqual({ reply: 'Nothing to add.', cards: [], dropped: 0 });
  });

  it('anything else is unreadable (null)', () => {
    for (const bad of ['', 'Sure! I added it.', '[]', '{"reply":"x","actions":{}}', '{"actions":[]}', '{"reply":5,"actions":[]}', '{"reply":"x"', '```\n{"reply":"x"}\n``` and more']) {
      expect(parseAnswer(bad, scope()), bad).toBeNull();
    }
  });

  it('reads ten actions at most: every one after counts as dropped', () => {
    const todos = Array.from({ length: 15 }, (_, i) => ({ type: 'todo', title: `Task ${i + 1}` }));
    const r = parseAnswer(answer(todos), scope());
    expect(r?.cards).toHaveLength(10);
    expect(r?.dropped).toBe(5);
    expect(r?.cards.at(-1)?.action).toMatchObject({ title: 'Task 10' });
    // A bad one inside the ten counts too: 1 there, and 6 past the tenth.
    expect(parseAnswer(answer([{ type: 'shell' }, ...todos]), scope())).toMatchObject({ dropped: 7 });
  });

  it('an empty reply with no cards is the fixed sentence; with cards, no reply', () => {
    expect(parseAnswer(answer([], '   '), scope())).toEqual({ reply: ASK_SENTENCES.empty, cards: [], dropped: 0 });
    expect(parseAnswer(answer([{ type: 'shell' }], ''), scope())).toEqual({ reply: ASK_SENTENCES.empty, cards: [], dropped: 1 });
    expect(parseAnswer(answer([{ type: 'show', what: 'due' }], '‮'), scope())).toEqual({ cards: [{ action: { type: 'show', what: 'due' }, state: 'proposed' }], dropped: 0 });
    // Nothing visible is no reply.
    expect(parseAnswer(answer([], '\u200b\ufeff \u2060'), scope())).toEqual({ reply: ASK_SENTENCES.empty, cards: [], dropped: 0 });
  });

  it('the reply: controls and bidi stripped, line breaks kept, cut to 500 with the "…" counted', () => {
    expect(replyOf('  Two todos‮ for\u0007 tomorrow.\r\nSee [bank](https://bank.example)  ')).toBe('Two todos for tomorrow.\nSee [bank](https://bank.example)');
    const long = replyOf(`Here ‮is \u0007${'x'.repeat(2000)}`);
    expect(long).toHaveLength(ASK_REPLY_MAX);
    expect(long.endsWith('…')).toBe(true);
    expect(long).not.toMatch(/[‮\u0007]/);
    expect(replyOf('x'.repeat(ASK_REPLY_MAX))).toBe('x'.repeat(ASK_REPLY_MAX));
    // Never half an emoji before the "…".
    const emoji = replyOf(`${'x'.repeat(ASK_REPLY_MAX - 2)}😀😀`);
    expect(emoji.length).toBeLessThanOrEqual(ASK_REPLY_MAX);
    expect(emoji.endsWith('x…')).toBe(true);
    const turn = { id: ID_A, at: '2026-11-01T08:35:00.000Z', text: 'x', state: 'done', reply: long, cards: [], dropped: 0 };
    expect(AskTurnSchema.safeParse(turn).success).toBe(true);
  });
});

describe('the allow-list', () => {
  it('four types only; anything else, a non-object or an unknown field drops it', () => {
    for (const raw of [
      { type: 'shell', command: 'touch x' },
      { type: 'settings', patch: { files: { enabled: true } } },
      { type: 'medicine', name: 'Examplocin', taken: true },
      { type: 'session', sid: 's1', text: 'y' },
      { type: 'intel', url: 'https://example.com' },
      { type: 'TODO', title: 'x' },
      'todo add milk',
      ['todo'],
      null,
      { type: 'todo', title: 'x', projectId: ID_B },
      { type: 'todo', title: 'x', id: ID_B },
      { type: 'food', name: 'Roti', kcal: 120, save: true },
      { type: 'money', kind: 'expense', amount: 250, category: 'Food', billId: ID_B },
      { type: 'show', what: 'due', day: TODAY },
    ]) {
      expect(one(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('a part that is off drops its actions (show cards by the part they read)', () => {
    const off = (m: Partial<AskScope['modules']>) => scope({ modules: { todos: true, food: true, finance: true, medicines: true, ...m } });
    expect(one({ type: 'todo', title: 'x' }, off({ todos: false }))).toBeNull();
    expect(one({ type: 'food', name: 'Roti', kcal: 1 }, off({ food: false }))).toBeNull();
    expect(one({ type: 'money', kind: 'income', amount: 1, category: 'Salary' }, off({ finance: false }))).toBeNull();
    expect(one({ type: 'show', what: 'due' }, off({ todos: false }))).toBeNull();
    expect(one({ type: 'show', what: 'calories' }, off({ food: false }))).toBeNull();
    expect(one({ type: 'show', what: 'meds' }, off({ medicines: false }))).toBeNull();
    expect(one({ type: 'show', what: 'meds' }, off({ todos: false, food: false, finance: false }))).toEqual({ action: { type: 'show', what: 'meds' } });
    for (const what of ['spent', 'bills', 'weight']) expect(one({ type: 'show', what })).toBeNull();
  });

  it('strings: controls stripped, line ends made spaces (notes keep them), trimmed; empty or too long drops, never cut', () => {
    expect(one({ type: 'todo', title: '  Call‮ the\r\nbank\u0007 ', notes: 'line one\r\nline two three' })).toEqual({
      action: { type: 'todo', title: 'Call the bank', notes: 'line one\nline two\nthree' },
    });
    expect(one({ type: 'todo', title: 'x'.repeat(200) })).not.toBeNull();
    expect(one({ type: 'todo', title: 'x'.repeat(201) })).toBeNull();
    expect(one({ type: 'todo', title: ' ‏ ' })).toBeNull();
    expect(one({ type: 'todo', title: '' })).toBeNull();
    // Nothing visible is empty: zero-width and other format characters, the Hangul filler.
    for (const blank of ['\u200b', '\u200b\u200c\u200d\ufeff \u2060\u00ad', '\u3164']) expect(one({ type: 'todo', title: blank }), JSON.stringify(blank)).toBeNull();
    expect(one({ type: 'food', name: '\u200b', kcal: 1 })).toBeNull();
    expect(one({ type: 'todo', title: 'x', notes: '\u200b\n\u200b' })).toBeNull();
    // Inside visible text they stay (a joined emoji keeps its joiners).
    expect(one({ type: 'todo', title: 'Call 👨\u200d👩\u200d👧' })?.action).toMatchObject({ title: 'Call 👨\u200d👩\u200d👧' });
    expect(one({ type: 'todo', title: 5 })).toBeNull();
    expect(one({ type: 'todo', title: 'x', notes: 'n'.repeat(2001) })).toBeNull();
    expect(one({ type: 'todo', title: 'x', notes: '' })).toBeNull();
    expect(one({ type: 'food', name: 'f'.repeat(81), kcal: 1 })).toBeNull();
    expect(one({ type: 'money', kind: 'expense', amount: 1, category: 'Food', note: 'n'.repeat(201) })).toBeNull();
  });
});

describe('todo: days and times, in order', () => {
  const todo = (fields: Record<string, unknown>, s = scope()) => one({ type: 'todo', title: 'Stretch', ...fields }, s);

  it('(1) a time and no day: today if still ahead, else tomorrow', () => {
    expect(todo({ time: '18:00' })).toEqual({ action: { type: 'todo', title: 'Stretch', due: { day: TODAY, time: '18:00' } } });
    expect(todo({ time: '09:00' })).toEqual({ action: { type: 'todo', title: 'Stretch', due: { day: TOMORROW, time: '09:00' } } });
    // "Not after now" is tomorrow too.
    expect(todo({ time: '14:05' })?.action).toMatchObject({ due: { day: TOMORROW, time: '14:05' } });
  });

  it('(2) a repeat and no day: today, then (3) on to its next day when that time has passed', () => {
    expect(todo({ repeat: 'daily' })).toEqual({ action: { type: 'todo', title: 'Stretch', due: { day: TODAY }, repeat: 'daily' } });
    expect(todo({ repeat: 'daily', time: '18:00' })?.action).toMatchObject({ due: { day: TODAY, time: '18:00' } });
    expect(todo({ repeat: 'daily', time: '09:00' })).toEqual({ action: { type: 'todo', title: 'Stretch', due: { day: TOMORROW, time: '09:00' }, repeat: 'daily' } });
    expect(todo({ repeat: 'weekly', time: '09:00' })?.action).toMatchObject({ due: { day: '2026-11-08', time: '09:00' } });
  });

  it('(3) a repeat dated today at a past time or before today steps on as Done does; no flag', () => {
    expect(todo({ repeat: 'weekly', day: TODAY, time: '00:00' })).toEqual({ action: { type: 'todo', title: 'Stretch', due: { day: '2026-11-08', time: '00:00' }, repeat: 'weekly' } });
    expect(todo({ repeat: 'daily', day: '2026-10-28', time: '09:00' })?.action).toMatchObject({ due: { day: TOMORROW } });
    expect(todo({ repeat: 'daily', day: '2026-10-28' })?.action).toMatchObject({ due: { day: TODAY } });
    // Monthly from the 31st: the next month's last day.
    const end = scope({ today: '2026-10-31', now: '14:05' });
    expect(todo({ repeat: 'monthly', day: '2026-10-31', time: '09:00' }, end)?.action).toMatchObject({ due: { day: '2026-11-30', time: '09:00' }, repeat: 'monthly' });
    expect(todo({ repeat: 'monthly', time: '09:00' }, scope({ today: '2027-01-31' }))?.action).toMatchObject({ due: { day: '2027-02-28' } });
  });

  it('(4) a one-off at a time not after now, today or a day before: kept, flagged past_time', () => {
    expect(todo({ day: TODAY, time: '09:00' })).toEqual({ action: { type: 'todo', title: 'Stretch', due: { day: TODAY, time: '09:00' } }, flag: 'past_time' });
    expect(todo({ day: TODAY, time: '14:05' })?.flag).toBe('past_time');
    expect(todo({ day: TODAY, time: '14:06' })?.flag).toBeUndefined();
    expect(todo({ day: TOMORROW, time: '09:00' })?.flag).toBeUndefined();
    // A day before today: any time has gone (a week back is the furthest a day may be).
    expect(todo({ day: '2026-10-31', time: '23:59' })).toEqual({ action: { type: 'todo', title: 'Stretch', due: { day: '2026-10-31', time: '23:59' } }, flag: 'past_time' });
    expect(todo({ day: '2026-10-25', time: '09:00' })?.flag).toBe('past_time');
    // With no time it never rings anyway: a plain overdue todo.
    expect(todo({ day: '2026-10-31' })).toEqual({ action: { type: 'todo', title: 'Stretch', due: { day: '2026-10-31' } } });
  });

  it('a day: real, from a week back to 400 days on; a time HH:MM; repeat and priority from their lists', () => {
    expect(todo({ day: '2026-10-25' })).not.toBeNull();
    expect(todo({ day: '2026-10-24' })).toBeNull();
    expect(todo({ day: '2027-12-06' })).not.toBeNull();
    expect(todo({ day: '2027-12-07' })).toBeNull();
    expect(todo({ day: '2028-11-01' })).toBeNull();
    for (const day of ['2026-02-31', '2026-11-1', 'tomorrow', '2026-13-01', 20261101]) expect(todo({ day }), String(day)).toBeNull();
    for (const time of ['25:00', '9:00', '09:60', '6 pm', 900]) expect(todo({ time }), String(time)).toBeNull();
    expect(todo({ repeat: 'hourly' })).toBeNull();
    expect(todo({ priority: 'urgent' })).toBeNull();
    expect(todo({ priority: 'high' })?.action).toMatchObject({ priority: 'high' });
  });

  it('no_time: a reminder asked for and no todo in the answer given a time', () => {
    expect(asksReminder('remind me to call mum')).toBe(true);
    expect(asksReminder('Reminder: pay rent')).toBe(true);
    expect(asksReminder('kal yaad dila dena')).toBe(true);
    expect(asksReminder('कल दवाई की याद दिलाना')).toBe(true);
    expect(asksReminder('todo add milk')).toBe(false);
    const flags = (actions: Record<string, unknown>[], remind = true) =>
      parseAnswer(answer(actions.map((a) => ({ type: 'todo', title: 'Stretch', ...a }))), scope({ remind }))?.cards.map((c) => c.flag);
    expect(flags([{}])).toEqual(['no_time']);
    expect(flags([{ day: TOMORROW }, { title: 'Buy milk' }])).toEqual(['no_time', 'no_time']);
    // "remind me at 6 to take X and add milk": the time answers the reminder; milk is a plain todo.
    expect(flags([{ title: 'Take X', time: '18:00' }, { title: 'Buy milk' }])).toEqual([undefined, undefined]);
    expect(flags([{ day: TODAY, time: '09:00' }, {}])).toEqual(['past_time', undefined]);
    // It outranks no_project; it is never on food, money or show cards; no reminder asked, no flag.
    expect(flags([{ project: 'Nope' }])).toEqual(['no_time']);
    expect(parseAnswer(answer([{ type: 'food', name: 'Roti', kcal: 1 }, { type: 'show', what: 'due' }]), scope({ remind: true }))?.cards.map((c) => c.flag)).toEqual([undefined, undefined]);
    expect(flags([{}], false)).toEqual([undefined]);
    // One action read alone never says it: it is the whole answer's.
    expect(todo({}, scope({ remind: true }))?.flag).toBeUndefined();
  });

  it("a project by name: trimmed, any case; active, then paused, then done; never the model's id", () => {
    expect(todo({ project: 'JANTAR' })?.action).toMatchObject({ projectId: ID_B });
    expect(todo({ project: '  acme SITE ' })?.action).toMatchObject({ projectId: ID_C });
    expect(todo({ project: 'Nope' })).toEqual({ action: { type: 'todo', title: 'Stretch' }, flag: 'no_project' });
    expect(todo({ project: 'Jantar' }, scope({ projects: [] }))?.flag).toBe('no_project');
    expect(todo({ project: 'p'.repeat(61) })).toBeNull();
    expect(matchProject('jantar', [{ id: ID_A, name: 'Jantar', status: 'done' }])).toBe(ID_A);
    expect(matchProject('jan', scope().projects)).toBeUndefined();
  });
});

describe('food', () => {
  const food = (fields: Record<string, unknown>) => one({ type: 'food', name: 'Roti', kcal: 240, ...fields });

  it('today when no day; kcal rounded, 0 to 10,000; never after today', () => {
    expect(food({})).toEqual({ action: { type: 'food', day: TODAY, name: 'Roti', kcal: 240 } });
    expect(food({ kcal: 239.6 })?.action).toMatchObject({ kcal: 240 });
    expect(food({ kcal: 0 })?.action).toMatchObject({ kcal: 0 });
    expect(food({ kcal: 10_000.4 })?.action).toMatchObject({ kcal: 10_000 });
    expect(food({ day: '2026-10-31' })?.action).toMatchObject({ day: '2026-10-31' });
    for (const kcal of [-1, 20_000, '240', Number.NaN, null]) expect(food({ kcal }), String(kcal)).toBeNull();
    expect(food({ day: TOMORROW })).toBeNull();
    expect(one({ type: 'food', name: 'Roti' })).toBeNull();
  });
});

describe('money', () => {
  const money = (fields: Record<string, unknown>) => one({ type: 'money', kind: 'expense', amount: 250, category: 'Food', ...fields });

  it('the amount in hundredths, whatever the currency; above 0 and at most 1e12', () => {
    expect(money({})).toEqual({ action: { type: 'money', kind: 'expense', amount: 25000, category: 'Food', day: TODAY } });
    expect(money({ amount: 12.345 })?.action).toMatchObject({ amount: 1235 });
    expect(money({ amount: 1e10 })?.action).toMatchObject({ amount: 1e12 });
    for (const amount of [0, -5, '250', 0.001, 1e10 + 1, Number.POSITIVE_INFINITY]) expect(money({ amount }), String(amount)).toBeNull();
  });

  it("a category from the kind's fixed list, any case, else Other", () => {
    expect(money({ category: 'food' })?.action).toMatchObject({ category: 'Food' });
    expect(money({ category: 'TRANSPORT' })?.action).toMatchObject({ category: 'Transport' });
    expect(money({ category: 'Lunch out' })?.action).toMatchObject({ category: 'Other' });
    // However long: never dropped for it.
    expect(money({ category: 'Team lunch at the office canteen' })?.action).toMatchObject({ category: 'Other' });
    expect(money({ category: 'c'.repeat(500) })?.action).toMatchObject({ category: 'Other' });
    expect(money({ kind: 'income', category: 'salary' })?.action).toMatchObject({ kind: 'income', category: 'Salary' });
    expect(money({ kind: 'income', category: 'Food' })?.action).toMatchObject({ category: 'Other' });
    expect(matchCategory('expense', ' rent ')).toBe('Rent');
    expect(money({ kind: 'gift' })).toBeNull();
    expect(money({ category: '' })).toBeNull();
  });

  it('a note up to 200; today when no day; never after today', () => {
    expect(money({ note: 'lunch', day: '2026-10-30' })?.action).toMatchObject({ note: 'lunch', day: '2026-10-30' });
    expect(money({ day: TOMORROW })).toBeNull();
  });
});

describe('settleDue and checkWrite (Add)', () => {
  const daily: AskTodoAction = { type: 'todo', title: 'Stretch', due: { day: TODAY, time: '18:00' }, repeat: 'daily' };

  it('a repeating card whose time passed since the answer moves on; a one-off is flagged', () => {
    expect(settleDue(daily, { today: TODAY, now: '17:00' })).toEqual({ action: daily });
    expect(settleDue(daily, { today: TODAY, now: '18:00' })).toEqual({ action: { ...daily, due: { day: TOMORROW, time: '18:00' } } });
    expect(settleDue(daily, { today: TOMORROW, now: '19:00' }).action.due).toEqual({ day: '2026-11-03', time: '18:00' });
    const { repeat: _r, ...once } = daily;
    expect(settleDue(once, { today: TODAY, now: '18:30' })).toEqual({ action: once, flag: 'past_time' });
    // Tapped after midnight: the day before today.
    expect(settleDue(once, { today: TOMORROW, now: '00:05' })).toEqual({ action: once, flag: 'past_time' });
    expect(settleDue({ type: 'todo', title: 'x' }, { today: TODAY, now: '18:30' })).toEqual({ action: { type: 'todo', title: 'x' } });
  });

  it('checkWrite: the same checks, against now', () => {
    const s = { today: TODAY, now: '19:00' };
    expect(checkWrite(daily, s)).toEqual({ ok: true, action: { ...daily, due: { day: TOMORROW, time: '18:00' } } });
    expect(checkWrite({ type: 'todo', title: 'x', repeat: 'daily' }, s)).toEqual({ ok: false, reason: ASK_SENTENCES.badItem });
    expect(checkWrite({ type: 'todo', title: 'x', due: { day: '2026-02-31' } }, s)).toEqual({ ok: false, reason: ASK_SENTENCES.badDay });
    expect(checkWrite({ type: 'food', day: TOMORROW, name: 'Roti', kcal: 1 }, s)).toEqual({ ok: false, reason: ASK_SENTENCES.futureDay });
    expect(checkWrite({ type: 'money', kind: 'expense', amount: 1, category: 'Food', day: '2026-10-01' }, s)).toEqual({ ok: false, reason: ASK_SENTENCES.badDay });
    expect(checkWrite({ type: 'food', day: TODAY, name: ' ', kcal: 1 }, s)).toEqual({ ok: false, reason: ASK_SENTENCES.badItem });
    expect(checkWrite({ type: 'todo', title: 'x' }, s, { noTime: true })).toEqual({ ok: true, action: { type: 'todo', title: 'x' }, flag: 'no_time' });
    // An edit that gives it a time clears no_time.
    expect(checkWrite({ type: 'todo', title: 'x', due: { day: TOMORROW, time: '09:00' } }, s, { noTime: true })).toEqual({ ok: true, action: { type: 'todo', title: 'x', due: { day: TOMORROW, time: '09:00' } } });
    expect(checkWrite({ type: 'todo', title: 'x', due: { day: TODAY, time: '18:00' } }, { today: TOMORROW, now: '00:05' })).toEqual({
      ok: true,
      action: { type: 'todo', title: 'x', due: { day: TODAY, time: '18:00' } },
      flag: 'past_time',
    });
    expect(checkWrite({ type: 'todo', title: 'x' }, s, { noProject: true })).toEqual({ ok: true, action: { type: 'todo', title: 'x' }, flag: 'no_project' });
    expect(checkWrite({ type: 'todo', title: 'x', projectId: ID_B }, s, { noProject: true })).toEqual({ ok: true, action: { type: 'todo', title: 'x', projectId: ID_B } });
  });
});
