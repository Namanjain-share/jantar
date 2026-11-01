/**
 * The fake interactive Claude (runtime/fake-claude-tui.mjs) the Docker
 * end-to-end suite runs as `claude` on its Linux nodes. Driven over pipes on
 * every platform (no raw mode there; the rest is the same code), and under a
 * pseudo-terminal, util-linux `script`, only when process.platform is
 * linux: macOS's BSD script takes other flags, so that case skips itself
 * there with a note.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dialogFixture, encodeProjectDir, perfBudgetMs } from '../src/index.js';

const TUI = fileURLToPath(new URL('../runtime/fake-claude-tui.mjs', import.meta.url));
const BUILT_DIALOGS = fileURLToPath(new URL('../dist/dialogs.js', import.meta.url));
const LINUX = process.platform === 'linux';
const HAS_SCRIPT = LINUX && spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0;

const DOWN = '\u001b[B';
const SHIFT_TAB = '\u001b[Z';
/** Past Claude's 100 ms paste window, so a Return submits. */
const AFTER_PASTE_MS = 250;

interface Rec {
  at: number;
  event: string;
  [k: string]: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + perfBudgetMs(ms);
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

let root: string;
let home: string;
let ctl: string;
let work: string;
const running: ChildProcessWithoutNullStreams[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'jantar-fake-tui-')));
  home = join(root, 'home');
  ctl = join(root, 'ctl');
  work = join(root, 'work', 'api-server');
  await mkdir(home, { recursive: true });
  await mkdir(work, { recursive: true });
});

afterEach(async () => {
  for (const c of running.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
});

/** One fake Claude: its pid, sid, files and the keys to type into it. */
class Tui {
  readonly sid: string;
  readonly child: ChildProcessWithoutNullStreams;
  output = '';
  private exited: Promise<number | null>;

  constructor(
    args: string[],
    opts: { env?: Record<string, string>; sid?: string; pty?: boolean } = {},
  ) {
    this.sid = opts.sid ?? randomUUID();
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      FAKE_CLAUDE_CTL: ctl,
      FAKE_CLAUDE_REPLY_MS: '50',
      ...opts.env,
    };
    const argv = [...args];
    if (!argv.includes('--') && !argv.includes('--session-id') && !argv.includes('--resume')) argv.unshift('--session-id', this.sid);
    if (opts.pty) {
      // util-linux script: -q quiet, -f flush, -e the child's exit code, -c the command (one shell word list).
      const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
      const cmd = [process.execPath, TUI, ...argv].map(q).join(' ');
      this.child = spawn('script', ['-qfec', cmd, '/dev/null'], { cwd: work, env: { ...env, COLUMNS: '100', LINES: '30' } });
    } else {
      this.child = spawn(process.execPath, [TUI, ...argv], { cwd: work, env });
    }
    running.push(this.child);
    this.child.stdout.on('data', (d: Buffer) => (this.output += d.toString('utf8')));
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => {});
    this.exited = new Promise((r) => this.child.on('close', (code) => r(code)));
  }

  async records(): Promise<Rec[]> {
    const text = await readFile(join(ctl, `${this.sid}.events.jsonl`), 'utf8').catch(() => '');
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Rec);
  }

  async waitFor(event: string, pred: (r: Rec) => boolean = () => true): Promise<Rec> {
    return until(async () => (await this.records()).find((r) => r.event === event && pred(r)), `the "${event}" record`);
  }

  async started(): Promise<Rec> {
    return this.waitFor('start');
  }

  /** The screen as the fake last drew it (one line per row, unwrapped). */
  async screen(): Promise<string[]> {
    const text = await readFile(join(ctl, `${this.sid}.screen.txt`), 'utf8');
    return text.replace(/\n$/, '').split('\n');
  }

  async screenWith(pred: (lines: string[]) => boolean, what: string): Promise<string[]> {
    return until(async () => {
      const lines = await this.screen();
      return pred(lines) ? lines : null;
    }, what);
  }

  type(bytes: string): void {
    this.child.stdin.write(bytes);
  }

  /** Text, then (past the paste window) one Return: how Jantar types a prompt. */
  async prompt(text: string): Promise<void> {
    this.type(text);
    await sleep(AFTER_PASTE_MS);
    this.type('\r');
  }

  async control(cmd: unknown): Promise<void> {
    await mkdir(ctl, { recursive: true });
    await writeFile(join(ctl, `${this.sid}.json`), JSON.stringify(cmd));
    await until(async () => !existsSync(join(ctl, `${this.sid}.json`)), 'the control file to be read');
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    return this.exited;
  }

  exit(): Promise<number | null> {
    return this.exited;
  }
}

