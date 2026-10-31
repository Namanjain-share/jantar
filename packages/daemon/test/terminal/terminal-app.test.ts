import { describe, expect, it } from 'vitest';
import { makeSession } from '@jantar/fixtures';
import type { Pane } from '@jantar/protocol';
import { createFakeExec, createTestContext, type ExecCall, type ExecHandler } from '../../src/core/testing.js';
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  CLEAR_ONE_ROW,
  TERMINAL_APP_SCRIPT,
  TerminalAppBackend,
  classifyForeground,
  classifyOsascriptError,
  clearInputBytes,
  createTerminalAppBackend,
  focusSession,
  isClaudeComm,
  readSessionScreen,
  normalizeTty,
  parsePsRows,
  type TerminalAppOptions,
} from '../../src/terminal/index.js';

// A model of Terminal.app answering our one script. It never runs anything.
interface FakeTab {
  wid: number;
  idx: number;
  tty: string;
  processes: number;
  contents: string;
  name?: string;
  /** Terminal's `number of rows` for the tab ('' when it won't say); default 24. */
  rows?: number | '';
}

interface FakeProc {
  pid: number;
  tty: string;
  stat: string;
  comm: string;
}

interface Model {
  running: boolean;
  tabs: FakeTab[];
  procs: FakeProc[];
  /** Answer osascript with this failure instead. */
  error?: { code: number; stderr: string };
  typed: { tty: string; text: string }[];
  focused: string[];
}

const RULE = '─'.repeat(60);
const SCREEN = ['⏺ Ready.', '', RULE, '❯ Try "write a test"', RULE, '  ⏵⏵ accept edits on (shift+tab to cycle)', '', ''].join('\n');

function model(over: Partial<Model> = {}): Model {
  return {
    running: true,
    tabs: [
      { wid: 4012, idx: 1, tty: '/dev/ttys002', processes: 2, contents: 'zsh prompt', name: 'other' },
      { wid: 4013, idx: 2, tty: '/dev/ttys003', processes: 3, contents: SCREEN, name: 'alpha-app — claude' },
    ],
    procs: [
      { pid: 900, tty: 'ttys003', stat: 'Ss', comm: 'login' },
      { pid: 901, tty: 'ttys003', stat: 'S', comm: '-zsh' },
      { pid: 41001, tty: 'ttys003', stat: 'S+', comm: '/synthetic/home/.local/bin/claude' },
      { pid: 800, tty: 'ttys002', stat: 'S+', comm: '-zsh' },
    ],
    typed: [],
    focused: [],
    ...over,
  };
}

function terminalApp(m: Model): ExecHandler {
  return (call: ExecCall) => {
    if (!call.file.endsWith('/osascript')) return undefined;
    // The contract: the script on stdin, always the same constant, values only in argv.
    if (call.args[0] !== '-' || call.opts.input !== TERMINAL_APP_SCRIPT) return { code: 99, stderr: 'contract broken' };
    if (m.error) return m.error;
    const [, tty, mode, text] = call.args;
    if (!m.running) return { stdout: '__JANTAR_NOT_RUNNING__\n' };
    const tab = m.tabs.find((t) => t.tty === tty && t.processes > 0);
    if (!tab) return { stdout: '__JANTAR_MISSING__\n' };
    switch (mode) {
      case 'find':
        return { stdout: `ok\n${tab.wid}\n${tab.idx}\n${tab.name ?? ''}\n` };
      case 'contents':
        return { stdout: `ok\n${tab.rows ?? 24}\n${tab.contents}\n` };
      case 'type':
        m.typed.push({ tty: tty as string, text: text as string });
        return { stdout: 'ok\n' };
      case 'focus':
        m.focused.push(tty as string);
        return { stdout: 'ok\n' };
      default:
        return { stdout: '__JANTAR_BAD_MODE__\n' };
    }
  };
}

