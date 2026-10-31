/**
 * jantar pair --extension (v0.5 spec 4.13) against an in-memory daemon: it
 * notes the extensions already paired, starts a one-time extension code,
 * prints `jantar-ext:<port>:<code>` on its own line, asks every second until
 * an extension id it had not seen appears ("Paired.") or the code expires
 * (on the fake clock), and refuses the phone's flags. The phone's own
 * pairing stays as it was (commands.test.ts). The run against the daemon's
 * real API is in meetings.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { EXTENSION_PAIR_PREFIX, type MeetingsStatus } from '@jantar/protocol';
import pair from '../src/commands/pair.js';
import { PAIR_WAIT_EVERY_MS } from '../src/commands/meetings.js';
import { EXIT } from '../src/command.js';
import { main } from '../src/index.js';
import { memoryIo } from '../src/io.js';
import { T0, contextFor, fakeCtl, ok, testDeps } from './helpers.js';

const ENV = { HOME: '/synthetic/home', JANTAR_HOME: '/synthetic/state' };
const CODE = 'C0DEc0deC0DEc0deC0DEc0';
const OLD = { id: '01JFZ8X8Y3T0V5G9WQK2M4N7E1', pairedAt: '2026-01-10T10:00:00.000Z', lastSeenAt: '2026-01-15T09:00:00.000Z' };
const NEW = { id: '01JFZ8X8Y3T0V5G9WQK2M4N7E2', pairedAt: '2026-01-15T10:00:05.000Z', lastSeenAt: null };

function status(extensions: MeetingsStatus['extensions'], on = true): MeetingsStatus {
  return { on, open: on, meetings: 0, running: 0, shotsBytes: 0, summary: { available: true }, extensions };
}

/**
 * A daemon whose status lists `before` until the status has been asked
 * `claimAfter` times, then `before` plus NEW (the extension's claim). Never
 * claims when `claimAfter` is null.
 */
function daemon(opts: { before?: MeetingsStatus['extensions']; claimAfter?: number | null; on?: boolean; port?: number | null; expiresAt?: string } = {}) {
  const before = opts.before ?? [];
  const claimAfter = opts.claimAfter === undefined ? 2 : opts.claimAfter;
  let asked = 0;
  const ctl = fakeCtl({
    'GET /v1/meetings/status': () => {
      asked += 1;
      const claimed = claimAfter !== null && asked > claimAfter;
      return ok(status(claimed ? [...before, NEW] : before, opts.on ?? true));
    },
    'POST /v1/ext/pair/start': () =>
      ok({ code: CODE, port: opts.port === undefined ? 7420 : opts.port, expiresAt: opts.expiresAt ?? new Date(T0 + 600_000).toISOString() }),
  });
  return { ctl, asked: () => asked };
}

/** testDeps whose sleep records each wait (and moves the fake clock by it). */
function sleepyDeps() {
  const waits: number[] = [];
  const deps = testDeps();
  const step = deps.sleep;
  deps.sleep = async (ms: number) => {
    waits.push(ms);
    await step(ms);
  };
  return { deps, waits };
}

