/**
 * v0.12 People (P2), M23: the honesty rule (spec 3.2). A scripted week of
 * short nights, low moods, low check-ins, skipped steps and unsent reviews
 * creates no item, no alert, no score and no concern line, and reaches him
 * with no push. (The import scan half is in test/arch/v012-people.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersonToday, PlanView } from '@jantar/protocol/people';
import { makeFixture, type Fixture } from './isolation-fixture.js';
import { EP, kit } from './p2-kit.js';

let f: Fixture;
const k = kit(() => f);
beforeEach(async () => {
  f = await makeFixture();
}, 60_000);
afterEach(async () => {
  await f?.close();
});

const dayOf = (i: number) => `2026-11-${String(3 + i).padStart(2, '0')}`;

describe('M23: the honesty rule', () => {
  it('a hard week creates nothing and tells him nothing', async () => {
    await k.subscribeAll();
    const core = f.life.people.openCore();
    if (!core) throw new Error('life closed');
    const count = (sql: string) => (core.db.prepare(sql).get(f.asha.id) as { n: number }).n;
    const todosBefore = count('SELECT COUNT(*) AS n FROM todos WHERE space = ?');
    for (let i = 0; i < 7; i += 1) {
      const day = dayOf(i);
      // Morning: he plans her day (a check-in step and two plain ones).
      const cur = ((await k.him('GET', `/v1/people/${f.asha.id}/plans/${day}`)).json() as PlanView).plan?.srev ?? 0;
      const put = await k.him('PUT', `/v1/people/${f.asha.id}/plans/${day}`, {
        srev: cur,
        send: 'quiet',
        between: [],
        steps: [{ title: 'Check-in', ask: 'checkin', ring: false }, { title: 'Walk', ring: false }, { title: 'Read', ring: false }],
      });
      expect(put.statusCode, put.body).toBe(200);
      const steps = (put.json() as PlanView).plan?.steps ?? [];
      // She answers the check-in at the lowest mood and energy, and skips the rest.
      await k.her('POST', `/v1/p/plans/${day}/steps/${steps[0]?.id}/checkin`, { mood: 1, energy: 1, line: 'low', need: 'nothing' });
      await k.her('POST', `/v1/p/plans/${day}/steps/${steps[1]?.id}/state`, { to: 'skipped', reason: 'Not feeling well' });
      // A low journal check-in.
      await k.her('POST', '/v1/p/journal', { kind: 'checkin', mood: 1, emotions: ['sadness'], clientId: `honesty-${i}-xxxx` });
      // A short night: 01:30 to 05:00.
      await k.her('PUT', `/v1/p/sleep/${day}`, { bedAt: `${dayOf(i + 1)}T01:30:00.000Z`, wakeAt: `${dayOf(i + 1)}T05:00:00.000Z` });
      // She never sends the review; the next day's 12:00 closes it.
      await k.at(`${dayOf(i + 1)}T09:00:00.000Z`);
    }
    await k.at('2026-11-10T12:30:00.000Z');
    // No item made, no alert sent either way, nothing pushed to him.
    expect(count('SELECT COUNT(*) AS n FROM todos WHERE space = ?')).toBe(todosBefore);
    expect(count("SELECT COUNT(*) AS n FROM person_alerts WHERE from_person = ? OR to_person = ''")).toBe(0);
    expect(k.to(EP.sam)).toEqual([]);
    // Every review closed on its own, with nothing counted against her.
    const r = (await k.him('GET', `/v1/people/${f.asha.id}/plans/${dayOf(0)}/review`)).json() as { sent: boolean; auto?: boolean; counts: { missed: number } };
    expect(r).toMatchObject({ sent: true, auto: true });
    // His Today has no concern line about sleep, moods, the journal or reviews.
    const today = (await k.him('GET', `/v1/people/${f.asha.id}/today`)).json() as PersonToday;
    for (const line of today.concerns) expect(line).not.toMatch(/sleep|night|mood|journal|review|low|short/i);
  });
});