function ps(m: Model): ExecHandler {
  return (call: ExecCall) => {
    if (!call.file.endsWith('/ps')) return undefined;
    const a = call.args;
    if (a[0] === '-t' && a[2] === '-o' && a[3] === 'pid=,stat=,comm=') {
      const rows = m.procs.filter((p) => p.tty === a[1]);
      return rows.length ? { stdout: rows.map((p) => `${String(p.pid).padStart(5)} ${p.stat.padEnd(4)} ${p.comm}`).join('\n') + '\n' } : { code: 1 };
    }
    if (a[0] === '-o' && a[1] === 'tty=' && a[2] === '-p') {
      const p = m.procs.find((x) => x.pid === Number(a[3]));
      return p ? { stdout: `${p.tty}\n` } : { code: 1 };
    }
    return undefined;
  };
}

function rig(m: Model = model(), opts: TerminalAppOptions = {}) {
  const exec = createFakeExec(terminalApp(m), ps(m));
  const ctx = createTestContext({ exec });
  const backend = new TerminalAppBackend(ctx, { platform: 'darwin', ...opts });
  return { m, exec, ctx, backend };
}

async function pane(b: TerminalAppBackend, target = { tty: '/dev/ttys003', pid: 41001 }): Promise<Pane> {
  const p = await b.findPane(target);
  if (!p) throw new Error('no pane');
  return p;
}

describe('Terminal.app backend: finding tabs', () => {
  it('finds a tab by tty and reports Claude in the foreground', async () => {
    const { backend } = rig();
    const p = await pane(backend);
    expect(p).toEqual({
      id: 'terminal-app:ttys003',
      backend: 'terminal-app',
      handle: '4013:2',
      tty: '/dev/ttys003',
      foreground: 'claude',
      title: 'alpha-app — claude',
      pid: 41001,
    });
  });

  it('finds a tab from the pid alone (ps -o tty=), and from the sid through the store', async () => {
    const { backend, ctx } = rig();
    expect((await backend.findPane({ pid: 41001 }))?.tty).toBe('/dev/ttys003');
    const sid = '11111111-1111-4111-8111-111111111111';
    ctx.store.emit({ type: 'session.added', sid, data: { session: makeSession({ sid, pid: 41001, tty: 'ttys003' }) } });
    expect((await backend.findPane({ sid }))?.id).toBe('terminal-app:ttys003');
  });

  it('skips a finished tab that kept the tty name (no processes)', async () => {
    const m = model();
    m.tabs = [{ wid: 1, idx: 1, tty: '/dev/ttys003', processes: 0, contents: '' }];
    const { backend } = rig(m);
    expect(await backend.findPane({ tty: '/dev/ttys003' })).toBeNull();
    expect(backend.lastError).toEqual({ code: 'not_found', reason: 'that Terminal tab is no longer open' });
  });

  it('does not launch Terminal to look for a tab', async () => {
    const { backend } = rig(model({ running: false }));
    expect(await backend.findPane({ tty: '/dev/ttys003' })).toBeNull();
    expect(backend.lastError?.reason).toBe('Terminal is not running');
  });

  it('no tty and no pid: not found without running osascript', async () => {
    const { backend, exec } = rig();
    expect(await backend.findPane({})).toBeNull();
    expect(exec.calls).toHaveLength(0);
  });

  it('is unavailable without osascript or off macOS', async () => {
    const m = model();
    const exec = createFakeExec(terminalApp(m), ps(m));
    const ctx = createTestContext({ exec, bins: { osascript: null } });
    const b = new TerminalAppBackend(ctx, { platform: 'darwin' });
    expect(await b.available()).toBe(false);
    expect(await b.findPane({ tty: '/dev/ttys003' })).toBeNull();
    const linux = new TerminalAppBackend(createTestContext({ exec }), { platform: 'linux' });
    expect(await linux.available()).toBe(false);
    expect(await createTerminalAppBackend(createTestContext({ exec }), {}).available()).toBe(process.platform === 'darwin');
  });
});