/** The transcript lines of `sid` under a config dir, parsed. */
async function transcript(configDir: string, sid: string): Promise<Array<Record<string, unknown>>> {
  const file = join(configDir, 'projects', encodeProjectDir(work), `${sid}.jsonl`);
  const text = await readFile(file, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const userTexts = (entries: Array<Record<string, unknown>>) =>
  entries.filter((e) => e.type === 'user').map((e) => (e.message as { content: unknown }).content);

const sessionFiles = async (configDir: string) => (await readdir(join(configDir, 'sessions')).catch(() => [] as string[])).filter((f) => f.endsWith('.json'));

/** The box Claude draws: a full-width rule, `❯ ` rows, a rule, the mode line. */
function inputBox(lines: string[]): { rows: string[]; mode: string } | null {
  for (let i = lines.length - 1; i > 0; i--) {
    if (!lines[i]!.startsWith('❯') || !/^─{20,}$/.test(lines[i - 1]!)) continue;
    const rows = [lines[i]!];
    let j = i + 1;
    while (j < lines.length && !/^─{20,}$/.test(lines[j]!)) rows.push(lines[j++]!);
    return { rows, mode: (lines[j + 1] ?? '').trim() };
  }
  return null;
}

describe('fake interactive Claude: the session it shows', () => {
  it('writes <config>/sessions/<pid>.json with procStart as ps prints it in UTC, and removes it on exit', async () => {
    const t = new Tui(['--name', 'fix-tests']);
    const start = await t.started();
    const configDir = join(home, '.claude');
    const file = join(configDir, 'sessions', `${String(start.pid)}.json`);
    const json = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(json).toMatchObject({ pid: start.pid, sessionId: t.sid, cwd: work, name: 'fix-tests', kind: 'interactive', entrypoint: 'cli', status: 'idle' });
    const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(start.pid)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, encoding: 'utf8' });
    expect(json.procStart).toBe(ps.stdout.trim());
    expect(json.procStart).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
    expect(await t.close()).toBe(0);
    expect(await sessionFiles(configDir)).toEqual([]);
  });

  it('honours CLAUDE_CONFIG_DIR, --resume and --permission-mode, and prints its version', async () => {
    const configDir = join(home, '.claude-work');
    const sid = randomUUID();
    const t = new Tui(['--resume', sid, '--permission-mode', 'acceptEdits'], { env: { CLAUDE_CONFIG_DIR: configDir }, sid });
    const start = await t.started();
    expect(start.configDir).toBe(configDir);
    expect(await sessionFiles(configDir)).toEqual([`${String(start.pid)}.json`]);
    expect(inputBox(await t.screen())?.mode).toBe('⏵⏵ accept edits on (shift+tab to cycle)');
    await t.prompt('first');
    await until(async () => (await transcript(configDir, sid)).some((e) => e.type === 'assistant'), 'a reply under the config dir');
    await t.close();
    const v = spawnSync(process.execPath, [TUI, '--version'], { encoding: 'utf8' });
    expect(v.stdout).toMatch(/^\d+\.\d+\.\d+ \(Claude Code\)\n$/);
  });

  it('takes every argument after -- as the prompt, flags included, as Claude does', async () => {
    const wanted = randomUUID();
    const t = new Tui(['--', '--session-id', wanted]);
    const configDir = join(home, '.claude');
    // The session id came from no flag: a random one, found by its transcript.
    const sid = await until(async () => {
      const files = await readdir(join(configDir, 'projects', encodeProjectDir(work))).catch(() => [] as string[]);
      return files[0]?.replace(/\.jsonl$/, '');
    }, 'the transcript of a random session id');
    expect(sid).not.toBe(wanted);
    expect(userTexts(await transcript(configDir, sid))).toEqual([`--session-id ${wanted}`]);
    const start = JSON.parse((await readFile(join(ctl, `${sid}.events.jsonl`), 'utf8')).split('\n')[0]!) as Rec;
    expect(start).toMatchObject({ event: 'start', argv: ['--', '--session-id', wanted] });
    await t.close();
  });
});

