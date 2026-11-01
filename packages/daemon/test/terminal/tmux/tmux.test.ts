/**
 * v0.6 Fleet, lane L2: the tmux backend at the argv level (spec 4.2, S21,
 * S22). A scripted tmux (fake-tmux.ts) answers every call on a model of one
 * server's panes; nothing is spawned. Real tmux runs only in the Docker
 * suite (real/).
 *
 * - The gate: the tty and mode terms, nested `#{&&:}`, the lines a
 *   compare-and-type checks, and every GLOB_SPECIALS character as `?` (a
 *   screen line `#(touch x)` is `?(touch x)`, so tmux runs nothing).
 * - The one write primitive: text only on stdin (`load-buffer -`), never in
 *   an argv item; one if-shell whose <do> and <else> hold only fixed tokens;
 *   buffers deleted on both branches; refusals named.
 * - findPane binds by tty, or by pid ancestry with no tty; a pane id alone
 *   never names a pane (S22).
 * - type, pressEnter, clearInput, pressKey (through Terminal.app's keys.ts),
 *   compare-and-type, openWindow, foregroundOf, focus.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLEET_SECRET } from '@jantar/fixtures';
import { SettingsSchema, type Pane, type Session } from '@jantar/protocol';
import { createFakeExec, createTestContext, onCommand, type TestContext } from '../../../src/core/testing.js';
import {
  GLOB_SPECIALS,
  JANTAR_CHANGED,
  NO_PANE,
  TmuxBackend,
  ancestorsOf,
  gateLines,
  hexTokens,
  parentFromStat,
  parsePaneRows,
  tmuxGate,
  tmuxVersionOk,
  tmuxWrite,
} from '../../../src/terminal/tmux/index.js';
import { CLEAR_ONE_ROW } from '../../../src/terminal/terminal-app/keys.js';
import { SOCKET, TMUX_BIN, createFakeTmux, type FakeTmux } from './fake-tmux.js';

const TTY = '/dev/pts/3';
const MODES = '#{&&:#{==:#{pane_in_mode},0},#{&&:#{==:#{pane_synchronized},0},#{&&:#{==:#{pane_input_off},0},#{==:#{pane_dead},0}}}}';
const BUF = /^jantar-[0-9A-Z]{26}$/u;
const DOWN = '\u001b[B';

/** The texts S21 names: a trailing `;`, a lone `;`, `a\;`, quotes, `#{`, and the planted secret. */
const HARD_TEXTS = ['echo hi;', ';', 'a\\;', `it's "quoted"`, 'a #{b', `say ${FLEET_SECRET}`, '%3 ; run-shell x'];

function rig(over: { settings?: unknown; env?: Record<string, string>; procRoot?: string; version?: string; ps?: string } = {}) {
  const fake = createFakeTmux({ version: over.version ?? 'tmux 3.3a' });
  const exec = createFakeExec(fake.handler, onCommand('ps', { stdout: over.ps ?? '  101 Ss   bash\n  202 S+   claude\n', code: 0 }));
  const ctx = createTestContext({
    exec,
    bins: { tmux: TMUX_BIN, ps: '/usr/bin/ps' },
    settings: SettingsSchema.parse(over.settings ?? { controls: { escapeVerified: true, clearVerified: true } }),
    ...(over.env ? { env: over.env } : {}),
  });
  const b = new TmuxBackend(ctx, { socket: SOCKET, ...(over.procRoot ? { procRoot: over.procRoot } : {}) });
  return { fake, exec, ctx, b };
}

function paneOf(fake: FakeTmux, id = '%3', tty = TTY): Pane {
  return { id: `tmux:${id}`, backend: 'tmux', handle: id, tty, foreground: 'claude', pid: 202 };
}

/** The if-shell calls, as [gate, do, else]. */
function gated(fake: FakeTmux): Array<[string, string, string]> {
  return fake.calls.filter((c) => c[0] === 'if-shell').map((c) => [c[4] as string, c[5] as string, c[6] as string]);
}

/** Await a call that sleeps on the fake clock, moving time on until it settles. */
async function settle<T>(ctx: TestContext, p: Promise<T>): Promise<T> {
  let done = false;
  void p.finally(() => {
    done = true;
  });
  for (let i = 0; i < 200 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    if (!done) ctx.clock.advance(50);
  }
  return p;
}

