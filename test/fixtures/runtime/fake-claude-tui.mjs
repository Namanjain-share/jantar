#!/usr/bin/env node
// Fake interactive Claude Code (v0.6 Fleet). Plain JavaScript, zero
// dependencies, Node 22. The Docker end-to-end suite (test/docker) installs
// it as /usr/local/bin/claude on its Linux nodes, in tmux and in a plain pty;
// it never talks to Anthropic and never runs a tool.
//
// What it copies of the real one, as far as Jantar can tell:
// - `<config>/sessions/<pid>.json` (CLAUDE_CONFIG_DIR, else ~/.claude) with
//   `procStart` from `ps -o lstart=` of itself in UTC (what Claude writes on
//   macOS), the status as it changes, removed on exit;
// - the screen: the conversation, then the input box between two full-width
//   rules (`❯ ` on its first row), then the mode line ("⏸ manual mode on");
// - raw-mode input with bracketed paste, and Claude's ~100 ms paste window:
//   a Return that comes within PASTE_WINDOW_MS of typed text is a newline,
//   a later one submits;
// - on submit a `user` line in `<config>/projects/<encoded cwd>/<sid>.jsonl`,
//   then (FAKE_CLAUDE_REPLY_MS later, 300 by default) an `assistant` line
//   that never repeats the prompt;
// - `--session-id`, `--resume`, `--name`, `--permission-mode` (and
//   `--dangerously-skip-permissions`); after `--` every argument is the
//   prompt and no flag counts, as with the real one;
// - hooks from `<config>/settings.json`, in shell form (`command`, run by
//   /bin/sh -c) and exec form (`command` + `args`, no shell): SessionStart,
//   UserPromptSubmit and Stop without waiting, PermissionRequest waited for,
//   with its decision applied. As in Claude the terminal dialog shows while
//   the hook runs; whichever answers first wins (the hook is killed when the
//   terminal does).
// - Keys: arrows, Shift+Tab (manual -> accept edits -> plan), Return, End,
//   Ctrl+U (the row, or the line break before an empty row), Backspace,
//   Escape (CSI-u or a lone ESC: interrupts a turn, twice clears a draft),
//   Ctrl+C (clears a draft, interrupts, twice exits), Ctrl+D (twice exits).
//
// The test drives it with a control file, `$FAKE_CLAUDE_CTL/<sid>.json`,
// read every 100 ms and removed once read (a half-written one waits for the
// next read):
//   {"dialog": "PERM_CREATE_2"}           a screen from DIALOG_FIXTURES, by name
//                                          (from the fixtures' built dist/dialogs.js)
//   {"dialog": {"name", "screen", "rows"?, "current"?}}  the same, given inline
//   ... "swapTo": <dialog>, "swapAfterMs": n  draw another one n ms later
//   {"permission": {"tool_name", "tool_input", "permission_suggestions"?}, "dialog"?}
//                                          raise a PermissionRequest (its dialog: the
//                                          one given, else a two-row Bash prompt)
//   {"say": "text"}                        a line on the screen only (never in the transcript)
//   {"close": true}                        drop the dialog on screen
//   {"exit": true}                         quit
// What happened goes to `$FAKE_CLAUDE_CTL/<sid>.events.jsonl` (start, the
// keys typed while a dialog shows, the row they chose, hooks and their
// decisions, prompts by length only) and the screen to `<sid>.screen.txt`.
// Without FAKE_CLAUDE_CTL there is no control file and no record.
//
// Only the input box and dialogs are faked: no history recall on Up, no
// cursor movement inside a draft (the cursor stays at its end), no slash
// command runs (a `/x` prompt is recorded as Claude records a command).
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const VERSION = '2.1.316';
/** Claude collects input for about this long: a Return inside it is a newline, not a submit. */
export const PASTE_WINDOW_MS = 100;
const CTL_POLL_MS = 100;
/** A lone ESC (or the start of a sequence) waits this long for the rest before it counts as Escape. */
const ESC_WAIT_MS = 50;
/** Ctrl+C and Ctrl+D quit on a second press within this. */
const EXIT_ARM_MS = 2000;
const HISTORY_MAX = 500;
const HOOK_TIMEOUT_DEFAULT_S = 60;