describe('fake interactive Claude: typing', () => {
  it('submits on a Return past the paste window: the transcript holds the prompt byte for byte, then a reply', async () => {
    const t = new Tui([]);
    await t.started();
    await t.prompt('fix the tests;');
    const configDir = join(home, '.claude');
    const entries = await until(async () => {
      const e = await transcript(configDir, t.sid);
      return e.some((x) => x.type === 'assistant') ? e : null;
    }, 'the reply');
    expect(userTexts(entries)).toEqual(['fix the tests;']);
    const replyText = JSON.stringify(entries.find((e) => e.type === 'assistant'));
    expect(replyText).not.toContain('fix the tests');
    const prompt = (await t.records()).find((r) => r.event === 'prompt');
    expect(prompt).toMatchObject({ chars: 14, lines: 1 });
    expect(JSON.stringify(prompt)).not.toContain('fix the tests');
    await t.close();
  });

  it('makes a Return inside the 100 ms paste window a newline: a two-line prompt goes as one', async () => {
    const t = new Tui([]);
    await t.started();
    t.type('first line\rsecond line');
    const lines = await t.screenWith((l) => (inputBox(l)?.rows.length ?? 0) === 2, 'a two-row draft');
    expect(inputBox(lines)?.rows).toEqual(['❯ first line', '  second line']);
    await sleep(AFTER_PASTE_MS);
    t.type('\r');
    const configDir = join(home, '.claude');
    await until(async () => userTexts(await transcript(configDir, t.sid)).length === 1, 'the prompt');
    expect(userTexts(await transcript(configDir, t.sid))).toEqual(['first line\nsecond line']);
    await t.close();
  });

  it('takes bracketed paste as text, Return included', async () => {
    const t = new Tui([]);
    await t.started();
    t.type('\u001b[200~one\rtwo\u001b[201~');
    await sleep(AFTER_PASTE_MS);
    t.type('\r');
    const configDir = join(home, '.claude');
    await until(async () => userTexts(await transcript(configDir, t.sid)).length === 1, 'the prompt');
    expect(userTexts(await transcript(configDir, t.sid))).toEqual(['one\ntwo']);
    await t.close();
  });

  it('clears a draft as Jantar does (End, then Ctrl+U per row and break), cycles modes on Shift+Tab, and quits on Ctrl+C twice', async () => {
    const t = new Tui([]);
    await t.started();
    t.type('alpha\rbeta');
    await t.screenWith((l) => (inputBox(l)?.rows.length ?? 0) === 2, 'a two-row draft');
    await sleep(AFTER_PASTE_MS);
    t.type(`${'\u001b[F'.repeat(4)}${'\u0015'.repeat(10)}`);
    await t.screenWith((l) => inputBox(l)?.rows.join('|') === '❯ ', 'an empty box');
    t.type(SHIFT_TAB);
    await t.screenWith((l) => inputBox(l)?.mode === '⏵⏵ accept edits on (shift+tab to cycle)', 'accept edits');
    t.type(`${SHIFT_TAB}\r`);
    await t.screenWith((l) => inputBox(l)?.mode === '⏸ plan mode on (shift+tab to cycle)', 'plan mode');
    expect(userTexts(await transcript(join(home, '.claude'), t.sid))).toEqual([]);
    t.type('\u0003');
    await t.screenWith((l) => inputBox(l)?.mode === 'Press Ctrl-C again to exit', 'the exit hint');
    t.type('\u0003');
    expect(await t.exit()).toBe(0);
  });
});

