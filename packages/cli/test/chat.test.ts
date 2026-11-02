/**
 * jantar chat (v0.10, spec 0.10 B12) against an in-memory daemon whose
 * settings routes apply patches as the real one does: on (what goes to
 * Claude), off (history stays), status (models, history on disk), keep,
 * voice-model, clear (asks first; --yes; --broken), and `jantar ask` as an
 * alias that says so.
 */
import { describe, expect, it } from 'vitest';
import { ROUTES } from '@jantar/protocol';
import chat from '../src/commands/chat.js';
import ask from '../src/commands/ask.js';
import { EXIT } from '../src/command.js';
import { contextFor, fakeCtl, fakeSettings, ok } from './helpers.js';

const ENV = { HOME: '/synthetic/home', JANTAR_HOME: '/synthetic/state' };

function daemon(start: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const s = fakeSettings(start);
  const routes = { ...s.routes, [`GET ${ROUTES.chatStatus.path}`]: ok({ turns: 12, photos: 2, bytes: 3 * 1024 * 1024, broken: null }), [`DELETE ${ROUTES.chatClear.path}`]: ok({ ok: true }), ...extra } as Parameters<typeof fakeCtl>[0];
  return { s, ctl: fakeCtl(routes) };
}

describe('jantar chat', () => {
  it('on says what goes to Claude, the models and the history; patches ask.enabled only', async () => {
    const { s, ctl } = daemon({ life: { todos: true } });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await chat.run(['on'], c.ctx)).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ ask: { enabled: true } }]);
    expect(c.io.stdout).toContain('Chat is on. The phone shows Chat.');
    expect(c.io.stdout).toContain('(model opus; by voice sonnet)');
    expect(c.io.stdout).toContain('never deletes without your tap, and never types into a session');
    expect(c.io.stdout).toContain('History stays on this Mac in chat.db for 30 days');
    expect(c.io.stdout).not.toContain('turn a part on');
  });

  it('on with nothing on but sessions gives a hint; off keeps the history', async () => {
    const { ctl } = daemon();
    const c = contextFor({ env: ENV }, { ctl });
    await chat.run(['on'], c.ctx);
    expect(c.io.stdout).toContain('Chat can read your sessions now. For more, turn a part on: jantar life on todos');
    const off = contextFor({ env: ENV }, { ctl });
    expect(await chat.run(['off'], off.ctx)).toBe(EXIT.ok);
    expect(off.io.stdout).toBe('Chat is off: the phone hides it and the Siri door closes. Its history stays until jantar chat clear; what it added stays in Life.\n');
  });

  it('status reads the switch, the models, keep days and the history on disk', async () => {
    const { s, ctl } = daemon({ ask: { enabled: true, keepDays: 14, voiceModel: 'haiku' } });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await chat.run(['status'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toContain('Chat: on\n');
    expect(c.io.stdout).toContain('by voice haiku');
    expect(c.io.stdout).toContain('History: kept 14 days');
    expect(c.io.stdout).toContain('On disk: 12 messages, 2 photos (3.0 MB)');
    expect(s.patches).toEqual([]);
  });

  it('keep and voice-model patch their keys; bad values are usage errors', async () => {
    const { s, ctl } = daemon();
    const c = contextFor({ env: ENV }, { ctl });
    expect(await chat.run(['keep', '7'], c.ctx)).toBe(EXIT.ok);
    expect(await chat.run(['voice-model', 'haiku'], c.ctx)).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ ask: { keepDays: 7 } }, { ask: { voiceModel: 'haiku' } }]);
    expect(c.io.stdout).toBe('Chat keeps its history 7 days.\nSiri questions run on haiku.\n');
    for (const [argv, said] of [
      [['keep', '0'], '1 to 365'],
      [['keep', '366'], '1 to 365'],
      [['voice-model', 'gpt'], 'opus, sonnet or haiku'],
    ] as const) {
      const bad = contextFor({ env: ENV }, { ctl });
      expect(await chat.run([...argv], bad.ctx)).toBe(EXIT.usage);
      expect(bad.io.stderr).toContain(said);
    }
  });

  it('clear asks first on a terminal, needs --yes without one, and --broken moves chat.db aside', async () => {
    const { ctl } = daemon();
    const no = contextFor({ env: ENV }, { ctl, ioOptions: { answers: ['n'] } });
    expect(await chat.run(['clear'], no.ctx)).toBe(EXIT.ok);
    expect(no.io.stdout).toBe('Nothing cleared.\n');
    expect(ctl.calls.some((x) => x.method === 'DELETE')).toBe(false);
    const yes = contextFor({ env: ENV }, { ctl, ioOptions: { answers: ['y'] } });
    expect(await chat.run(['clear'], yes.ctx)).toBe(EXIT.ok);
    expect(yes.io.stdout).toBe('Chat cleared. What it added stays in Life, Intel and Meetings.\n');
    const script = contextFor({ env: ENV }, { ctl });
    expect(await chat.run(['clear'], script.ctx)).toBe(EXIT.usage);
    expect(script.io.stderr).toContain('--yes');
    expect(await chat.run(['clear', '--broken', '--yes'], script.ctx)).toBe(EXIT.ok);
    expect(ctl.calls.filter((x) => x.method === 'DELETE').map((x) => x.path)).toEqual(['/v1/chat', '/v1/chat?broken=1']);
  });

  it('ask is an alias that says so on stderr', async () => {
    const { s, ctl } = daemon();
    const c = contextFor({ env: ENV }, { ctl });
    expect(await ask.run(['on'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stderr).toBe('Ask is now Chat: jantar chat on\n');
    expect(c.io.stdout).toContain('Chat is on.');
    expect(s.patches).toEqual([{ ask: { enabled: true } }]);
  });
});
