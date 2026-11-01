/**
 * Every sentence the daemon or the web app shows that names a v0.3, v0.4,
 * v0.5 or v0.5.3 jantar command ("Turn it on at your Mac: jantar files on",
 * "On your Mac run: jantar devices grant <device> launch", MAC_COMMAND's
 * "jantar folders", "jantar life on medicines", "jantar meetings on",
 * "jantar pair --extension", "jantar ask on", "jantar notify test", "jantar
 * mcp") names one that exists and does its job. The sentences are read from
 * the source, so a new one is checked as soon as it is written. A command
 * still a WP0 stub (`stub: true`) has its sentences skipped; they are
 * checked once its package drops the flag (`pair --extension` goes with
 * `meetings`: one package builds both).
 *
 * Each runs through main() against an in-memory daemon on a synthetic HOME;
 * test/integration/cli-v03.integration.test.ts runs them over the real
 * ctl.sock of a booted jantard.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import { meetingDetail } from '@jantar/fixtures';
import type { DevicePublic, LifeStatus, MeetingsStatus } from '@jantar/protocol';
import { COMMANDS, EXIT, main, memoryIo } from '../src/index.js';
import { contextFor, fakeCtl, fakeSettings, ok } from './helpers.js';

const PACKAGES = fileURLToPath(new URL('../../', import.meta.url));
const COMMAND = '(?:files|folders|launch|devices|rewrite|controls|screenshots|new|life|intel|accounts|init|meetings|ask|notify|mcp|pair(?= --extension))\\b';
/** Commands WP0 registered as stubs, until their packages build them. */
const STUBS = new Set(COMMANDS.filter((c) => c.stub).map((c) => c.name));
/** A sentence's command when another command's package builds it (v0.5: WP-MC builds `pair --extension` with `meetings`). */
const BUILT_WITH: Readonly<Record<string, string>> = { pair: 'meetings' };
/** Sentences that name a command whose argument the screen fills in (the phone's "jantar meetings export {id}"). */
const FILLED: Readonly<Record<string, string>> = { 'meetings export': 'meetings export <id>' };
/** Commands whose --help prints their own text, not the usage line (v0.5.3: `jantar mcp` prints the line that adds it to Claude Code). */
const OWN_HELP: Readonly<Record<string, string>> = { mcp: 'claude mcp add ' };
/** Commands that only read from the daemon and write files on the Mac: they get `--out` and must write something. */
const WRITES_FILES = /^meetings export\b/;
/** Words after the command: a <placeholder>, or a plain word (paths like ~/Desktop included). */
const WORDS = '(?: (?:<[a-z-]+>|[A-Za-z0-9~/._-]+))*';
const LITERAL = new RegExp(`\\bjantar (${COMMAND}${WORDS})`, 'g');
/** JSX: <code>{CLI_NAME} folders add-root ~/Desktop</code> (not a `${CLI_NAME}` template, which fills in its own words). */
const JSX = new RegExp(`(?<!\\$)\\{CLI_NAME\\} (${COMMAND}${WORDS})`, 'g');
const PLACEHOLDERS: Readonly<Record<string, string>> = {
  '<device>': 'iPhone',
  '<name>': 'iPhone',
  // v0.4
  '<module>': 'medicines',
  '<file>': 'life-2026-01-15.db',
  '<title>': 'Example',
  // v0.5: the fixtures' meeting.
  '<id>': meetingDetail().meeting.id,
  // v0.5.3
  '<group>': 'needs',
};

/**
 * What GET /v1/meetings/status answers: Meetings on and no extension the
 * first time it is asked, one paired extension every time after (the claim
 * that `jantar pair --extension` waits for).
 */
function meetingsStatus(): () => MeetingsStatus {
  let asked = 0;
  return () => {
    asked += 1;
    const extensions = asked > 1 ? [{ id: '01JFZ8X8Y3T0V5G9WQK2M4N6PT', pairedAt: '2026-01-15T10:00:00.000Z', lastSeenAt: null }] : [];
    return { on: true, open: true, meetings: 1, running: 0, shotsBytes: 2048, summary: { available: true }, extensions };
  };
}