function session(over: Partial<Session> & Pick<Session, 'sid'>): Session {
  return {
    pid: 202,
    procStart: 'Thu Jan 15 09:00:00 2026',
    account: 0,
    configDir: '/home/sam/.claude',
    cwd: '/home/sam/code/api-server',
    folder: 'api-server',
    entrypoint: 'cli',
    status: 'idle',
    statusSource: 'session-file',
    statusSince: '2026-01-15T10:00:00.000Z',
    subagentsRunning: 0,
    ...over,
  };
}

/** Every grammar a gated <do> may use: fixed words, %N, the buffer name and hex, joined by ` ; `. */
const DO_RE = /^(?:send-keys -t %\d+ -H(?: [0-9a-f]{2})+|paste-buffer(?: -p)? -d -r -b jantar-[0-9A-Z]{26} -t %\d+|send-keys -t %\d+ Enter)(?: ; (?:send-keys -t %\d+ -H(?: [0-9a-f]{2})+|paste-buffer(?: -p)? -d -r -b jantar-[0-9A-Z]{26} -t %\d+|send-keys -t %\d+ Enter))*$/u;
const ELSE_RE = /^(?:delete-buffer -b jantar-[0-9A-Z]{26} ; )?display-message -p JANTAR-CHANGED$/u;

describe('tmuxGate (spec 4.2)', () => {
  it('checks the tty and the four mode flags, nested two by two', () => {
    expect(tmuxGate(undefined, TTY)).toBe(`#{&&:#{==:#{pane_tty},${TTY}},${MODES}}`);
  });

  it('adds a #{C:} term per checked line, innermost last', () => {
    expect(tmuxGate('Bash command', TTY)).toBe(
      `#{&&:#{==:#{pane_tty},${TTY}},#{&&:#{==:#{pane_in_mode},0},#{&&:#{==:#{pane_synchronized},0},#{&&:#{==:#{pane_input_off},0},#{&&:#{==:#{pane_dead},0},#{C:Bash command}}}}}}`,
    );
  });

  it('S21: a screen line #(touch x) becomes ?(touch x): no # is left for tmux to expand', () => {
    const gate = tmuxGate('#(touch x)', TTY);
    expect(gate).toContain('#{C:?(touch x)}');
    expect(gate).not.toContain('#(');
    expect(gateLines('#(touch /tmp/x)')).toEqual(['?(touch /tmp/x)']);
  });

  it('every GLOB_SPECIALS character is ?, and nothing else is changed', () => {
    expect(GLOB_SPECIALS).toBe('#,{}*?[]\\');
    expect(gateLines('a#b,c{d}e*f?g[h]i\\j k:l;m%n')).toEqual(['a?b?c?d?e?f?g?h?i?j k:l;m%n']);
    // box drawing, the pointer and wide characters stay as they are
    expect(gateLines('╭─ ❯ 1. Yes 漢字 │')).toEqual(['╭─ ❯ 1. Yes 漢字 │']);
  });

  it('drops trailing white space (tmux trims each screen line) and turns controls into ?', () => {
    expect(gateLines('Do you want to proceed?   \r\nnext\tline\u001b')).toEqual(['Do you want to proceed?', 'next?line?']);
  });

  it('checks the first, the pointer row, the longest and the last non-empty line, each once, at most four', () => {
    const block = ['', ' Do you want to make this edit?', '   1. Yes', ' ❯ 2. Yes, allow all edits during this session (shift+tab)', '   3. No', '', 'Esc to cancel', ''].join('\n');
    expect(gateLines(block)).toEqual([' Do you want to make this edit?', ' ❯ 2. Yes? allow all edits during this session (shift+tab)', 'Esc to cancel']);
    const lines = ['first line here', 'a much longer line than any other one', '❯ pointer', 'last'].join('\n');
    expect(gateLines(lines)).toEqual(['first line here', '❯ pointer', 'a much longer line than any other one', 'last']);
    expect(gateLines(['part one ends in ', ' part two'])).toEqual(['part one ends in', ' part two']);
    expect(gateLines(' \n\n  ')).toEqual([]);
  });

  it('takes a /dev/pts tty only', () => {
    for (const bad of ['/dev/ttys003', 'pts/3', '/dev/pts/3;', '/dev/pts/3}', '/dev/pts/']) expect(() => tmuxGate(undefined, bad)).toThrow();
  });
});