describe('fake interactive Claude: dialogs from DIALOG_FIXTURES', () => {
  const create = dialogFixture('PERM_CREATE_2');
  const inline = { name: create.name, screen: create.screen, rows: create.expected.dialog!.options.map((o) => o.label), current: create.expected.dialog!.current };

  it('shows the screen as the fixture has it and records the row a key sequence chose', async () => {
    const t = new Tui([]);
    await t.started();
    await t.control({ dialog: inline });
    expect(await t.screenWith((l) => l.join('\n') === create.screen, 'the fixture screen')).toEqual(create.screen.split('\n'));
    // What the daemon types for option 1: the fixture's bytes, then the one Return.
    t.type(`${create.bytes[1]!}\r`);
    const chosen = await t.waitFor('chosen');
    expect(chosen).toMatchObject({ dialog: 'PERM_CREATE_2', row: 1, label: 'No' });
    const keys = (await t.records()).filter((r) => r.event === 'keys');
    expect(keys.map((k) => k.bytes)).toEqual([`${DOWN}\r`]);
    expect(inputBox(await t.screen())).not.toBeNull();
    await t.close();
  });

  it.skipIf(!existsSync(BUILT_DIALOGS))('looks a fixture up by name in the built fixtures (dist/dialogs.js)', async () => {
    const t = new Tui([]);
    await t.started();
    await t.control({ dialog: 'PERM_BASH_PREFIX' });
    await t.screenWith((l) => l.join('\n') === dialogFixture('PERM_BASH_PREFIX').screen, 'PERM_BASH_PREFIX');
    t.type(`${DOWN}${DOWN}${DOWN}\r`);
    expect(await t.waitFor('chosen')).toMatchObject({ row: 3, label: 'No' });
    await t.close();
  });

  it('swaps the screen on time and records no key when nothing was typed', async () => {
    const t = new Tui([]);
    await t.started();
    const twin = dialogFixture('PERM_BASH_TWIN');
    await t.control({ dialog: inline, swapTo: { name: twin.name, screen: twin.screen }, swapAfterMs: 150 });
    expect(await t.waitFor('swapped')).toMatchObject({ from: 'PERM_CREATE_2', to: 'PERM_BASH_TWIN' });
    await t.screenWith((l) => l.join('\n') === twin.screen, 'the twin');
    expect((await t.records()).filter((r) => r.event === 'keys' || r.event === 'chosen')).toEqual([]);
    await t.close();
  });

  it('draws a line on the screen only, never in the transcript', async () => {
    const t = new Tui([]);
    await t.started();
    await t.control({ say: 'screen-only-line-7d1' });
    await t.screenWith((l) => l.includes('● screen-only-line-7d1'), 'the line');
    await t.prompt('go');
    await until(async () => (await transcript(join(home, '.claude'), t.sid)).some((e) => e.type === 'assistant'), 'the reply');
    expect(JSON.stringify(await transcript(join(home, '.claude'), t.sid))).not.toContain('screen-only-line-7d1');
    await t.close();
  });
});

