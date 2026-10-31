// @vitest-environment node
/**
 * The v0.3 calls of the API client: paths and queries from the route table,
 * the rewrite job id on a send, and the two byte routes (screenshots, raw
 * files) that answer with a Blob but still fail with the daemon's JSON error.
 */
import { describe, expect, it, vi } from 'vitest';
import { SCREENSHOT_AT_HEADER, SCREENSHOT_DISTURBED_HEADER, SCREENSHOT_SIZE_HEADER } from '@jantar/protocol';
import { ApiError, createApi } from '../src/lib/api.js';

const BASE = 'http://127.0.0.1:7420';

function fetchReturning(status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  const payload = (): BodyInit =>
    typeof body === 'string' ? body : body instanceof Uint8Array ? new Blob([new Uint8Array(body)]) : JSON.stringify(body);
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(payload(), { status, headers }));
}

const apiWith = (f: ReturnType<typeof fetchReturning>) => createApi({ fetch: f as unknown as typeof fetch, base: BASE });

describe('v0.3 api client', () => {
  it('sends a prompt with its rewrite job id, and leaves it out otherwise', async () => {
    const f = fetchReturning(202, { jobId: 'j', job: {} });
    const api = apiWith(f);
    await api.sendPrompt('s1', 'Fix the test', 'key-1', { rewriteJobId: 'rw-1' });
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({ text: 'Fix the test', onDraft: 'refuse', rewriteJobId: 'rw-1' });
    await api.sendPrompt('s1', 'hello', 'key-2');
    expect(JSON.parse(String(f.mock.calls[1]![1]?.body))).toEqual({ text: 'hello', onDraft: 'refuse' });
  });

  it('starts, reads and cancels a rewrite', async () => {
    const f = fetchReturning(202, { jobId: 'rw-1', job: {} });
    const api = apiWith(f);
    await api.rewriteStart('s 1', 'haan toh fix it', { model: 'sonnet' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/v1/sessions/s%201/rewrite`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'haan toh fix it', model: 'sonnet' });
    expect((init?.headers as Record<string, string>)['idempotency-key']).toMatch(/.{16,}/);
    await api.rewriteGet('rw-1');
    expect(f.mock.calls[1]![0]).toBe(`${BASE}/v1/rewrite/rw-1`);
    await api.rewriteCancel('rw-1');
    expect(f.mock.calls[2]![1]?.method).toBe('DELETE');
  });

  it('puts file and folder places in the query string, booleans as 0 / 1', async () => {
    const f = fetchReturning(200, {});
    const api = apiWith(f);
    await api.filesList({ root: 'r.work', path: 'src/a b', hidden: true });
    expect(f.mock.calls[0]![0]).toBe(`${BASE}/v1/files/list?root=r.work&path=src%2Fa+b&hidden=1`);
    await api.filesText({ root: 's.abc', path: 'README.md', offset: 524288 });
    expect(f.mock.calls[1]![0]).toBe(`${BASE}/v1/files/text?root=s.abc&path=README.md&offset=524288`);
    await api.foldersList({ root: 'r.work', showHidden: false });
    expect(f.mock.calls[2]![0]).toBe(`${BASE}/v1/folders?root=r.work&showHidden=0`);
    await api.launchPreview({ root: 'r.work', path: 'foo', account: 'auto', flags: { chrome: false, effort: 'high' } });
    expect(f.mock.calls[3]![0]).toBe(`${BASE}/v1/launch/preview?root=r.work&path=foo&account=auto&chrome=0&effort=high`);
    expect(api.filesRawUrl({ root: 'r.work', path: 'img/a.png' })).toBe(`${BASE}/v1/files/raw?root=r.work&path=img%2Fa.png`);
  });

  it('starts a launch with the Idempotency-Key it was given', async () => {
    const f = fetchReturning(202, { job: {} });
    const api = apiWith(f);
    const body = { root: 'r.work', path: 'foo', account: 'auto' as const, flags: { permission: 'manual' as const, chrome: false, effort: 'default' as const, model: 'default' as const } };
    await api.launchStart(body, 'hold-123');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/v1/launches`);
    expect(JSON.parse(String(init?.body))).toEqual(body);
    expect((init?.headers as Record<string, string>)['idempotency-key']).toBe('hold-123');
  });

  it('reads a screenshot as a Blob with its capture headers', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const f = fetchReturning(200, png, {
      'content-type': 'image/png',
      etag: '"abc"',
      [SCREENSHOT_AT_HEADER]: '2026-10-30T10:00:00.000Z',
      [SCREENSHOT_SIZE_HEADER]: '1600x1000',
      [SCREENSHOT_DISTURBED_HEADER]: '0',
    });
    const api = apiWith(f);
    const shot = await api.screenshot('s1', { max: 1200, select: false });
    expect(f.mock.calls[0]![0]).toBe(`${BASE}/v1/sessions/s1/screenshot?max=1200&select=0`);
    expect(f.mock.calls[0]![1]).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect(shot).toMatchObject({ at: '2026-10-30T10:00:00.000Z', width: 1600, height: 1000, disturbed: false, etag: '"abc"' });
    expect(new Uint8Array(await shot.blob.arrayBuffer())).toEqual(png);
  });

  it("fails a byte route with the daemon's error code", async () => {
    const api = apiWith(fetchReturning(409, { error: { code: 'tab_not_visible', message: 'another tab is showing in that window' } }));
    const e = await api.screenshot('s1').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ code: 'tab_not_visible', status: 409 });
    const raw = apiWith(fetchReturning(415, 'nope', { 'content-type': 'text/plain' }));
    expect(await raw.filesRaw({ root: 'r.work', path: 'x.png' }).catch((x: unknown) => x)).toMatchObject({ code: 'unsupported_media_type', status: 415 });
  });
});
