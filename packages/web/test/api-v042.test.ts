// @vitest-environment node
/**
 * The v0.4.2 calls of the API client (wave 0): a call per route, paths from
 * the route table, the device secret on every new write, an Idempotency-Key
 * on dialog answers and keypad sends (the one kept, when given) and none on
 * uploads, the upload sent as application/octet-stream through lib/upload.ts
 * (here a fake), and a prompt that carries attachment refs.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEVICE_SECRET_HEADER, ROUTES, type RouteDef, type UploadResponse } from '@jantar/protocol';
import { createApi } from '../src/lib/api.js';
import type { CredentialStore } from '../src/lib/credential.js';
import type { UploadFn } from '../src/lib/upload.js';

const BASE = 'http://127.0.0.1:7420';
const SID = 'sess-1';
const UPLOAD = '01jfz8x8y3t0v5g9wqk2m4n6pr';
const SECRET = 'S'.repeat(43);

function fetchOk(body: unknown = { ok: true }) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}

const credentials = (secret: string | null): CredentialStore =>
  ({
    get: async () => (secret ? { secret, deviceId: 'dev-1', savedAt: '2026-10-31T00:00:00.000Z' } : null),
    set: async () => undefined,
    clear: async () => undefined,
  }) as unknown as CredentialStore;

const headersOf = (init: RequestInit | undefined) => (init?.headers ?? {}) as Record<string, string>;
const REPLY: UploadResponse = { upload: { id: UPLOAD, kind: 'image', bytes: 3 } };

function apiWith(f: ReturnType<typeof fetchOk>, upload?: UploadFn, secret: string | null = SECRET) {
  return createApi({ fetch: f as unknown as typeof fetch, base: BASE, credentials: credentials(secret), ...(upload ? { upload } : {}) });
}

describe('v0.4.2 api client', () => {
  it('has a call for every v0.4.2 route', () => {
    const api = apiWith(fetchOk());
    const v042 = (Object.entries(ROUTES) as [string, RouteDef][]).filter(([, r]) => r.phase === 'v0.4.2');
    expect(v042.map(([n]) => n).sort()).toEqual(['sessionDialog', 'sessionKeypad', 'uploadCreate', 'uploadDelete']);
    for (const [name] of v042) expect(typeof (api as unknown as Record<string, unknown>)[name], name).toBe('function');
  });

  it('a dialog answer and a keypad send: POST, JSON, the device secret and an Idempotency-Key (the one kept, when given)', async () => {
    const f = fetchOk({ outcome: 'done', dialog: null });
    const api = apiWith(f);
    const answer = { fingerprint: 'a'.repeat(64), option: 3, text: 'teal' };
    expect(await api.sessionDialog(SID, answer, 'tap-1')).toEqual({ outcome: 'done', dialog: null });
    await api.sessionDialog(SID, { fingerprint: 'a'.repeat(64), option: 0, confirm: true });
    await api.sessionKeypad(SID, { screen: 'b'.repeat(64), lines: 40, move: 2, key: 'enter' }, 'tap-2');
    const calls = f.mock.calls;
    expect(calls.map(([url]) => String(url))).toEqual([`${BASE}/v1/sessions/${SID}/dialog`, `${BASE}/v1/sessions/${SID}/dialog`, `${BASE}/v1/sessions/${SID}/keypad`]);
    for (const [, init] of calls) {
      expect(init?.method).toBe('POST');
      expect(headersOf(init)['content-type']).toBe('application/json');
      expect(headersOf(init)[DEVICE_SECRET_HEADER]).toBe(SECRET);
      expect(headersOf(init)['idempotency-key']).toBeTruthy();
    }
    expect(headersOf(calls[0]?.[1])['idempotency-key']).toBe('tap-1');
    expect(headersOf(calls[1]?.[1])['idempotency-key']).not.toBe('tap-1');
    expect(headersOf(calls[2]?.[1])['idempotency-key']).toBe('tap-2');
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual(answer);
    expect(JSON.parse(String(calls[2]?.[1]?.body))).toEqual({ screen: 'b'.repeat(64), lines: 40, move: 2, key: 'enter' });
  });

  it('an upload goes through lib/upload.ts as raw bytes: octet-stream, the device secret, no Idempotency-Key', async () => {
    const f = fetchOk();
    const upload = vi.fn<UploadFn>(async () => REPLY);
    const api = apiWith(f, upload);
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const onProgress = vi.fn();
    const ctrl = new AbortController();
    expect(await api.uploadCreate(SID, blob, { ext: 'md', onProgress, signal: ctrl.signal })).toEqual(REPLY);
    expect(await api.uploadCreate(SID, blob)).toEqual(REPLY);
    expect(f).not.toHaveBeenCalled();
    const [req, sent, opts] = upload.mock.calls[0] ?? [];
    expect(req?.url).toBe(`${BASE}/v1/sessions/${SID}/uploads?ext=md`);
    expect(req?.headers).toEqual({ accept: 'application/json', 'content-type': 'application/octet-stream', [DEVICE_SECRET_HEADER]: SECRET });
    expect(Object.keys(req?.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('idempotency-key');
    expect(sent).toBe(blob);
    expect(opts).toEqual({ onProgress, signal: ctrl.signal });
    expect(upload.mock.calls[1]?.[0].url).toBe(`${BASE}/v1/sessions/${SID}/uploads`);
    expect(upload.mock.calls[1]?.[2]).toEqual({});
  });

  it('an upload without a stored secret sends none (the daemon answers 401)', async () => {
    const upload = vi.fn<UploadFn>(async () => REPLY);
    await apiWith(fetchOk(), upload, null).uploadCreate(SID, new Blob(['x']));
    expect(upload.mock.calls[0]?.[0].headers[DEVICE_SECRET_HEADER]).toBeUndefined();
  });

  it('removing an upload: DELETE with the device secret, no Idempotency-Key', async () => {
    const f = fetchOk({ ok: true });
    await apiWith(f).uploadDelete(SID, UPLOAD);
    const [url, init] = f.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${BASE}/v1/sessions/${SID}/uploads/${UPLOAD}`);
    expect(init?.method).toBe('DELETE');
    expect(headersOf(init)[DEVICE_SECRET_HEADER]).toBe(SECRET);
    expect(headersOf(init)['idempotency-key']).toBeUndefined();
    expect(init?.body).toBeUndefined();
  });

  it('a prompt carries attachment refs only when there are some', async () => {
    const f = fetchOk({ jobId: 'job-1', job: {} });
    const api = apiWith(f);
    const refs = [{ upload: UPLOAD, label: 'IMG_0412' }];
    await api.sendPrompt(SID, 'look at these', 'k1', { attachments: refs });
    await api.sendPrompt(SID, '', 'k2', { attachments: refs, rewriteJobId: 'rw-1' });
    await api.sendPrompt(SID, 'no files', 'k3', { attachments: [] });
    await api.sendPrompt(SID, 'plain', 'k4');
    const bodies = f.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      { text: 'look at these', onDraft: 'refuse', attachments: refs },
      { text: '', onDraft: 'refuse', rewriteJobId: 'rw-1', attachments: refs },
      { text: 'no files', onDraft: 'refuse' },
      { text: 'plain', onDraft: 'refuse' },
    ]);
  });

  it('a refusal of the daemon comes back as ApiError with its code', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'conflict', message: 'The dialog on the Mac changed. Look at it again.' } }), { status: 409 }));
    const api = createApi({ fetch: f as unknown as typeof fetch, base: BASE, credentials: credentials(SECRET) });
    await expect(api.sessionDialog(SID, { fingerprint: 'a'.repeat(64), option: 1 })).rejects.toMatchObject({ code: 'conflict', status: 409, message: 'The dialog on the Mac changed. Look at it again.' });
  });
});