describe('fake interactive Claude: PermissionRequest hooks', () => {
  /** A hook program: records its stdin and argv, prints `decision` (or nothing), sleeps first when told to. */
  async function hookProgram(name: string, decision: unknown, sleepMs = 0): Promise<string> {
    const file = join(root, `${name}.mjs`);
    const log = join(root, `${name}.log`);
    await writeFile(
      file,
      [
        "import { appendFileSync } from 'node:fs';",
        "let input = '';",
        "process.stdin.on('data', (d) => (input += d));",
        "process.stdin.on('end', () => {",
        `  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), ppid: process.ppid, input: JSON.parse(input) }) + '\\n');`,
        `  setTimeout(() => {`,
        `    const d = ${JSON.stringify(decision)};`,
        "    if (d) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } }) + '\\n');",
        `  }, ${sleepMs});`,
        '});',
        '',
      ].join('\n'),
    );
    await chmod(file, 0o755);
    return file;
  }

  async function hookLog(name: string): Promise<Array<{ argv: string[]; ppid: number; input: Record<string, unknown> }>> {
    const text = await readFile(join(root, `${name}.log`), 'utf8').catch(() => '');
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { argv: string[]; ppid: number; input: Record<string, unknown> });
  }

  async function settings(hooks: unknown): Promise<void> {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PermissionRequest: [{ matcher: '*', hooks }] } }));
  }

  const q = (s: string) => `"${s}"`;

  it('runs a shell-form hook, applies its allow, and resolves the ask', async () => {
    const prog = await hookProgram('shell', { behavior: 'allow' });
    await settings([{ type: 'command', command: `${q(process.execPath)} ${q(prog)} --wait`, timeout: 60 }]);
    const t = new Tui([]);
    const start = await t.started();
    await t.control({ permission: { tool_name: 'Bash', tool_input: { command: 'pnpm test' } } });
    expect(await t.waitFor('decision')).toMatchObject({ by: 'hook', behavior: 'allow' });
    const [run] = await hookLog('shell');
    expect(run?.argv).toEqual(['--wait']);
    expect(run?.input).toMatchObject({ session_id: t.sid, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'pnpm test' }, cwd: work });
    expect(run?.input.transcript_path).toBe(join(home, '.claude', 'projects', encodeProjectDir(work), `${t.sid}.jsonl`));
    expect(start.pid).toBeGreaterThan(0);
    const hook = (await t.records()).find((r) => r.event === 'hook' && r.hook === 'PermissionRequest');
    expect(hook).toMatchObject({ form: 'shell', code: 0, decision: { behavior: 'allow' } });
    const entries = await transcript(join(home, '.claude'), t.sid);
    const contents = entries.flatMap((e) => {
      const c = (e.message as { content?: unknown } | undefined)?.content;
      return Array.isArray(c) ? (c as Array<{ type?: string; is_error?: boolean; name?: string }>) : [];
    });
    expect(contents.find((c) => c.type === 'tool_use')?.name).toBe('Bash');
    expect(contents.find((c) => c.type === 'tool_result')?.is_error).toBe(false);
    await t.screenWith((l) => inputBox(l) !== null, 'the input box back');
    await t.close();
  });

  it('runs an exec-form hook (command + args, no shell) and applies its deny', async () => {
    const prog = await hookProgram('exec', { behavior: 'deny', message: 'Denied from Jantar', interrupt: false });
    await settings([{ type: 'command', command: process.execPath, args: [prog, '--wait'], onFailure: 'continue', timeout: 60 }]);
    const t = new Tui([]);
    const start = await t.started();
    await t.control({ permission: { tool_name: 'Write', tool_input: { file_path: '/synthetic/a.txt', content: 'x' } } });
    expect(await t.waitFor('decision')).toMatchObject({ by: 'hook', behavior: 'deny' });
    const [run] = await hookLog('exec');
    expect(run?.argv).toEqual(['--wait']);
    // No shell in between: Claude (here the fake) is the hook's parent.
    expect(run?.ppid).toBe(start.pid);
    expect((await t.records()).find((r) => r.event === 'hook')).toMatchObject({ form: 'exec', decision: { behavior: 'deny' } });
    await t.close();
  });

  it('keeps the terminal ask when no hook decides, and kills a held hook when the terminal answers first', async () => {
    const prog = await hookProgram('held', { behavior: 'allow' }, 60_000);
    await settings([{ type: 'command', command: `${q(process.execPath)} ${q(prog)} --wait`, timeout: 86400 }]);
    const t = new Tui([]);
    await t.started();
    await t.control({ permission: { tool_name: 'Bash', tool_input: { command: 'date > a.txt' } } });
    const lines = await t.screenWith((l) => l.includes(' Do you want to proceed?'), 'the terminal ask');
    expect(lines).toContain('   date > a.txt');
    await until(async () => (await hookLog('held')).length === 1, 'the hook to start');
    t.type('\r');
    expect(await t.waitFor('decision')).toMatchObject({ by: 'terminal', behavior: 'allow' });
    expect(await t.waitFor('hook')).toMatchObject({ hook: 'PermissionRequest', decision: null });
    await t.close();
  });
});

describe.skipIf(!HAS_SCRIPT)('fake interactive Claude under a pseudo-terminal (Linux, util-linux script)', () => {
  it('reads raw keys from a tty: its size, no echo of the draft, the paste window, the session file and exit', async () => {
    const t = new Tui([], { pty: true });
    const start = await t.started();
    expect(start).toMatchObject({ tty: true });
    const configDir = join(home, '.claude');
    expect(await sessionFiles(configDir)).toEqual([`${String(start.pid)}.json`]);
    expect(start.cols).toBe(100);
    t.type('hello');
    // Raw mode: the draft reaches the fake before any Return (a cooked tty would hold the line back).
    await t.screenWith((l) => inputBox(l)?.rows[0] === '❯ hello', 'the draft');
    expect(t.output).toContain('❯ hello');
    await sleep(AFTER_PASTE_MS);
    t.type('\r');
    await until(async () => userTexts(await transcript(configDir, t.sid)).length === 1, 'the prompt');
    expect(userTexts(await transcript(configDir, t.sid))).toEqual(['hello']);
    t.type('\u0003\u0003');
    await until(async () => (await sessionFiles(configDir)).length === 0, 'the session file to go');
    await t.close();
  });
});

if (!LINUX) {
  describe('fake interactive Claude under a pseudo-terminal', () => {
    it.skip('runs only on Linux: macOS has BSD script, which takes other flags (the Docker image runs it)', () => {});
  });
}