describe('Terminal.app backend: reading', () => {
  it('reads the visible contents, bounded to the last N lines', async () => {
    const m = model();
    const long = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
    (m.tabs[1] as FakeTab).contents = `${long}\n\n\n`;
    const { backend } = rig(m);
    const p = await pane(backend);
    const ten = await backend.readScreen(p, { lines: 10 });
    expect(ten.ok && ten.text.split('\n')).toEqual(Array.from({ length: 10 }, (_, i) => `line ${491 + i}`));
    const dflt = await backend.readScreen(p);
    expect(dflt.ok && dflt.text.split('\n')).toHaveLength(80);
    const max = await backend.readScreen(p, { lines: 10_000 });
    expect(max.ok && max.text.split('\n')).toHaveLength(400);
  });

  it("reads the tab's height with its contents: the first line of the answer, absent when Terminal won't say", async () => {
    const m = model();
    const { backend } = rig(m);
    const p = await pane(backend);
    expect(await backend.readScreen(p)).toMatchObject({ ok: true, tabRows: 24, text: SCREEN.replace(/\n+$/u, '') });
    (m.tabs[1] as FakeTab).rows = 71;
    expect(await backend.readScreen(p)).toMatchObject({ ok: true, tabRows: 71 });
    // The text never loses its first line to the height.
    (m.tabs[1] as FakeTab).contents = '42\nsecond';
    expect(await backend.readScreen(p)).toMatchObject({ ok: true, tabRows: 71, text: '42\nsecond' });
    (m.tabs[1] as FakeTab).rows = '';
    const none = await backend.readScreen(p);
    expect(none).toMatchObject({ ok: true, text: '42\nsecond' });
    expect(none.ok && 'tabRows' in none).toBe(false);
  });

  it("reads the input box; Terminal can't see styles", async () => {
    const m = model();
    const { backend } = rig(m);
    const p = await pane(backend);
    expect(await backend.readInputBox(p)).toEqual({ ok: true, text: '', styled: false });
    (m.tabs[1] as FakeTab).contents = ['⏺ Ready.', RULE, '❯ my draft', RULE].join('\n');
    expect(await backend.readInputBox(p)).toEqual({ ok: true, text: 'my draft', styled: false });
    (m.tabs[1] as FakeTab).contents = 'no box here';
    const r = await backend.readInputBox(p);
    expect(r.ok).toBe(false);
  });

  it('reports a missing Automation permission (-1743) as permission', async () => {
    const m = model();
    const { backend } = rig(m);
    const p = await pane(backend);
    m.error = { code: 1, stderr: '41:120: execution error: Not authorized to send Apple events to Terminal. (-1743)\n' };
    const r = await backend.readScreen(p);
    expect(r).toMatchObject({ ok: false, code: 'permission' });
  });

  it('keeps osascript stderr (which can echo argv) out of reasons', () => {
    const e = classifyOsascriptError("execution error: Can't make \"my secret prompt\" into type text. (-1700)");
    expect(e.reason).toBe('osascript failed (-1700)');
    expect(classifyOsascriptError('x (-1728)').code).toBe('not_found');
    expect(classifyOsascriptError('').reason).toBe('osascript failed');
  });

  it('a timed-out osascript is a timeout', async () => {
    const m = model();
    const exec = createFakeExec((call) => (call.file.endsWith('/osascript') && call.args[2] === 'contents' ? { code: null, timedOut: true } : undefined), terminalApp(m), ps(m));
    const b = new TerminalAppBackend(createTestContext({ exec }), { platform: 'darwin' });
    const p = await pane(b);
    expect(await b.readScreen(p)).toMatchObject({ ok: false, code: 'timeout' });
  });
});

