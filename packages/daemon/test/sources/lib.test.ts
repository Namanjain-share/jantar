import { describe, expect, it } from 'vitest';
import { defaultAccounts, formatLstart, profileDirName, sequenceJson, slugifyEmail as fixtureSlug } from '@jantar/fixtures';
import { accountForProfileDir, parseSequence, slugifyEmail } from '../../src/sources/lib/cswap-files.js';
import { parseLstart, parsePsRows, sameProcessStart } from '../../src/sources/lib/lstart.js';
import { Serial } from '../../src/sources/lib/serial.js';
import { headline, toolDesc } from '../../src/sources/lib/text.js';
import { clip, toEpochMs, toIso } from '../../src/sources/lib/values.js';
import { isHeadless, parseSessionFile } from '../../src/sources/claude-files/discover.js';

describe('lstart', () => {
  it('parses ps lstart in UTC or local time', () => {
    expect(parseLstart('Thu Jan 15 09:00:00 2026')).toBe(Date.parse('2026-01-15T09:00:00Z'));
    expect(parseLstart('Mon Feb  2 23:59:59 2026')).toBe(Date.parse('2026-02-02T23:59:59Z'));
    expect(parseLstart('Thu Jan 15 09:00:00 2026', 'local')).toBe(new Date(2026, 0, 15, 9, 0, 0).getTime());
    const ms = Date.parse('2026-07-04T18:30:05Z');
    expect(parseLstart(formatLstart(ms))).toBe(ms);
    for (const bad of ['', 'yesterday', 'Thu Foo 15 09:00:00 2026', 'Thu Jan 15 25:00:00 2026', undefined]) {
      expect(parseLstart(bad)).toBeNull();
    }
  });

  it('matches start times within 5 s, fails open without a procStart', () => {
    const t = Date.parse('2026-01-15T09:00:00Z');
    expect(sameProcessStart('Thu Jan 15 09:00:00 2026', t + 2000)).toBe(true);
    expect(sameProcessStart('Thu Jan 15 09:00:00 2026', t + 60_000)).toBe(false);
    expect(sameProcessStart('', t)).toBe(true);
    expect(sameProcessStart('garbage', t)).toBe(true);
    // a procStart written in local time still matches
    expect(sameProcessStart('Thu Jan 15 09:00:00 2026', new Date(2026, 0, 15, 9, 0, 1).getTime())).toBe(true);
  });

  it('parses `ps -o pid=,tty=,lstart=` rows as macOS prints them', () => {
    const out = '    1 ??       Fri Oct 16 10:33:00 2026    \n41001 ttys001  Thu Jan 15 09:00:00 2026\n\nps: junk\n';
    expect(parsePsRows(out)).toEqual([
      { pid: 1, startMs: Date.parse('2026-10-16T10:33:00Z') },
      { pid: 41001, tty: 'ttys001', startMs: Date.parse('2026-01-15T09:00:00Z') },
    ]);
  });
});

describe('cswap files', () => {
  it('slugifies like cswap', () => {
    expect(slugifyEmail('a.b+c@sub-x.example.com')).toBe('a.b_c_sub-x.example.com');
    expect(slugifyEmail('jö@x.de')).toBe('j__x.de');
    expect(slugifyEmail('x@y.z')).toBe(fixtureSlug('x@y.z'));
  });

  it('parses sequence.json', () => {
    const seq = parseSequence(sequenceJson(defaultAccounts(), Date.parse('2026-01-15T10:00:00Z'), 2));
    expect(seq?.active).toBe(2);
    expect(seq?.order).toEqual([1, 2, 3, 4]);
    expect(seq?.accounts.get(2)).toMatchObject({ alias: 'team-b', email: 'bravo@example.com' });
    expect(seq?.accounts.get(3)?.disabled).toBe(true);
    expect(parseSequence({ nope: 1 })).toBeNull();
    expect(parseSequence({ accounts: { x: {}, '5': { email: 'e@example.net', kind: 'api_key' } } })?.accounts.get(5)?.kind).toBe('api_key');
  });

  it('maps profile dirs to slots, also after a renumbering', () => {
    const seq = parseSequence(sequenceJson(defaultAccounts(), 0));
    expect(accountForProfileDir(profileDirName(2, 'bravo@example.com'), seq)).toBe(2);
    // the dir says 7, but that address now lives in slot 3
    expect(accountForProfileDir(`7-${slugifyEmail('charlie@example.org')}`, seq)).toBe(3);
    // slot 2's dir with another address that no slot has: still slot 2 (the prefix is what makes dirs unique)
    expect(accountForProfileDir('2-someone_else.com', seq)).toBe(2);
    expect(accountForProfileDir('9-ghost_example.com', seq)).toBeNull();
    expect(accountForProfileDir('9-ghost_example.com', null)).toBe(9);
    expect(accountForProfileDir('not-a-profile', seq)).toBeNull();
  });
});

