import { describe, expect, it } from 'vitest';
import { ALERT_GROUPS, alertGroupOf, type PendingRequest, type SendJob } from '@jantar/protocol';
import {
  ALERT_GROUP_LABEL,
  GENERIC_BODY,
  MAX_TITLE,
  TEST_KIND,
  URGENT_BODY,
  alertNotification,
  cardNotification,
  clip,
  describeToolCall,
  doneNotification,
  dur,
  reminderNotification,
  leftWords,
  sendFailedNotification,
  sentence,
  testNotification,
  urgentNotification,
  usageNotification,
  waitingKind,
  waitingNotification,
} from '../../src/notify/format.js';
import { makeCard, makeSession } from '../api/fakes.js';

const TS = '2026-01-15T10:00:05.000Z';
const UTC = { timeZone: 'UTC' };

describe('notification text (web direction.md 5.8)', () => {
  it('titles start with the folder; bodies lead with the kind; one tag per session', () => {
    const s = makeSession();
    const n = cardNotification(makeCard(), s, 'full', TS);
    expect(n).toMatchObject({
      kind: 'permission',
      title: 'demo-app needs you',
      body: 'Permission · Bash: npm test',
      sid: s.sid,
      tag: `s:${s.sid}`,
      ts: TS,
    });
    expect(n?.url).toBe(`/s/${s.sid}?card=${encodeURIComponent(n?.pendingId ?? '')}`);
    expect(cardNotification(makeCard(), s, 'short', TS)?.body).toBe('Permission waiting · Bash');
    // No folder: the session name, then the first 8 characters of the sid.
    expect(cardNotification(makeCard(), makeSession({ folder: '' }), 'full', TS)?.title).toBe('refactor needs you');
    expect(cardNotification(makeCard(), makeSession({ folder: '', name: undefined }), 'full', TS)?.title).toBe('sess-aaa needs you');
  });

  it('keeps titles to 40 characters by clipping the folder, never the words after it', () => {
    const long = makeSession({ folder: 'a-very-long-monorepo-folder-name-for-the-billing-service' });
    const t = cardNotification(makeCard(), long, 'full', TS)?.title ?? '';
    expect([...t].length).toBeLessThanOrEqual(MAX_TITLE);
    expect(t.endsWith('… needs you')).toBe(true);
    const plan = cardNotification(makeCard({ kind: 'plan', tool: 'ExitPlanMode', input: { plan: 'x' } }), long, 'full', TS)?.title ?? '';
    expect([...plan].length).toBeLessThanOrEqual(MAX_TITLE);
    expect(plan.endsWith(' has a plan for you')).toBe(true);
  });

  it('describes questions and plans, and keeps the terminal style for tool calls elsewhere', () => {
    const q: PendingRequest = makeCard({
      kind: 'question',
      tool: 'AskUserQuestion',
      input: {},
      questions: [
        { question: 'Which module should own the session cookie?', options: [{ label: 'auth/session.ts' }, { label: 'middleware/cookies.ts' }] },
        { question: 'Which features?', options: [{ label: 'Auth' }], multiSelect: true },
      ],
    });
    expect(cardNotification(q, makeSession(), 'full', TS)).toMatchObject({
      kind: 'question',
      title: 'demo-app needs you',
      body: 'Question: Which module should own the session cookie? (+1 more)',
    });
    expect(cardNotification(q, makeSession(), 'short', TS)?.body).toBe('Question waiting');

    const plan = makeCard({ kind: 'plan', tool: 'ExitPlanMode', input: { plan: '# Move the state bucket to eu-west-1\n\n1. Add the bucket' } });
    expect(cardNotification(plan, makeSession({ folder: 'infra' }), 'full', TS)).toMatchObject({
      title: 'infra has a plan for you',
      body: 'Move the state bucket to eu-west-1',
    });
    const plain = makeCard({ kind: 'plan', tool: 'ExitPlanMode', input: { plan: '3 to add, 1 to change, 0 to destroy.\n\n- step one' } });
    expect(cardNotification(plain, makeSession(), 'full', TS)?.body).toBe('3 to add, 1 to change, 0 to destroy.');
    expect(cardNotification(plain, makeSession(), 'short', TS)?.body).toBe('Plan waiting');
    expect(cardNotification(makeCard({ kind: 'subagent-info' }), makeSession(), 'full', TS)).toBeNull();

    expect(describeToolCall('Edit', { file_path: '/p/src/a.ts', old_string: 'x' })).toBe('Edit /p/src/a.ts');
    expect(describeToolCall('WebFetch', { url: 'https://example.com' })).toBe('WebFetch https://example.com');
    expect(describeToolCall('Bash', { command: 'git   status\n  --short' })).toBe('$ git status --short');
    expect(describeToolCall('mcp__x__y', { b: 1, a: 2 })).toBe('mcp__x__y {"a":2,"b":1}');
    expect(describeToolCall('Custom', undefined)).toBe('Custom');
  });

  it('applies notify.bodies: full, short and generic (no details at all)', () => {
    const long = `${'word '.repeat(300)}\nsecond line`;
    const s = makeSession();
    const full = doneNotification(s.sid, s, { text: long }, 'full', TS);
    expect(full.body.length).toBeLessThanOrEqual(600);
    expect(full.body.endsWith('…')).toBe(true);
    expect(full.body).not.toContain('second line');
    const short = doneNotification(s.sid, s, { text: long }, 'short', TS);
    expect(short.body).toBe('Finished');
    const generic = doneNotification(s.sid, s, { text: 'secret reply' }, 'generic', TS);
    expect(generic).toMatchObject({ title: 'A session finished', body: GENERIC_BODY });
    expect(GENERIC_BODY).toBe('');
    expect(JSON.stringify(generic)).not.toContain('demo-app');
    expect(cardNotification(makeCard(), s, 'generic', TS)).toMatchObject({ title: 'A session needs you', body: '' });
    expect(clip('abcdef', 4)).toBe('abc…');
  });

  it('says how long a finished turn ran', () => {
    const s = makeSession({ folder: 'api-server' });
    expect(doneNotification(s.sid, s, { text: 'The rate limiter tests pass (14 passed).\nMore.' }, 'full', TS, 7 * 60_000)).toMatchObject({
      title: 'api-server finished · 7m',
      body: 'The rate limiter tests pass (14 passed).',
    });
    expect(doneNotification(s.sid, s, undefined, 'full', TS, 20_000).title).toBe('api-server finished');
    expect(doneNotification(s.sid, s, undefined, 'full', TS).body).toBe('Claude finished its turn.');
    expect(dur(72 * 60_000)).toBe('1h12');
    expect(dur(120 * 60_000)).toBe('2h');
  });

  it('maps waitingFor, blocked and error alerts', () => {
    expect(waitingKind('plan approval')).toBe('plan');
    expect(waitingKind('permission')).toBe('permission');
    expect(waitingKind(undefined)).toBe('question');
    const w = waitingNotification(makeSession({ status: 'waiting', waitingFor: 'permission' }), 'full', TS);
    expect(w).toMatchObject({ kind: 'permission', title: 'demo-app needs you', body: 'Waiting for permission in the terminal.' });
    expect(waitingNotification(makeSession({ status: 'waiting', waitingFor: 'plan approval' }), 'short', TS)).toMatchObject({
      title: 'demo-app has a plan for you',
      body: 'Plan waiting',
    });

    const s = makeSession({ folder: 'landing' });
    const blocked = alertNotification(
      { id: 'a1', ts: TS, kind: 'rejected', sid: s.sid, label: 'x', what: 'deny rule: Bash · rm -rf public', why: 'matches Bash(rm:*)' },
      s,
      'full',
      TS,
    );
    expect(blocked).toMatchObject({
      kind: 'blocked',
      title: 'landing is blocked',
      body: 'Deny rule: Bash · rm -rf public. Matches Bash(rm:*).',
      url: '/alerts?id=a1',
      tag: `s:${s.sid}`,
    });
    const error = alertNotification(
      { id: 'a2', ts: TS, kind: 'error', sid: s.sid, label: 'x', what: 'API error', why: '529 overloaded. Retried twice, then stopped' },
      makeSession({ folder: 'mobile' }),
      'full',
      TS,
    );
    expect(error).toMatchObject({ kind: 'error', title: 'mobile hit an API error', body: '529 overloaded. Retried twice, then stopped.' });
    expect(alertNotification({ id: 'a3', ts: TS, kind: 'error', sid: s.sid, label: 'x', what: 'API error' }, s, 'short', TS).body).toBe('API error');
    expect(sentence('the terminal tab has no running program')).toBe('The terminal tab has no running program.');
  });

  it('limit and usage pushes name the account and the reset, tagged per account', () => {
    const limit = alertNotification(
      { id: 'a4', ts: TS, kind: 'limit', sid: 'sess-aaaa-1111', account: 3, label: 'x', what: 'hit a limit' },
      makeSession(),
      'full',
      TS,
      { ...UTC, window: '5-hour', resetsAt: '2026-01-15T17:31:00.000Z', folders: ['web-app', 'api-server'] },
    );
    expect(limit).toMatchObject({
      kind: 'limit',
      title: 'acct 03 hit its 5-hour limit',
      body: 'Resets 17:31. web-app and api-server are paused.',
      url: '/accounts',
      tag: 'acct:3',
    });
    expect(
      alertNotification({ id: 'a4', ts: TS, kind: 'limit', account: 3, label: 'x', what: 'hit a limit' }, null, 'short', TS, {
        ...UTC,
        resetsAt: '2026-01-15T17:31:00.000Z',
      }),
    ).toMatchObject({ title: 'acct 03 hit its limit', body: 'Limit hit · resets 17:31' });

    const usage = usageNotification(4, { window: 'five_hour', pct: 91.6, threshold: 90 }, 'full', '2026-01-15T16:36:00.000Z', {
      ...UTC,
      resetsAt: '2026-01-15T17:48:00.000Z',
      fullAt: '2026-01-15T17:20:00.000Z',
    });
    expect(usage).toMatchObject({
      kind: 'usage',
      title: 'acct 04 at 92% of 5h',
      body: 'Resets 17:48, in 1h12. Full at this pace ~17:20.',
      url: '/accounts',
      tag: 'acct:4',
    });
    expect(
      usageNotification(4, { window: 'five_hour', pct: 91.6, threshold: 90 }, 'short', '2026-01-15T16:36:00.000Z', { ...UTC, resetsAt: '2026-01-15T17:48:00.000Z' })
        .body,
    ).toBe('92% · resets 17:48');
    // Full after the reset: no dead time to warn about.
    expect(
      usageNotification(4, { window: 'five_hour', pct: 91, threshold: 90 }, 'full', '2026-01-15T16:36:00.000Z', {
        ...UTC,
        resetsAt: '2026-01-15T17:48:00.000Z',
        fullAt: '2026-01-15T18:20:00.000Z',
      }).body,
    ).toBe('Resets 17:48, in 1h12.');
    expect(usageNotification(3, { window: 'seven_day', pct: 81.4, threshold: 80 }, 'full', TS)).toMatchObject({
      title: 'acct 03 at 81% of 7d',
      body: 'Crossed 80%.',
    });
  });

  it('failed sends say "Not delivered" with the reason and a way to retry', () => {
    const s = makeSession({ folder: 'web-app' });
    const job: SendJob = {
      id: 'job1',
      sid: s.sid,
      textHash: 'h',
      textLength: 5,
      stage: 'failed',
      attempts: 12,
      reason: 'a dialog was open in the terminal',
      createdAt: TS,
      updatedAt: TS,
    };
    expect(sendFailedNotification(job, s, 'full', TS)).toMatchObject({
      kind: 'send-failed',
      title: 'Not delivered to web-app',
      body: 'A dialog was open in the terminal. Tap to retry.',
      url: `/s/${s.sid}?send=job1`,
      tag: `s:${s.sid}`,
    });
    expect(sendFailedNotification(job, s, 'short', TS).body).toBe('Prompt not delivered');
  });

  it('reminders say how long it has waited and repeat the original question or command', () => {
    const base = cardNotification(makeCard(), makeSession({ folder: 'web-app' }), 'full', TS);
    if (!base) throw new Error('no base');
    const r = reminderNotification(base, 30, 'full', TS);
    expect(r).toMatchObject({ kind: 'reminder', baseKind: 'permission', title: 'web-app still needs you · 30m', tag: base.tag, url: base.url });
    expect(r.body).toBe('Permission · Bash: npm test');
    expect(reminderNotification(base, 30, 'short', TS).body).toBe('Still waiting · 30m');
    expect(reminderNotification(base, 30, 'generic', TS)).toMatchObject({ title: 'A session still needs you', body: GENERIC_BODY });
  });

  it('ships no em dashes and no emoji', () => {
    const s = makeSession();
    const all = [
      cardNotification(makeCard(), s, 'full', TS),
      cardNotification(makeCard({ kind: 'question', tool: 'AskUserQuestion', input: {}, questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }] }), s, 'full', TS),
      alertNotification({ id: 'a', ts: TS, kind: 'blocked', sid: s.sid, label: 'x', what: 'w', why: 'y' }, s, 'full', TS),
    ];
    expect(JSON.stringify(all)).not.toMatch(/—|\p{Extended_Pictographic}/u);
  });
});