describe('Terminal.app backend: typing', () => {
  it('passes text only as argv; the script on stdin is always the same constant', async () => {
    const { backend, exec, m } = rig();
    const p = await pane(backend);
    const text = 'say "zq7-marker" & then end tell -- not AppleScript';
    expect(await backend.type(p, text)).toEqual({ ok: true });
    expect(m.typed).toEqual([{ tty: '/dev/ttys003', text }]);
    const osa = exec.calls.filter((c) => c.file.endsWith('/osascript'));
    for (const c of osa) {
      expect(c.args[0]).toBe('-');
      expect(c.opts.input).toBe(TERMINAL_APP_SCRIPT);
      expect(c.opts.input).not.toContain('zq7-marker');
    }
    expect(osa.at(-1)?.args).toEqual(['-', '/dev/ttys003', 'type', text]);
  });

  it('auto: single-line text is typed plainly; text with newlines or tabs as one bracketed paste', async () => {
    const { backend, m } = rig();
    const p = await pane(backend);
    await backend.type(p, 'one line');
    await backend.type(p, 'two\nlines');
    await backend.type(p, 'a\ttab');
    expect(m.typed.map((t) => t.text)).toEqual([
      'one line',
      `${BRACKETED_PASTE_START}two\nlines${BRACKETED_PASTE_END}`,
      `${BRACKETED_PASTE_START}a\ttab${BRACKETED_PASTE_END}`,
    ]);
  });

  it("'paste' always wraps; 'plain' refuses multi-line text", async () => {
    const paste = rig(model(), { typing: 'paste' });
    await paste.backend.type(await pane(paste.backend), 'x');
    expect(paste.m.typed[0]?.text).toBe(`${BRACKETED_PASTE_START}x${BRACKETED_PASTE_END}`);
    const plain = rig(model(), { typing: 'plain' });
    expect(await plain.backend.type(await pane(plain.backend), 'a\nb')).toMatchObject({ ok: false, code: 'unsupported' });
    expect(plain.m.typed).toHaveLength(0);
  });

  it('refuses control characters without calling osascript', async () => {
    const { backend, m } = rig();
    const p = await pane(backend);
    for (const bad of ['\u001b[201~', 'a\rb', 'nul\u0000', 'c1\u009b']) {
      expect(await backend.type(p, bad)).toMatchObject({ ok: false, code: 'unsupported' });
    }
    expect(m.typed).toHaveLength(0);
  });

  it('Enter is a carriage return, clearInput is End then Ctrl-U (one row, padded), focus raises the tab', async () => {
    const { backend, m } = rig();
    const p = await pane(backend);
    await backend.pressEnter(p);
    await backend.clearInput(p);
    await backend.focus(p);
    // A lone Ctrl-U would keep the text right of a cursor moved at the Mac, and the Return would send it.
    expect(m.typed.map((t) => t.text)).toEqual(['\r', `${'\u001b[F'.repeat(3)}${'\u0015'.repeat(8)}`]);
    expect(CLEAR_ONE_ROW).toBe(clearInputBytes(1));
    expect(m.focused).toEqual(['/dev/ttys003']);
  });

  it('a tab that closed in the meantime is not_found; a non-Terminal pane is unsupported', async () => {
    const m = model();
    const { backend } = rig(m);
    const p = await pane(backend);
    m.tabs = [];
    expect(await backend.type(p, 'x')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await backend.focus({ ...p, backend: 'tmux' })).toMatchObject({ ok: false, code: 'unsupported' });
  });
});

