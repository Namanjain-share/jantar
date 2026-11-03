/**
 * jantar work (v0.13) against an in-memory daemon whose settings routes
 * apply patches as the real one does, and with the daemon down: on turns
 * Todos on too and says so (only when it was off), off leaves Todos, status
 * says whether Work works; `jantar life on work` brings Todos, and `jantar
 * life off todos` takes Work with it and says so.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import life from '../src/commands/life.js';
import work from '../src/commands/work.js';
import { EXIT } from '../src/command.js';
import { contextFor, fakeCtl, fakeSettings } from './helpers.js';

const ENV = { HOME: '/synthetic/home', JANTAR_HOME: '/synthetic/state' };

function daemon(start: Record<string, unknown> = {}) {
  const s = fakeSettings(start);
  return { s, ctl: fakeCtl(s.routes) };
}

describe('jantar work', () => {
  it('on turns Todos on too, and says so only when Todos was off', async () => {
    const { s, ctl } = daemon();
    const on = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['on'], on.ctx)).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ life: { work: true, todos: true } }]);
    expect(s.settings.life).toMatchObject({ work: true, todos: true });
    expect(on.io.stdout).toContain('Work: on');
    expect(on.io.stdout).toContain("Todos is on too: Work's projects and follow-ups are todos.");
    const again = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['on'], again.ctx)).toBe(EXIT.ok);
    expect(again.io.stdout).not.toContain('Todos is on too');
  });

  it('off leaves Todos on; status says whether Work works', async () => {
    const { s, ctl } = daemon({ life: { work: true, todos: true } });
    const off = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['off'], off.ctx)).toBe(EXIT.ok);
    expect(s.settings.life).toMatchObject({ work: false, todos: true });
    expect(off.io.stdout).toContain('Work: off');
    const st = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['status'], st.ctx)).toBe(EXIT.ok);
    expect(st.io.stdout).toBe('Work: off (turn it on: jantar work on)\n');
  });

  it('status: on only while Todos is on too (a config.json edited by hand)', async () => {
    const { ctl } = daemon({ life: { work: true, todos: false } });
    const st = contextFor({ env: ENV }, { ctl });
    expect(await work.run(['status'], st.ctx)).toBe(EXIT.ok);
    expect(st.io.stdout).toBe('Work: off, because Todos is off (jantar work on turns both on)\n');
  });

  it('refuses no action, an unknown one, and a word after one', async () => {
    const { s, ctl } = daemon();
    for (const bad of [[], ['maybe'], ['on', 'x'], ['status', 'x']]) {
      expect(await work.run(bad, contextFor({ env: ENV }, { ctl }).ctx), bad.join(' ')).toBe(EXIT.usage);
    }
    expect(s.patches).toEqual([]);
  });

  it('life on work brings Todos; life off todos takes Work with it and says so', async () => {
    const { s, ctl } = daemon();
    const on = contextFor({ env: ENV }, { ctl });
    expect(await life.run(['on', 'work'], on.ctx)).toBe(EXIT.ok);
    expect(s.settings.life).toMatchObject({ work: true, todos: true });
    expect(on.io.stdout).toContain("Todos is on too: Work's projects and follow-ups are todos.");
    const off = contextFor({ env: ENV }, { ctl });
    expect(await life.run(['off', 'todos'], off.ctx)).toBe(EXIT.ok);
    expect(s.settings.life).toMatchObject({ work: false, todos: false });
    expect(off.io.stdout).toContain('Work is off too: it needs Todos.');
    // With Work already off, turning Todos off says nothing about it.
    const quiet = contextFor({ env: ENV }, { ctl });
    expect(await life.run(['on', 'todos'], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.ok);
    expect(await life.run(['off', 'todos'], quiet.ctx)).toBe(EXIT.ok);
    expect(quiet.io.stdout).not.toContain('Work is off too');
  });
});

describe('with the daemon down', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
  });
  afterEach(async () => {
    await home.cleanup();
  });

  it('on lands in config.json with Todos', async () => {
    const c = contextFor(home);
    expect(await work.run(['on'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toContain('Saved to config.json');
    const config = JSON.parse(await readFile(join(home.jantarHome, 'config.json'), 'utf8'));
    expect(config.life).toMatchObject({ work: true, todos: true });
  });
});
