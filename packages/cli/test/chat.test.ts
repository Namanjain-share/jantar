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

describe('jantar chat shortcut', () => {
  const KEY = `jchat_${'B'.repeat(43)}`;
  const ID = '01JSYNTHKEY000000000000000';
  function keyDaemon(settings: Record<string, unknown> = {}) {
    const s = fakeSettings({ ask: { enabled: true }, remote: { mode: 'tailscale', publicUrl: 'https://jantar.example.com' }, ...settings });
    const routes = {
      ...s.routes,
      [`POST ${ROUTES.chatKeyAdd.path}`]: ok({ id: ID, key: KEY, name: 'iphone', chatUrl: 'https://jantar.example.com/v1/capture/chat' }),
      [`GET ${ROUTES.chatKeyList.path}`]: ok({ keys: [{ id: ID, name: 'iphone', createdAt: '2026-11-02T10:00:00.000Z', lastSeenAt: null }], chatUrl: 'https://jantar.example.com/v1/capture/chat' }),
      [`POST ${ROUTES.chatKeyRevoke.path}`]: ok({ revoked: 1 }),
    } as Parameters<typeof fakeCtl>[0];
    return { s, ctl: fakeCtl(routes) };
  }

  it('add refuses without a terminal and inside Claude Code; the key never leaves without one', async () => {
    const { ctl } = keyDaemon();
    const pipe = contextFor({ env: ENV }, { ctl });
    expect(await chat.run(['shortcut', 'add'], pipe.ctx)).toBe(EXIT.failed);
    expect(pipe.io.stderr).toBe('Run this yourself in Terminal: the key is shown once and must not end up in a log.\n');
    const claude = contextFor({ env: { ...ENV, CLAUDECODE: '1' } }, { ctl, ioOptions: { isTTY: true } });
    expect(await chat.run(['shortcut', 'add'], claude.ctx)).toBe(EXIT.failed);
    const entry = contextFor({ env: { ...ENV, CLAUDE_CODE_ENTRYPOINT: 'cli' } }, { ctl, ioOptions: { isTTY: true } });
    expect(await chat.run(['shortcut', 'add'], entry.ctx)).toBe(EXIT.failed);
    expect(ctl.calls.some((c) => c.method === 'POST')).toBe(false);
    for (const c of [pipe, claude, entry]) expect(c.io.stdout + c.io.stderr).not.toContain('jchat_');
  });

  it('add on a terminal prints the key once, the door and the steps', async () => {
    const { ctl } = keyDaemon();
    const c = contextFor({ env: ENV }, { ctl, ioOptions: { isTTY: true } });
    expect(await chat.run(['shortcut', 'add', '--name', 'iphone'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout.split(KEY)).toHaveLength(2);
    expect(c.io.stdout).toContain('The door: POST https://jantar.example.com/v1/capture/chat');
    expect(c.io.stdout).toContain('name it "Jantar", so "Hey Siri, Jantar" runs it');
    expect(c.io.stdout).toContain('Dictate Text');
    expect(c.io.stdout).toContain('Speak Text');
    expect(c.io.stdout).toContain(`jantar chat shortcut revoke ${ID}`);
  });

  it('list never prints a key; revoke one or all; steps works anywhere with no key', async () => {
    const { ctl } = keyDaemon();
    const l = contextFor({ env: ENV }, { ctl });
    expect(await chat.run(['shortcut', 'list'], l.ctx)).toBe(EXIT.ok);
    expect(l.io.stdout).toContain(`${ID}  iphone`);
    expect(l.io.stdout).not.toContain('jchat_');
    const r = contextFor({ env: ENV }, { ctl });
    expect(await chat.run(['shortcut', 'revoke', ID], r.ctx)).toBe(EXIT.ok);
    expect(await chat.run(['shortcut', 'revoke', '--all'], r.ctx)).toBe(EXIT.ok);
    const st = contextFor({ env: ENV }, { ctl });
    expect(await chat.run(['shortcut', 'steps'], st.ctx)).toBe(EXIT.ok);
    expect(st.io.stdout).toContain('https://jantar.example.com/v1/capture/chat');
    expect(st.io.stdout).not.toContain('jchat_');
    const closed = keyDaemon({ remote: { mode: 'loopback' } });
    const c2 = contextFor({ env: ENV }, { ctl: closed.ctl });
    expect(await chat.run(['shortcut', 'steps'], c2.ctx)).toBe(EXIT.ok);
    expect(c2.io.stdout).toContain('https://<your address>/v1/capture/chat');
    expect(c2.io.stdout).toContain('The door is closed now');
  });

  it('status shows the Siri door and its keys', async () => {
    const { ctl } = keyDaemon();
    const extra = fakeCtl({ ...ctl.routes, [`GET ${ROUTES.chatStatus.path}`]: ok({ turns: 1, photos: 0, bytes: 0, broken: null }) } as Parameters<typeof fakeCtl>[0]);
    const c = contextFor({ env: ENV }, { ctl: extra });
    expect(await chat.run(['status'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toContain('Siri door: POST https://jantar.example.com/v1/capture/chat, 1 Siri key\n');
  });
});
