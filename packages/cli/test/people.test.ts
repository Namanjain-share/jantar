/**
 * jantar people (v0.11) against an in-memory daemon: a space a Life restore
 * took out (T20, spec 2.7). `list` says so with the way to invite them
 * again; `remove <id>` clears it at once (no window: nothing is left to
 * download) and prints no Access step, since they may be sharing again
 * under the same email. Synthetic people only (Asha, Bea).
 */
import { describe, expect, it } from 'vitest';
import people, { NAME_FIRST, fieldList } from '../src/commands/people.js';
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
    expect(help.io.stdout).toContain('--see todos,plan,review=counts|full,meds=full|adherence,weight,food=counts|full,sleep,journal,chat');
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

  it('food: --see food takes a level (bare or on is full); modules --food says what changes for them and what you see', async () => {
    expect(fieldList('see', 'food')).toEqual({ food: 'full' });
    expect(fieldList('see', 'food=on,weight')).toEqual({ food: 'full', weight: true });
    expect(fieldList('see', 'food=counts')).toEqual({ food: 'counts' });
    expect(fieldList('see', 'food=off')).toEqual({ food: 'off' });
    const offered: unknown[] = [];
    const sharing = { ...asha, agreement: { version: 2, see: { food: 'off' } } };
    const ctl = fakeCtl({
      'GET /v1/people': ok({ enabled: true, people: [sharing] }),
      [`POST /v1/people/${ASHA}/offer`]: (call) => (offered.push(call.body), ok({ version: 2, on: [], fields: { see: { food: 'counts' } } })),
      [`PATCH /v1/people/${ASHA}/modules`]: ok({ ok: true }),
    });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['offer', 'Asha', '--preset', 'standard', '--see', 'food=counts'], c.ctx)).toBe(EXIT.ok);
    expect(offered).toEqual([{ preset: 'standard', see: { food: 'counts' } }]);
    expect(c.io.stdout).toContain('see.food = counts  (sees their food log: how many meals at counts; what they ate, with calories, at full)');
    const on = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['modules', 'Asha', '--food', 'on'], on.ctx)).toBe(EXIT.ok);
    expect(ctl.calls.find((x) => x.path === `/v1/people/${ASHA}/modules`)?.body).toEqual({ food: true });
    expect(on.io.stdout).toBe("Asha's food log is on: their app has Food, and a quick add on Today.\nYou see none of it until they say yes: jantar people ask Asha --see food=counts (how many meals) or food=full (what they ate, with calories)\n");
    const off = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['modules', 'Asha', '--food', 'off'], off.ctx)).toBe(EXIT.ok);
    expect(off.io.stdout).toBe("Asha's food log is off: their app has no Food, and you see none of it.\n");
    expect(on.io.stdout).not.toMatch(/no food log in this release/);
  });

  it('remove with the 7-day window names its end, and the Access step waits for it; --now gives the step at once (review 4, B5)', async () => {
    const withEmail = { ...asha, emailLabel: 'asha@example.com' };
    let state: Record<string, unknown> = withEmail;
    const ctl = fakeCtl({
      'GET /v1/people': () => ok({ enabled: true, people: [state] }),
      [`POST /v1/people/${ASHA}/remove`]: (call) => {
        const body = call.body as { mode: string; forget: boolean };
        state = body.mode === 'window' && !body.forget ? { ...withEmail, state: 'ending', endingUntil: '2026-11-10T09:00:00.000Z' } : { ...withEmail, state: 'left' };
        return ok({ ok: true });
      },
    });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['remove', 'Asha'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toBe(
      'Sharing with Asha ends on 2026-11-10; they can download their data until then.\n' +
        'After 2026-11-10, in Zero Trust > Access > Applications > Accountability partner > Policies > Partner, remove asha@example.com. Not before: until then Access must let them in to download their data.\n',
    );
    state = withEmail;
    const now = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['remove', 'Asha', '--now'], now.ctx)).toBe(EXIT.ok);
    expect(now.io.stdout).toBe('Asha is removed.\nIn Zero Trust > Access > Applications > Accountability partner > Policies > Partner, remove asha@example.com. Optionally, My Team > Users > them > Revoke session.\n');
  });

  it('by name, someone still sharing wins over someone of the same name who left; an id reaches either (review 4, B4)', async () => {
    const LEFT = '01JASHALEFTAAAAAAAAAAAAAAA';
    const two = { enabled: true, people: [{ ...asha, id: LEFT, state: 'left' }, { ...asha, state: 'invited' }] };
    const ctl = fakeCtl({ 'GET /v1/people': ok(two), [`POST /v1/people/${ASHA}/agreement`]: ok({ ok: true }), [`POST /v1/people/${LEFT}/remove`]: ok({ ok: true }) });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['ask', 'Asha', '--see', 'sleep'], c.ctx)).toBe(EXIT.ok);
    expect(ctl.calls.some((x) => x.path === `/v1/people/${ASHA}/agreement`)).toBe(true);
    expect(await people.run(['remove', LEFT, '--forget'], c.ctx)).toBe(EXIT.ok);
    expect(ctl.calls.find((x) => x.method === 'POST' && x.path.endsWith('/remove'))?.path).toBe(`/v1/people/${LEFT}/remove`);
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