const MODE_LINES = {
  default: '⏸ manual mode on (shift+tab to cycle)',
  acceptEdits: '⏵⏵ accept edits on (shift+tab to cycle)',
  plan: '⏸ plan mode on (shift+tab to cycle)',
  auto: '⏵⏵ auto mode on (shift+tab to cycle)',
  bypassPermissions: '⏵⏵ bypass permissions on (shift+tab to cycle)',
  dontAsk: "⏵⏵ don't ask on (shift+tab to cycle)",
};
const MODE_CYCLE = ['default', 'acceptEdits', 'plan'];
/** Flags whose value is the next argument (read or skipped, never taken for the prompt). */
const VALUE_FLAGS = new Set([
  '--session-id',
  '--resume',
  '-r',
  '--name',
  '-n',
  '--permission-mode',
  '--model',
  '--effort',
  '--fallback-model',
  '--add-dir',
  '--settings',
  '--mcp-config',
  '--append-system-prompt',
  '--system-prompt',
  '--allowedTools',
  '--disallowedTools',
  '--agent',
]);

// ---------------------------------------------------------------------------
// Arguments and environment

function parseArgs(argv) {
  const o = { sessionId: null, resume: null, name: null, mode: 'default', prompt: null, version: false, print: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      // Claude's own rule: everything after `--` is the prompt, flags included.
      o.prompt = argv.slice(i + 1).join(' ') || null;
      break;
    }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const value = () => (eq > 0 ? a.slice(eq + 1) : argv[++i]);
    if (flag === '--version' || flag === '-v') o.version = true;
    else if (flag === '-p' || flag === '--print') o.print = true;
    else if (flag === '--dangerously-skip-permissions') o.mode = 'bypassPermissions';
    else if (VALUE_FLAGS.has(flag)) {
      const v = value();
      if (flag === '--session-id') o.sessionId = v ?? null;
      else if (flag === '--resume' || flag === '-r') o.resume = v ?? null;
      else if (flag === '--name' || flag === '-n') o.name = v ?? null;
      else if (flag === '--permission-mode') o.mode = v === 'manual' || !MODE_LINES[v] ? 'default' : v;
    } else if (!a.startsWith('-')) o.prompt = a;
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (args.version) {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
  process.exit(0);
}
if (args.print) {
  process.stderr.write('fake claude (interactive): print mode is not faked here\n');
  process.exit(1);
}

// What `ps` and tmux show for the process, as for the native binary.
process.title = 'claude';

const env = process.env;
const configDir = resolve(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
const ctlDir = env.FAKE_CLAUDE_CTL ? resolve(env.FAKE_CLAUDE_CTL) : null;
const replyMs = Number(env.FAKE_CLAUDE_REPLY_MS) || 300;
const sid = args.sessionId || args.resume || randomUUID();
const cwd = process.cwd();
const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
const startedAt = Date.now();
const sessionFile = join(configDir, 'sessions', `${process.pid}.json`);
const transcriptPath = join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sid}.jsonl`);

// ---------------------------------------------------------------------------
// Files

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** One line of the record, when the test asked for one. Never a prompt's text. */
function record(event, extra = {}) {
  if (!ctlDir) return;
  try {
    mkdirSync(ctlDir, { recursive: true });
    appendFileSync(join(ctlDir, `${sid}.events.jsonl`), `${JSON.stringify({ at: Date.now(), event, ...extra })}\n`);
  } catch {
    // recording is best effort
  }
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');

/** `ps -o lstart=` of this process in UTC ("Sun Nov  1 04:45:12 2026"), as Claude writes it; computed if ps fails. */
function procStart() {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
      env: { ...env, LC_ALL: 'C', TZ: 'UTC' },
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch {
    // no ps here: computed below
  }
  const d = new Date(Date.now() - Math.round(process.uptime() * 1000));
  return `${DAY[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

const s = {
  mode: args.mode,
  status: 'idle',
  waitingFor: null,
  statusAt: startedAt,
  procStart: procStart(),
  input: '',
  lastTextAt: 0,
  lastEscAt: 0,
  exitArmedAt: 0,
  exitHint: '',
  history: [],
  turns: 0,
  replies: 0,
  /** {name, lines, rows: [{label, role}], current, typed, permission?, hook?} while a dialog shows. */
  dialog: null,
  swapTimer: null,
  lastUuid: null,
};

function writeSessionFile() {
  const json = {
    pid: process.pid,
    sessionId: sid,
    cwd,
    startedAt,
    kind: 'interactive',
    entrypoint: 'cli',
    status: s.status,
    procStart: s.procStart,
    version: VERSION,
    updatedAt: Date.now(),
    statusUpdatedAt: s.statusAt,
  };
  if (args.name) json.name = args.name;
  if (s.waitingFor) json.waitingFor = s.waitingFor;
  writeAtomic(sessionFile, JSON.stringify(json));
}

function setStatus(status, waitingFor = null) {
  if (s.status === status && s.waitingFor === waitingFor) return;
  s.status = status;
  s.waitingFor = waitingFor;
  s.statusAt = Date.now();
  writeSessionFile();
}

function appendTranscript(type, extra) {
  const uuid = randomUUID();
  const e = {
    type,
    uuid,
    parentUuid: s.lastUuid,
    timestamp: new Date().toISOString(),
    sessionId: sid,
    cwd,
    isSidechain: false,
    userType: 'external',
    version: VERSION,
    ...extra,
  };
  s.lastUuid = uuid;
  mkdirSync(dirname(transcriptPath), { recursive: true });
  appendFileSync(transcriptPath, `${JSON.stringify(e)}\n`);
}

const assistantText = (text) => ({ message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text }] } });