describe('tmuxWrite: the one write primitive (S21)', () => {
  it('text goes only to load-buffer on stdin; one if-shell of fixed tokens pastes it; no argv item holds it', async () => {
    for (const text of HARD_TEXTS) {
      const { fake, ctx } = rig();
      const p = fake.addPane({ id: '%3', tty: TTY });
      expect(await tmuxWrite(ctx, { socket: SOCKET }, paneOf(fake), { text, enter: false })).toEqual({ ok: true });
      expect(p.input, text).toBe(text);
      expect(fake.calls.map((c) => c[0])).toEqual(['load-buffer', 'if-shell']);
      const load = fake.calls[0] as string[];
      expect(load.slice(0, 2)).toEqual(['load-buffer', '-b']);
      expect(load[2]).toMatch(BUF);
      expect(load[3]).toBe('-');
      expect(fake.inputs).toEqual([text]);
      const [[gate, run, otherwise]] = gated(fake) as [[string, string, string]];
      expect(gate).toBe(`#{&&:#{==:#{pane_tty},${TTY}},${MODES}}`);
      expect(run).toBe(`paste-buffer -d -r -b ${load[2]} -t %3`);
      expect(otherwise).toBe(`delete-buffer -b ${load[2]} ; display-message -p ${JANTAR_CHANGED}`);
      for (const c of fake.calls) for (const a of c) if (text.length > 2) expect(a.includes(text), `${text} in argv`).toBe(false);
      expect(fake.buffers.size).toBe(0);
      expect(fake.shellRuns).toEqual([]);
    }
  });

  it('every call passes the private socket first, and never TMUX or TMUX_PANE', async () => {
    const { fake, ctx, exec } = rig({ env: { HOME: '/home/sam', TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%9', LC_ALL: 'C' } });
    fake.addPane({ id: '%3', tty: TTY });
    expect(await tmuxWrite(ctx, { socket: SOCKET }, paneOf(fake), { text: 'hi', enter: true })).toEqual({ ok: true });
    const calls = exec.calls.filter((c) => c.file === TMUX_BIN);
    expect(calls.length).toBe(2);
    for (const c of calls) {
      expect(c.args.slice(0, 2)).toEqual(['-S', SOCKET]);
      expect(c.opts.env?.TMUX).toBeUndefined();
      expect(c.opts.env?.TMUX_PANE).toBeUndefined();
      expect(c.opts.env?.HOME).toBe('/home/sam');
    }
  });

  it('text with a line feed or a tab is pasted bracketed when the app asked (-p), its bytes kept (-r)', async () => {
    const { fake, ctx } = rig();
    const p = fake.addPane({ id: '%3', tty: TTY, bracketed: true });
    expect(await tmuxWrite(ctx, {}, paneOf(fake), { text: 'line one\nline two', enter: false })).toEqual({ ok: true });
    expect(gated(fake)[0]?.[1]).toMatch(/^paste-buffer -p -d -r -b jantar-[0-9A-Z]{26} -t %3$/u);
    expect(p.input).toBe('\u001b[200~line one\nline two\u001b[201~');
  });

  it('keys go as one hex token a byte, then the text, then one Enter, all in one gated step', async () => {
    const { fake, ctx } = rig();
    const p = fake.addPane({ id: '%3', tty: TTY, screen: 'Pick one\n❯ 1. Red\n  2. Type something.' });
    const r = await tmuxWrite(ctx, {}, paneOf(fake), { keys: DOWN, text: 'teal', enter: true, expect: '❯ 1. Red\n  2. Type something.' });
    expect(r).toEqual({ ok: true });
    expect(p.input).toBe(`${DOWN}teal\r`);
    const [[gate, run, otherwise]] = gated(fake) as [[string, string, string]];
    expect(run).toMatch(/^send-keys -t %3 -H 1b 5b 42 ; paste-buffer -d -r -b jantar-[0-9A-Z]{26} -t %3 ; send-keys -t %3 Enter$/u);
    expect(run).toMatch(DO_RE);
    expect(otherwise).toMatch(ELSE_RE);
    expect(gate).toContain('#{C:❯ 1. Red}');
    expect(gate).toContain('#{C:  2. Type something.}');
  });

  it('an Enter alone is one gated send-keys Enter, with no buffer', async () => {
    const { fake, ctx } = rig();
    const p = fake.addPane({ id: '%3', tty: TTY });
    expect(await tmuxWrite(ctx, {}, paneOf(fake), { enter: true })).toEqual({ ok: true });
    expect(p.input).toBe('\r');
    expect(fake.calls.map((c) => c[0])).toEqual(['if-shell']);
    expect(gated(fake)[0]?.slice(1)).toEqual(['send-keys -t %3 Enter', `display-message -p ${JANTAR_CHANGED}`]);
  });

  it('refuses before anything runs: controls in text, a pane id or tty that is not one, non-key bytes, nothing to type', async () => {
    const { fake, ctx } = rig();
    fake.addPane({ id: '%3', tty: TTY });
    const cases: Array<[Pane, Parameters<typeof tmuxWrite>[3]]> = [
      [paneOf(fake), { text: 'a\u001bb', enter: false }],
      [paneOf(fake), { text: 'a\rb', enter: false }],
      [paneOf(fake, '%3;'), { enter: true }],
      [paneOf(fake, '%3 ; run-shell x'), { enter: true }],
      [paneOf(fake, '3'), { enter: true }],
      [paneOf(fake, '%3', '/dev/pts/3;'), { enter: true }],
      [paneOf(fake, '%3', '/dev/ttys003'), { enter: true }],
      [{ ...paneOf(fake), backend: 'terminal-app' }, { enter: true }],
      [paneOf(fake), { keys: 'é', enter: true }],
      [paneOf(fake), { enter: false }],
      [paneOf(fake), { keys: DOWN, enter: true, expect: '   \n ' }],
    ];
    for (const [pane, w] of cases) {
      const r = await tmuxWrite(ctx, {}, pane, w);
      expect(r.ok, JSON.stringify([pane.handle, pane.tty, w])).toBe(false);
    }
    expect(fake.calls).toEqual([]);
  });

  it('a refused ungated write names why: copy mode, synchronize-panes, input off, a dead pane, another tty; its buffer is gone', async () => {
    const flags: Array<[Partial<Parameters<FakeTmux['addPane']>[0]>, string, RegExp]> = [
      [{ inMode: true }, 'unsupported', /copy mode: press q there/u],
      [{ sync: true }, 'unsupported', /synchronize-panes/u],
      [{ inputOff: true }, 'unsupported', /input is off/u],
      [{ dead: true }, 'not_found', /exited/u],
      [{ tty: '/dev/pts/9' }, 'not_found', /no longer this session's/u],
    ];
    for (const [over, code, reason] of flags) {
      const { fake, ctx } = rig();
      const p = fake.addPane({ id: '%3', tty: TTY, ...over });
      const r = await tmuxWrite(ctx, {}, paneOf(fake), { text: 'hello', enter: false });
      expect(r).toMatchObject({ ok: false, code });
      expect(r.ok ? '' : r.reason).toMatch(reason);
      expect(p.input).toBe('');
      expect(fake.buffers.size).toBe(0);
    }
  });

  it('a refused compare-and-type is `changed`, nothing typed', async () => {
    const { fake, ctx } = rig();
    const p = fake.addPane({ id: '%3', tty: TTY, screen: 'something else' });
    const r = await tmuxWrite(ctx, {}, paneOf(fake), { keys: DOWN, enter: true, expect: 'Do you want to proceed?' });
    expect(r).toMatchObject({ ok: false, code: 'changed' });
    expect(p.input).toBe('');
    // copy mode with the lines still there: the same gate says no
    const q = fake.addPane({ id: '%4', tty: '/dev/pts/4', screen: 'Do you want to proceed?', inMode: true });
    expect(await tmuxWrite(ctx, {}, paneOf(fake, '%4', '/dev/pts/4'), { keys: DOWN, enter: true, expect: 'Do you want to proceed?' })).toMatchObject({ ok: false, code: 'changed' });
    expect(q.input).toBe('');
  });

  it('a pane that is gone is not_found and its buffer is deleted; no server refuses before the gate', async () => {
    const { fake, ctx } = rig();
    expect(await tmuxWrite(ctx, {}, paneOf(fake), { text: 'hello', enter: false })).toMatchObject({ ok: false, code: 'not_found' });
    expect(fake.calls.map((c) => c[0])).toEqual(['load-buffer', 'if-shell', 'delete-buffer']);
    expect(fake.buffers.size).toBe(0);
    const other = rig();
    other.fake.noServer = true;
    expect(await tmuxWrite(other.ctx, {}, paneOf(other.fake), { text: 'hello', enter: false })).toMatchObject({ ok: false, code: 'not_found' });
    expect(other.fake.calls.map((c) => c[0])).toEqual(['load-buffer', 'delete-buffer']);
  });

  it('S21: a gated write whose checked line reads #(touch x) runs no command and still types', async () => {
    const { fake, ctx } = rig();
    const p = fake.addPane({ id: '%3', tty: TTY, screen: 'Run this?\n  #(touch /tmp/x)\n❯ 1. Yes' });
    const r = await tmuxWrite(ctx, {}, paneOf(fake), { keys: '', enter: true, expect: 'Run this?\n  #(touch /tmp/x)\n❯ 1. Yes' });
    expect(r).toEqual({ ok: true });
    expect(p.input).toBe('\r');
    expect(fake.shellRuns).toEqual([]);
    expect(gated(fake)[0]?.[0]).toContain('#{C:  ?(touch /tmp/x)}');
  });

  it('hexTokens: one two-digit token per byte', () => {
    expect(hexTokens('\u001b[B\u0003')).toBe('1b 5b 42 03');
    expect(hexTokens(CLEAR_ONE_ROW)).toMatch(/^(?:[0-9a-f]{2} )*[0-9a-f]{2}$/u);
  });
});

describe('the tmux backend', () => {
  it('available: tmux found and 3.2 or later', async () => {
    expect(tmuxVersionOk('tmux 3.1c')).toBe(false);
    expect(tmuxVersionOk('tmux 2.9a')).toBe(false);
    for (const v of ['tmux 3.2a', 'tmux 3.3a', 'tmux 3.4', 'tmux 4.0', 'tmux next-3.6', 'tmux master']) expect(tmuxVersionOk(v), v).toBe(true);
    expect(tmuxVersionOk('tmux')).toBe(false);
    expect(await rig().b.available()).toBe(true);
    expect(await rig({ version: 'tmux 3.1c' }).b.available()).toBe(false);
    const none = createTestContext({ bins: { tmux: null } });
    expect(await new TmuxBackend(none).available()).toBe(false);
  });

  it('findPane binds by the session\'s tty; the pane id, tty and foreground come from tmux and ps', async () => {
    const { fake, b, exec } = rig();
    fake.addPane({ id: '%1', tty: '/dev/pts/1' });
    fake.addPane({ id: '%3', tty: TTY, pid: 101 });
    const pane = await b.findPane({ tty: 'pts/3', pid: 202 });
    expect(pane).toEqual({ id: 'tmux:%3', backend: 'tmux', handle: '%3', tty: TTY, foreground: 'claude', pid: 202 });
    const ps = exec.calls.find((c) => c.file === '/usr/bin/ps');
    expect(ps?.args).toEqual(['-t', 'pts/3', '-o', 'pid=,stat=,comm=']);
    expect(ps?.opts.env?.LC_ALL).toBe('C');
    expect(fake.calls.find((c) => c[0] === 'list-panes')).toEqual(['list-panes', '-a', '-F', '#{pane_id}\t#{pane_tty}\t#{pane_pid}\t#{pane_height}\t#{pane_dead}']);
  });

  it('S22: a stored paneId names no pane: a session on another tty is not bound to the server\'s %3', async () => {
    const { fake, b, ctx } = rig();
    fake.addPane({ id: '%3', tty: TTY });
    ctx.store.emit({ type: 'session.added', sid: 's1', account: 0, data: { session: session({ sid: 's1', tty: 'pts/9', paneId: '%3' }) } });
    expect(await b.findPane({ sid: 's1' })).toBeNull();
    expect(b.lastError).toEqual({ code: 'not_found', reason: NO_PANE });
  });

  it('a dead pane is never bound; no server is no pane', async () => {
    const { fake, b } = rig();
    fake.addPane({ id: '%3', tty: TTY, dead: true });
    expect(await b.findPane({ tty: TTY })).toBeNull();
    fake.noServer = true;
    expect(await b.findPane({ tty: TTY })).toBeNull();
    expect(b.lastError?.code).toBe('not_found');
  });

  it('a session is looked up by sid (its tty and pid), only among this machine\'s own sessions', async () => {
    const { fake, b, ctx } = rig();
    fake.addPane({ id: '%3', tty: TTY });
    ctx.store.emit({ type: 'session.added', sid: 'mine', account: 0, data: { session: session({ sid: 'mine', tty: 'pts/3' }) } });
    expect((await b.findPane({ sid: 'mine' }))?.handle).toBe('%3');
    expect(await b.findPane({ sid: 'nobody' })).toBeNull();
    expect(b.lastError?.reason).toBe('the session is not attached to a terminal');
  });

  describe('pid ancestry, when the session has no tty', () => {
    let root: string;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'jantar-proc-'));
      // 202 (claude) <- 150 (env) <- 101 (the pane's shell) <- 1
      const stat = async (pid: number, comm: string, ppid: number) => {
        await mkdir(join(root, String(pid)), { recursive: true });
        await writeFile(join(root, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304`);
      };
      await stat(202, 'claude', 150);
      await stat(150, 'a (weird) name', 101);
      await stat(101, 'bash', 1);
      await stat(303, 'claude', 77);
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('reads the parent past a (comm) holding spaces and parens', () => {
      expect(parentFromStat('150 (a (weird) name) S 101 150 150 0')).toBe(101);
      expect(parentFromStat('garbage')).toBeNull();
    });

    it('walks up to the pane\'s process', async () => {
      expect(await ancestorsOf(202, root)).toEqual([202, 150, 101]);
      const { fake, b } = rig({ procRoot: root });
      fake.addPane({ id: '%5', tty: '/dev/pts/5', pid: 101 });
      expect((await b.findPane({ pid: 202 }))?.handle).toBe('%5');
      // 303 does not descend from any pane
      expect(await b.findPane({ pid: 303 })).toBeNull();
    });

    it('a known tty wins: ancestry is never tried then', async () => {
      const { fake, b } = rig({ procRoot: root });
      fake.addPane({ id: '%5', tty: '/dev/pts/5', pid: 101 });
      expect(await b.findPane({ tty: '/dev/pts/8', pid: 202 })).toBeNull();
    });
  });

  it('parsePaneRows keeps only well-formed rows', () => {
    expect(parsePaneRows('%3\t/dev/pts/3\t101\t50\t0\n%4\t/dev/ttys004\t1\t50\t0\n%x\t/dev/pts/5\t1\t50\t0\n%6\t/dev/pts/6\t7\t24\t1\n')).toEqual([
      { id: '%3', tty: '/dev/pts/3', pid: 101, height: 50, dead: false },
      { id: '%6', tty: '/dev/pts/6', pid: 7, height: 24, dead: true },
    ]);
  });

  it('readScreen reads the tty, the height and the screen in one call, and refuses a pane on another tty', async () => {
    const { fake, b } = rig();
    const p = fake.addPane({ id: '%3', tty: TTY, height: 40, screen: 'one  \ntwo\nthree   ' });
    const r = await b.readScreen(paneOf(fake), { lines: 2 });
    expect(r).toMatchObject({ ok: true, raw: 'one  \ntwo\nthree   ', tabRows: 40 });
    expect(r.ok && r.text).toBe('two\nthree');
    expect(fake.calls).toEqual([['display-message', '-p', '-t', '%3', '#{pane_tty}\t#{pane_height}', ';', 'capture-pane', '-p', '-N', '-t', '%3']]);
    p.tty = '/dev/pts/7';
    expect(await b.readScreen(paneOf(fake))).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('readInputBox reads Claude\'s box off the screen, unstyled', async () => {
    const { fake, b } = rig();
    const rule = '─'.repeat(60);
    fake.addPane({ id: '%3', tty: TTY, screen: `Claude\n${rule}\n❯ draft text\n${rule}\n  ? for shortcuts` });
    expect(await b.readInputBox(paneOf(fake))).toEqual({ ok: true, text: 'draft text', styled: false });
  });

  it('type: the text, then 250 ms later one gated Enter in its own call', async () => {
    const { fake, b, ctx } = rig();
    const p = fake.addPane({ id: '%3', tty: TTY });
    const typing = b.type(paneOf(fake), 'fix the tests;');
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(p.input).toBe('fix the tests;');
    expect(gated(fake).length).toBe(1);
    ctx.clock.advance(249);
    await new Promise((r) => setImmediate(r));
    expect(gated(fake).length).toBe(1);
    expect(await settle(ctx, typing)).toEqual({ ok: true });
    expect(p.input).toBe('fix the tests;\r');
    expect(gated(fake).map((g) => g[1].replace(/jantar-[0-9A-Z]{26}/u, 'B'))).toEqual(['paste-buffer -d -r -b B -t %3', 'send-keys -t %3 Enter']);
  });

  it('type refuses control characters as Terminal.app does', async () => {
    const { fake, b } = rig();
    fake.addPane({ id: '%3', tty: TTY });
    expect(await b.type(paneOf(fake), 'a\u0007b')).toMatchObject({ ok: false, code: 'unsupported' });
    expect(fake.calls).toEqual([]);
  });

  it('pressEnter is one Enter; clearInput is the one-row clear and its Return', async () => {
    const { fake, b } = rig();
    const p = fake.addPane({ id: '%3', tty: TTY });
    expect(await b.pressEnter(paneOf(fake))).toEqual({ ok: true });
    expect(p.input).toBe('\r');
    p.input = '';
    expect(await b.clearInput(paneOf(fake))).toEqual({ ok: true });
    expect(p.input).toBe(`${CLEAR_ONE_ROW}\r`);
  });

  it('pressKey: the Mac\'s bytes for every key, then one Enter, in one step', async () => {
    const want: Array<[Parameters<TmuxBackend['pressKey']>[1], number, string]> = [
      ['down', 2, `${DOWN}${DOWN}\r`],
      ['up', 1, '\u001b[A\r'],
      ['enter', 1, '\r'],
      ['shiftTab', 1, '\u001b[Z\r'],
      ['interrupt', 1, '\u0003\r'],
      ['quit', 1, '\u0003\u0003\r'],
      ['escape', 1, '\u001b[27u\r'],
    ];
    for (const [key, repeat, bytes] of want) {
      const { fake, b } = rig();
      const p = fake.addPane({ id: '%3', tty: TTY });
      expect(await b.pressKey(paneOf(fake), key, { repeat }), key).toEqual({ ok: true });
      expect(p.input, key).toBe(bytes);
      expect(gated(fake).length).toBe(1);
      expect(gated(fake)[0]?.[1]).toMatch(DO_RE);
    }
  });

  it('pressKey keeps the Mac\'s key rules: Escape behind escapeVerified, a bad repeat, text without expect', async () => {
    const { fake, b } = rig({ settings: { controls: { escapeVerified: false } } });
    fake.addPane({ id: '%3', tty: TTY });
    expect(await b.pressKey(paneOf(fake), 'escape')).toMatchObject({ ok: false, code: 'unsupported' });
    expect(await b.pressKey(paneOf(fake), 'enter', { repeat: 2 })).toMatchObject({ ok: false });
    expect(await b.pressKey(paneOf(fake), 'down', { text: 'teal' })).toMatchObject({ ok: false });
    expect(fake.calls).toEqual([]);
  });

  it('compare-and-type: an exact check on a capture first; a screen that no longer shows the text types nothing', async () => {
    const { fake, b } = rig();
    const p = fake.addPane({ id: '%3', tty: TTY, screen: 'Do you want to proceed?\n❯ 1. Yes\n  2. No' });
    expect(await b.pressKey(paneOf(fake), 'down', { expect: 'Do you want to proceed?\n❯ 1. Yes\n  2. No' })).toEqual({ ok: true });
    expect(p.input).toBe(`${DOWN}\r`);
    p.input = '';
    fake.calls.length = 0;
    // a capture that misses it (case counts, as Terminal's typeif): no gate is even tried
    expect(await b.pressKey(paneOf(fake), 'down', { expect: 'do you want to proceed?' })).toMatchObject({ ok: false, code: 'changed' });
    expect(fake.calls.map((c) => c[0])).toEqual(['display-message']);
    expect(p.input).toBe('');
  });

  it('compare-and-type: a screen that changes between the capture and the write gives changed, nothing typed, the buffer gone', async () => {
    const { fake, b } = rig();
    const p = fake.addPane({ id: '%3', tty: TTY, screen: 'Which colour?\n❯ 1. Red\n  2. Type something.' });
    fake.beforeGate = () => {
      p.screen = 'Claude is working…';
    };
    const r = await b.pressKey(paneOf(fake), 'down', { expect: 'Which colour?\n❯ 1. Red\n  2. Type something.', text: 'teal' });
    expect(r).toMatchObject({ ok: false, code: 'changed' });
    expect(p.input).toBe('');
    expect(fake.buffers.size).toBe(0);
    expect(fake.inputs).toEqual(['teal']);
  });

  it('copy mode entered between the capture and the write: nothing typed', async () => {
    const { fake, b } = rig();
    const p = fake.addPane({ id: '%3', tty: TTY, screen: 'Do you want to proceed?\n❯ 1. Yes' });
    fake.beforeGate = () => {
      p.inMode = true;
    };
    expect(await b.pressKey(paneOf(fake), 'enter', { expect: 'Do you want to proceed?\n❯ 1. Yes' })).toMatchObject({ ok: false, code: 'changed' });
    expect(p.input).toBe('');
  });

  it('focus has nothing to show; there is no screenshot', async () => {
    const { fake, b } = rig();
    fake.addPane({ id: '%3', tty: TTY });
    expect(await b.focus(paneOf(fake))).toMatchObject({ ok: false, code: 'unsupported' });
    expect((b as { getScreenshot?: unknown }).getScreenshot).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });

  it('openWindow: a detached 200x50 session, then the line typed into its shell with its Return', async () => {
    const { fake, b } = rig();
    const command = `cd -- /home/sam/code/api-server && env CLAUDE_CONFIG_DIR=/home/sam/.claude-work /home/sam/.local/bin/claude --permission-mode default --session-id 5e1f0000-0000-4000-8000-000000000001 --name ${FLEET_SECRET}`;
    const r = await b.openWindow(command);
    expect(r).toEqual({ ok: true, tty: '/dev/pts/20', windowId: '%0' });
    const create = fake.calls.find((c) => c[0] === 'new-session') as string[];
    expect(create.slice(0, 3)).toEqual(['new-session', '-d', '-s']);
    expect(create[3]).toMatch(/^jantar-[0-9a-z]{10}$/u);
    expect(create.slice(4)).toEqual(['-x', '200', '-y', '50', '-P', '-F', '#{pane_id}\t#{pane_tty}']);
    expect(fake.pane('%0').input).toBe(`${command}\r`);
    for (const c of fake.calls) for (const a of c) expect(a).not.toContain(FLEET_SECRET);
  });

  it('openWindow refuses control characters, an empty or too long line, and no tmux', async () => {
    const { fake, b } = rig();
    expect(await b.openWindow('echo a\necho b')).toMatchObject({ ok: false, code: 'unsupported' });
    expect(await b.openWindow('  ')).toMatchObject({ ok: false });
    expect(await b.openWindow(`echo ${'x'.repeat(5000)}`)).toMatchObject({ ok: false, code: 'unsupported' });
    expect(fake.calls.filter((c) => c[0] !== '-V')).toEqual([]);
    const none = new TmuxBackend(createTestContext({ bins: { tmux: null } }));
    expect(await none.openWindow('echo hi')).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('foregroundOf: exact with the session\'s pid, gone with no process on the tty', async () => {
    expect(await rig().b.foregroundOf(paneOf(createFakeTmux()))).toBe('claude');
    expect(await rig({ ps: '  101 Ss+  bash\n  202 S    claude\n' }).b.foregroundOf(paneOf(createFakeTmux()))).toBe('shell');
    expect(await rig({ ps: '' }).b.foregroundOf(paneOf(createFakeTmux()))).toBe('gone');
    expect(await rig().b.foregroundOf({ ...paneOf(createFakeTmux()), backend: 'terminal-app' })).toBe('other');
  });
});

describe('S21 across every operation: no prompt, dialog-row or launch text in any argv item', () => {
  it('only the gate carries screen lines, and only as #{C:} patterns', async () => {
    const { fake, b, ctx } = rig();
    const p = fake.addPane({ id: '%3', tty: TTY, screen: `Question ${FLEET_SECRET}\n❯ 1. Type something.` });
    await settle(ctx, b.type(paneOf(fake), `prompt ${FLEET_SECRET};`));
    await b.pressKey(paneOf(fake), 'enter', { expect: `Question ${FLEET_SECRET}\n❯ 1. Type something.`, text: `answer ${FLEET_SECRET}` });
    await b.pressEnter(paneOf(fake));
    await b.clearInput(paneOf(fake));
    await b.readScreen(paneOf(fake));
    await b.openWindow(`echo ${FLEET_SECRET}`);
    expect(fake.inputs).toEqual([`prompt ${FLEET_SECRET};`, `answer ${FLEET_SECRET}`, `echo ${FLEET_SECRET}`]);
    for (const c of fake.calls) {
      for (const [i, a] of c.entries()) {
        if (!a.includes(FLEET_SECRET)) continue;
        // the if-shell gate, and there only inside #{C:…}
        expect(c[0]).toBe('if-shell');
        expect(i).toBe(4);
        expect(a).toContain(`#{C:Question ${FLEET_SECRET}}`);
      }
    }
    expect(p.input).toContain(`answer ${FLEET_SECRET}`);
    expect(fake.shellRuns).toEqual([]);
  });
});
