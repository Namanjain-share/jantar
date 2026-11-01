/**
 * LI5: a capture appends (O_APPEND) one line to captures.jsonl, a 0600 file
 * in a 0700 dir, and a url already on the shelf writes nothing. The line is
 * shaped like a bot's record, the shelf holds it before the reply (without
 * the CLI's folder, which stays in the file), and no text reaches the log
 * or the events.
 */
import { chmodSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LIFE_MARKER, appendIntel, captureBody, intelRecord, writeIntelJsonl } from '@jantar/fixtures';
import { IntelCaptureReplySchema } from '@jantar/protocol';
import { CAPTURE_OPEN_FLAGS, appendCapture, captureRecord } from '../../src/intel/capture.js';
import { CAPTURE_FAILED, SHELF_OFF } from '../../src/intel/service.js';
import { intelEnv, type IntelEnv } from './helpers.js';

let env: IntelEnv;
afterEach(async () => {
  await env?.cleanup();
});

const mode = (p: string) => statSync(p).mode & 0o777;
const lines = (p: string) => readFileSync(p, 'utf8').split('\n').filter((l) => l !== '');

describe('appendCapture', () => {
  it('opens append-only, never through a symlink, and makes the dir 0700 and the file 0600', async () => {
    expect(CAPTURE_OPEN_FLAGS & constants.O_APPEND).toBe(constants.O_APPEND);
    expect(CAPTURE_OPEN_FLAGS & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(CAPTURE_OPEN_FLAGS & constants.O_TRUNC).toBe(0);
    env = await intelEnv({ start: false });
    const dir = join(env.home, '.jantar', 'intel');
    await appendCapture(dir, { id: 'a', title: 'First' });
    await appendCapture(dir, { id: 'b', title: 'Second' });
    const file = join(dir, 'captures.jsonl');
    expect(lines(file).map((l) => JSON.parse(l).id)).toEqual(['a', 'b']);
    expect(mode(dir)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
  });

  it('keeps what is there and tightens a dir or file left wider', async () => {
    env = await intelEnv({ start: false });
    const dir = join(env.home, '.jantar', 'intel');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const file = join(dir, 'captures.jsonl');
    writeFileSync(file, '{"id":"old","title":"Old"}\n', { mode: 0o644 });
    await appendCapture(dir, { id: 'new', title: 'New' });
    expect(lines(file).map((l) => JSON.parse(l).id)).toEqual(['old', 'new']);
    expect(mode(dir)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
  });

  it('ends a last line left with no newline first, so the new line is its own', async () => {
    env = await intelEnv({ start: false });
    const dir = join(env.home, '.jantar', 'intel');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'captures.jsonl');
    writeFileSync(file, '{"id":"old","title":"Old"}\n{"id":"torn","title":"To');
    await appendCapture(dir, { id: 'new', title: 'New' });
    await appendCapture(dir, { id: 'next', title: 'Next' });
    expect(readFileSync(file, 'utf8')).toBe('{"id":"old","title":"Old"}\n{"id":"torn","title":"To\n{"id":"new","title":"New"}\n{"id":"next","title":"Next"}\n');
  });

  it('the record: id, time, title, url, type, tags, the note as what_it_is, via, and cwd from the Mac only', () => {
    const body = captureBody({ tags: [' example ', 'example', 'tool'] });
    expect(captureRecord('01J', '2026-10-30T10:00:00.000Z', { ...body, cwd: '/synthetic/home/work' }, { via: 'phone' })).toEqual({
      id: '01J',
      captured_at: '2026-10-30T10:00:00.000Z',
      title: 'Example capture',
      url: 'https://example.com/new',
      type: 'tool',
      tags: ['example', 'tool'],
      what_it_is: 'A synthetic capture note',
      via: 'phone',
    });
    expect(captureRecord('01J', '2026-10-30T10:00:00.000Z', { title: 'Bare', type: ' ', note: ' ' }, { via: 'cli', cwd: '/synthetic/home/work' })).toEqual({
      id: '01J',
      captured_at: '2026-10-30T10:00:00.000Z',
      title: 'Bare',
      via: 'cli',
      cwd: '/synthetic/home/work',
    });
    // v0.5.3: what `jantar mcp` saved for a Claude session, with that session's folder.
    expect(captureRecord('01J', '2026-10-30T10:00:00.000Z', { title: 'From Claude' }, { via: 'claude', cwd: '/synthetic/home/work/app' })).toEqual({
      id: '01J',
      captured_at: '2026-10-30T10:00:00.000Z',
      title: 'From Claude',
      via: 'claude',
      cwd: '/synthetic/home/work/app',
    });
  });
});

describe('capturing onto the shelf', () => {
  it('writes one line and the shelf holds it before the reply', async () => {
    env = await intelEnv();
    const r = await env.intel.capture(captureBody(), { via: 'phone' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(IntelCaptureReplySchema.safeParse(r.value).success).toBe(true);
    expect(r.value.duplicate).toBe(false);
    expect(r.value.id).toMatch(/^captures:[0-9A-HJKMNP-TV-Z]{26}$/);
    const file = join(env.home, '.jantar', 'intel', 'captures.jsonl');
    const [line] = lines(file);
    expect(JSON.parse(line ?? '')).toMatchObject({ id: r.value.id.slice('captures:'.length), title: 'Example capture', via: 'phone' });
    expect(env.intel.get(r.value.id)).toMatchObject({
      title: 'Example capture',
      url: 'https://example.com/new',
      type: 'tool',
      tags: ['example'],
      summary: 'A synthetic capture note',
      fields: [{ key: 'via', value: 'phone' }],
    });
    expect(env.intel.sources()[0]).toMatchObject({ id: 'captures', items: 1, skipped: 0 });
    expect(env.intel.sources()[0]?.updatedAt).not.toBeNull();
  });

  it('a url already on the shelf (from a source or an earlier capture) answers its id and writes nothing', async () => {
    env = await intelEnv();
    const bot = join(env.bot, 'intel.jsonl');
    await writeIntelJsonl(bot, { count: 3 });
    await env.setIntel({ sources: [bot] });
    const fromBot = await env.intel.capture(captureBody({ url: 'https://EXAMPLE.com/2' }), { via: 'phone' });
    expect(fromBot).toEqual({ ok: true, value: { id: 'intel:ex-2', duplicate: true } });
    const file = join(env.home, '.jantar', 'intel', 'captures.jsonl');
    expect(existsSync(file)).toBe(false);

    const first = await env.intel.capture(captureBody(), { via: 'cli', cwd: '/synthetic/home/work' });
    const before = readFileSync(file);
    const again = await env.intel.capture(captureBody({ title: 'Same link, other title' }), { via: 'phone' });
    expect(first.ok && again.ok && again.value).toEqual({ id: first.ok ? first.value.id : '', duplicate: true });
    expect(readFileSync(file).equals(before)).toBe(true);
    // The CLI's folder is kept in the file on the Mac, never on the shelf.
    expect(JSON.parse(readFileSync(file, 'utf8').trim())).toMatchObject({ via: 'cli', cwd: '/synthetic/home/work' });
    expect(env.intel.get(first.ok ? first.value.id : '')?.fields).toEqual([{ key: 'via', value: 'cli' }]);
  });

  it('v0.5.3: a capture via claude shows "via claude" on the shelf; its folder stays in the file', async () => {
    env = await intelEnv();
    const r = await env.intel.capture(captureBody({ title: 'Saved by a session' }), { via: 'claude', cwd: '/synthetic/home/work/zz-session' });
    const id = r.ok ? r.value.id : '';
    expect(env.intel.get(id)?.fields).toEqual([{ key: 'via', value: 'claude' }]);
    expect(env.intel.list({ q: 'zz-session', limit: 50 }).total).toBe(0);
    expect(env.intel.list({ q: 'claude', limit: 50 }).items.map((i) => i.id)).toEqual([id]);
    expect(JSON.parse(readFileSync(join(env.home, '.jantar', 'intel', 'captures.jsonl'), 'utf8').trim())).toMatchObject({ via: 'claude', cwd: '/synthetic/home/work/zz-session' });
  });

  it("a CLI capture's folder is no field on the shelf and no search finds it; another source's cwd field stays", async () => {
    env = await intelEnv();
    const bot = join(env.bot, 'intel.jsonl');
    await writeIntelJsonl(bot, { count: 1 });
    await appendIntel(bot, intelRecord(1, { id: 'with-cwd', cwd: '/synthetic/elsewhere' }));
    await env.setIntel({ sources: [bot] });
    const r = await env.intel.capture(captureBody({ title: 'From a session' }), { via: 'cli', cwd: '/synthetic/home/work/zz-folder' });
    const id = r.ok ? r.value.id : '';
    expect(env.intel.get(id)?.fields.map((f) => f.key)).toEqual(['via']);
    expect(env.intel.list({ q: 'zz-folder', limit: 50 }).total).toBe(0);
    expect(env.intel.list({ q: 'From a session', limit: 50 }).items.map((i) => i.id)).toEqual([id]);
    expect(env.intel.get('intel:with-cwd')?.fields).toContainEqual({ key: 'cwd', value: '/synthetic/elsewhere' });
  });

  it('after a torn last line, the id in the reply is on the shelf and the torn line counts as skipped', async () => {
    env = await intelEnv();
    const dir = join(env.home, '.jantar', 'intel');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'captures.jsonl'), '{"id":"torn","title":"To');
    await env.intel.refresh();
    const r = await env.intel.capture(captureBody(), { via: 'phone' });
    expect(r.ok && r.value.duplicate).toBe(false);
    expect(r.ok && env.intel.get(r.value.id)?.title).toBe('Example capture');
    expect(env.intel.sources()[0]).toMatchObject({ id: 'captures', items: 1, skipped: 1 });
  });

  it('two captures of one url at once write one line; captures without a url are never duplicates', async () => {
    env = await intelEnv();
    const [a, b] = await Promise.all([env.intel.capture(captureBody(), { via: 'phone' }), env.intel.capture(captureBody(), { via: 'phone' })]);
    expect([a.ok && a.value.duplicate, b.ok && b.value.duplicate]).toEqual([false, true]);
    await env.intel.capture({ title: 'No link' }, { via: 'phone' });
    await env.intel.capture({ title: 'No link' }, { via: 'phone' });
    expect(lines(join(env.home, '.jantar', 'intel', 'captures.jsonl'))).toHaveLength(3);
    expect(env.intel.list({ limit: 50 }).total).toBe(3);
  });

  it('says so when the shelf is off or the file cannot be written, and logs no text', async () => {
    env = await intelEnv({ intel: { enabled: false } });
    expect(await env.intel.capture(captureBody({}, { marked: true }), { via: 'phone' })).toEqual({ ok: false, code: 'unavailable', reason: SHELF_OFF });
    await env.setIntel({ enabled: true });
    // The intel dir is a file: nothing can be written there.
    mkdirSync(join(env.home, '.jantar'), { recursive: true });
    writeFileSync(join(env.home, '.jantar', 'intel'), 'not a dir');
    expect(await env.intel.capture(captureBody({}, { marked: true }), { via: 'phone' })).toEqual({ ok: false, code: 'unavailable', reason: CAPTURE_FAILED });
    const logs = JSON.stringify(env.ctx.log.records);
    expect(logs).not.toContain(LIFE_MARKER);
    expect(logs).not.toContain('example.com');
    expect(logs).toContain('intel capture not saved');
  });

  it('a marked capture reaches the shelf; the events carry nothing but life.changed {}', async () => {
    env = await intelEnv();
    const r = await env.intel.capture(captureBody({}, { marked: true }), { via: 'phone' });
    expect(r.ok && env.intel.get(r.value.id)?.title).toContain(LIFE_MARKER);
    const events = env.ctx.store.replay(0);
    expect(JSON.stringify(events)).not.toContain(LIFE_MARKER);
    expect(events.kind === 'events' && events.events.filter((e) => e.type === 'life.changed').every((e) => JSON.stringify(e.data) === '{}')).toBe(true);
  });
});
