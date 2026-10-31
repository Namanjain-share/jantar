/**
 * devices against an in-memory daemon whose scopes route edits scopes with
 * the daemon's own editScopes: list, grant and revoke-scope by name or id,
 * the scopes left after every change, and "revoke launch too" when taking
 * admin away leaves launch.
 */
import { describe, expect, it } from 'vitest';
import { editScopes } from '@jantar/daemon/auth/scopes';
import type { DevicePublic, Scope } from '@jantar/protocol';
import devices from '../src/commands/devices.js';
import { EXIT } from '../src/command.js';
import { resolveDevice, scopesText } from '../src/lib/devices.js';
import { contextFor, fakeCtl, fakeSettings, fail, ok, type CtlCall, type Handler } from './helpers.js';

const ENV = { HOME: '/synthetic/home', JANTAR_HOME: '/synthetic/state' };
const AT = '2026-01-15T09:00:00.000Z';

function device(id: string, name: string, scopes: Scope[], over: Partial<DevicePublic> = {}): DevicePublic {
  return { id, name, scopes, createdAt: AT, lastSeenAt: '2026-01-15T09:55:00.000Z', ...over };
}

/** A daemon with `list` paired devices: GET /v1/devices, the scopes route, DELETE, and the settings routes. */
function daemon(list: DevicePublic[], settings: Record<string, unknown> = {}) {
  const s = fakeSettings(settings);
  const routes: Record<string, Handler> = { ...s.routes, 'GET /v1/devices': () => ok({ devices: list }) };
  for (const d of list) {
    routes[`POST /v1/devices/${d.id}/scopes`] = (call: CtlCall) => {
      const body = call.body as { add?: Scope[]; remove?: Scope[] };
      if (d.revokedAt) return fail('not_found', 'no such device', 404);
      d.scopes = editScopes(d.scopes, body.add, body.remove);
      return ok({ device: d });
    };
    routes[`DELETE /v1/devices/${d.id}`] = () => {
      d.revokedAt = '2026-01-15T10:00:00.000Z';
      return ok({ device: d });
    };
  }
  return fakeCtl(routes);
}

const PHONE = '01JSYNTHPHONE0000000000000';
const MAC = '01JSYNTHMAC000000000000000';