describe('session files', () => {
  it('validates the fields it uses', () => {
    expect(parseSessionFile({ pid: 5, sessionId: 's' })).toEqual({ sid: 's', pid: 5, procStart: '', cwd: '', entrypoint: 'cli', rawStatus: 'idle' });
    expect(parseSessionFile({ pid: '5', sessionId: 's' })).toBeNull();
    expect(parseSessionFile({ pid: 5 })).toBeNull();
    expect(parseSessionFile([])).toBeNull();
    const full = parseSessionFile({ pid: 5, sessionId: 's', status: 'busy', statusUpdatedAt: 10, updatedAt: -1, waitingFor: '', name: 'n' });
    expect(full).toMatchObject({ rawStatus: 'busy', statusUpdatedAt: 10, name: 'n' });
    expect(full?.updatedAt).toBeUndefined();
    expect(full?.waitingFor).toBeUndefined();
    expect(isHeadless('sdk-cli')).toBe(true);
    expect(isHeadless('sdk-ts')).toBe(true);
    expect(isHeadless('cli')).toBe(false);
  });
});

describe('text and values', () => {
  it('picks the line worth showing', () => {
    expect(headline('# Summary\n- did a thing\n\nShall I push it?')).toBe('Shall I push it?');
    expect(headline('**Done.** All `tests` pass.\n---')).toBe('Done. All tests pass.');
    expect(headline('')).toBe('');
  });

  it('describes tools', () => {
    expect(toolDesc('Bash', { command: 'npm test\nmore', description: '' })).toBe('Bash · npm test');
    expect(toolDesc('Read', { file_path: '/a/b/c.ts' })).toBe('Read · c.ts');
    expect(toolDesc('mcp__srv__do_it', {})).toBe('srv·do_it');
    expect(toolDesc('ExitPlanMode', {})).toBe('plan ready for your approval');
    expect(toolDesc('AskUserQuestion', { questions: [{ question: 'Which DB?' }] })).toBe('asks · Which DB?');
  });

  it('reads times in seconds, milliseconds or ISO, and rejects nonsense', () => {
    expect(toEpochMs(1768471200)).toBe(1768471200_000);
    expect(toEpochMs(1768471200_000)).toBe(1768471200_000);
    expect(toIso('2026-01-15T12:10:00.123456+00:00')).toBe('2026-01-15T12:10:00.123Z');
    expect(toEpochMs(5)).toBeUndefined();
    expect(toEpochMs('soon')).toBeUndefined();
    expect(clip('abcdef', 4)).toBe('abc…');
  });
});

describe('Serial', () => {
  it('runs one at a time and gives late callers a fresh run', async () => {
    let runs = 0;
    let active = 0;
    let max = 0;
    const s = new Serial(async () => {
      active += 1;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return ++runs;
    });
    const results = await Promise.all([s.run(), s.run(), s.run(), s.run()]);
    expect(results).toEqual([1, 2, 2, 2]);
    expect(max).toBe(1);
    await s.idle();
    expect(await s.run()).toBe(3);
  });
});
