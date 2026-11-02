/**
 * v0.12 People: the isolation suites' fixture (spec 9.7.2). Synthetic people
 * only: the owner Sam, the partner Asha, a second partner Bea (PEOPLE_MAX is
 * raised inside the tests only), and one person per other state: Cara
 * paused, Dev ending, Eli left (keep 30 days), Fay forgotten, Gus invited.
 * His host is `jantar.test`, hers `us.test`, every email `@example.com`.
 *
 * - A real Life service (life.db in a temp dir) on the API test harness,
 *   `remote: {mode: 'cloudflare', publicUrl: https://jantar.test, peopleUrl:
 *   https://us.test}`, `people: {enabled: true, ownerName: 'Sam'}`.
 * - His credentials: a device at each scope (cookie and secret), the cookie
 *   alone, and the CLI on ctl.sock.
 * - Hers: two devices (one revoked), and a left person's old cookie.
 * - `call()` resets every rate limiter first, so a limiter can't make the
 *   two halves of a comparison differ.
 * - `sampleParams(def)` fills each `:param` with a well-formed value.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEVICE_COOKIE, DEVICE_SECRET_HEADER, SettingsSchema, type RouteDef, type Scope } from '@jantar/protocol';
import { PERSON_COOKIE, type JoinPreview } from '@jantar/protocol/people';
import { ALL_ROUTES, type AnyRouteName } from '../../src/api/all-routes.js';
import type { ApiOptions } from '../../src/api/services.js';
import { SlidingWindowBudget, SlidingWindowLimiter } from '../../src/auth/rate-limit.js';
import type { LifeService } from '../../src/contracts.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import { setPeopleMaxForTests } from '../../src/life/people/module.js';
import { buildLifeService } from '../../src/life/service.js';
import { makeApi, pairCookie, type TestApi } from '../api/fakes.js';

export const OWNER_HOST = 'jantar.test';
export const PEOPLE_HOST = 'us.test';
export const LOOPBACK_HOST = '127.0.0.1:7420';
export const OWNER_ORIGIN = `https://${OWNER_HOST}`;
export const PEOPLE_ORIGIN = `https://${PEOPLE_HOST}`;
export const LOOPBACK_ORIGIN = 'http://127.0.0.1:7420';
export const UNKNOWN_ULID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
export const DAY = '2026-11-03';

/** A credential as headers: a cookie and an optional secret. */
export interface Cred {
  name: string;
  cookie?: string;
  secret?: string;
}

export const NONE: Cred = { name: 'none' };

export interface PersonCreds {
  id: string;
  cookie: Cred;
  secretOnly: Cred;
  full: Cred;
  deviceId: string;
}

export interface Fixture {
  api: TestApi;
  life: LifeService;
  dir: string;
  owner: Record<Scope, Cred> & { cookieOnly: Cred };
  asha: PersonCreds & { revoked: Cred; secondDeviceId: string };
  bea: PersonCreds;
  /** People in each other state, by name (cookies where they had a device). */
  cara: PersonCreds;
  dev: PersonCreds;
  eli: { id: string; oldCookie: Cred };
  fay: { id: string; oldCookie: Cred };
  gus: { id: string; inviteUrl: string };
  close(): Promise<void>;
}

/** Reset every rate limiter of the API's services (so a limiter can't make two calls differ). */
export function resetLimiters(api: TestApi): void {
  for (const v of Object.values(api.services as unknown as Record<string, unknown>)) {
    if (v instanceof SlidingWindowLimiter) (v as unknown as { hits: Map<string, unknown> }).hits.clear();
    if (v instanceof SlidingWindowBudget) (v as unknown as { used: Map<string, unknown> }).used.clear();
  }
}

export function credHeaders(c: Cred): Record<string, string> {
  const out: Record<string, string> = {};
  if (c.cookie) out.cookie = c.cookie;
  if (c.secret) out[DEVICE_SECRET_HEADER] = c.secret;
  return out;
}

/** A well-formed value for every `:param`. */
export function sampleParams(def: Pick<RouteDef, 'path'>, pid: string = UNKNOWN_ULID): string {
  return def.path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    switch (name) {
      case 'pid':
        return pid;
      case 'sid':
        return 'sess-aaaa-1111';
      case 'day':
        return DAY;
      case 'area':
        return 'todos';
      case 'n':
        return '0';
      case 'clientId':
        return 'client-0001';
      case 'jobId':
        return UNKNOWN_ULID;
      default:
        return UNKNOWN_ULID;
    }
  });
}

