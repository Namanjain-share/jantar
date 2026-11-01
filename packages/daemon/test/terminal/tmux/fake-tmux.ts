/**
 * A scripted tmux for the argv-level tests: an ExecHandler that answers the
 * calls the tmux backend makes, on a model of one server's panes, and
 * records every byte a pane would get. It understands only the contract
 * (spec 4.2): the gate grammar the backend builds (`#{&&:a,b}`, `#{==:a,b}`,
 * `#{C:pattern}` and the pane variables) and the three commands a gated
 * <do> may hold. Anything else is an error, and a `#(` anywhere in a format
 * is recorded as a shell run (it must never happen). Nothing is spawned.
 */
import type { ExecCall, ExecHandler } from '../../../src/core/testing.js';
import type { ExecResult } from '../../../src/contracts.js';

export const TMUX_BIN = '/usr/bin/tmux';
export const SOCKET = '/synthetic/tmux-test/tmux.sock';

export interface FakePane {
  id: string;
  tty: string;
  pid: number;
  height: number;
  screen: string;
  inMode?: boolean;
  sync?: boolean;
  inputOff?: boolean;
  dead?: boolean;
  /** The app asked for bracketed paste (paste-buffer -p brackets only then). */
  bracketed?: boolean;
  /** Every byte the pane got, in order. */
  input: string;
}

export interface FakeTmux {
  handler: ExecHandler;
  panes: FakePane[];
  buffers: Map<string, string>;
  /** Formats that held `#(`: a command tmux would have run. Must stay empty. */
  shellRuns: string[];
  /** Every tmux argv (without the -S socket). */
  calls: string[][];
  /** stdin of every call that had one. */
  inputs: string[];
  version: string;
  /** Set to make every call fail as if no server were running. */
  noServer: boolean;
  addPane(p: Partial<FakePane> & Pick<FakePane, 'id' | 'tty'>): FakePane;
  pane(id: string): FakePane;
  /** Run a hook just before a gate is evaluated (a screen that changes between the capture and the write). */
  beforeGate: (() => void) | null;
}

const res = (r: Partial<ExecResult>): Partial<ExecResult> => ({ code: 0, stdout: '', stderr: '', ...r });

/** fnmatch(`*pat*`, line) with only `?` and `*` special, as tmux's `#{C:}` with GLOB_SPECIALS gone. */
function globFinds(pattern: string, line: string): boolean {
  const re = [...pattern].map((ch) => (ch === '?' ? '.' : ch === '*' ? '.*' : ch.replace(/[.*+?^${}()|[\]\\]/u, '\\$&'))).join('');
  return new RegExp(`^.*${re}.*$`, 'su').test(line);
}