describe('foreground', () => {
  it('with the pid known, Claude is foreground only if its own process has the +', async () => {
    const m = model();
    const { backend } = rig(m);
    const p = await pane(backend);
    expect(await backend.foregroundOf(p)).toBe('claude');
    m.procs = m.procs.map((x) => (x.pid === 41001 ? { ...x, stat: 'T' } : x.pid === 901 ? { ...x, stat: 'S+' } : x));
    expect(await backend.foregroundOf(p)).toBe('shell');
    m.procs = m.procs.filter((x) => x.tty !== 'ttys003');
    expect(await backend.foregroundOf(p)).toBe('gone');
  });

  it('two sessions on one tty: a lookup for one never changes the other pane\'s answer (W8)', async () => {
    // Claude A was suspended with Ctrl-Z; Claude B now runs in the same tab.
    const m = model({
      procs: [
        { pid: 900, tty: 'ttys003', stat: 'Ss', comm: 'login' },
        { pid: 901, tty: 'ttys003', stat: 'S', comm: '-zsh' },
        { pid: 41001, tty: 'ttys003', stat: 'T', comm: '/synthetic/home/.local/bin/claude' },
        { pid: 41002, tty: 'ttys003', stat: 'S+', comm: '/synthetic/home/.local/bin/claude' },
      ],
    });
    const { backend } = rig(m);
    const paneA = await pane(backend, { tty: '/dev/ttys003', pid: 41001 });
    expect(paneA.foreground).toBe('other');
    expect(await backend.foregroundOf(paneA)).toBe('other');
    // A screen peek or a send for B looks B up on the same tty...
    const paneB = await pane(backend, { tty: '/dev/ttys003', pid: 41002 });
    expect(paneB.id).toBe(paneA.id);
    expect(paneB.foreground).toBe('claude');
    // ...and A's in-flight checks still ask about A, B's about B.
    expect(await backend.foregroundOf(paneA)).toBe('other');
    expect(await backend.foregroundOf(paneB)).toBe('claude');
    // The reverse order too: looking A up again does not turn B's answer.
    await pane(backend, { tty: '/dev/ttys003', pid: 41001 });
    expect(await backend.foregroundOf(paneB)).toBe('claude');
  });

  it('a different claude on the same tty is not ours', async () => {
    const m = model();
    const { backend } = rig(m);
    const p = await pane(backend, { tty: '/dev/ttys003', pid: 55555 });
    expect(p.foreground).toBe('other');
  });

  it('classifies rows (node shim, shells, others)', () => {
    const rows = parsePsRows('  10 Ss   login\n  11 S+   node\n');
    expect(classifyForeground(rows)).toBe('claude');
    expect(classifyForeground(parsePsRows('11 S+ -zsh\n'))).toBe('shell');
    expect(classifyForeground(parsePsRows('11 S+ vim\n'))).toBe('other');
    expect(classifyForeground([])).toBe('gone');
    expect(parsePsRows('12 S+ /Applications/My App/bin/tool\n')[0]?.comm).toBe('/Applications/My App/bin/tool');
    expect(isClaudeComm('/synthetic/.local/share/claude/versions/2.1.300')).toBe(true);
    expect(isClaudeComm('/usr/bin/python3')).toBe(false);
  });

  it('normalises tty names', () => {
    expect(normalizeTty('ttys003')).toBe('/dev/ttys003');
    expect(normalizeTty('/dev/ttys003')).toBe('/dev/ttys003');
    expect(normalizeTty('s003')).toBe('/dev/ttys003');
    expect(normalizeTty('??')).toBeNull();
    expect(normalizeTty('../etc')).toBeNull();
    expect(normalizeTty(undefined)).toBeNull();
  });
});

describe('session screen and focus (for the API)', () => {
  it('reads and focuses a session by sid; unknown sessions and missing tabs say why', async () => {
    const { backend, ctx, m } = rig();
    const sid = '11111111-1111-4111-8111-111111111111';
    expect(await readSessionScreen(ctx, backend, sid)).toMatchObject({ ok: false, code: 'no_session' });
    ctx.store.emit({ type: 'session.added', sid, data: { session: makeSession({ sid, pid: 41001, tty: '/dev/ttys003' }) } });
    const r = await readSessionScreen(ctx, backend, sid, 3);
    expect(r).toMatchObject({ ok: true, lines: 3, backend: 'terminal-app' });
    expect(r.ok && r.text).toBe(['❯ Try "write a test"', RULE, '  ⏵⏵ accept edits on (shift+tab to cycle)'].join('\n'));
    expect(await focusSession(ctx, backend, sid)).toEqual({ ok: true });
    expect(m.focused).toEqual(['/dev/ttys003']);
    m.tabs = [];
    expect(await focusSession(ctx, backend, sid)).toMatchObject({ ok: false, code: 'not_found' });
    expect(m.typed).toHaveLength(0);
  });
});
