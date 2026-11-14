/**
 * 0.15 Messages: the "ask" rules for Jantar's WhatsApp tools in Claude's
 * settings.json (ask-rules.ts), on a synthetic settings file in a temp dir
 * (never the real ~/.claude/settings.json): only `permissions.ask` changes,
 * by exactly the five rules, every other key and its order kept, no allow
 * rule added; off removes only ours; the write follows a symlinked file to
 * the real one and leaves a byte-exact backup, and a file that won't parse
 * or has another shape is refused and left alone.
 */
import { lstat, mkdir, readFile, readdir, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MESSAGES_ASK_RULES, askRules, askRulesState, planAskRules, readAskRules, setAskRules } from '../../src/hooks/ask-rules.js';
import type { HooksFailure, HooksWritten } from '../../src/hooks/installer.js';
import { tempDir } from './helpers.js';

const SETTINGS = {
  cleanupPeriodDays: 3650,
  permissions: {
    allow: ['Bash(npm test:*)', 'mcp__jantar__intel_search'],
    ask: ['Bash(git push:*)'],
    deny: ['Read(//synthetic/home/.ssh/**)'],
    defaultMode: 'auto',
  },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'synthetic-tool hook claude' }] }] },
  theme: 'dark',
};
const NOW = () => new Date('2026-11-14T10:00:00.000Z');

function ok<T extends { ok: boolean }>(r: T | HooksFailure): T {
  if (!r.ok) throw new Error(`expected success, got ${(r as HooksFailure).code}: ${(r as HooksFailure).message}`);
  return r as T;
}

describe('askRules (pure)', () => {
  it('askRules adds the five rules once and keeps other keys', () => {
    expect(MESSAGES_ASK_RULES).toEqual([
      'mcp__jantar__messages_chats',
      'mcp__jantar__messages_read',
      'mcp__jantar__messages_search',
      'mcp__jantar__messages_media',
      'mcp__jantar__calls_to_return',
    ]);
    const before = structuredClone(SETTINGS);
    const on = askRules(SETTINGS, true) as typeof SETTINGS;
    // The input is never changed in place.
    expect(SETTINGS).toEqual(before);
    // Identical except permissions.ask: same keys in the same order, allow untouched, nothing allowed.
    expect(Object.keys(on)).toEqual(Object.keys(SETTINGS));
    expect(Object.keys(on.permissions)).toEqual(Object.keys(SETTINGS.permissions));
    expect({ ...on, permissions: { ...on.permissions, ask: SETTINGS.permissions.ask } }).toEqual(SETTINGS);
    expect(on.permissions.allow).toEqual(SETTINGS.permissions.allow);
    expect(on.permissions.ask).toEqual(['Bash(git push:*)', ...MESSAGES_ASK_RULES]);
    expect(askRulesState(on)).toBe('on');
    // Once: on again changes nothing, and gives back the very same object.
    expect(askRules(on, true)).toBe(on);
    // One already there is not added twice; the missing ones go after it.
    const one = askRules({ permissions: { ask: ['mcp__jantar__messages_read'] } }, true) as { permissions: { ask: string[] } };
    expect(one.permissions.ask).toEqual(['mcp__jantar__messages_read', ...MESSAGES_ASK_RULES.filter((r) => r !== 'mcp__jantar__messages_read')]);
    // No permissions at all: they are made, after every other key.
    const bare = askRules({ theme: 'dark' }, true);
    expect(bare).toEqual({ theme: 'dark', permissions: { ask: [...MESSAGES_ASK_RULES] } });
    expect(Object.keys(bare as object)).toEqual(['theme', 'permissions']);
  });

  it('askRules off removes only ours', () => {
    const on = askRules(SETTINGS, true);
    const off = askRules(on, false) as typeof SETTINGS;
    expect(off).toEqual(SETTINGS);
    expect(Object.keys(off.permissions)).toEqual(Object.keys(SETTINGS.permissions));
    expect(askRulesState(off)).toBe('off');
    // Nothing of ours: the same object back.
    expect(askRules(SETTINGS, false)).toBe(SETTINGS);
    expect(askRules({}, false)).toEqual({});
    // A list emptied by us goes, and permissions with it when that empties it; one the user made stays.
    expect(askRules({ theme: 'dark', permissions: { ask: [...MESSAGES_ASK_RULES] } }, false)).toEqual({ theme: 'dark' });
    expect(askRules({ permissions: { ask: [...MESSAGES_ASK_RULES], allow: [] } }, false)).toEqual({ permissions: { allow: [] } });
    expect(askRules({ permissions: { ask: [] } }, false)).toEqual({ permissions: { ask: [] } });
    // The user's own rules for these tools elsewhere are theirs: allow and deny are never touched.
    const theirs = { permissions: { allow: ['mcp__jantar__messages_read'], deny: ['mcp__jantar__calls_to_return'], ask: ['mcp__jantar__messages_chats', 'WebFetch'] } };
    expect(askRules(theirs, false)).toEqual({ permissions: { allow: ['mcp__jantar__messages_read'], deny: ['mcp__jantar__calls_to_return'], ask: ['WebFetch'] } });
    expect(askRulesState(theirs)).toBe('partial');
  });

  it('refuses a settings value of another shape, on and off', () => {
    for (const bad of [null, [], 'x', { permissions: [] }, { permissions: 'ask' }, { permissions: { ask: 'mcp__jantar__messages_read' } }]) {
      expect(() => askRules(bad, true), JSON.stringify(bad)).toThrow(/nothing was changed/);
      expect(() => askRules(bad, false), JSON.stringify(bad)).toThrow(/nothing was changed/);
    }
  });
});

