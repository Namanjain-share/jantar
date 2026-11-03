/**
 * v0.12 People (P2): the 14-day sharing check-in (spec 3.9, C26).
 *
 * - It shows 14 days after she joined, on her first open from 10:00; a
 *   snooze brings it back a week later; any other answer, in 14 days.
 * - The answer is hers alone unless she picks Let's talk (a neutral alert to
 *   him, no score, no detail) or ticks "Tell Sam my answer"; the ledger row
 *   is written only then.
 * - Nothing is counted or shown for skipping it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AlertsResponse, PersonOwnToday } from '@jantar/protocol/people';
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

const DAY = 86_400_000;
const due = async () => ((await k.her('GET', '/v1/p/today')).json() as PersonOwnToday).sharingCheckin;
const answer = (body: object) => k.her('POST', '/v1/p/sharing/checkin', body);
const ledger = () => f.api.ctx.db.people.consents.listFor(f.asha.id).filter((r) => r.action === 'sharing_checkin');

/** The fixture joins her at 09:00 on 3 Nov: the card is due from 17 Nov, after 10:00. */
async function toDue(): Promise<void> {
  f.api.ctx.clock.set(new Date(Date.parse('2026-11-17T09:30:00.000Z')).toISOString());
}

describe('the sharing check-in', () => {
  it('shows from day 14 after 10:00; a snooze is a week; private by default', async () => {
    expect(await due()).toBe(false);
    await toDue();
    expect(await due()).toBe(false);
    f.api.ctx.clock.set('2026-11-17T10:00:00.000Z');
    expect(await due()).toBe(true);
    expect((await answer({ answer: 'snooze' })).statusCode).toBe(200);
    expect(await due()).toBe(false);
    f.api.ctx.clock.set(new Date(Date.parse('2026-11-17T10:00:00.000Z') + 7 * DAY).toISOString());
    expect(await due()).toBe(true);
    await k.subscribeAll();
    expect((await answer({ answer: 'keep' })).statusCode).toBe(200);
    expect(await due()).toBe(false);
    // Private: no ledger row, no push, no alert.
    expect(ledger()).toEqual([]);
    expect(k.to(EP.sam)).toEqual([]);
    expect(((await k.him('GET', `/v1/people/alerts?with=${f.asha.id}`)).json() as AlertsResponse).alerts).toEqual([]);
    f.api.ctx.clock.set(new Date(Date.parse('2026-11-24T10:00:00.000Z') + 14 * DAY).toISOString());
    expect(await due()).toBe(true);
  });

  it('"Tell Sam my answer" writes the ledger row and tells him in a neutral line', async () => {
    f.api.ctx.clock.set('2026-11-17T10:00:00.000Z');
    await k.subscribeAll();
    expect((await answer({ answer: 'ease', tell: true })).statusCode).toBe(200);
    expect(ledger().map((r) => r.action)).toEqual(['sharing_checkin']);
    expect(k.to(EP.sam).map((p) => p.body)).toEqual(['Asha would like to ease off a little.']);
  });

  it("Let's talk sends him a neutral alert with no score and no detail", async () => {
    f.api.ctx.clock.set('2026-11-17T10:00:00.000Z');
    await k.subscribeAll();
    expect((await answer({ answer: 'talk' })).statusCode).toBe(200);
    expect(ledger()).toHaveLength(1);
    const alerts = ((await k.him('GET', `/v1/people/alerts?with=${f.asha.id}`)).json() as AlertsResponse).alerts;
    expect(alerts.map((a) => [a.from, a.kind, a.text])).toEqual([[f.asha.id, 'custom', 'Asha would like to talk about how things are set up.']]);
    expect(k.to(EP.sam)).toHaveLength(1);
    expect((await answer({ answer: 'maybe' })).statusCode).toBe(400);
  });
});
