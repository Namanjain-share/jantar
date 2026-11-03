/**
 * jantar people (v0.11) against an in-memory daemon: a space a Life restore
 * took out (T20, spec 2.7). `list` says so with the way to invite them
 * again; `remove <id>` clears it at once (no window: nothing is left to
 * download) and prints no Access step, since they may be sharing again
 * under the same email. Synthetic people only (Asha, Bea).
 */
import { describe, expect, it } from 'vitest';
import people from '../src/commands/people.js';
import { EXIT } from '../src/command.js';
import { contextFor, fakeCtl, ok } from './helpers.js';

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