// ---------------------------------------------------------------------------
// Hooks

/** A group's matcher against the event's tool name or source; events without one (UserPromptSubmit, Stop) run every group. */
function matcherHits(matcher, value) {
  if (value === undefined || matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(value ?? '');
  } catch {
    return matcher === value;
  }
}

/** The command hooks `<config>/settings.json` registers for `event` (its matcher checked against `value`). */
function hookCommands(event, value) {
  let settings;
  try {
    settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
  } catch {
    return [];
  }
  const groups = settings?.hooks?.[event];
  if (!Array.isArray(groups)) return [];
  const out = [];
  for (const g of groups) {
    if (!matcherHits(g?.matcher, value)) continue;
    for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
      if (h?.type === 'command' && typeof h.command === 'string' && h.command) out.push(h);
    }
  }
  return out;
}

/**
 * Run one hook: exec form without a shell, shell form through /bin/sh -c,
 * in its own process group. Resolves {code, stdout, form}; `kill()` ends the
 * group (a shell and what it started) and resolves at once with no output.
 */
function runHook(h, payload) {
  const exec = Array.isArray(h.args);
  const opts = { cwd, env: { ...env, CLAUDE_PROJECT_DIR: cwd }, stdio: ['pipe', 'pipe', 'ignore'], detached: true };
  const child = exec ? spawn(h.command, h.args.map(String), opts) : spawn('/bin/sh', ['-c', h.command], opts);
  const form = exec ? 'exec' : 'shell';
  let settle;
  const done = new Promise((res) => (settle = res));
  let stdout = '';
  let settled = false;
  const finish = (r) => {
    if (settled) return;
    settled = true;
    clearTimeout(limit);
    settle(r);
  };
  const kill = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    finish({ code: null, stdout: '', form });
  };
  const limit = setTimeout(kill, (Number(h.timeout) || HOOK_TIMEOUT_DEFAULT_S) * 1000);
  child.stdout.on('data', (d) => (stdout += d));
  child.on('error', () => finish({ code: null, stdout: '', form }));
  child.on('close', (code) => finish({ code, stdout, form }));
  child.stdin.on('error', () => {});
  child.stdin.end(`${JSON.stringify(payload)}\n`);
  return { done, kill };
}