describe('jantar devices', () => {
  it('list shows names, ids, every scope a device has and when it was seen; --all and --json', async () => {
    const list = [
      device(PHONE, 'iPhone', ['read', 'control']),
      device(MAC, 'This Mac', ['read', 'control', 'admin']),
      device('01JSYNTHOLD000000000000000', 'Old iPad', ['read'], { revokedAt: '2026-01-14T10:00:00.000Z' }),
    ];
    const ctl = daemon(list);
    const a = contextFor({ env: ENV }, { ctl });
    expect(await devices.run(['list'], a.ctx)).toBe(EXIT.ok);
    expect(a.io.stdout).toContain(`  iPhone    ${PHONE}  read + control  · seen 5m ago\n`);
    // a pre-v0.3 admin shows the launch its admin implies
    expect(a.io.stdout).toContain(`  This Mac  ${MAC}  read + control + launch + admin`);
    expect(a.io.stdout).not.toContain('Old iPad');

    const all = contextFor({ env: ENV }, { ctl });
    expect(await devices.run(['list', '--all'], all.ctx)).toBe(EXIT.ok);
    expect(all.io.stdout).toContain('Old iPad');
    expect(all.io.stdout).toContain('Old iPad  01JSYNTHOLD000000000000000  read  · revoked 24h ago');

    const json = contextFor({ env: ENV }, { ctl });
    expect(await devices.run(['list', '--json'], json.ctx)).toBe(EXIT.ok);
    expect(JSON.parse(json.io.stdout).devices.map((d: DevicePublic) => d.name)).toEqual(['iPhone', 'This Mac']);

    const none = contextFor({ env: ENV }, { ctl: daemon([]) });
    expect(await devices.run(['list'], none.ctx)).toBe(EXIT.ok);
    expect(none.io.stdout).toContain('No paired devices. Pair one: jantar pair');
  });

  it('grant <name> launch posts the scope over ctl.sock and prints the scopes the device has now', async () => {
    const phone = device(PHONE, 'iPhone', ['read', 'control']);
    const ctl = daemon([phone]);
    const { ctx, io } = contextFor({ env: ENV }, { ctl });
    expect(await devices.run(['grant', 'iPhone', 'launch'], ctx)).toBe(EXIT.ok);
    const post = ctl.calls.find((c) => c.method === 'POST') as CtlCall;
    expect(post.path).toBe(`/v1/devices/${PHONE}/scopes`);
    expect(post.body).toEqual({ add: ['launch'] });
    expect(post.opts.idempotencyKey).toBeTruthy();
    expect(phone.scopes).toEqual(['read', 'control', 'launch']);
    expect(io.stdout).toContain('iPhone now has read + control + launch.');
    expect(io.stdout).toContain("It applies at the device's next request");
    // launching is off on this Mac: say how to turn it on
    expect(io.stdout).toContain('Starting sessions from the phone is off on this Mac: jantar launch on');

    const on = daemon([device(PHONE, 'iPhone', ['read', 'control'])], { launch: { enabled: true } });
    const b = contextFor({ env: ENV }, { ctl: on });
    expect(await devices.run(['grant', PHONE.slice(0, 10).toLowerCase(), 'launch'], b.ctx)).toBe(EXIT.ok);
    expect(b.io.stdout).not.toContain('jantar launch on');
  });

  it('revoke-scope admin says to revoke launch too while launch stays; revoking launch takes admin with it', async () => {
    const mac = device(MAC, 'This Mac', ['read', 'control', 'admin']);
    const ctl = daemon([mac]);
    const a = contextFor({ env: ENV }, { ctl });
    expect(await devices.run(['revoke-scope', 'this mac', 'admin'], a.ctx)).toBe(EXIT.ok);
    expect(mac.scopes).toEqual(['read', 'control', 'launch']);
    expect(a.io.stdout).toContain('This Mac now has read + control + launch.');
    expect(a.io.stdout).toContain("revoke launch too: jantar devices revoke-scope 'this mac' launch");

    const b = contextFor({ env: ENV }, { ctl });
    expect(await devices.run(['revoke-scope', MAC, 'launch'], b.ctx)).toBe(EXIT.ok);
    expect(mac.scopes).toEqual(['read', 'control']);
    expect(b.io.stdout).toContain('This Mac now has read + control.');
    expect(b.io.stdout).not.toContain('revoke launch too');

    const both = device(PHONE, 'iPad', ['read', 'control', 'launch', 'admin']);
    const c = contextFor({ env: ENV }, { ctl: daemon([both]) });
    expect(await devices.run(['revoke-scope', 'iPad', 'admin', 'launch'], c.ctx)).toBe(EXIT.ok);
    expect(both.scopes).toEqual(['read', 'control']);
    expect(c.io.stdout).not.toContain('revoke launch too');
  });

  it('refuses ambiguous or unknown devices, bad scopes, and taking read away', async () => {
    const ctl = daemon([device(PHONE, 'iPhone', ['read', 'control']), device(MAC, 'iphone', ['read', 'control'])]);
    const amb = contextFor({ env: ENV }, { ctl });
    // "iPhone" matches one name exactly; "IPHONE" matches both ignoring case
    expect(await devices.run(['grant', 'IPHONE', 'launch'], amb.ctx)).toBe(EXIT.usage);
    expect(amb.io.stderr).toContain('matches 2 devices');
    expect(amb.io.stderr).toContain(PHONE);
    const none = contextFor({ env: ENV }, { ctl });
    expect(await devices.run(['grant', 'Android', 'launch'], none.ctx)).toBe(EXIT.failed);
    expect(none.io.stderr).toContain('no paired device matches "Android"');

    for (const bad of [['grant', 'iPhone'], ['grant', 'iPhone', 'root'], ['revoke-scope', 'iPhone', 'read'], ['frob'], ['list', 'x'], ['grant', '--all']]) {
      const c = contextFor({ env: ENV }, { ctl });
      expect(await devices.run(bad, c.ctx), bad.join(' ')).toBe(EXIT.usage);
    }
    expect(ctl.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('revoke signs a device out; the daemon down exits 3', async () => {
    const phone = device(PHONE, 'iPhone', ['read', 'control']);
    const ctl = daemon([phone]);
    const a = contextFor({ env: ENV }, { ctl });
    expect(await devices.run(['revoke', 'iPhone'], a.ctx)).toBe(EXIT.ok);
    expect(ctl.calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/v1/devices/${PHONE}` });
    expect(a.io.stdout).toContain(`Revoked iPhone (${PHONE})`);
    const again = contextFor({ env: ENV }, { ctl });
    expect(await devices.run(['revoke', PHONE], again.ctx)).toBe(EXIT.ok);
    expect(again.io.stdout).toContain('already revoked');
    const granted = contextFor({ env: ENV }, { ctl });
    expect(await devices.run(['grant', PHONE, 'launch'], granted.ctx)).toBe(EXIT.failed);
    expect(granted.io.stderr).toContain('was revoked');

    const down = contextFor({ env: ENV });
    expect(await devices.run(['grant', 'iPhone', 'launch'], down.ctx)).toBe(EXIT.daemonDown);
  });

  it('resolveDevice: id, id prefix, name, name ignoring case; revoked only by full id', () => {
    const list = [
      device('01AAAA1111', 'iPhone', ['read']),
      device('01AAAA2222', 'iPad', ['read']),
      device('01BBBB3333', 'Old', ['read'], { revokedAt: AT }),
    ];
    expect(resolveDevice(list, '01AAAA2222')).toMatchObject({ ok: true, device: { name: 'iPad' } });
    expect(resolveDevice(list, '01aaaa1')).toMatchObject({ ok: true, device: { name: 'iPhone' } });
    expect(resolveDevice(list, '01AA')).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(resolveDevice(list, 'ipad')).toMatchObject({ ok: true, device: { id: '01AAAA2222' } });
    expect(resolveDevice(list, 'Old')).toMatchObject({ ok: false, reason: 'none' });
    expect(resolveDevice(list, '01BBBB3333')).toMatchObject({ ok: true, device: { name: 'Old' } });
    expect(resolveDevice(list, '  ')).toMatchObject({ ok: false, reason: 'none' });
    expect(scopesText(['admin'])).toBe('read + control + launch + admin');
  });
});