describe('the settings file', () => {
  let tmp: Awaited<ReturnType<typeof tempDir>>;
  let real: string;
  let link: string;
  const text = `${JSON.stringify(SETTINGS, null, 2)}\n`;

  beforeEach(async () => {
    tmp = await tempDir('jantar-ask-');
    // ~/.claude/settings.json as a link to a file kept elsewhere (a dotfiles folder), as some setups have it.
    await mkdir(join(tmp.dir, 'dotfiles'), { recursive: true });
    await mkdir(join(tmp.dir, 'home', '.claude'), { recursive: true });
    real = join(tmp.dir, 'dotfiles', 'claude-settings.json');
    link = join(tmp.dir, 'home', '.claude', 'settings.json');
    await writeFile(real, text, { mode: 0o600 });
    await symlink(real, link);
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('writes go through the symlink and leave a backup', async () => {
    const res = ok(await setAskRules({ settingsPath: link, on: true, now: NOW }));
    expect(res.written).toBe(true);
    expect(res.isSymlink).toBe(true);
    expect(res.events).toEqual([...MESSAGES_ASK_RULES]);
    // The link is still a link to the same file, which now holds the rules (same 2-space format, trailing newline).
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(real);
    const after = await readFile(real, 'utf8');
    expect(after).toBe(`${JSON.stringify(askRules(SETTINGS, true), null, 2)}\n`);
    expect(((await lstat(real)).mode & 0o777).toString(8)).toBe('600');
    // A byte-exact backup beside the real file.
    expect(res.backupPath).toBe(`${await realpath(real)}.jantar-backup-2026-11-14T10-00-00-000Z`);
    expect(await readFile(res.backupPath as string, 'utf8')).toBe(text);
    expect(await readAskRules(link)).toBe('on');

    // Again: nothing to change, nothing written, no second backup.
    const again = ok(await setAskRules({ settingsPath: link, on: true, now: NOW }));
    expect([again.changed, again.written]).toEqual([false, false]);
    expect((await readdir(join(tmp.dir, 'dotfiles'))).filter((n) => n.includes('.jantar-backup-'))).toHaveLength(1);

    // Off: back to the original bytes.
    const off = ok(await setAskRules({ settingsPath: link, on: false, now: () => new Date('2026-11-14T10:00:01.000Z') }));
    expect(off.written).toBe(true);
    expect(await readFile(real, 'utf8')).toBe(text);
    expect(await readAskRules(link)).toBe('off');
  });

  it('a plan only reads; a dry run and a changed file write nothing', async () => {
    const plan = ok(await planAskRules({ settingsPath: link, on: true }));
    expect(plan.changed).toBe(true);
    expect(plan.diff).toContain('+      "mcp__jantar__messages_read",');
    expect(await readFile(real, 'utf8')).toBe(text);
    const dry = ok(await setAskRules({ settingsPath: link, on: true, dryRun: true }));
    expect(dry.written).toBe(false);
    expect(await readFile(real, 'utf8')).toBe(text);
    // The file changed after the diff was shown: refused, left as it is.
    const stale = await setAskRules({ settingsPath: link, on: true, expectedBefore: '{}\n' });
    expect(stale).toMatchObject({ ok: false, code: 'changed' });
    expect(await readFile(real, 'utf8')).toBe(text);
  });

  it('a file that is not JSON, or whose permissions are not an object, is refused and left alone', async () => {
    for (const bad of ['{ "permissions": ', '{ "permissions": ["x"] }\n']) {
      await writeFile(real, bad);
      const r = await setAskRules({ settingsPath: link, on: true, now: NOW });
      expect(r.ok, bad).toBe(false);
      expect((r as HooksFailure).message).toMatch(/nothing was changed/);
      expect(await readFile(real, 'utf8')).toBe(bad);
      expect(await readAskRules(link)).toMatchObject({ ok: false });
    }
  });

  it('no settings file yet: on makes one (0600) holding only the rules; off makes none', async () => {
    const fresh = join(tmp.dir, 'home', '.claude', 'fresh.json');
    expect(ok(await setAskRules({ settingsPath: fresh, on: false })).written).toBe(false);
    await expect(readFile(fresh, 'utf8')).rejects.toThrow();
    expect(await readAskRules(fresh)).toBe('off');
    const res: HooksWritten = ok(await setAskRules({ settingsPath: fresh, on: true }));
    expect(res.written).toBe(true);
    expect(JSON.parse(await readFile(fresh, 'utf8'))).toEqual({ permissions: { ask: [...MESSAGES_ASK_RULES] } });
    expect(((await lstat(fresh)).mode & 0o777).toString(8)).toBe('600');
  });
});