function hookPayload(event, extra) {
  return { session_id: sid, transcript_path: transcriptPath, cwd, permission_mode: s.mode, hook_event_name: event, ...extra };
}

/** Fire every hook for an event that Claude does not wait on. */
function fireHooks(event, extra, value) {
  for (const h of hookCommands(event, value)) {
    void runHook(h, hookPayload(event, extra)).done.then((r) => record('hook', { hook: event, form: r.form, code: r.code }));
  }
}

/** PermissionRequest: every hook at once; the first `decision` wins. `cancel()` kills them all (the terminal answered). */
function permissionHooks(extra, toolName) {
  const runs = hookCommands('PermissionRequest', toolName).map((h) => runHook(h, hookPayload('PermissionRequest', extra)));
  const decision = new Promise((res) => {
    let left = runs.length;
    if (left === 0) res(null);
    for (const r of runs) {
      void r.done.then((out) => {
        let d = null;
        try {
          d = JSON.parse(out.stdout.trim().split('\n').pop() || 'null')?.hookSpecificOutput?.decision ?? null;
        } catch {
          d = null;
        }
        record('hook', { hook: 'PermissionRequest', form: out.form, code: out.code, decision: d });
        if (d && (d.behavior === 'allow' || d.behavior === 'deny')) res(d);
        else if (--left === 0) res(null);
      });
    }
  });
  return { decision, cancel: () => runs.forEach((r) => r.kill()) };
}

// ---------------------------------------------------------------------------
// The screen

function columns() {
  return process.stdout.columns || Number(env.COLUMNS) || 80;
}

function screenRows() {
  return process.stdout.rows || Number(env.LINES) || 24;
}

/** Hard-wrap at the screen's width, as the terminal would. */
function wrap(line, cols) {
  const chars = Array.from(line);
  if (chars.length <= cols) return [line];
  const out = [];
  for (let i = 0; i < chars.length; i += cols) out.push(chars.slice(i, i + cols).join(''));
  return out;
}

function screenLines() {
  if (s.dialog) return s.dialog.lines;
  const rule = '─'.repeat(columns());
  const box = s.input.split('\n').map((l, i) => (i === 0 ? `❯ ${l}` : `  ${l}`));
  const footer = [rule, ...box, rule, `  ${s.exitHint || MODE_LINES[s.mode]}`];
  const body = [`✻ Welcome to Claude Code (fake ${VERSION})`, '', `  cwd: ${cwd}`, '', ...s.history, ...(s.status === 'busy' ? ['✻ Thinking…'] : []), ''];
  const room = Math.max(0, screenRows() - footer.length);
  return [...body.slice(-room), ...footer];
}

function out(text) {
  try {
    process.stdout.write(text);
  } catch {
    // nobody reads the screen any more
  }
}

function render() {
  const lines = screenLines();
  const cols = columns();
  const drawn = lines.flatMap((l) => wrap(l, cols)).slice(-screenRows());
  out(`\u001b[H\u001b[2J${drawn.join('\r\n')}`);
  if (ctlDir) {
    try {
      writeAtomic(join(ctlDir, `${sid}.screen.txt`), `${lines.join('\n')}\n`);
    } catch {
      // the record is best effort
    }
  }
}

function say(line) {
  s.history.push(...line.split('\n'));
  if (s.history.length > HISTORY_MAX) s.history.splice(0, s.history.length - HISTORY_MAX);
}

// ---------------------------------------------------------------------------
// Dialogs

/** Numbered rows read off a screen (`❯ 1. Yes`, `  2. No`) when no model came with it. */
function rowsOfScreen(lines) {
  const rows = [];
  let current = 0;
  for (const l of lines) {
    const m = /^\s*(❯\s*)?(\d+)\.\s+(.*)$/.exec(l);
    if (!m) continue;
    if (m[1]) current = rows.length;
    rows.push({ label: m[3].trim(), role: 'pick' });
  }
  return { rows, current };
}