describe('v0.5.3: the urgent alert and the test push', () => {
  const DEADLINE = '2026-01-15T10:01:54.000Z';

  it('leftWords is approximate on purpose: never "1 min 59 s"', () => {
    expect([110, 93, 90, 60, 45, 44, 30, 20].map(leftWords)).toEqual([
      'about 2 min',
      'about 2 min',
      'about 2 min',
      'about 1 min',
      'about 1 min',
      'under a minute',
      'under a minute',
      'under a minute',
    ]);
    expect(leftWords(300)).toBe('about 5 min');
  });

  it('"<folder> · about 2 min to answer": a permission with its deadline, the session tag, no prompt text in any mode', () => {
    const s = makeSession({ folder: 'web-app', now: { kind: 'tool', tool: 'Bash', text: 'rm -rf build' }, waitingFor: 'permission' });
    const full = urgentNotification(s, 110, DEADLINE, 'full', TS);
    expect(full).toEqual({
      kind: 'permission',
      title: 'web-app · about 2 min to answer',
      body: URGENT_BODY,
      sid: s.sid,
      url: `/s/${s.sid}`,
      tag: `s:${s.sid}`,
      folder: 'web-app',
      deadline: DEADLINE,
      ts: TS,
    });
    expect(alertGroupOf(full.kind, full.deadline)).toBe('urgent');
    expect(urgentNotification(s, 110, DEADLINE, 'short', TS)).toMatchObject({ title: 'web-app · about 2 min to answer', body: URGENT_BODY });
    const generic = urgentNotification(s, 30, DEADLINE, 'generic', TS);
    expect(generic).toMatchObject({ title: 'Under a minute to answer', body: '', deadline: DEADLINE });
    expect(generic).not.toHaveProperty('folder');
    expect(JSON.stringify([full, generic])).not.toContain('rm -rf');
    // A long folder gives way; the words after it never do.
    const long = urgentNotification(makeSession({ folder: 'a-very-long-folder-name-for-a-monorepo' }), 60, DEADLINE, 'full', TS);
    expect([...long.title].length).toBeLessThanOrEqual(MAX_TITLE);
    expect(long.title.endsWith(' · about 1 min to answer')).toBe(true);
  });

  it('a test push per group: its kind, fixed words, a deadline for urgent, control scope for care', () => {
    expect(TEST_KIND).toEqual({ urgent: 'permission', needs: 'permission', done: 'done', care: 'life', problem: 'send-failed' });
    for (const group of ALERT_GROUPS) {
      const n = testNotification(group, TS);
      expect(n, group).toMatchObject({ kind: TEST_KIND[group], title: 'Jantar test', body: `This is how "${ALERT_GROUP_LABEL[group]}" alerts arrive.`, url: '/', tag: `test:${group}`, ts: TS });
      expect(alertGroupOf(n.kind, n.deadline), group).toBe(group);
    }
    expect(testNotification('urgent', TS).deadline).toBe('2026-01-15T10:02:05.000Z');
    expect(testNotification('needs', TS)).not.toHaveProperty('deadline');
    expect(testNotification('care', TS).minScope).toBe('control');
    expect(testNotification('done', TS)).not.toHaveProperty('minScope');
  });
});

