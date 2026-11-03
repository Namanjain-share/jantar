/**
 * jantar people (v0.11) against an in-memory daemon: a space a Life restore
 * took out (T20, spec 2.7). `list` says so with the way to invite them
 * again; `remove <id>` clears it at once (no window: nothing is left to
 * download) and prints no Access step, since they may be sharing again
 * under the same email. Synthetic people only (Asha, Bea).
 */
import { describe, expect, it } from 'vitest';
import people, { NAME_FIRST } from '../src/commands/people.js';
import { EXIT } from '../src/command.js';
import { contextFor, fakeCtl, fakeSettings, ok } from './helpers.js';

const ENV = { HOME: '/synthetic/home', JANTAR_HOME: '/synthetic/state' };
const ASHA = '01JASHAAAAAAAAAAAAAAAAAAAA';
const BEA = '01JBEAAAAAAAAAAAAAAAAAAAAA';

function daemon() {
  const list = {
    enabled: true,
    people: [{ id: ASHA, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, invite: null, agreement: null, offer: null, pendingProposal: null }],
    setupAgain: [{ id: BEA, accessEmail: 'bea@example.com' }],
  };
  return fakeCtl({ 'GET /v1/people': ok(list), [`POST /v1/people/${BEA}/remove`]: ok({ ok: true }) });
}

describe('jantar people: a space a restore took out', () => {
  it('list names it by id and Access email, with the way to invite them again', async () => {
    const ctl = daemon();
    const c = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['list'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toContain(`Asha  active  ${ASHA}`);
    expect(c.io.stdout).toContain(`Restore removed the space you shared with bea@example.com. Invite them again.  ${BEA}`);
    expect(c.io.stdout).toContain('jantar people add <name> --email bea@example.com, then jantar people invite <name>.');
    expect(c.io.stdout).toContain(`jantar people remove ${BEA} clears this`);
    expect(c.io.stdout).not.toContain('Nobody yet');
  });

  it('remove <id> clears it at once, without an Access step', async () => {
    const ctl = daemon();
    const c = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['remove', BEA], c.ctx)).toBe(EXIT.ok);
    expect(ctl.calls.filter((x) => x.method === 'POST')).toMatchObject([{ path: `/v1/people/${BEA}/remove`, body: { mode: 'now', forget: false } }]);
    expect(c.io.stdout).toBe(`Cleared ${BEA}: its old devices no longer open anything.\n`);
  });
});

describe('jantar people: the Accountability partner words, ask, prefs and the name check (0.11)', () => {
  const asha = { id: ASHA, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, invite: null, agreement: null, offer: null, pendingProposal: null };
  const list = { enabled: true, people: [asha] };

  it('help and messages call it Accountability partner; the command stays `people`', async () => {
    const s = fakeSettings({ people: { ownerName: 'Sam' } });
    const ctl = fakeCtl({ ...s.routes, 'GET /v1/people': ok(list), 'POST /v1/people/switch': ok({ ok: true }) });
    const c = contextFor({ env: ENV }, { ctl });
    expect(people.summary).toMatch(/^Accountability partner: /);
    expect(people.usage).toMatch(/^jantar people /);
    expect(await people.run(['on'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toBe('Accountability partner is on.\n');
    expect(await people.run(['off'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toContain('Accountability partner is off. They can still download their data or leave.\n');
    expect(await people.run(['list'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toContain('Accountability partner is on.\n');
    const help = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['--help'], help.ctx)).toBe(EXIT.ok);
    expect(help.io.stdout).toContain('--comment journal');
    expect(help.io.stdout).toContain('--see todos,plan,review=counts|full,meds=full|adherence,weight,sleep,journal,chat');
    expect(help.io.stdout).toContain('people ask <name>');
    expect(help.io.stdout).toContain('people prefs');
    expect(`${help.io.stdout}${c.io.stdout}`).not.toMatch(/People is|Partners can/);
  });

  it('on without a name, while none is set, says to set one', async () => {
    const s = fakeSettings();
    const ctl = fakeCtl({ ...s.routes, 'POST /v1/people/switch': ok({ ok: true }) });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['on'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toContain(NAME_FIRST);
  });

  it('invite refuses while your name is unset (their page would say "Your accountability partner")', async () => {
    const s = fakeSettings();
    const ctl = fakeCtl({ ...s.routes, 'GET /v1/people': ok(list), [`POST /v1/people/${ASHA}/invite`]: ok({ url: 'https://us.example.com/p/join#c=x', expiresAt: '2026-11-04T10:00:00.000Z' }) });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['invite', 'Asha'], c.ctx)).toBe(EXIT.failed);
    expect(c.io.stderr).toBe(`${NAME_FIRST}\n`);
    expect(ctl.calls.some((x) => x.method === 'POST')).toBe(false);
    s.settings.people.ownerName = 'Sam';
    const again = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['invite', 'Asha'], again.ctx)).toBe(EXIT.ok);
    expect(again.io.stdout).toContain('https://us.example.com/p/join#c=x');
  });

  it('offer takes --comment journal; ask sends the same patch with a note to the propose route', async () => {
    const offered: unknown[] = [];
    const ctl = fakeCtl({
      'GET /v1/people': ok(list),
      [`POST /v1/people/${ASHA}/offer`]: (call) => (offered.push(call.body), ok({ version: 2, on: [], fields: {} })),
      [`POST /v1/people/${ASHA}/agreement`]: ok({ ok: true }),
    });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['offer', 'Asha', '--see', 'journal,review=full', '--comment', 'journal'], c.ctx)).toBe(EXIT.ok);
    expect(offered).toEqual([{ see: { journal: true, review: 'full' }, comment: { journal: true } }]);
    expect(await people.run(['ask', 'Asha', '--see', 'sleep', '--note', 'For the bedtime plan'], c.ctx)).toBe(EXIT.ok);
    expect(ctl.calls.find((x) => x.path === `/v1/people/${ASHA}/agreement`)?.body).toEqual({ see: { sleep: true }, note: 'For the bedtime plan' });
    expect(c.io.stdout).toContain('Asked Asha. Nothing changes until they accept');
    const none = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['ask', 'Asha'], none.ctx)).toBe(EXIT.usage);
  });

  it('prefs sets the day summary, the review push and quiet hours, and prints them', async () => {
    const prefs = { urgentBreaksQuiet: true, alertCaps: { hour: 3, day: 10, urgentDay: 2 }, muteUntil: null, reviewPush: false, summaryAt: '21:00', quiet: { from: '23:00', to: '07:00' } };
    const ctl = fakeCtl({ 'PATCH /v1/people/prefs': ok({ prefs }) });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['prefs', '--summary', '21:00', '--review-push', 'off', '--quiet', '23:00-07:00'], c.ctx)).toBe(EXIT.ok);
    expect(ctl.calls[0]?.body).toEqual({ summaryAt: '21:00', reviewPush: false, quiet: { from: '23:00', to: '07:00' } });
    expect(c.io.stdout).toBe('Day summary: 21:00\nEvening review push: off\nQuiet hours for pushes about them: 23:00-07:00\n');
    const bad = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['prefs', '--summary', '9pm'], bad.ctx)).toBe(EXIT.usage);
    const off = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['prefs', '--summary', 'off'], off.ctx)).toBe(EXIT.ok);
    expect(ctl.calls.at(-1)?.body).toEqual({ summaryAt: null });
  });
});