/** A dialog to show: a DIALOG_FIXTURES name (the fixtures' built dist) or {name, screen, rows?, current?}. */
async function dialogOf(spec) {
  let name;
  let screen;
  let model = null;
  if (typeof spec === 'string') {
    const mod = await import(new URL('../dist/dialogs.js', import.meta.url).href);
    const f = mod.DIALOG_FIXTURES.find((x) => x.name === spec);
    if (!f) throw new Error(`no dialog fixture ${spec}`);
    name = f.name;
    screen = f.screen;
    model = (f.expectedOpen ?? f.expected)?.dialog ?? f.expected?.dialog ?? null;
  } else {
    name = String(spec?.name ?? 'inline');
    screen = String(spec?.screen ?? '');
    if (Array.isArray(spec?.rows)) model = { options: spec.rows.map((r) => (typeof r === 'string' ? { label: r, role: 'pick' } : r)), current: Number(spec.current) || 0 };
  }
  const lines = screen.replace(/\r\n?/g, '\n').split('\n');
  const parsed = rowsOfScreen(lines);
  const rows = model?.options?.length ? model.options.map((o) => ({ label: o.label, role: o.role })) : parsed.rows;
  const current = model?.options?.length ? (model.current ?? 0) : parsed.current;
  return { name, lines, rows, current, typed: '' };
}

/** The permission prompt drawn when the control gives no screen: Claude's two-row Bash ask. */
function permissionDialog(toolName, input) {
  const rule = '─'.repeat(Math.min(columns(), 80));
  const what = toolName === 'Bash' && typeof input?.command === 'string' ? input.command : JSON.stringify(input ?? {});
  const lines = [
    '● I will run a command.',
    '',
    rule,
    ` ${toolName === 'Bash' ? 'Bash command' : toolName}`,
    '',
    ...what.split('\n').map((l) => `   ${l}`),
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel · Tab to amend',
  ];
  return { name: 'permission', lines, rows: [{ label: 'Yes', role: 'pick' }, { label: 'No', role: 'pick' }], current: 0, typed: '' };
}

function showDialog(d) {
  clearTimeout(s.swapTimer);
  s.dialog = d;
  record('shown', { dialog: d.name, rows: d.rows.length, current: d.current });
  render();
}

function closeDialog() {
  clearTimeout(s.swapTimer);
  s.dialog = null;
}

/** A row was picked at the terminal: record it and, for a permission, apply it (killing the hook). */
function choose(row) {
  const d = s.dialog;
  if (!d) return;
  const label = d.rows[row]?.label ?? null;
  record('chosen', { dialog: d.name, row, label, ...(d.typed ? { typed: d.typed } : {}) });
  closeDialog();
  if (d.permission) {
    d.hook?.cancel();
    finishPermission(d.permission, /^yes/i.test(label ?? '') ? { behavior: 'allow' } : { behavior: 'deny' }, 'terminal');
  } else {
    say(`● (fake) row ${row + 1} chosen.`);
    say('');
    if (s.status === 'waiting') setStatus('idle');
  }
  render();
}

function cancelDialog() {
  const d = s.dialog;
  if (!d) return;
  record('cancelled', { dialog: d.name });
  closeDialog();
  if (d.permission) {
    d.hook?.cancel();
    finishPermission(d.permission, { behavior: 'deny', interrupt: true }, 'terminal');
  } else if (s.status === 'waiting') setStatus('idle');
  render();
}

// ---------------------------------------------------------------------------
// Turns

function reply(text) {
  appendTranscript('assistant', assistantText(text));
  say(`● ${text}`);
  say('');
  fireHooks('Stop', { last_assistant_message: text, stop_hook_active: false });
}

let replyTimers = [];

