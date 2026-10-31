/**
 * Acceptance gate 7, minus the real Claude session: a question card opens,
 * the phone gets "Question · folder · session" by Web Push, the tap target
 * opens the card, the answer goes through the API to the hooks bridge, and
 * the audit log shows it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { NotificationRouterImpl } from '../../src/notify/router.js';
import { persistPendingHistory } from '../../src/db/index.js';
import { h, makeApi, makeCard, pairCookie, type TestApi } from './fakes.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

describe('question card -> push -> answer -> audit', () => {
  it('works end to end through the API, router and Web Push notifier', async () => {
    api = await makeApi();
    const unsubHistory = persistPendingHistory(api.ctx.store, api.ctx.db);
    const router = new NotificationRouterImpl(api.ctx, { notifiers: api.fakes.notifiers });
    await router.start();
    try {
      const phone = await pairCookie(api, ['read', 'control'], 'Phone');
      const sub = await api.tcp.inject({
        method: 'POST',
        url: '/v1/push/subscribe',
        headers: h(phone.cookie),
        payload: { subscription: { endpoint: 'https://web.push.apple.com/v2/abc', keys: { p256dh: 'p', auth: 'a' } } },
      });
      expect(sub.statusCode).toBe(200);

      const card = makeCard({
        kind: 'question',
        tool: 'AskUserQuestion',
        input: { questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] },
        questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }],
        suggestions: [],
        createdAt: api.ctx.clock.iso(),
        settleUntil: api.ctx.clock.iso(api.ctx.clock.now() + 3000),
      });
      api.ctx.store.emit({ type: 'pending.opened', sid: card.sid, data: { pending: card } });
      api.ctx.clock.advance(3000);
      await router.whenIdle();

      expect(api.fakes.pushed).toHaveLength(1);
      const payload = JSON.parse(api.fakes.pushed[0]?.payload ?? '{}');
      expect(payload).toMatchObject({
        v: 1,
        kind: 'question',
        title: 'demo-app needs you',
        body: 'Question: Which database?',
        pendingId: card.id,
      });

      // Tapping the push opens /s/<sid>?card=<id>; the app loads the card from the API.
      expect(payload.url).toBe(`/s/${card.sid}?card=${encodeURIComponent(card.id)}`);
      const session = await api.tcp.inject({ method: 'GET', url: `/v1/sessions/${card.sid}`, headers: h(phone.cookie) });
      expect(session.json().pending.map((p: { id: string }) => p.id)).toEqual([card.id]);

      const answer = await api.tcp.inject({
        method: 'POST',
        url: `/v1/pending/${card.id}/decision`,
        headers: h(phone.cookie, { 'idempotency-key': 'tap-1' }),
        payload: { behavior: 'allow', answers: { 'Which database?': 'Postgres' } },
      });
      expect(answer.statusCode).toBe(200);
      expect(api.fakes.hooks.decisions[0]).toMatchObject({ id: card.id, actor: `device:${phone.deviceId}`, decision: { answers: { 'Which database?': 'Postgres' } } });

      const audit = api.ctx.db.audit.list().find((e) => e.action === 'decidePending');
      expect(audit).toMatchObject({ actor: `device:${phone.deviceId}`, target: card.id, result: 'ok', params: { behavior: 'allow', answers: 1, sid: card.sid } });
      expect(JSON.stringify(audit)).not.toContain('Postgres');
      expect(api.ctx.db.pending.get(card.id)).toMatchObject({ state: 'decided', decidedBy: `device:${phone.deviceId}` });

      // No reminder for an answered card.
      api.ctx.clock.advance(60 * 60_000);
      await router.whenIdle();
      expect(api.fakes.pushed).toHaveLength(1);
    } finally {
      unsubHistory();
      await router.stop();
    }
  });
});