/** Call one route on the TCP app (limiters reset first). */
export async function call(
  api: TestApi,
  def: Pick<RouteDef, 'method' | 'path'>,
  opts: { host: string; cred?: Cred; origin?: string | undefined; path?: string; body?: unknown },
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  resetLimiters(api);
  const headers: Record<string, string> = { host: opts.host, ...credHeaders(opts.cred ?? NONE) };
  if (opts.origin !== undefined) headers.origin = opts.origin;
  const method = def.method === 'WS' ? 'GET' : def.method;
  const hasBody = method !== 'GET' && method !== 'DELETE';
  const r = await api.tcp.inject({
    method,
    url: opts.path ?? sampleParams(def),
    headers: hasBody ? { ...headers, 'content-type': 'application/json' } : headers,
    ...(hasBody ? { payload: JSON.stringify(opts.body ?? {}) } : {}),
  });
  return { status: r.statusCode, body: r.body, headers: r.headers as Record<string, unknown> };
}

export const routeEntries = (): [AnyRouteName, RouteDef][] => Object.entries(ALL_ROUTES) as [AnyRouteName, RouteDef][];

async function ctl<T>(api: TestApi, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<T> {
  const r = await api.ctl.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
  if (r.statusCode >= 300) throw new Error(`${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json() as T;
}

/** Her side of a call on her host, with her origin. */
async function onHer(api: TestApi, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cred: Cred, payload?: unknown) {
  resetLimiters(api);
  return api.tcp.inject({
    method,
    url,
    headers: { host: PEOPLE_HOST, origin: PEOPLE_ORIGIN, ...credHeaders(cred), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });
}

/** Add, offer, invite and join one person through the real routes. Returns her first device. */
export async function joinPerson(
  api: TestApi,
  name: string,
  opts: { preset?: 'light' | 'standard' | 'everything'; offer?: Record<string, unknown>; food?: boolean; deviceName?: string } = {},
): Promise<PersonCreds> {
  const { id } = await ctl<{ id: string }>(api, 'POST', '/v1/people', {
    name,
    email: `${name.toLowerCase()}@example.com`,
    modules: { food: opts.food ?? false },
  });
  await ctl(api, 'POST', `/v1/people/${id}/offer`, { preset: opts.preset ?? 'everything', ...(opts.food === true ? {} : { see: { food: false } }), ...opts.offer });
  const { url } = await ctl<{ url: string }>(api, 'POST', `/v1/people/${id}/invite`);
  const code = url.split('#c=')[1] as string;
  const preview = await onHer(api, 'POST', '/v1/p/join/preview', NONE, { code });
  if (preview.statusCode !== 200) throw new Error(`preview: ${preview.body}`);
  const p = preview.json() as JoinPreview;
  const joined = await onHer(api, 'POST', '/v1/p/join', NONE, {
    code,
    acceptedVersion: p.version,
    agreement: p.offer,
    adult: true,
    name,
    deviceName: opts.deviceName ?? `${name} phone`,
  });
  if (joined.statusCode !== 200) throw new Error(`join: ${joined.body}`);
  const set = joined.cookies.find((c) => c.name === PERSON_COOKIE);
  if (!set) throw new Error('no person cookie');
  const body = joined.json() as { personId: string; deviceId: string; deviceSecret: string };
  const cookie = `${PERSON_COOKIE}=${set.value}`;
  return {
    id: body.personId,
    deviceId: body.deviceId,
    cookie: { name: `${name}:cookie`, cookie },
    secretOnly: { name: `${name}:secret`, secret: body.deviceSecret },
    full: { name: `${name}:cookie+secret`, cookie, secret: body.deviceSecret },
  };
}

/** Link a second device of hers with a link code. */
export async function linkDevice(api: TestApi, who: PersonCreds, deviceName: string): Promise<{ cred: Cred; deviceId: string }> {
  const code = await onHer(api, 'POST', '/v1/p/devices/link', who.full);
  if (code.statusCode !== 200) throw new Error(`link code: ${code.body}`);
  const claim = await onHer(api, 'POST', '/v1/p/devices/link/claim', NONE, { code: (code.json() as { code: string }).code, deviceName });
  if (claim.statusCode !== 200) throw new Error(`link claim: ${claim.body}`);
  const set = claim.cookies.find((c) => c.name === PERSON_COOKIE);
  const body = claim.json() as { deviceId: string; deviceSecret: string };
  return { cred: { name: `${deviceName}`, cookie: `${PERSON_COOKIE}=${set?.value}`, secret: body.deviceSecret }, deviceId: body.deviceId };
}

export { onHer };

export async function makeFixture(opts: { api?: ApiOptions } = {}): Promise<Fixture> {
  setPeopleMaxForTests(10);
  const dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'jantar-people-')));
  let life!: LifeService;
  const api = await makeApi({
    ctx: {
      home: dir,
      settings: SettingsSchema.parse({
        remote: { mode: 'cloudflare', publicUrl: OWNER_ORIGIN, peopleUrl: PEOPLE_ORIGIN },
        people: { enabled: true, ownerName: 'Sam' },
        life: { todos: true, medicines: true, food: true },
      }),
    },
    ...(opts.api ? { api: opts.api } : {}),
    deps: (ctx, f) => {
      life = buildLifeService(ctx, { sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, notifiers: f.notifiers }, LIFE_MODULE_BUILDERS, { macZone: 'UTC' });
      return { life };
    },
  });
  api.ctx.clock.set(`${DAY}T09:00:00.000Z`);
  await life.start();

  const owner = {} as Fixture['owner'];
  for (const scope of ['read', 'control', 'launch', 'admin'] as Scope[]) {
    const scopes: Scope[] = scope === 'read' ? ['read'] : scope === 'control' ? ['read', 'control'] : scope === 'launch' ? ['read', 'control', 'launch'] : ['read', 'control', 'launch', 'admin'];
    const p = await pairCookie(api, scopes, `Sam ${scope}`);
    owner[scope] = { name: `owner:${scope}`, cookie: p.cookie, secret: p.secret };
  }
  owner.cookieOnly = { name: 'owner:cookie-only', cookie: owner.admin.cookie as string };
  if (!owner.admin.cookie?.startsWith(`${DEVICE_COOKIE}=`)) throw new Error('owner cookie');

  const ashaBase = await joinPerson(api, 'Asha');
  const second = await linkDevice(api, ashaBase, 'Asha old phone');
  // Her second device is revoked: its cookie must be inert everywhere.
  const rv = await onHer(api, 'DELETE', `/v1/p/devices/${second.deviceId}`, ashaBase.full);
  if (rv.statusCode !== 200) throw new Error(`revoke: ${rv.body}`);
  const asha = { ...ashaBase, revoked: { ...second.cred, name: 'asha:revoked' }, secondDeviceId: second.deviceId };

  const bea = await joinPerson(api, 'Bea', { preset: 'standard' });
  const cara = await joinPerson(api, 'Cara');
  await onHer(api, 'POST', '/v1/p/pause', cara.full, {});
  const dev = await joinPerson(api, 'Dev');
  await ctl(api, 'POST', `/v1/people/${dev.id}/remove`, { mode: 'window', forget: false });
  const eliP = await joinPerson(api, 'Eli');
  await onHer(api, 'POST', '/v1/p/leave', eliP.full, { data: 'keep30', confirm: 'LEAVE' });
  const fayP = await joinPerson(api, 'Fay');
  await onHer(api, 'POST', '/v1/p/leave', fayP.full, { data: 'delete', confirm: 'LEAVE' });
  const gus = await ctl<{ id: string }>(api, 'POST', '/v1/people', { name: 'Gus', email: 'gus@example.com' });
  const gusInvite = await ctl<{ url: string }>(api, 'POST', `/v1/people/${gus.id}/invite`);

  return {
    api,
    life,
    dir,
    owner,
    asha,
    bea,
    cara,
    dev,
    eli: { id: eliP.id, oldCookie: { ...eliP.full, name: 'eli:left' } },
    fay: { id: fayP.id, oldCookie: { ...fayP.full, name: 'fay:forgotten' } },
    gus: { id: gus.id, inviteUrl: gusInvite.url },
    async close() {
      setPeopleMaxForTests(undefined);
      await life.stop();
      await api.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