function submit() {
  const text = s.input.trim();
  s.input = '';
  if (!text) return;
  s.turns += 1;
  const command = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const content = command
    ? `<command-name>/${command[1]}</command-name>\n<command-message>${command[1]}</command-message>\n<command-args>${command[2] ?? ''}</command-args>`
    : text;
  appendTranscript('user', { message: { role: 'user', content } });
  record('prompt', { turn: s.turns, chars: text.length, lines: text.split('\n').length });
  say(text.split('\n').map((l, i) => `${i === 0 ? '>' : ' '} ${l}`).join('\n'));
  setStatus('busy');
  fireHooks('UserPromptSubmit', { prompt: text });
  const timer = setTimeout(() => {
    replyTimers = replyTimers.filter((t) => t !== timer);
    s.replies += 1;
    reply(`Done (fake reply ${s.replies}).`);
    if (replyTimers.length === 0 && !s.dialog) setStatus('idle');
    render();
  }, replyMs);
  replyTimers.push(timer);
}

function interrupt() {
  for (const t of replyTimers) clearTimeout(t);
  replyTimers = [];
  appendTranscript('user', { message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  record('interrupted');
  say('  ⎿  Interrupted · What should Claude do instead?');
  say('');
  setStatus('idle');
}

/** Show the ask and start the hooks; their decision is applied when it comes (not waited for here). */
async function raisePermission(req, dialogSpec) {
  const toolName = String(req?.tool_name ?? 'Bash');
  const toolInput = req?.tool_input ?? { command: 'echo fake' };
  const d = dialogSpec ? await dialogOf(dialogSpec) : permissionDialog(toolName, toolInput);
  const toolUseId = `toolu_${randomBytes(12).toString('hex')}`;
  appendTranscript('assistant', { message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'tool_use', id: toolUseId, name: toolName, input: toolInput }] } });
  d.permission = { toolName, toolUseId };
  setStatus('waiting', 'permission');
  showDialog(d);
  const extra = { tool_name: toolName, tool_input: toolInput, permission_suggestions: Array.isArray(req?.permission_suggestions) ? req.permission_suggestions : [] };
  const hook = permissionHooks(extra, toolName);
  d.hook = hook;
  void hook.decision.then((decision) => {
    // The terminal answered first, or another dialog took the screen.
    if (s.dialog !== d || !decision) return;
    closeDialog();
    finishPermission(d.permission, decision, 'hook');
    render();
  });
}

