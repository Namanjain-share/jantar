/**
 * rewrite, controls and screenshots against an in-memory daemon whose
 * settings routes apply patches as the real one does, and with the daemon
 * down (config.json on a synthetic HOME).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import controls from '../src/commands/controls.js';
import rewrite from '../src/commands/rewrite.js';
import screenshots from '../src/commands/screenshots.js';
import { EXIT } from '../src/command.js';
import { contextFor, fakeCtl, fakeSettings } from './helpers.js';

const ENV = { HOME: '/synthetic/home', JANTAR_HOME: '/synthetic/state' };

function daemon(start: Record<string, unknown> = {}) {
  const s = fakeSettings(start);
  return { s, ctl: fakeCtl(s.routes) };
}

describe('jantar rewrite', () => {
  it('on, off and status; on names the model that writes prompts', async () => {
    const { s, ctl } = daemon();
    const on = contextFor({ env: ENV }, { ctl });
    expect(await rewrite.run(['on'], on.ctx)).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ rewrite: { enabled: true } }]);
    expect(on.io.stdout).toContain('Rewrite is on. The phone shows Rewrite next to Send.');
    expect(on.io.stdout).toContain('Model: opus (effort low; sonnet when opus is unavailable)');
    const st = contextFor({ env: ENV }, { ctl });
    expect(await rewrite.run(['status'], st.ctx)).toBe(EXIT.ok);
    expect(st.io.stdout).toContain('Rewrite: on');
    expect(st.io.stdout).toContain('Glossary: empty. Add words: jantar rewrite glossary add <word...>');
    expect(await rewrite.run(['off'], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.rewrite.enabled).toBe(false);
    for (const bad of [[], ['maybe'], ['on', 'x'], ['status', 'x']]) {
      expect(await rewrite.run(bad, contextFor({ env: ENV }, { ctl }).ctx), bad.join(' ')).toBe(EXIT.usage);
    }
  });

  it('glossary adds words once (ignoring case), removes them, and refuses bad words', async () => {
    const { s, ctl } = daemon({ rewrite: { glossary: ['ccw'] } });
    const add = contextFor({ env: ENV }, { ctl });
    expect(await rewrite.run(['glossary', 'add', 'cswap', 'CCW', 'Acme', 'pnpm', 'Acme'], add.ctx)).toBe(EXIT.ok);
    expect(s.settings.rewrite.glossary).toEqual(['ccw', 'cswap', 'Acme', 'pnpm']);
    expect(add.io.stdout).toContain('Glossary (4): ccw, cswap, Acme, pnpm');

    const same = contextFor({ env: ENV }, { ctl });
    expect(await rewrite.run(['glossary', 'add', 'PNPM'], same.ctx)).toBe(EXIT.ok);
    expect(same.io.stdout).toContain('Already in the glossary.');
    expect(s.patches).toHaveLength(1);

    expect(await rewrite.run(['glossary', 'rm', 'acme', 'nope'], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.rewrite.glossary).toEqual(['ccw', 'cswap', 'pnpm']);
    const missing = contextFor({ env: ENV }, { ctl });
    expect(await rewrite.run(['glossary', 'rm', 'nope'], missing.ctx)).toBe(EXIT.failed);
    expect(missing.io.stderr).toContain('none of those words is in the glossary');

    const list = contextFor({ env: ENV }, { ctl });
    expect(await rewrite.run(['glossary'], list.ctx)).toBe(EXIT.ok);
    expect(list.io.stdout).toBe('Glossary (3): ccw, cswap, pnpm\n');

    for (const bad of [['glossary', 'add'], ['glossary', 'add', 'x'.repeat(65)], ['glossary', 'add', 'a\u001b[2Jb'], ['glossary', 'add', '  '], ['glossary', 'frob', 'x']]) {
      const c = contextFor({ env: ENV }, { ctl });
      expect(await rewrite.run(bad, c.ctx), bad.join(' ')).toBe(EXIT.usage);
    }
    expect(s.settings.rewrite.glossary).toEqual(['ccw', 'cswap', 'pnpm']);

    const full = daemon({ rewrite: { glossary: Array.from({ length: 200 }, (_, i) => `w${i}`) } });
    const over = contextFor({ env: ENV }, { ctl: full.ctl });
    expect(await rewrite.run(['glossary', 'add', 'one-more'], over.ctx)).toBe(EXIT.usage);
    expect(over.io.stderr).toContain('at most 200 words');
  });

  it('model picks the prompt writer from opus, sonnet and haiku', async () => {
    const { s, ctl } = daemon();
    const show = contextFor({ env: ENV }, { ctl });
    expect(await rewrite.run(['model'], show.ctx)).toBe(EXIT.ok);
    expect(show.io.stdout).toBe('Model: opus (effort low; sonnet when opus is unavailable)\n');
    expect(await rewrite.run(['model', 'sonnet'], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ rewrite: { model: 'sonnet' } }]);
    for (const bad of [['model', 'gpt-5'], ['model', 'opus', 'x']]) {
      expect(await rewrite.run(bad, contextFor({ env: ENV }, { ctl }).ctx), bad.join(' ')).toBe(EXIT.usage);
    }
    expect(s.settings.rewrite.model).toBe('sonnet');
  });
});

describe('jantar controls', () => {
  it('on, off and status', async () => {
    const { s, ctl } = daemon();
    const off = contextFor({ env: ENV }, { ctl });
    expect(await controls.run(['off'], off.ctx)).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ controls: { enabled: false } }]);
    expect(off.io.stdout).toContain('Controls are off.');
    const on = contextFor({ env: ENV }, { ctl });
    expect(await controls.run(['on'], on.ctx)).toBe(EXIT.ok);
    expect(s.settings.controls.enabled).toBe(true);
    expect(on.io.stdout).toContain('Controls are on.');
    const st = contextFor({ env: ENV }, { ctl });
    expect(await controls.run(['status'], st.ctx)).toBe(EXIT.ok);
    // Escape and Clear draft are on by default since the 30 Oct 2026 spike.
    expect(st.io.stdout).toBe('Controls: on\nEscape key: allowed\nClear draft: allowed\n');
    // A config.json that held false keeps it.
    const saved = daemon({ controls: { escapeVerified: false, clearVerified: false } });
    const old = contextFor({ env: ENV }, { ctl: saved.ctl });
    expect(await controls.run(['status'], old.ctx)).toBe(EXIT.ok);
    expect(old.io.stdout).toBe(
      'Controls: on\nEscape key: refused (turn it on: jantar controls escape on)\nClear draft: hidden and refused (turn it on: jantar controls clear-draft on)\n',
    );
    for (const bad of [[], ['maybe'], ['on', 'x'], ['status', 'x'], ['escape'], ['escape', 'maybe'], ['clear-draft'], ['clear-draft', 'yes']]) {
      expect(await controls.run(bad, contextFor({ env: ENV }, { ctl }).ctx), bad.join(' ')).toBe(EXIT.usage);
    }
  });

  it('escape and clear-draft turn on the two keys a config.json from 0.4.0 holds off', async () => {
    const saved = daemon({ controls: { escapeVerified: false, clearVerified: false } });
    const clear = contextFor({ env: ENV }, { ctl: saved.ctl });
    expect(await controls.run(['clear-draft', 'on'], clear.ctx)).toBe(EXIT.ok);
    expect(clear.io.stdout).toBe('Clear draft: allowed\n');
    const esc = contextFor({ env: ENV }, { ctl: saved.ctl });
    expect(await controls.run(['escape', 'on'], esc.ctx)).toBe(EXIT.ok);
    expect(esc.io.stdout).toBe('Escape key: allowed\n');
    expect(saved.s.patches).toEqual([{ controls: { clearVerified: true } }, { controls: { escapeVerified: true } }]);
    expect(saved.s.settings.controls).toMatchObject({ enabled: true, escapeVerified: true, clearVerified: true });
    // And off again.
    const off = contextFor({ env: ENV }, { ctl: saved.ctl });
    expect(await controls.run(['clear-draft', 'off'], off.ctx)).toBe(EXIT.ok);
    expect(off.io.stdout).toBe('Clear draft: hidden and refused (turn it on: jantar controls clear-draft on)\n');
    expect(saved.s.settings.controls.clearVerified).toBe(false);
  });
});

describe('jantar screenshots', () => {
  it('on, off, status and allow-select', async () => {
    const { s, ctl } = daemon();
    const sel = contextFor({ env: ENV }, { ctl });
    expect(await screenshots.run(['allow-select'], sel.ctx)).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ screenshots: { allowSelect: true } }]);
    expect(sel.io.stdout).toContain('Background tabs: selected for a moment to capture them');
    expect(sel.io.stdout).toContain('Screenshots themselves are off: jantar screenshots on');

    const on = contextFor({ env: ENV }, { ctl });
    expect(await screenshots.run(['on'], on.ctx)).toBe(EXIT.ok);
    expect(s.settings.screenshots).toMatchObject({ enabled: true, allowSelect: true });
    expect(on.io.stdout).toContain("Screenshots are on. The session's Screen tab gains a Picture view.");

    const unsel = contextFor({ env: ENV }, { ctl });
    expect(await screenshots.run(['allow-select', 'off'], unsel.ctx)).toBe(EXIT.ok);
    expect(s.settings.screenshots.allowSelect).toBe(false);
    expect(unsel.io.stdout).toBe('Background tabs: not selected; the phone shows their text instead.\n');

    const st = contextFor({ env: ENV }, { ctl });
    expect(await screenshots.run(['status'], st.ctx)).toBe(EXIT.ok);
    expect(st.io.stdout).toContain('Screenshots: on (long edge 1600 px)');

    expect(await screenshots.run(['off'], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.screenshots.enabled).toBe(false);
    for (const bad of [[], ['maybe'], ['on', 'x'], ['allow-select', 'yes'], ['allow-select', 'on', 'x']]) {
      expect(await screenshots.run(bad, contextFor({ env: ENV }, { ctl }).ctx), bad.join(' ')).toBe(EXIT.usage);
    }
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

  it('every switch lands in config.json', async () => {
    expect(await rewrite.run(['on'], contextFor(home).ctx)).toBe(EXIT.ok);
    expect(await rewrite.run(['glossary', 'add', 'ccw'], contextFor(home).ctx)).toBe(EXIT.ok);
    expect(await controls.run(['off'], contextFor(home).ctx)).toBe(EXIT.ok);
    expect(await controls.run(['escape', 'off'], contextFor(home).ctx)).toBe(EXIT.ok);
    expect(await controls.run(['clear-draft', 'on'], contextFor(home).ctx)).toBe(EXIT.ok);
    const last = contextFor(home);
    expect(await screenshots.run(['on'], last.ctx)).toBe(EXIT.ok);
    expect(last.io.stdout).toContain('Saved to config.json');
    const config = JSON.parse(await readFile(join(home.jantarHome, 'config.json'), 'utf8'));
    expect(config.rewrite).toMatchObject({ enabled: true, glossary: ['ccw'] });
    expect(config.controls).toMatchObject({ enabled: false, escapeVerified: false, clearVerified: true });
    expect(config.screenshots).toMatchObject({ enabled: true, allowSelect: false });
  });
});