describe('jantar people doctor: the host fence, Access in front, the Tailscale step (spec 2.1 step 4)', () => {
  const okDoctor = { checks: [{ name: 'switch', ok: true, detail: 'on' }] };
  const FENCE_OK: Record<string, number> = {
    'us.example.com/p': 200,
    'us.example.com/v1/state': 404,
    'us.example.com/index.html': 404,
    'us.example.com/sw.js': 404,
    'us.example.com/v1/node/link': 404,
    'jantar.example.com/v1/p/me': 404,
    // The Origin half: a body-less POST with the other host's Origin (with his own on his pairing claim: 400, no body).
    'POST jantar.example.com/v1/pair/claim https://us.example.com': 403,
    'POST jantar.example.com/v1/pair/claim https://jantar.example.com': 400,
    'POST us.example.com/v1/p/join/preview https://jantar.example.com': 403,
  };
  const run = async (mode: 'cloudflare' | 'tailscale', probe: { status: number; location: string | null; jantar: boolean } | null, fence: Record<string, number> = FENCE_OK, enabled = true) => {
    const s = fakeSettings({ remote: { mode, publicUrl: 'https://jantar.example.com', peopleUrl: 'https://us.example.com' }, people: { enabled, ownerName: 'Sam' } });
    const ctl = fakeCtl({ ...s.routes, 'GET /v1/people/doctor': ok(okDoctor) });
    const asked: string[] = [];
    const c = contextFor({ env: ENV }, { ctl });
    c.ctx.deps.probe = async (url) => (asked.push(url), probe);
    c.ctx.deps.localStatus = async (base, path, host, opts) => {
      const key = opts?.method === 'POST' ? `POST ${host}${path} ${opts.origin}` : `${host}${path}`;
      asked.push(`${base} ${key}`);
      return fence[key] ?? null;
    };
    const code = await people.run(['doctor'], c.ctx);
    return { code, out: c.io.stdout, asked };
  };

  it('all good: her host is fenced and Access sends a visitor to sign in', async () => {
    const r = await run('cloudflare', { status: 302, location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/us.example.com', jantar: false });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain('ok   host fence: us.example.com serves her app and none of yours; yours serves none of hers');
    expect(r.out).toContain("ok   origin fence: jantar.example.com refuses writes with https://us.example.com's Origin, and us.example.com with https://jantar.example.com's");
    expect(r.asked).toContain('http://127.0.0.1:7420 POST jantar.example.com/v1/pair/claim https://us.example.com');
    expect(r.asked).toContain('http://127.0.0.1:7420 POST us.example.com/v1/p/join/preview https://jantar.example.com');
    expect(r.out).toContain('ok   Access in front: us.example.com sends a visitor without a sign-in to Cloudflare Access');
    expect(r.asked).toContain('https://us.example.com/healthz');
    expect(r.asked).toContain('http://127.0.0.1:7420 us.example.com/v1/state');
  });

  it("FAIL when Access isn't in front: the daemon answered", async () => {
    const r = await run('cloudflare', { status: 200, location: null, jantar: false });
    expect(r.code).toBe(EXIT.failed);
    expect(r.out).toContain("FIX  Access in front: Access isn't protecting us.example.com: it answered 200 without a sign-in.");
    const none = await run('cloudflare', null);
    expect(none.out).toContain("FIX  Access in front: nothing answers at https://us.example.com: check its DNS route and the tunnel's ingress rule");
    const elsewhere = await run('cloudflare', { status: 302, location: 'https://evil.example/login', jantar: false });
    expect(elsewhere.out).toContain("Access isn't protecting us.example.com: it answered 302 (to evil.example)");
  });

  it('FAIL when the fence leaks: her host serves his board', async () => {
    const r = await run('cloudflare', { status: 302, location: 'https://team.cloudflareaccess.com/x', jantar: false }, { ...FENCE_OK, 'us.example.com/v1/state': 200 });
    expect(r.code).toBe(EXIT.failed);
    expect(r.out).toContain('FIX  host fence: us.example.com/v1/state (his board) answered 200, not 404');
  });

  it('FAIL when a write with the other Origin gets through, on either host', async () => {
    const his = await run('cloudflare', { status: 302, location: 'https://team.cloudflareaccess.com/x', jantar: false }, { ...FENCE_OK, 'POST jantar.example.com/v1/pair/claim https://us.example.com': 400 });
    expect(his.code).toBe(EXIT.failed);
    expect(his.out).toContain('FIX  origin fence: jantar.example.com/v1/pair/claim (a write of yours with their Origin) answered 400, not 403');
    const hers = await run('cloudflare', { status: 302, location: 'https://team.cloudflareaccess.com/x', jantar: false }, { ...FENCE_OK, 'POST us.example.com/v1/p/join/preview https://jantar.example.com': 400 });
    expect(hers.out).toContain('FIX  origin fence: us.example.com/v1/p/join/preview (a write of theirs with your Origin) answered 400, not 403');
    // A 403 for every Origin proves nothing: his own Origin must get past it.
    const shut = await run('cloudflare', { status: 302, location: 'https://team.cloudflareaccess.com/x', jantar: false }, { ...FENCE_OK, 'POST jantar.example.com/v1/pair/claim https://jantar.example.com': 403 });
    expect(shut.out).toContain('(the same write with your Origin) answered 403, not 400');
  });

  it('People off: her join routes are 404, which refuses every Origin', async () => {
    const r = await run('cloudflare', { status: 302, location: 'https://team.cloudflareaccess.com/x', jantar: false }, { ...FENCE_OK, 'POST us.example.com/v1/p/join/preview https://jantar.example.com': 404 }, false);
    expect(r.out).toContain('ok   origin fence:');
  });

  it('tailscale: no Access probe, a note for the policy step', async () => {
    const r = await run('tailscale', null);
    expect(r.code).toBe(EXIT.ok);
    expect(r.asked.some((u) => u.endsWith('/healthz'))).toBe(false);
    expect(r.out).toContain("note Tailscale policy: share this Mac with their tailnet account and grant it us.example.com's port only");
  });
});

describe('jantar people: what the space with someone is called (the label)', () => {
  const asha = { id: ASHA, name: 'Asha', color: 'teal', label: 'Accountability partner', state: 'active', modules: { food: false }, invite: null, agreement: null, offer: null, pendingProposal: null };

  it('add --label sends it trimmed and says what the space is called', async () => {
    const added: unknown[] = [];
    const ctl = fakeCtl({ 'POST /v1/people': (call) => (added.push(call.body), ok({ id: BEA })) });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['add', 'Bea', '--email', 'bea@example.com', '--label', '  Cofounder '], c.ctx)).toBe(EXIT.ok);
    expect(added).toEqual([{ name: 'Bea', email: 'bea@example.com', label: 'Cofounder', modules: { food: true } }]);
    expect(c.io.stdout).toContain('Their space is called "Cofounder" on your screens and theirs (change it: jantar people label Bea <words>).');
    const plain = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['add', 'Cy'], plain.ctx)).toBe(EXIT.ok);
    expect(added.at(-1)).toEqual({ name: 'Cy', modules: { food: true } });
    expect(plain.io.stdout).toContain('Their space is called "Accountability partner"');
  });

  it('label <name> <words> renames it; --default puts it back; no words prints it; a bad one is a usage error', async () => {
    const patched: unknown[] = [];
    const ctl = fakeCtl({ 'GET /v1/people': ok({ enabled: true, people: [{ ...asha, label: 'Coach' }] }), [`PATCH /v1/people/${ASHA}`]: (call) => (patched.push(call.body), ok({ ok: true })) });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['label', 'Asha', 'Running coach'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toBe('The space with Asha is now called "Running coach". Their app shows it now, and their Activity says you renamed it.\nTheir Home Screen keeps the name it was added with; the new name shows inside the app.\n');
    const back = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['label', 'Asha', '--default'], back.ctx)).toBe(EXIT.ok);
    expect(back.io.stdout).toContain('is now called "Accountability partner"');
    expect(patched).toEqual([{ label: 'Running coach' }, { label: null }]);
    const show = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['label', 'Asha'], show.ctx)).toBe(EXIT.ok);
    expect(show.io.stdout).toBe('Asha: "Coach"\n');
    for (const bad of [['label', 'Asha', 'x'.repeat(41)], ['label', 'Asha', '   '], ['label', 'Asha', `Coach${String.fromCharCode(0x1b)}[2J`], ['label', 'Asha', 'Coach', '--default'], ['invite', 'Asha', 'extra']]) {
      const b = contextFor({ env: ENV }, { ctl });
      expect(await people.run(bad, b.ctx), JSON.stringify(bad)).toBe(EXIT.usage);
    }
    expect(patched).toHaveLength(2);
  });

  it('list names a space that isn’t the default', async () => {
    const ctl = fakeCtl({ 'GET /v1/people': ok({ enabled: true, people: [{ ...asha, label: 'Mentor' }, { ...asha, id: BEA, name: 'Bea' }] }) });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await people.run(['list'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toContain(`  Asha (Mentor)  active  ${ASHA}\n`);
    expect(c.io.stdout).toContain(`  Bea  active  ${BEA}\n`);
  });
});