/** Apply a permission decision as Claude does: run the (fake) tool or refuse it, then end the turn. */
function finishPermission(p, decision, by) {
  record('decision', { by, behavior: decision.behavior, ...(decision.interrupt ? { interrupt: true } : {}) });
  const mode = Array.isArray(decision.updatedPermissions) ? decision.updatedPermissions.find((u) => u?.type === 'setMode' && MODE_LINES[u.mode]) : null;
  if (mode) s.mode = mode.mode;
  const allow = decision.behavior === 'allow';
  const result = allow ? 'ok (fake tool run)' : "The user doesn't want to proceed with this tool use. The tool use was rejected.";
  appendTranscript('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: p.toolUseId, content: result, is_error: !allow }] } });
  if (!allow && decision.interrupt) {
    interrupt();
    return;
  }
  s.replies += 1;
  reply(allow ? `Ran ${p.toolName} (fake reply ${s.replies}).` : `Not run (fake reply ${s.replies}).`);
  setStatus('idle');
}

// ---------------------------------------------------------------------------
// Keys

function armExit() {
  const now = Date.now();
  if (now - s.exitArmedAt < EXIT_ARM_MS) quit(0);
  s.exitArmedAt = now;
  s.exitHint = 'Press Ctrl-C again to exit';
  setTimeout(() => {
    if (Date.now() - s.exitArmedAt >= EXIT_ARM_MS) {
      s.exitHint = '';
      render();
    }
  }, EXIT_ARM_MS).unref();
}

function key(name, now) {
  const d = s.dialog;
  if (d) {
    if (name === 'up') d.current = Math.max(0, d.current - 1);
    else if (name === 'down') d.current = Math.min(Math.max(0, d.rows.length - 1), d.current + 1);
    else if (name === 'enter') choose(d.current);
    else if (name === 'escape' || name === 'ctrl-c') cancelDialog();
    return;
  }
  switch (name) {
    case 'enter':
      if (now - s.lastTextAt < PASTE_WINDOW_MS) {
        s.input += '\n';
        s.lastTextAt = now;
      } else submit();
      break;
    case 'escape':
      if (s.status === 'busy') interrupt();
      else if (s.input && now - s.lastEscAt < 1000) s.input = '';
      s.lastEscAt = now;
      break;
    case 'ctrl-c':
      if (s.input) s.input = '';
      else if (s.status === 'busy') interrupt();
      else armExit();
      break;
    case 'ctrl-d':
      if (!s.input) armExit();
      break;
    case 'ctrl-u': {
      const nl = s.input.lastIndexOf('\n');
      if (nl < s.input.length - 1) s.input = s.input.slice(0, nl + 1);
      else if (nl >= 0) s.input = s.input.slice(0, nl);
      break;
    }
    case 'backspace':
      s.input = Array.from(s.input).slice(0, -1).join('');
      break;
    case 'shift-tab': {
      const cycle = MODE_CYCLE.includes(args.mode) ? MODE_CYCLE : [...MODE_CYCLE, args.mode];
      s.mode = cycle[(cycle.indexOf(s.mode) + 1) % cycle.length];
      appendTranscript('permission-mode', { permissionMode: s.mode });
      record('mode', { mode: s.mode });
      break;
    }
    default:
      // end, home, left, right, up, down: the cursor stays at the end of the draft
      break;
  }
}

function text(t, now) {
  const d = s.dialog;
  if (d) {
    const row = d.rows[d.current];
    if (row?.role === 'text') d.typed += t;
    else {
      // Claude picks a numbered row when its number is typed.
      const n = Number(t[0]);
      if (n >= 1 && n <= d.rows.length) choose(n - 1);
    }
    return;
  }
  s.input += t;
  s.lastTextAt = now;
  s.exitArmedAt = 0;
  s.exitHint = '';
}

const CSI_KEYS = { A: 'up', B: 'down', C: 'right', D: 'left', Z: 'shift-tab', F: 'end', H: 'home' };
const TILDE_KEYS = { 1: 'home', 3: 'delete', 4: 'end', 7: 'home', 8: 'end' };

function seqKey(params, final) {
  if (final === '~') return TILDE_KEYS[params] ?? 'other';
  // CSI-u: 27u is Escape (what Jantar's Terminal backend types), 13u Return, 13;2u Shift+Return.
  if (final === 'u') return params === '27' ? 'escape' : params === '13' ? 'enter' : params === '13;2' ? 'newline' : 'other';
  return CSI_KEYS[final] ?? 'other';
}

const decoder = new StringDecoder('utf8');
let carry = '';
let carryTimer = null;
let inPaste = false;
const PASTE_END = '\u001b[201~';

function feed(chunk) {
  clearTimeout(carryTimer);
  let str = carry + chunk;
  carry = '';
  const now = Date.now();
  if (s.dialog && str) record('keys', { dialog: s.dialog.name, bytes: str });
  let i = 0;
  while (i < str.length) {
    if (inPaste) {
      const end = str.indexOf(PASTE_END, i);
      let body = end < 0 ? str.slice(i) : str.slice(i, end);
      if (end < 0) {
        // keep a possible start of the end marker for the next chunk
        for (let k = Math.min(PASTE_END.length - 1, body.length); k > 0; k--) {
          if (PASTE_END.startsWith(body.slice(-k))) {
            carry = body.slice(-k);
            body = body.slice(0, -k);
            break;
          }
        }
      }
      if (body) text(body.replace(/\r\n?/g, '\n'), now);
      if (end < 0) break;
      inPaste = false;
      i = end + PASTE_END.length;
      continue;
    }
    const c = str[i];
    if (c === '\u001b') {
      const rest = str.slice(i);
      if (rest.startsWith('\u001b[200~')) {
        inPaste = true;
        i += 6;
        continue;
      }
      const m = /^\u001b(?:\[([0-9;?]*)[ -/]*([@-~])|O([@-~]))/.exec(rest);
      if (m) {
        const name = m[3] ? (CSI_KEYS[m[3]] ?? 'other') : seqKey(m[1], m[2]);
        if (name === 'newline') text('\n', now);
        else key(name, now);
        i += m[0].length;
        continue;
      }
      if (/^\u001b(?:\[[0-9;?]*|O)?$/.test(rest)) {
        // A lone ESC, or a sequence cut in two: wait a moment for the rest.
        carry = rest;
        carryTimer = setTimeout(() => {
          carry = '';
          key('escape', Date.now());
          render();
        }, ESC_WAIT_MS);
        break;
      }
      key('escape', now);
      i += 1;
      continue;
    }
    if (c === '\r') key('enter', now);
    else if (c === '\n') text('\n', now);
    else if (c === '\u0003') key('ctrl-c', now);
    else if (c === '\u0004') key('ctrl-d', now);
    else if (c === '\u0015') key('ctrl-u', now);
    else if (c === '\u007f' || c === '\b') key('backspace', now);
    else if (c >= ' ' || c === '\t') {
      let j = i + 1;
      while (j < str.length && (str[j] >= ' ' || str[j] === '\t') && str[j] !== '\u007f') j++;
      text(str.slice(i, j), now);
      i = j;
      continue;
    }
    i += 1;
  }
  render();
}

// ---------------------------------------------------------------------------
// Control file

let acting = false;

async function act(cmd) {
  if (typeof cmd?.say === 'string') {
    say(`● ${cmd.say}`);
    record('said');
  }
  if (cmd?.close) {
    if (s.dialog) record('closed', { dialog: s.dialog.name });
    closeDialog();
    if (s.status === 'waiting') setStatus('idle');
  }
  if (cmd?.permission) await raisePermission(cmd.permission, cmd.dialog);
  else if (cmd?.dialog) {
    const d = await dialogOf(cmd.dialog);
    setStatus('waiting', 'permission');
    showDialog(d);
    if (cmd.swapTo) {
      const next = await dialogOf(cmd.swapTo);
      s.swapTimer = setTimeout(() => {
        if (s.dialog !== d) return;
        s.dialog = next;
        record('swapped', { from: d.name, to: next.name });
        render();
      }, Number(cmd.swapAfterMs) || 0);
    }
  }
  if (cmd?.exit) quit(0);
}

function pollControl() {
  if (!ctlDir || acting) return;
  const file = join(ctlDir, `${sid}.json`);
  let cmd;
  try {
    cmd = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return; // none yet, or still being written
  }
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
  acting = true;
  void act(cmd)
    .catch((e) => record('control-failed', { error: String(e?.message ?? e) }))
    .finally(() => {
      acting = false;
      render();
    });
}

// ---------------------------------------------------------------------------
// Start and stop

let quitting = false;

function quit(code) {
  if (quitting) return;
  quitting = true;
  record('exit', { code });
  process.exit(code);
}

process.on('exit', () => {
  try {
    unlinkSync(sessionFile);
  } catch {
    // already gone
  }
  if (tty) {
    out('\u001b[?2004l\r\n');
    try {
      process.stdin.setRawMode(false);
    } catch {
      // the terminal is gone
    }
  }
});
for (const [sig, n] of [
  ['SIGTERM', 15],
  ['SIGHUP', 1],
  ['SIGINT', 2],
]) {
  process.on(sig, () => quit(128 + n));
}
process.stdout.on('error', () => {});

writeSessionFile();
record('start', { pid: process.pid, argv: process.argv.slice(2), cwd, configDir, tty, cols: columns(), rows: screenRows(), mode: s.mode });
fireHooks('SessionStart', { source: args.resume ? 'resume' : 'startup' }, args.resume ? 'resume' : 'startup');
if (tty) {
  process.stdin.setRawMode(true);
  out('\u001b[?2004h');
  process.stdout.on('resize', render);
}
process.stdin.on('data', (b) => feed(decoder.write(b)));
process.stdin.on('end', () => quit(0));
process.stdin.resume();
setInterval(pollControl, CTL_POLL_MS);
render();
if (args.prompt) {
  s.input = args.prompt;
  submit();
  render();
}
