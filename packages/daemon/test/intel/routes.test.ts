/**
 * The shelf's routes over the real pipeline: list, item, sources and
 * capture from a phone and from ctl.sock. A phone's capture is `via:
 * phone`, the CLI's keeps its folder (v0.5.3: `via: claude` from ctl.sock
 * when `jantar mcp` says so); 30 captures a minute per device or
 * CLI; the audit holds the id and whether it was a duplicate, never text;
 * no reply carries a source path; an item id with any printable character
 * round-trips through the URL.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LIFE_MARKER, captureBody, writeIntelJsonl } from '@jantar/fixtures';
import { IntelItemResponseSchema, IntelListResponseSchema, IntelSourcesResponseSchema, SettingsSchema } from '@jantar/protocol';
import { V04_LIMITS } from '../../src/api/services.js';
import { NO_SUCH_ITEM, TOO_MANY_CAPTURES } from '../../src/api/routes/intel.js';
import type { FilesService } from '../../src/contracts.js';
import { buildFilesService } from '../../src/files/service.js';
import { IntelShelfService } from '../../src/intel/service.js';
import { h, makeApi, pairCookie, type TestApi } from '../api/fakes.js';
import { writeAt } from './helpers.js';

let api: TestApi;
let base: string;
let intel: IntelShelfService;
let files: FilesService;

afterEach(async () => {
  await intel?.stop();
  await files?.stop();
  await api?.close();
  rmSync(base, { recursive: true, force: true });
});

async function shelfApi(): Promise<{ home: string; source: string }> {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ccw-intel-api-')));
  const home = join(base, 'home');
  mkdirSync(join(home, 'bot'), { recursive: true });
  const source = join(home, 'bot', 'intel.jsonl');
  await writeIntelJsonl(source, { count: 5, extras: true });
  writeAt(join(home, 'bot', 'odd.jsonl'), `${JSON.stringify({ id: 'a/b?c#d%e:f', title: 'Odd id', url: 'https://example.com/odd' })}\n`);
  const settings = SettingsSchema.parse({ intel: { enabled: true, sources: [source, join(home, 'bot', 'odd.jsonl')] } });
  api = await makeApi({
    ctx: { userHome: home, home: join(home, '.jantar'), settings },
    deps: (ctx, fakes) => {
      files = buildFilesService(ctx, { sessions: fakes.sessions, notifiers: [] });
      intel = new IntelShelfService(ctx, { files, usage: fakes.usage, ccwLegacy: fakes.ccwLegacy }, { watch: false });
      return { files, intel };
    },
  });
  await files.start();
  await intel.start();
  return { home, source };
}

describe('reading the shelf', () => {
  it('lists, opens an item, and names the sources, over TCP and ctl.sock, with no path anywhere', async () => {
    const { home } = await shelfApi();
    const { cookie } = await pairCookie(api, ['read', 'control']);
    for (const [transport, headers] of [['tcp', h(cookie)], ['ctl', {}]] as const) {
      const list = await api[transport].inject({ method: 'GET', url: '/v1/intel?type=tool&limit=10', headers });
      expect(list.statusCode, transport).toBe(200);
      const body = IntelListResponseSchema.parse(list.json());
      expect(body.items.every((i) => i.type === 'tool')).toBe(true);
      const item = await api[transport].inject({ method: 'GET', url: `/v1/intel/items/${encodeURIComponent('intel:ex-3')}`, headers });
      expect(IntelItemResponseSchema.parse(item.json()).item.title).toBe('Example tool 3');
      const sources = await api[transport].inject({ method: 'GET', url: '/v1/intel/sources', headers });
      expect(IntelSourcesResponseSchema.parse(sources.json()).sources.map((s) => s.id)).toEqual(['captures', 'intel', 'odd']);
      for (const r of [list, item, sources]) {
        expect(r.body).not.toContain(home);
        expect(r.body).not.toContain('.jsonl');
      }
    }
  });

  it('an unknown item is 404 with a fixed sentence; an id with any printable character round-trips', async () => {
    await shelfApi();
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const missing = await api.tcp.inject({ method: 'GET', url: `/v1/intel/items/${encodeURIComponent('intel:nope')}`, headers: h(cookie) });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toEqual({ code: 'not_found', message: NO_SUCH_ITEM });
    const odd = await api.tcp.inject({ method: 'GET', url: `/v1/intel/items/${encodeURIComponent('odd:a/b?c#d%e:f')}`, headers: h(cookie) });
    expect(odd.statusCode).toBe(200);
    expect(odd.json().item).toMatchObject({ id: 'odd:a/b?c#d%e:f', title: 'Odd id' });
  });

  it('a script in a title comes back as the text it is', async () => {
    await shelfApi();
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const r = await api.tcp.inject({ method: 'GET', url: `/v1/intel?q=${encodeURIComponent('<script>')}`, headers: h(cookie) });
    expect(r.json().items.map((i: { title: string }) => i.title)).toEqual(['<script>window.__pwned=1</script>']);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
  });
});

describe('capturing', () => {
  it('a phone capture is via phone; a CLI capture keeps its folder in the file only; a repeat says duplicate', async () => {
    const { home } = await shelfApi();
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const phone = await api.tcp.inject({ method: 'POST', url: '/v1/intel/captures', headers: h(cookie, { 'idempotency-key': 'k1' }), payload: captureBody() });
    expect(phone.statusCode).toBe(200);
    expect(phone.json()).toEqual({ id: expect.stringMatching(/^captures:/), duplicate: false });
    const replay = await api.tcp.inject({ method: 'POST', url: '/v1/intel/captures', headers: h(cookie, { 'idempotency-key': 'k1' }), payload: captureBody() });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(phone.json());
    const cli = await api.ctl.inject({ method: 'POST', url: '/v1/intel/captures', payload: { title: 'From a session', url: 'https://example.com/cli', cwd: '/synthetic/home/work/bot' } });
    expect(cli.json().duplicate).toBe(false);
    const again = await api.ctl.inject({ method: 'POST', url: '/v1/intel/captures', payload: { title: 'Again', url: 'https://example.com/cli' } });
    expect(again.json()).toEqual({ id: cli.json().id, duplicate: true });
    const records = readFileSync(join(home, '.jantar', 'intel', 'captures.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(records.map((r) => [r.via, r.cwd ?? null])).toEqual([
      ['phone', null],
      ['cli', '/synthetic/home/work/bot'],
    ]);
    // The folder stays on the Mac: the phone never gets it as a field.
    const item = await api.tcp.inject({ method: 'GET', url: `/v1/intel/items/${encodeURIComponent(cli.json().id)}`, headers: h(cookie) });
    expect(item.json().item.fields).toEqual([{ key: 'via', value: 'cli' }]);
    expect(item.body).not.toContain('/synthetic/home/work/bot');
  });

  it("v0.5.3: ctl.sock's via claude is written and shown; a search ranks the title first", async () => {
    const { home } = await shelfApi();
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const r = await api.ctl.inject({ method: 'POST', url: '/v1/intel/captures', payload: { title: 'Saved from a session', url: 'https://example.com/mcp', cwd: '/synthetic/home/work/app', via: 'claude' } });
    expect(r.statusCode, r.body).toBe(200);
    const records = readFileSync(join(home, '.jantar', 'intel', 'captures.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(records.map((x) => [x.via, x.cwd])).toEqual([['claude', '/synthetic/home/work/app']]);
    const item = await api.tcp.inject({ method: 'GET', url: `/v1/intel/items/${encodeURIComponent(r.json().id)}`, headers: h(cookie) });
    expect(item.json().item.fields).toEqual([{ key: 'via', value: 'claude' }]);
    // "session" is in its title only; "example" in every item: the title match comes first, then newest first.
    const list = await api.tcp.inject({ method: 'GET', url: `/v1/intel?q=${encodeURIComponent('session example')}`, headers: h(cookie) });
    expect(list.json().items.map((i: { id: string }) => i.id)).toEqual([r.json().id]);
    const best = await api.tcp.inject({ method: 'GET', url: '/v1/intel?q=example&limit=2', headers: h(cookie) });
    expect(best.json().next).toMatch(/^#2\|/);
    const older = await api.ctl.inject({ method: 'GET', url: `/v1/intel?q=example&limit=2&before=${encodeURIComponent(best.json().next)}` });
    expect(older.statusCode).toBe(200);
    expect(older.json().items.map((i: { id: string }) => i.id)).not.toContain(best.json().items[0].id);
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/intel?q=example&sort=new&limit=2', headers: h(cookie) })).json().next).toMatch(/^2026-/);
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/intel?sort=newest', headers: h(cookie) })).statusCode).toBe(400);
  });

  it('audits the id and duplicate only, never the text', async () => {
    await shelfApi();
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const first = await api.tcp.inject({ method: 'POST', url: '/v1/intel/captures', headers: h(cookie), payload: captureBody({}, { marked: true }) });
    await api.tcp.inject({ method: 'POST', url: '/v1/intel/captures', headers: h(cookie), payload: captureBody({}, { marked: true }) });
    const rows = api.ctx.db.audit.list().filter((a) => a.action === 'intelCapture');
    expect(rows.map((r) => [r.target, r.params, r.result])).toEqual([
      [first.json().id, { duplicate: false }, 'ok'],
      [first.json().id, { duplicate: true }, 'ok'],
    ]);
    expect(JSON.stringify(api.ctx.db.audit.list())).not.toContain(LIFE_MARKER);
    expect(JSON.stringify(api.ctx.log.records)).not.toContain(LIFE_MARKER);
  });

  it('30 captures a minute per device or CLI: the next is 429 with retry-after; another caller is not counted', async () => {
    await shelfApi();
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const other = await pairCookie(api, ['read', 'control']);
    expect(V04_LIMITS.intelCapture.limit).toBe(30);
    for (let i = 0; i < 30; i++) {
      const r = await api.tcp.inject({ method: 'POST', url: '/v1/intel/captures', headers: h(cookie), payload: { title: `Example ${i}` } });
      expect(r.statusCode, `capture ${i + 1}`).toBe(200);
    }
    const limited = await api.tcp.inject({ method: 'POST', url: '/v1/intel/captures', headers: h(cookie), payload: { title: 'One more' } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toEqual({ code: 'rate_limited', message: TOO_MANY_CAPTURES });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await api.tcp.inject({ method: 'POST', url: '/v1/intel/captures', headers: h(other.cookie), payload: { title: 'Other' } })).statusCode).toBe(200);
    expect((await api.ctl.inject({ method: 'POST', url: '/v1/intel/captures', payload: { title: 'Mac' } })).statusCode).toBe(200);
    api.ctx.clock.advance(60_000);
    expect((await api.tcp.inject({ method: 'POST', url: '/v1/intel/captures', headers: h(cookie), payload: { title: 'Later' } })).statusCode).toBe(200);
  });

  it('a body with a non-http link is 400 before the shelf', async () => {
    await shelfApi();
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const r = await api.tcp.inject({ method: 'POST', url: '/v1/intel/captures', headers: h(cookie), payload: { title: 'Bad', url: 'javascript:alert(1)' } });
    expect(r.statusCode).toBe(400);
    expect(intel.list({ limit: 100 }).items.some((i) => i.title === 'Bad')).toBe(false);
  });
});