describe('jantar pair --extension', () => {
  it('reads the status, starts the code, prints the line on its own, waits and says "Paired."', async () => {
    const { ctl } = daemon({ claimAfter: 2 });
    const { deps, waits } = sleepyDeps();
    const c = contextFor({ env: ENV }, { ctl, deps });
    expect(await pair.run(['--extension'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toBe(
      'In Chrome, click the Jantar icon and paste:\n' +
        '\n' +
        `${EXTENSION_PAIR_PREFIX}:7420:${CODE}\n` +
        '\n' +
        'It works once, within 10 minutes.\n' +
        'Waiting for the extension (Ctrl-C stops waiting; the code still works).\n' +
        'Paired.\n',
    );
    expect(c.io.stderr).toBe('');
    // The status once before the code, then once a second until the claim.
    expect(ctl.calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /v1/meetings/status',
      'POST /v1/ext/pair/start',
      'GET /v1/meetings/status',
      'GET /v1/meetings/status',
    ]);
    expect(waits).toEqual([PAIR_WAIT_EVERY_MS, PAIR_WAIT_EVERY_MS]);
    expect(PAIR_WAIT_EVERY_MS).toBe(1_000);
    expect(ctl.calls[1]?.opts.idempotencyKey).toBeTruthy();
  });

  it('the pairing line is what the popup parses', async () => {
    const { ctl } = daemon({ port: 51234 });
    const c = contextFor({ env: ENV }, { ctl });
    await pair.run(['--extension'], c.ctx);
    const lines = c.io.stdout.split('\n').filter((l) => l.startsWith(EXTENSION_PAIR_PREFIX));
    expect(lines).toEqual([`jantar-ext:51234:${CODE}`]);
    expect(lines[0]).toMatch(/^jantar-ext:(\d{2,5}):([A-Za-z0-9_-]{16,128})$/);
  });

  it('an extension paired before does not count: only a new id is the claim', async () => {
    const { ctl, asked } = daemon({ before: [OLD], claimAfter: 5 });
    const { deps, waits } = sleepyDeps();
    const c = contextFor({ env: ENV }, { ctl, deps });
    expect(await pair.run(['--extension'], c.ctx)).toBe(EXIT.ok);
    expect(asked()).toBe(6);
    expect(waits).toHaveLength(5);
    expect(c.io.stdout.endsWith('Paired.\n')).toBe(true);
  });

  it('with Meetings off it says so, and still pairs', async () => {
    const { ctl } = daemon({ on: false });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await pair.run(['--extension'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toContain('It works once, within 10 minutes.\nMeetings are off: jantar meetings on\n');
    expect(c.io.stdout.endsWith('Paired.\n')).toBe(true);
  });

  it('when the code expires unclaimed: the expiry sentence and exit 1 (fake clock)', async () => {
    const { ctl, asked } = daemon({ claimAfter: null });
    const { deps, waits } = sleepyDeps();
    const c = contextFor({ env: ENV }, { ctl, deps });
    expect(await pair.run(['--extension'], c.ctx)).toBe(EXIT.failed);
    expect(c.io.stderr).toBe('jantar pair: The code expired. Run jantar pair --extension again.\n');
    expect(c.io.stdout).not.toContain('Paired.');
    // Ten minutes of one-second waits, each followed by one more look.
    expect(waits).toHaveLength(600);
    expect(asked()).toBe(601);
    expect(deps.now()).toBe(T0 + 600_000);
  });

  it('an expiry that does not parse still waits the ten minutes, not one look', async () => {
    const { ctl, asked } = daemon({ claimAfter: null, expiresAt: 'soon' });
    const { deps, waits } = sleepyDeps();
    const c = contextFor({ env: ENV }, { ctl, deps });
    expect(await pair.run(['--extension'], c.ctx)).toBe(EXIT.failed);
    expect(c.io.stderr).toBe('jantar pair: The code expired. Run jantar pair --extension again.\n');
    expect(waits).toHaveLength(600);
    expect(asked()).toBe(601);
  });

  it('a claim in the last second still counts', async () => {
    const { ctl } = daemon({ claimAfter: 600 });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await pair.run(['--extension'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout.endsWith('Paired.\n')).toBe(true);
  });

  it('refuses the phone\'s flags (a usage error, naming the flag as typed) and asks the daemon nothing', async () => {
    for (const flag of ['--admin', '--read-only', '--name=phone', '--json', '--qr', '--no-qr']) {
      const { ctl } = daemon();
      const c = contextFor({ env: ENV }, { ctl });
      expect(await pair.run(['--extension', flag], c.ctx), flag).toBe(EXIT.usage);
      expect(c.io.stderr, flag).toContain(`jantar pair: ${flag.replace(/=.*$/, '')} does not go with --extension\n`);
      expect(ctl.calls, flag).toEqual([]);
    }
  });

  it('fails when the daemon has no TCP port for the extension to reach', async () => {
    const { ctl } = daemon({ port: null });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await pair.run(['--extension'], c.ctx)).toBe(EXIT.failed);
    expect(c.io.stderr).toContain('not listening on a TCP port');
    expect(c.io.stdout).not.toContain(EXTENSION_PAIR_PREFIX);
  });

  it('exits 3 when the daemon is down', async () => {
    const c = contextFor({ env: ENV });
    expect(await pair.run(['--extension'], c.ctx)).toBe(EXIT.daemonDown);
    expect(c.io.stderr).toContain('jantard is not running');
  });

  it('runs through main(), and pair --help names it', async () => {
    const { ctl } = daemon();
    const io = memoryIo(ENV);
    const { ctx } = contextFor({ env: ENV }, { ctl, io });
    expect(await main(['pair', '--extension'], { io, context: ctx })).toBe(EXIT.ok);
    expect(io.stdout.endsWith('Paired.\n')).toBe(true);
    const help = memoryIo(ENV);
    expect(await main(['pair', '--help'], { io: help })).toBe(EXIT.ok);
    expect(help.stdout).toContain('jantar pair --extension');
  });

  it('the phone pairing is unchanged: no status read, no wait', async () => {
    const ctl = fakeCtl({ 'POST /v1/pair/start': ok({ code: 'c'.repeat(22), url: `https://mac.tailnet-0000.ts.net/pair#c=${'c'.repeat(22)}`, expiresAt: '2026-01-15T10:10:00.000Z' }) });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await pair.run(['--no-qr'], c.ctx)).toBe(EXIT.ok);
    expect(ctl.calls.map((x) => `${x.method} ${x.path}`)).toEqual(['POST /v1/pair/start']);
    expect(c.io.stdout).not.toContain(EXTENSION_PAIR_PREFIX);
  });
});