/** The index of the matching `}` for a `#{` that opens at `at`. */
function closeOf(s: string, at: number): number {
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    if (s[i] === '#' && s[i + 1] === '{') {
      depth++;
      i++;
    } else if (s[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced format: ${s}`);
}

/** Split `a,b` at the first comma outside any `#{…}`. */
function splitTop(s: string): [string, string] {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '#' && s[i + 1] === '{') {
      depth++;
      i++;
    } else if (s[i] === '}') depth--;
    else if (s[i] === ',' && depth === 0) return [s.slice(0, i), s.slice(i + 1)];
  }
  throw new Error(`no operands: ${s}`);
}

export function createFakeTmux(opts: { version?: string } = {}): FakeTmux {
  const fake: FakeTmux = {
    handler: () => undefined,
    panes: [],
    buffers: new Map(),
    shellRuns: [],
    calls: [],
    inputs: [],
    version: opts.version ?? 'tmux 3.3a',
    noServer: false,
    beforeGate: null,
    addPane(p) {
      const pane: FakePane = { pid: 4000 + fake.panes.length, height: 50, screen: '', input: '', ...p };
      fake.panes.push(pane);
      return pane;
    },
    pane(id) {
      const p = fake.panes.find((x) => x.id === id);
      if (!p) throw new Error(`no pane ${id}`);
      return p;
    },
  };

  const vars = (p: FakePane): Record<string, string> => ({
    pane_id: p.id,
    pane_tty: p.tty,
    pane_pid: String(p.pid),
    pane_height: String(p.height),
    pane_in_mode: p.inMode ? '1' : '0',
    pane_synchronized: p.sync ? '1' : '0',
    pane_input_off: p.inputOff ? '1' : '0',
    pane_dead: p.dead ? '1' : '0',
  });

  /** Expand a format the way the backend uses them; `#(` is recorded, never run. */
  function expand(fmt: string, p: FakePane): string {
    if (fmt.includes('#(')) fake.shellRuns.push(fmt);
    let out = '';
    for (let i = 0; i < fmt.length; i++) {
      if (fmt[i] !== '#') {
        out += fmt[i];
        continue;
      }
      if (fmt[i + 1] !== '{') throw new Error(`a lone # in a format: ${fmt}`);
      const end = closeOf(fmt, i);
      out += evalBraced(fmt.slice(i + 2, end), p);
      i = end;
    }
    return out;
  }

  function evalBraced(body: string, p: FakePane): string {
    if (body.startsWith('&&:')) {
      const [a, b] = splitTop(body.slice(3));
      return truthy(expand(a, p)) && truthy(expand(b, p)) ? '1' : '0';
    }
    if (body.startsWith('==:')) {
      const [a, b] = splitTop(body.slice(3));
      return expand(a, p) === expand(b, p) ? '1' : '0';
    }
    if (body.startsWith('C:')) {
      const pattern = expand(body.slice(2), p);
      const lines = p.screen.split('\n').map((l) => l.replace(/[ \t\r\n\v\f]+$/u, ''));
      const at = lines.findIndex((l) => globFinds(pattern, l));
      return String(at + 1);
    }
    const v = vars(p)[body];
    if (v === undefined) throw new Error(`unknown format variable ${body}`);
    return v;
  }

  const truthy = (v: string) => v !== '' && v !== '0';

  function target(args: string[]): FakePane | null {
    const i = args.indexOf('-t');
    const id = i >= 0 ? args[i + 1] : undefined;
    return fake.panes.find((p) => p.id === id) ?? null;
  }

  /** Run one command of a gated <do> or <else>, as tmux would. Unknown shapes throw. */
  function runCommand(cmd: string): string {
    const w = cmd.split(' ');
    if (w[0] === 'send-keys' && w[1] === '-t' && w[3] === '-H') {
      const p = fake.pane(w[2] as string);
      for (const h of w.slice(4)) {
        if (!/^[0-9a-f]{2}$/u.test(h)) throw new Error(`bad hex ${h}`);
        p.input += String.fromCharCode(parseInt(h, 16));
      }
      return '';
    }
    if (w[0] === 'send-keys' && w[1] === '-t' && w[3] === 'Enter' && w.length === 4) {
      fake.pane(w[2] as string).input += '\r';
      return '';
    }
    if (w[0] === 'paste-buffer') {
      const m = /^paste-buffer( -p)? -d -r -b (jantar-[0-9A-Z]{26}) -t (%\d+)$/u.exec(cmd);
      if (!m) throw new Error(`bad paste-buffer ${cmd}`);
      const text = fake.buffers.get(m[2] as string);
      if (text === undefined) throw new Error('no buffer');
      const p = fake.pane(m[3] as string);
      p.input += m[1] && p.bracketed ? `\u001b[200~${text}\u001b[201~` : text;
      fake.buffers.delete(m[2] as string);
      return '';
    }
    if (w[0] === 'delete-buffer' && w[1] === '-b' && w.length === 3) {
      fake.buffers.delete(w[2] as string);
      return '';
    }
    if (cmd === 'display-message -p JANTAR-CHANGED') return 'JANTAR-CHANGED\n';
    throw new Error(`not a command the contract allows: ${cmd}`);
  }

  fake.handler = (call: ExecCall) => {
    if (call.file !== TMUX_BIN) return undefined;
    let args = [...call.args];
    if (args[0] === '-S') {
      if (args[1] !== SOCKET) return res({ code: 1, stderr: 'wrong socket' });
      args = args.slice(2);
    }
    fake.calls.push(args);
    if (call.opts.input !== undefined) fake.inputs.push(call.opts.input);
    if (call.opts.env?.TMUX !== undefined || call.opts.env?.TMUX_PANE !== undefined) return res({ code: 1, stderr: 'TMUX leaked into the env' });
    if (args[0] === '-V') return res({ stdout: `${fake.version}\n` });
    if (fake.noServer) return res({ code: 1, stderr: 'no server running on /tmp/tmux-1000/default' });
    try {
      switch (args[0]) {
        case 'list-panes': {
          if (args[1] !== '-a' || args[2] !== '-F') throw new Error('list-panes shape');
          return res({ stdout: fake.panes.map((p) => `${expand(args[3] as string, p)}\n`).join('') });
        }
        case 'display-message': {
          const p = target(args);
          if (!p) return res({ code: 1, stderr: `can't find pane: ${args[3]}` });
          const fmt = args[4] as string;
          let out = `${expand(fmt, p)}\n`;
          if (args[5] === ';') {
            if (args.slice(6).join(' ') !== `capture-pane -p -N -t ${p.id}`) throw new Error('capture shape');
            out += `${p.screen}\n`;
          }
          return res({ stdout: out });
        }
        case 'load-buffer': {
          if (args[1] !== '-b' || args[3] !== '-' || args.length !== 4) throw new Error('load-buffer shape');
          fake.buffers.set(args[2] as string, call.opts.input ?? '');
          return res({});
        }
        case 'delete-buffer': {
          fake.buffers.delete(args[2] as string);
          return res({});
        }
        case 'if-shell': {
          if (args[1] !== '-F' || args[2] !== '-t' || args.length !== 7) throw new Error('if-shell shape');
          const p = target(args);
          if (!p) return res({ code: 1, stderr: `can't find pane: ${args[3]}` });
          fake.beforeGate?.();
          const branch = truthy(expand(args[4] as string, p)) ? (args[5] as string) : (args[6] as string);
          const out = branch.split(' ; ').map(runCommand).join('');
          return res({ stdout: out });
        }
        case 'new-session': {
          const id = `%${fake.panes.length}`;
          const p = fake.addPane({ id, tty: `/dev/pts/${20 + fake.panes.length}`, height: Number(args[args.indexOf('-y') + 1]) });
          return res({ stdout: `${expand(args[args.indexOf('-F') + 1] as string, p)}\n` });
        }
        default:
          throw new Error(`unexpected tmux command ${args[0]}`);
      }
    } catch (e) {
      return res({ code: 1, stderr: String(e) });
    }
  };
  return fake;
}
