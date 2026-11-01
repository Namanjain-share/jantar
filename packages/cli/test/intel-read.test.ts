/**
 * jantar intel's v0.8 verbs (spec 11) against a fake ctl.sock: `save`
 * (POST /v1/intel/reads with an Idempotency-Key; reading off saves nothing),
 * `jobs`, `retry`, `delete`, `read on|off|status|speech`; `add` stays 0.7's
 * plain capture whatever the switch. Usage errors never reach the daemon.
 * Synthetic links and titles only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import { INTEL_READ_LIMITS, INTEL_READ_REASONS, type IntelJobsResponse, type IntelReadStatus } from '@jantar/protocol';
import intel, { READ_NEEDS_SHELF, READ_OFF_SENTENCE, READ_ON_SENTENCE } from '../src/commands/intel.js';
import { EXIT } from '../src/command.js';
import { contextFor, fail, fakeCtl, fakeSettings, ok, type CtlCall } from './helpers.js';

let home: FakeHome;
beforeEach(async () => {
  home = await makeFakeHome({ sessions: [] });
});
afterEach(async () => {
  await home.cleanup();
});

const ID = 'captures:01JSYNTHCAPTURE00000000000';

function daemon(start: Record<string, unknown> = {}, routes: Parameters<typeof fakeCtl>[0] = {}) {
  const s = fakeSettings(start);
  return { s, ctl: fakeCtl({ ...s.routes, ...routes }) };
}

async function run(args: string[], ctl: ReturnType<typeof fakeCtl>) {
  const c = contextFor(home, { ctl });
  const code = await intel.run(args, c.ctx);
  return { code, out: c.io.stdout, err: c.io.stderr };
}

function status(over: Partial<IntelReadStatus> = {}): IntelReadStatus {
  return {
    on: true,
    canRun: true,
    chrome: { paired: true, lastPollAt: '2026-11-02T10:00:00.000Z' },
    browser: { found: true },
    ytdlp: { found: true, version: '2026.10.22' },
    clt: { found: true },
    helper: { built: true },
    sandbox: { found: true },
    speech: { locale: 'en-IN', onDevice: true },
    today: { reads: 3, full: 1, perDay: INTEL_READ_LIMITS.perDay, fullPerDay: INTEL_READ_LIMITS.fullPerDay },
    queue: { waiting: 1, running: 1 },
    captureKeys: 1,
    door: { open: false, url: null, why: 'The door is closed: remote mode is loopback (it needs tailscale or cloudflare).' },
    ...over,
  };
}

describe('save', () => {
  it('sends the text and depth with an Idempotency-Key and prints the daemon\'s sentence; a duplicate adds nothing', async () => {
    const calls: CtlCall[] = [];
    let duplicate = false;
    const { ctl } = daemon({}, {
      'POST /v1/intel/reads': (call) => {
        calls.push(call);
        const r = ok({ id: ID, duplicate, queued: !duplicate, message: duplicate ? 'Already saved.' : 'Saved. Reading it on your Mac.' });
        duplicate = true;
        return r;
      },
    });
    const r = await run(['save', 'https://www.instagram.com/reel/AbC123xyz/', 'for', 'sunday', '--depth', 'Full'], ctl);
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(calls[0]?.body).toEqual({ text: 'https://www.instagram.com/reel/AbC123xyz/ for sunday', depth: 'full' });
    expect(calls[0]?.opts.idempotencyKey).toMatch(/^id-/);
    expect(r.out).toBe(`Saved. Reading it on your Mac. ${ID}\n`);
    const again = await run(['save', 'https://www.instagram.com/reel/AbC123xyz/'], ctl);
    expect(again.out).toBe(`Already saved (${ID}): nothing added.\n`);
    expect(calls[1]?.body).toEqual({ text: 'https://www.instagram.com/reel/AbC123xyz/' });
  });

  it('reading off: the daemon\'s off sentence, and nothing is saved', async () => {
    const { ctl } = daemon({}, { 'POST /v1/intel/reads': fail('forbidden', INTEL_READ_REASONS.off, 403) });
    const r = await run(['save', 'https://example.com/a'], ctl);
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toContain('jantar intel read on');
  });

  it('usage errors never reach the daemon', async () => {
    const { ctl } = daemon();
    for (const [args, why] of [
      [['save'], 'save needs a link or some text'],
      [['save', 'x'.repeat(INTEL_READ_LIMITS.textMax + 1)], `at most ${INTEL_READ_LIMITS.textMax}`],
      [['save', 'https://example.com', '--depth', 'deep'], '--depth must be light, standard or full'],
      [['save', 'https://example.com', '--url', 'https://example.com'], '--url is not for "intel save"'],
      [['jobs', 'extra'], 'jobs takes no argument'],
      [['retry'], 'retry needs an item id'],
      [['retry', 'a', 'b'], 'retry takes one item id'],
      [['retry', 'has space', '--depth', 'light'], 'is not an item id'],
      [['delete'], 'delete needs an item id'],
      [['read'], 'read needs on, off, status or speech'],
      [['read', 'maybe'], 'unknown read action'],
      [['read', 'on', 'now'], 'read on takes no argument'],
      [['read', 'speech'], 'read speech needs a language'],
      [['read', 'speech', 'english'], 'the language looks like en-IN'],
    ] as [string[], string][]) {
      const r = await run(args, ctl);
      expect(r.code, args.join(' ')).toBe(EXIT.usage);
      expect(r.err, args.join(' ')).toContain(why);
    }
    expect(ctl.calls.filter((c) => c.path.startsWith('/v1/intel'))).toEqual([]);
  });

  it('a down daemon exits 3', async () => {
    const down = contextFor(home);
    expect(await intel.run(['save', 'https://example.com/a'], down.ctx)).toBe(EXIT.daemonDown);
  });
});

describe('jobs, retry, delete', () => {
  it('jobs: one line a job (state in words, depth, platform, title or host, id, reason)', async () => {
    const reply: IntelJobsResponse = {
      jobs: [
        { id: ID, title: 'Instagram reel', url: 'https://www.instagram.com/reel/AbC123xyz/', platform: 'instagram', depth: 'standard', state: 'fetching', tier: 'chrome', queuedAt: '2026-11-02T10:00:00.000Z', startedAt: '2026-11-02T10:00:01.000Z' },
        { id: 'captures:01JSYNTHCAPTURE00000000001', title: '', url: 'https://www.example.test/post', platform: 'web', depth: 'light', state: 'failed', reason: INTEL_READ_REASONS.notFound, queuedAt: '2026-11-02T09:00:00.000Z', endedAt: '2026-11-02T09:00:05.000Z' },
      ],
      reading: { on: true, canRun: true },
    };
    const { ctl } = daemon({}, { 'GET /v1/intel/jobs': ok(reply) });
    const r = await run(['jobs'], ctl);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain(`opening (chrome)  standard  instagram  Instagram reel  ${ID}`);
    expect(r.out).toContain(`couldn't read  light  web  example.test  captures:01JSYNTHCAPTURE00000000001: ${INTEL_READ_REASONS.notFound}`);
  });

  it('jobs with reading off says why; none at all says so', async () => {
    const { ctl } = daemon({}, { 'GET /v1/intel/jobs': ok({ jobs: [], reading: { on: false, canRun: false, why: INTEL_READ_REASONS.off } }) });
    const r = await run(['jobs'], ctl);
    expect(r.out).toBe(`${INTEL_READ_REASONS.off}\nNo reads waiting, running or finished today.\n`);
  });

  it('retry and delete call the item\'s routes with its id in the path and an Idempotency-Key', async () => {
    const enc = encodeURIComponent(ID);
    const { ctl } = daemon({}, { [`POST /v1/intel/items/${enc}/read`]: ok({ id: ID }), [`DELETE /v1/intel/items/${enc}`]: ok({ ok: true }) });
    const retry = await run(['retry', ID, '--depth', 'light'], ctl);
    expect(retry.out).toBe('Reading it again (light): see jantar intel jobs\n');
    const del = await run(['delete', ID], ctl);
    expect(del.out).toBe(`Deleted ${ID} and its pictures.\n`);
    const calls = ctl.calls.filter((c) => c.path.startsWith('/v1/intel/items'));
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', `/v1/intel/items/${enc}/read`, { depth: 'light' }],
      ['DELETE', `/v1/intel/items/${enc}`, undefined],
    ]);
    expect(calls.every((c) => /^id-/.test(c.opts.idempotencyKey ?? ''))).toBe(true);
  });

  it('a Retry refused by the daemon says its sentence', async () => {
    const enc = encodeURIComponent(ID);
    const { ctl } = daemon({}, { [`POST /v1/intel/items/${enc}/read`]: fail('conflict', 'It is being read now.', 409) });
    const r = await run(['retry', ID], ctl);
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toContain('It is being read now.');
  });
});

describe('read on | off | status | speech', () => {
  it('on says what leaves the Mac; with the shelf off it says how to turn that on too; off says nothing is read', async () => {
    const { s, ctl } = daemon({ intel: { enabled: true } });
    const on = await run(['read', 'on'], ctl);
    expect(on.code).toBe(EXIT.ok);
    expect(s.settings.intel.read).toBe(true);
    expect(on.out).toBe(READ_ON_SENTENCE);
    const off = await run(['read', 'off'], ctl);
    expect(off.out).toBe(READ_OFF_SENTENCE);
    expect(s.settings.intel.read).toBe(false);
    const shelfOff = daemon();
    const r = await run(['read', 'on'], shelfOff.ctl);
    expect(r.out).toContain(READ_NEEDS_SHELF);
  });

  it('status lists what reading can use on this Mac', async () => {
    const { ctl } = daemon({}, { 'GET /v1/intel/read/status': ok(status()) });
    const r = await run(['read', 'status'], ctl);
    expect(r.code).toBe(EXIT.ok);
    for (const line of [
      'Reading links: on',
      'Chrome (the extension): paired, last asked 2026-11-02T10:00:00.000Z',
      'Headless browser (Google Chrome): found',
      'yt-dlp (optional): found (2026.10.22)',
      'Command Line Tools: found',
      'Media helper: built',
      'sandbox-exec: found',
      'Speech: en-IN (on this Mac)',
      `Today: 3 of ${INTEL_READ_LIMITS.perDay} reads, 1 of ${INTEL_READ_LIMITS.fullPerDay} Full`,
      'Queue: 1 waiting, 1 running',
      'Shortcut keys: 1',
      'Shortcut door: closed (The door is closed: remote mode is loopback (it needs tailscale or cloudflare).)',
    ]) {
      expect(r.out).toContain(line);
    }
  });

  it('status with the daemon down reads the local settings', async () => {
    const c = contextFor(home);
    expect(await intel.run(['read', 'status'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toContain('the daemon is not running');
  });

  it('speech: kept when this Mac recognises it on device, put back when it does not', async () => {
    let onDevice: boolean | null = true;
    const { s, ctl } = daemon({}, { 'GET /v1/intel/read/status': () => ok(status({ speech: { locale: s.settings.intel.speechLocale, onDevice } })) });
    const yes = await run(['read', 'speech', 'en-US'], ctl);
    expect(yes.code, yes.err).toBe(EXIT.ok);
    expect(yes.out).toBe('Speech-to-text language: en-US (on this Mac).\n');
    expect(s.settings.intel.speechLocale).toBe('en-US');
    onDevice = false;
    const no = await run(['read', 'speech', 'hi-IN'], ctl);
    expect(no.code).toBe(EXIT.failed);
    expect(no.err).toContain('hi-IN is not recognised on this Mac');
    expect(s.settings.intel.speechLocale).toBe('en-US');
    onDevice = null;
    const later = await run(['read', 'speech', 'en-GB'], ctl);
    expect(later.out).toBe('Speech-to-text language: en-GB (checked when the Mac first reads speech).\n');
  });
});

describe('add stays a plain capture', () => {
  it('whatever the reading switch, add sends a capture (never a read)', async () => {
    const { ctl } = daemon({ intel: { enabled: true, read: true } }, { 'POST /v1/intel/captures': ok({ id: ID, duplicate: false }) });
    const r = await run(['add', 'Example', '--url', 'https://www.instagram.com/reel/AbC123xyz/'], ctl);
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(ctl.calls.map((c) => `${c.method} ${c.path}`)).toContain('POST /v1/intel/captures');
    expect(ctl.calls.some((c) => c.path === '/v1/intel/reads')).toBe(false);
  });
});