describe('v0.6: the machine word (a paired server names itself as the Mac named it)', () => {
  const MACHINE = { machine: 'build-1' };

  it("a server's push leads with its name; the Mac's own carries none", () => {
    const s = makeSession({ folder: 'api-server' });
    expect(cardNotification(makeCard(), s, 'full', TS, MACHINE)?.title).toBe('build-1 · api-server needs you');
    expect(cardNotification(makeCard(), s, 'full', TS)?.title).toBe('api-server needs you');
    expect(waitingNotification({ ...s, status: 'waiting', waitingFor: 'input' }, 'full', TS, MACHINE).title).toBe('build-1 · api-server needs you');
    expect(doneNotification(s.sid, s, { text: 'All green.' }, 'full', TS, undefined, MACHINE).title).toBe('build-1 · api-server finished');
    const job: SendJob = { id: 'job1', sid: s.sid, textHash: 'h', textLength: 3, stage: 'failed', attempts: 1, createdAt: TS, updatedAt: TS, reason: 'a dialog was open' };
    expect(sendFailedNotification(job, s, 'full', TS, MACHINE).title).toBe('Not delivered to build-1 · api-server');
    expect(alertNotification({ id: 'a', ts: TS, kind: 'error', sid: s.sid, label: 'x', what: 'API error' }, s, 'full', TS, MACHINE).title).toBe(
      'build-1 · api-server hit an API error',
    );
  });

  it("a server's account 01 is not the Mac's: its limit push names the server first", () => {
    const s = makeSession({ folder: 'api-server', account: 1 });
    const alert = { id: 'l', ts: TS, kind: 'limit' as const, sid: s.sid, account: 1, label: 'x', what: 'limit' };
    expect(alertNotification(alert, s, 'full', TS, { ...MACHINE, window: '5-hour' }).title).toBe('build-1 · acct 01 hit its 5-hour limit');
    expect(alertNotification(alert, s, 'full', TS, { window: '5-hour' }).title).toBe('acct 01 hit its 5-hour limit');
  });

  it('the folder gives way to the name and the words after it, within the title cap', () => {
    const s = makeSession({ folder: 'a-very-long-folder-name-for-the-api-server' });
    const title = cardNotification(makeCard(), s, 'full', TS, MACHINE)?.title ?? '';
    expect(title.startsWith('build-1 · a-very')).toBe(true);
    expect(title.endsWith('… needs you')).toBe(true);
    expect([...title].length).toBeLessThanOrEqual(MAX_TITLE);
  });

  it('generic bodies name no machine', () => {
    const s = makeSession();
    const all = [
      cardNotification(makeCard(), s, 'generic', TS, MACHINE),
      doneNotification(s.sid, s, { text: 'x' }, 'generic', TS, undefined, MACHINE),
      alertNotification({ id: 'a', ts: TS, kind: 'error', sid: s.sid, label: 'x', what: 'w' }, s, 'generic', TS, MACHINE),
    ];
    expect(JSON.stringify(all)).not.toContain('build-1');
  });
});
