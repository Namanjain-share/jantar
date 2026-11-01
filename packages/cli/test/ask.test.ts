/**
 * jantar ask (v0.5.3) against an in-memory daemon whose settings routes
 * apply patches as the real one does, and with the daemon down (config.json
 * on a synthetic HOME).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASK_SENTENCES } from '@jantar/daemon/ask/answer';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import { MAC_ONLY_SETTING_GROUPS } from '@jantar/protocol';
import ask from '../src/commands/ask.js';
import { EXIT } from '../src/command.js';
import { COMMANDS, main, memoryIo } from '../src/index.js';
import { contextFor, fakeCtl, fakeSettings } from './helpers.js';

const ENV = { HOME: '/synthetic/home', JANTAR_HOME: '/synthetic/state' };

function daemon(start: Record<string, unknown> = {}) {
  const s = fakeSettings(start);
  return { s, ctl: fakeCtl(s.routes) };
}

describe('jantar ask', () => {
  it('on says what goes to Claude and what stays, names Rewrite\'s model, and patches ask.enabled only', async () => {
    const { s, ctl } = daemon({ life: { todos: true } });
    expect(s.settings.ask.enabled).toBe(false);
    const on = contextFor({ env: ENV }, { ctl });
    expect(await ask.run(['on'], on.ctx)).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ ask: { enabled: true } }]);
    expect(s.settings.ask.enabled).toBe(true);
    expect(on.io.stdout).toBe(
      'Ask is on. The phone shows Ask.\n' +
        'Only what you type there goes to Claude (medicine names or amounts you type do go), with the date, time and time zone, ' +
        'which Life parts are on, the currency code and the fixed category names, ' +
        'through Claude Code on your account (model opus, as Rewrite).\n' +
        'Your saved lists, medicines and money stay on this Mac. Nothing is added until you tap Add.\n' +
        'The last 30 messages per phone stay in memory for up to 7 days; a restart forgets them.\n',
    );
    expect(on.io.stderr).toBe('');
  });

  it('on follows a changed Rewrite model, and points at Life with the daemon\'s own sentence when no Life part is on', async () => {
    const { s, ctl } = daemon({ rewrite: { model: 'sonnet' } });
    const on = contextFor({ env: ENV }, { ctl });
    expect(await ask.run(['on'], on.ctx)).toBe(EXIT.ok);
    expect(on.io.stdout).toContain('(model sonnet, as Rewrite)');
    expect(ASK_SENTENCES.noModules).toBe('Turn a Life part on first: jantar life on todos');
    expect(on.io.stdout).toContain(`${ASK_SENTENCES.noModules}\n`);
    // Any of todos, food, finance or medicines is enough; cafés are not.
    for (const part of ['food', 'finance', 'medicines']) {
      const one = daemon({ life: { [part]: true } });
      const io = contextFor({ env: ENV }, { ctl: one.ctl });
      expect(await ask.run(['on'], io.ctx)).toBe(EXIT.ok);
      expect(io.io.stdout, part).not.toContain(ASK_SENTENCES.noModules);
    }
    const places = daemon({ life: { places: true } });
    const p = contextFor({ env: ENV }, { ctl: places.ctl });
    expect(await ask.run(['on'], p.ctx)).toBe(EXIT.ok);
    expect(p.io.stdout).toContain(ASK_SENTENCES.noModules);
    expect(s.settings.ask.enabled).toBe(true);
  });

  it('off forgets the history and says items added stay in Life', async () => {
    const { s, ctl } = daemon({ ask: { enabled: true } });
    const off = contextFor({ env: ENV }, { ctl });
    expect(await ask.run(['off'], off.ctx)).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ ask: { enabled: false } }]);
    expect(s.settings.ask.enabled).toBe(false);
    expect(off.io.stdout).toBe('Ask is off. Its history is forgotten; items you added stay in Life.\n');
  });

  it('status reads the switch and Rewrite\'s model, and changes nothing', async () => {
    const { s, ctl } = daemon({ ask: { enabled: true }, rewrite: { model: 'opus' } });
    const st = contextFor({ env: ENV }, { ctl });
    expect(await ask.run(['status'], st.ctx)).toBe(EXIT.ok);
    expect(st.io.stdout).toBe("Ask: on\nModel: opus (Rewrite's model; change it with jantar rewrite model <m>)\n");
    expect(ctl.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(s.patches).toEqual([]);
    const offStatus = daemon();
    const st2 = contextFor({ env: ENV }, { ctl: offStatus.ctl });
    expect(await ask.run(['status'], st2.ctx)).toBe(EXIT.ok);
    expect(st2.io.stdout).toMatch(/^Ask: off\n/);
  });

  it('refuses a missing, unknown or extra word as a usage error, changing nothing', async () => {
    const { s, ctl } = daemon();
    for (const bad of [[], ['maybe'], ['enable'], ['on', 'x'], ['off', 'now'], ['status', 'x'], ['model', 'sonnet']]) {
      const c = contextFor({ env: ENV }, { ctl });
      expect(await ask.run(bad, c.ctx), bad.join(' ')).toBe(EXIT.usage);
    }
    expect(s.patches).toEqual([]);
    const long = contextFor({ env: ENV }, { ctl });
    expect(await main(['ask', 'x'.repeat(200)], { io: long.io, context: long.ctx })).toBe(EXIT.usage);
    expect(long.io.stderr).toContain('unknown action');
    expect(long.io.stderr).not.toContain('x'.repeat(40));
    // An unknown word is named as unknown, extra words or not; a known one with an extra word takes no argument.
    for (const [argv, said] of [
      [['model', 'sonnet'], 'unknown action "model" (on, off or status)'],
      [['foo', 'bar'], 'unknown action "foo" (on, off or status)'],
      [['on', 'x'], 'on takes no argument'],
      [['status', 'x'], 'status takes no argument'],
    ] as const) {
      const c = contextFor({ env: ENV }, { ctl });
      expect(await main(['ask', ...argv], { io: c.io, context: c.ctx }), argv.join(' ')).toBe(EXIT.usage);
      expect(c.io.stderr, argv.join(' ')).toContain(said);
    }
  });

  it('is registered after meetings with its help, and ask is a Mac-only group', async () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names.indexOf('ask')).toBe(names.indexOf('meetings') + 1);
    expect(COMMANDS.find((c) => c.name === 'ask')?.stub).toBeUndefined();
    const help = memoryIo({ HOME: '/nonexistent/jantar-test-home' });
    expect(await main(['ask', '--help'], { io: help })).toBe(EXIT.ok);
    expect(help.stdout).toContain('usage: jantar ask <on|off|status>');
    expect(help.stdout).toContain('ask on       show Ask on the phone (says what goes to Claude)');
    expect(help.stdout).toContain("ask off      hide it, stop any answer being written, and forget Ask's history");
    expect(help.stdout).toContain("ask status   the switch and the model (Rewrite's: jantar rewrite model <m>)");
    const all = memoryIo();
    expect(await main(['help'], { io: all })).toBe(EXIT.ok);
    expect(all.stdout).toContain('  ask  ');
    expect(MAC_ONLY_SETTING_GROUPS).toContain('ask');
  });
});

describe('jantar ask with the daemon down', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
  });
  afterEach(async () => {
    await home.cleanup();
  });

  it('on and off land in config.json; status reads it', async () => {
    const on = contextFor(home);
    expect(await ask.run(['on'], on.ctx)).toBe(EXIT.ok);
    expect(on.io.stdout).toContain('Ask is on.');
    expect(on.io.stdout).toContain('Saved to config.json');
    expect(JSON.parse(await readFile(join(home.jantarHome, 'config.json'), 'utf8')).ask).toEqual({ enabled: true });
    const st = contextFor(home);
    expect(await ask.run(['status'], st.ctx)).toBe(EXIT.ok);
    expect(st.io.stdout).toContain('Ask: on\n');
    expect(await ask.run(['off'], contextFor(home).ctx)).toBe(EXIT.ok);
    expect(JSON.parse(await readFile(join(home.jantarHome, 'config.json'), 'utf8')).ask).toEqual({ enabled: false });
  });
});
