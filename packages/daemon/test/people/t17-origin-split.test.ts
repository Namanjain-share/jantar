/**
 * v0.11 People, T17 (C1, D15): two Origin sets, one per principal.
 *
 * - On his host, with his cookie and secret at every scope, every owner
 *   write route and his event stream refuse `Origin: https://us.test`
 *   (403; a closed door's own 404 for the node and capture doors).
 * - On her host, with her credential, every person write route and her
 *   stream refuse `Origin: https://jantar.test` (403).
 * - Settings that would mix the two are refused: a peopleUrl inside
 *   allowedOrigins, equal to publicUrl, not https, or People on in lan
 *   mode.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySettingsPatch, defaultSettings } from '@jantar/protocol';
import { OriginPolicy } from '../../src/auth/origin.js';
import { OWNER_HOST, OWNER_ORIGIN, PEOPLE_HOST, PEOPLE_ORIGIN, call, credHeaders, makeFixture, routeEntries, type Fixture } from './isolation-fixture.js';

let f: Fixture;
beforeAll(async () => {
  f = await makeFixture();
}, 60_000);
afterAll(async () => {
  await f?.close();
});

describe('T17: the Origin split', () => {
  it('his writes refuse her origin, at every scope', async () => {
    const bad: string[] = [];
    for (const [name, def] of routeEntries()) {
      if (def.scope === 'person' || def.method === 'GET' || def.method === 'WS') continue;
      for (const cred of [f.owner.control, f.owner.admin]) {
        const r = await call(f.api, def, { host: OWNER_HOST, cred, origin: PEOPLE_ORIGIN });
        const doorClosed = (def.scope === 'node' || def.scope === 'capture') && r.status === 404;
        if (r.status !== 403 && !doorClosed) bad.push(`${name} ${cred.name}: ${r.status} ${r.body.slice(0, 60)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('his event stream refuses her origin', async () => {
    await expect(f.api.tcp.injectWS('/v1/events', { headers: { host: OWNER_HOST, origin: PEOPLE_ORIGIN, ...credHeaders(f.owner.admin) } })).rejects.toThrow(/403/);
  });

  it("her writes refuse his origin", async () => {
    const bad: string[] = [];
    for (const [name, def] of routeEntries()) {
      if (def.scope !== 'person' || def.method === 'GET' || def.method === 'WS') continue;
      const r = await call(f.api, def, { host: PEOPLE_HOST, cred: f.asha.full, origin: OWNER_ORIGIN });
      if (r.status !== 403) bad.push(`${name}: ${r.status}`);
    }
    expect(bad).toEqual([]);
    await expect(f.api.tcp.injectWS('/v1/p/events', { headers: { host: PEOPLE_HOST, origin: OWNER_ORIGIN, ...credHeaders(f.asha.full) } })).rejects.toThrow(/403/);
  });

  it("the owner's origin set never holds hers; hers is hers alone", () => {
    const policy = f.api.services.origin;
    expect(policy.allowedOrigins().has(PEOPLE_ORIGIN)).toBe(false);
    expect(policy.originAllowedFor('owner', PEOPLE_ORIGIN)).toBe(false);
    expect(policy.originAllowedFor('person', PEOPLE_ORIGIN)).toBe(true);
    expect(policy.originAllowedFor('person', OWNER_ORIGIN)).toBe(false);
    expect(policy.originAllowedFor('person', 'http://127.0.0.1:7420')).toBe(false);
    expect(policy.hostAllowed(PEOPLE_HOST)).toBe(true);
  });

  it('settings that would mix the two are refused', () => {
    const base = applySettingsPatch(defaultSettings(), { remote: { mode: 'cloudflare', publicUrl: OWNER_ORIGIN } });
    if (!base.ok) throw new Error(base.error);
    const refuse = (patch: object) => {
      const r = applySettingsPatch(base.settings, patch);
      expect(r.ok, JSON.stringify(patch)).toBe(false);
    };
    refuse({ remote: { peopleUrl: OWNER_ORIGIN } });
    refuse({ remote: { peopleUrl: PEOPLE_ORIGIN, allowedOrigins: [PEOPLE_ORIGIN] } });
    refuse({ remote: { peopleUrl: 'http://us.test' } });
    refuse({ remote: { peopleUrl: 'https://192.168.1.4' } });
    refuse({ remote: { peopleUrl: 'https://us.test/p' } });
    refuse({ people: { enabled: true, ownerName: 'Sam' } });
    refuse({ remote: { mode: 'lan', peopleUrl: PEOPLE_ORIGIN }, people: { enabled: true, ownerName: 'Sam' } });
    refuse({ remote: { peopleUrl: PEOPLE_ORIGIN }, people: { enabled: true } });
    const ok = applySettingsPatch(base.settings, { remote: { peopleUrl: PEOPLE_ORIGIN }, people: { enabled: true, ownerName: 'Sam' } });
    expect(ok.ok).toBe(true);
  });

  it('no people host exists in loopback or lan mode, nor with a problem in its settings', () => {
    const make = (remote: object) =>
      new OriginPolicy({ settings: () => ({ remote: { ...defaultSettings().remote, ...remote }, people: { enabled: true, ownerName: 'Sam' } }), port: () => 7420 });
    expect(make({ mode: 'loopback', peopleUrl: PEOPLE_ORIGIN }).peopleHost()).toBeNull();
    expect(make({ mode: 'lan', peopleUrl: PEOPLE_ORIGIN }).peopleHost()).toBeNull();
    expect(make({ mode: 'cloudflare', peopleUrl: PEOPLE_ORIGIN, publicUrl: PEOPLE_ORIGIN }).peopleHost()).toBeNull();
    expect(make({ mode: 'tailscale', peopleUrl: PEOPLE_ORIGIN }).peopleHost()).toBe(PEOPLE_HOST);
  });
});
