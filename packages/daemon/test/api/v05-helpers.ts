/**
 * Requests that pass validation for every v0.5 route, so a status says
 * something about the pipeline (the extension's key, loopback, Origin,
 * scope, the switch, a broken meetings.db, a stub), settings with Meetings
 * on or off, and the extension's side of pairing. Synthetic values only.
 */
import { EXTENSION_ID, EXTENSION_KEY_HEADER, ROUTES, SettingsSchema, type RouteDef, type RouteName, type Settings } from '@jantar/protocol';
import { HOST, type TestApi } from './fakes.js';

export const ULID = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
export const SHOT_ULID = '01JFZ8X8Y3T0V5G9WQK2M4N6PS';
export const CLIENT_ID = '0b4e7c4e-0000-4000-8000-000000000000';
export const SHOT_KEY = '1c5f8d5f-0000-4000-8000-000000000000';
/** The extension's own Origin, as its service worker's POSTs carry it. */
export const EXT_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
/** A tiny JPEG as a data URL (FF D8 FF ...): enough for validation; WP-MS's tests send real ones. */
export const JPEG_DATA_URL = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]).toString('base64')}`;

/** Every v0.5 route, in table order. */
export const V05 = (Object.entries(ROUTES) as [RouteName, RouteDef][]).filter(([, d]) => d.phase === 'v0.5');
/** The extension's capture routes (scope `extension`). */
export const V05_EXT = V05.filter(([, d]) => d.scope === 'extension');
/** The phone's routes (scope control). */
export const V05_PHONE = V05.filter(([, d]) => d.path.startsWith('/v1/meetings'));

/** Meetings on. */
export const V05_ON: Settings = SettingsSchema.parse({ meetings: { enabled: true } });
/** Meetings off (the default). */
export const V05_OFF: Settings = SettingsSchema.parse({});

const PARAMS: Record<string, string> = { id: ULID, shotId: SHOT_ULID, clientId: CLIENT_ID, n: '0' };

export const V05_REQ: Partial<Record<RouteName, { query?: string; body?: unknown; params?: Record<string, string> }>> = {
  extPairClaim: { body: { code: 'A'.repeat(22) } },
  extMeetingOpen: { body: { site: 'meet', name: 'Weekly sync', people: 'Sam, Priya', autoTodos: false, captions: true, at: 1_793_350_800_000 } },
  extMeetingLines: { body: { lines: [{ lineId: 'aB3dE6gH-1', rev: 1, speaker: 'Sam', text: 'Hello there', at: 1_793_350_801_000 }] } },
  extMeetingShot: { body: { key: SHOT_KEY, at: 1_793_350_802_000, image: JPEG_DATA_URL } },
  extMeetingEnd: { body: { reason: 'user', at: 1_793_350_900_000 } },
  meetingsList: { query: '?project=none&q=launch&limit=10' },
  meetingUpdate: { body: { name: 'Weekly sync', projectId: null } },
};

export function v05Url(name: RouteName): string {
  const def = ROUTES[name] as RouteDef;
  const params = { ...PARAMS, ...V05_REQ[name]?.params };
  return def.path.replace(/:([A-Za-z]+)/g, (_m, n: string) => encodeURIComponent(params[n] ?? 'x')) + (V05_REQ[name]?.query ?? '');
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** One request to a v0.5 route over a transport, with the valid body when it takes one. */
export function v05Call(
  api: TestApi,
  transport: 'tcp' | 'ctl',
  name: RouteName,
  headers: Record<string, string> = {},
  body?: unknown,
  opts: { remoteAddress?: string } = {},
) {
  const def = ROUTES[name] as RouteDef;
  const payload = body ?? V05_REQ[name]?.body;
  return api[transport].inject({
    method: def.method as Method,
    url: v05Url(name),
    headers,
    ...(opts.remoteAddress ? { remoteAddress: opts.remoteAddress } : {}),
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

/**
 * What the extension's service worker sends: the loopback Host, its key in
 * its own header, and its Origin (`origin: null` sends none, as its GETs do).
 */
export function extHeaders(key: string | undefined, origin: string | null = EXT_ORIGIN, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = { host: HOST, ...extra };
  if (key !== undefined) out[EXTENSION_KEY_HEADER] = key;
  if (origin !== null) out.origin = origin;
  return out;
}

/** The gate's own refusals: 401, and these 403 sentences (the switch's included). */
const GATE_REFUSALS: ReadonlySet<string> = new Set([
  'this device does not have the control scope',
  'request origin is not allowed',
  'only the paired Jantar extension can call this',
  'only the Jantar extension on this Mac can call this',
  'only the Jantar extension can pair here',
  'Meetings are off. Turn them on at your Mac: jantar meetings on',
]);

/** A request got past the gate and the switch to its handler (WP0's stub: 501; a built one: its own answer, a 403 of its own included). */
export function pastGate(res: { statusCode: number; json(): unknown }): boolean {
  if (res.statusCode === 401) return false;
  if (res.statusCode !== 403) return true;
  const message = (res.json() as { error?: { message?: string } } | null)?.error?.message ?? '';
  return !GATE_REFUSALS.has(message);
}

/** Pair an extension through the real flow (extPairStart over ctl.sock, the claim over TCP): its id and key. */
export async function pairExtension(api: TestApi): Promise<{ id: string; key: string; code: string }> {
  const start = await api.ctl.inject({ method: 'POST', url: '/v1/ext/pair/start' });
  if (start.statusCode !== 200) throw new Error(`extension pair start failed: ${start.body}`);
  const code = (start.json() as { code: string }).code;
  const claim = await api.tcp.inject({ method: 'POST', url: '/v1/ext/pair', headers: { host: HOST, origin: EXT_ORIGIN }, payload: { code } });
  if (claim.statusCode !== 200) throw new Error(`extension pair claim failed: ${claim.body}`);
  const { id, key } = claim.json() as { id: string; key: string };
  return { id, key, code };
}