/** What GET /v1/life/status answers on a Mac whose settings are `life`. */
function lifeStatus(life: ReturnType<typeof fakeSettings>['settings']['life']): LifeStatus {
  return {
    open: true,
    timezone: life.timezone ?? 'UTC',
    today: '2026-01-15',
    currency: life.currency,
    lockScreenDetails: life.lockScreenDetails,
    modules: { todos: life.todos, medicines: life.medicines, food: life.food, places: life.places, finance: life.finance },
    estimate: { available: false },
    backups: { last: null, count: 0 },
    push: { devices: 1, webpush: true },
  };
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** "launch mode cswap-run" -> where it is written. */
function sentences(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const pkg of ['daemon', 'protocol', 'web']) {
    for (const file of sourceFiles(join(PACKAGES, pkg, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const re of [LITERAL, JSX]) {
        for (const m of text.matchAll(re)) {
          const line = (m[1] as string).replace(/\.+$/, '');
          found.set(line, [...(found.get(line) ?? []), file.slice(PACKAGES.length)]);
        }
      }
    }
  }
  return found;
}

describe('the commands the daemon and the web app name', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
    await mkdir(join(home.home, 'Desktop'));
  });
  afterEach(async () => {
    await home.cleanup();
  });

  const found = sentences();

  it('finds the sentences (the sweep is not matching nothing)', () => {
    expect([...found.keys()]).toEqual(
      expect.arrayContaining([
        'files on',
        'launch on',
        'rewrite on',
        'controls on',
        'screenshots on',
        'screenshots allow-select',
        'devices grant <device> launch',
        'devices revoke <device>',
        'launch mode cswap-run',
        'launch mode cs-shell',
        'folders add-root ~/Desktop',
        'files',
        'folders',
        // v0.4
        'life on medicines',
        'intel on',
        'life backup',
        'life restore <file>',
        'life',
        // v0.5
        'meetings on',
        'meetings unpair',
        'meetings',
        'pair --extension',
        // v0.5.3
        'ask on',
        'ask',
        'notify test',
        'notify done on',
        'notify urgent on',
        'mcp',
      ]),
    );
  });

  for (const [said, where] of found) {
    const first = said.split(' ')[0] as string;
    const stub = STUBS.has(first) || STUBS.has(BUILT_WITH[first] ?? '');
    const line = FILLED[said] ?? said;
    it.skipIf(stub)(`jantar ${said} (${where[0]}${where.length > 1 ? ` and ${where.length - 1} more` : ''})`, async () => {
      const words = line.split(' ').map((w) => {
        if (!w.startsWith('<')) return w;
        const real = PLACEHOLDERS[w];
        if (!real) throw new Error(`no stand-in for the placeholder ${w} in "jantar ${line}": add one to PLACEHOLDERS`);
        return real;
      });
      if (words.length === 1) {
        // A pointer to the command ("change this on the Mac: jantar files"): it exists and explains itself.
        const io = memoryIo(home.env);
        expect(await main([...words, '--help'], { io }), io.stderr).toBe(EXIT.ok);
        expect(io.stdout).toContain(OWN_HELP[words[0] as string] ?? `usage: jantar ${words[0]} `);
        return;
      }
      const s = fakeSettings();
      const at = new Date(home.now).toISOString();
      const phone: DevicePublic = { id: '01JSYNTHPHONE0000000000000', name: 'iPhone', scopes: ['read', 'control'], createdAt: at, lastSeenAt: at };
      const ctl = fakeCtl({
        ...s.routes,
        'GET /v1/devices': ok({ devices: [phone] }),
        [`POST /v1/devices/${phone.id}/scopes`]: () => ok({ device: { ...phone, scopes: ['read', 'control', 'launch'] } }),
        [`DELETE /v1/devices/${phone.id}`]: () => ok({ device: { ...phone, revokedAt: at } }),
        // v0.4: Life and the shelf on ctl.sock.
        'GET /v1/life/status': () => ok(lifeStatus(s.settings.life)),
        'POST /v1/life/backup': () => ok({ file: 'life-2026-01-15.db', at }),
        'POST /v1/life/restore': () => ok({ ok: true, kept: 'life-before-restore.db' }),
        'GET /v1/intel/sources': ok({ sources: [] }),
        'POST /v1/intel/captures': () => ok({ id: 'captures:01JSYNTHCAPTURE00000000000', duplicate: false }),
        // v0.5: Meetings on ctl.sock (the export reads one meeting; pairing waits for the claim).
        'GET /v1/meetings/status': ((status) => () => ok(status()))(meetingsStatus()),
        'POST /v1/ext/pair/start': () => ok({ code: 'C0DEc0deC0DEc0deC0DEc0', port: 7420, expiresAt: new Date(home.now + 600_000).toISOString() }),
        'POST /v1/ext/unpair': () => ok({ ok: true, revoked: 1 }),
        'GET /v1/meetings': ok({ meetings: [meetingDetail().meeting], next: null, running: null }),
        [`GET /v1/meetings/${meetingDetail().meeting.id}`]: ok(meetingDetail()),
        [`GET /v1/meetings/${meetingDetail().meeting.id}/shots/${meetingDetail().shots[0]?.id}`]: ok(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
        // v0.5.3: the test push.
        'POST /v1/notify/test': () => ok({ delivered: 1, failed: 0 }),
      });
      // A person at the Mac answers yes when a command asks (life restore asks before it replaces life.db).
      const { ctx, io } = contextFor(home, { ctl, ioOptions: { answers: ['y', 'y', 'y'] } });
      const out = join(home.home, 'exports');
      const argv = WRITES_FILES.test(line) ? [...words, '--out', out] : words;
      expect(await main(argv, { io, context: ctx }), `${io.stdout}${io.stderr}`).toBe(EXIT.ok);
      if (WRITES_FILES.test(line)) expect((await readdir(out)).length, 'the command wrote nothing').toBeGreaterThan(0);
      else expect(ctl.calls.some((c) => c.method !== 'GET'), 'the command changed nothing').toBe(true);
      expect(io.stderr).toBe('');
    });
  }
});
