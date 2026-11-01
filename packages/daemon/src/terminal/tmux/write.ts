/**
 * v0.6 Fleet: the tmux backend's one write primitive (spec 4.2), and the
 * argv runner every tmux call goes through.
 *
 * Every call is `ctx.exec(bins.tmux, argv)`: no shell. No user, prompt or
 * screen text is ever an argv item or part of a tmux command string. tmux
 * takes any argv item ending in `;` as a command separator (and drops the
 * `;`), and it parses an `if-shell` command string a second time, so text
 * there could become a command. Text enters tmux only on stdin:
 *
 * 1. With text: `load-buffer -b jantar-<ulid> -`, the text as stdin.
 * 2. One `if-shell -F -t %N <gate> <do> <else>`:
 *    - the gate (tmuxGate, one argv item) is `#{&&:…}` of the pane's tty
 *      (the session's, `/dev/pts/N`), copy mode, synchronize-panes, input
 *      off and a dead pane all off, and for compare-and-type up to
 *      GATE_LINES_MAX `#{C:<line>}` (gateLines). tmux evaluates it and runs
 *      <do> in one server step, with no pane output in between, so neither
 *      copy mode nor another pane can slip in between the check and the write;
 *    - <do> holds only `send-keys -t %N -H <hex>…` (key bytes, each byte its
 *      own two-digit token, byte for byte what Terminal.app's `do script`
 *      gets), `paste-buffer [-p] -d -r -b jantar-<ulid> -t %N` (the text
 *      bytes as typed, LF kept; `-p` brackets text holding a line feed or a
 *      tab when the app asked for bracketed paste, as Terminal's paste path)
 *      and `send-keys -t %N Enter`, joined by ` ; `;
 *    - <else> is `delete-buffer -b jantar-<ulid> ; display-message -p
 *      JANTAR-CHANGED` (no delete-buffer without text).
 *    `%N` is validated `^%\d+$` and the buffer name `^jantar-[0-9A-Z]{26}$`;
 *    nothing else ever goes in those strings.
 * 3. JANTAR-CHANGED on stdout is `changed` when `expect` was given;
 *    otherwise one `display-message` of the pane's flags names the refusal.
 *    A failed if-shell gets a best-effort `delete-buffer`.
 *
 * Every key write that carries Terminal's implicit Return carries exactly
 * one `Enter` in the same step (the caller says so with `enter`). tmux's
 * stderr is never passed on or logged: it can quote the command it refused.
 */
import type { Pane } from '@jantar/protocol';
import type { DaemonContext, ExecResult, OpResult, TerminalErrorCode } from '../../contracts.js';
import { CSWAP_SCRUB_ENV, scrubEnv } from '../../core/exec.js';
import { newId } from '../../core/ids.js';
import type { TmuxBackendOptions } from './index.js';

/** What the gated command's else branch prints: the screen changed (or the pane is no longer the session's), nothing was typed. */
export const JANTAR_CHANGED = 'JANTAR-CHANGED';

/** Characters a `#{C:}` pattern treats specially (and `#`, which starts a format): each becomes `?` in the gate. */
export const GLOB_SPECIALS = '#,{}*?[]\\';

/** One gated write's parts: text through the buffer, key bytes, one Return, and the lines that must still show. */
export interface TmuxWrite {
  text?: string;
  /** Key bytes (as Terminal.app's KEY_BYTES give them). */
  keys?: string;
  enter: boolean;
  expect?: string | readonly string[];
}

/** Per tmux call. */
export const TMUX_TIMEOUT_MS = 5_000;
/**
 * Between the fields of a printed format (`-F`, `display-message -p`): a
 * space. tmux 3.2a and 3.3a print a tab there as `_`, and no field Jantar
 * reads (a pane id, a /dev/pts tty, a number, a flag) can hold a space.
 */
export const FIELD_SEP = ' ';
/** The most `#{C:}` lines one gate checks: the first, the pointer row, the longest and the last. */
export const GATE_LINES_MAX = 4;

/** A pane id as tmux prints it. */
export const PANE_ID_RE = /^%\d{1,9}$/u;
/** A Linux pane's tty, the only kind the gate takes. */
export const PTS_RE = /^\/dev\/pts\/\d{1,9}$/u;
const BUFFER_RE = /^jantar-[0-9A-Z]{26}$/u;
// C0 controls except tab and line feed, DEL, and C1 controls (Terminal.app's rule for typed text).
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
/** Key bytes are ASCII: every KEY_BYTES entry and Clear draft's bytes are. */
const KEY_BYTES_RE = /^[\u0001-\u007f]+$/u;
// C0 controls and DEL in a gate line: never part of a tmux format.
const GATE_CONTROLS = /[\u0000-\u001f\u007f]/gu;
/** Claude's dialog pointer. */
const POINTER = '❯';

const NO_TMUX = 'tmux was not found on this machine';
export const NOT_THIS_PANE = "the tmux pane is no longer this session's";
export const PANE_GONE = 'the tmux pane is gone';
export const CHANGED_REASON = 'the terminal changed before Jantar typed';

type Failure = { ok: false; code: TerminalErrorCode; reason: string };

export function fail(code: TerminalErrorCode, reason: string): Failure {
  return { ok: false, code, reason };
}

/**
 * The daemon's env without TMUX and TMUX_PANE: every call reaches the user's
 * default server (`/tmp/tmux-<uid>/default`), also when jantard itself was
 * started inside tmux. Nor CLAUDE_CONFIG_DIR (CSWAP_SCRUB_ENV): a server
 * jantard starts passes its env to every pane, where it would move a
 * ~/.claude start into another config dir. Nor the Access secret `jantar
 * node join` may read from the environment (a jantard run by hand from that
 * shell): every Claude the phone starts would have it.
 */
export function tmuxEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  return scrubEnv(env, ['TMUX', 'TMUX_PANE', 'JANTAR_CF_ACCESS_CLIENT_SECRET', ...CSWAP_SCRUB_ENV]);
}

/** One tmux call: `-S <socket>` first when a test gave one, then `args`. Null when tmux was not found. */
export async function runTmux(
  ctx: DaemonContext,
  opts: TmuxBackendOptions,
  args: readonly string[],
  more: { input?: string; timeoutMs?: number } = {},
): Promise<ExecResult | null> {
  const bin = ctx.bins.tmux;
  if (!bin) return null;
  return ctx.exec(bin, [...(opts.socket ? ['-S', opts.socket] : []), ...args], {
    env: tmuxEnv(ctx.env),
    timeoutMs: more.timeoutMs ?? TMUX_TIMEOUT_MS,
    ...(more.input !== undefined ? { input: more.input } : {}),
  });
}

/** Why a tmux call did not succeed, from its exit alone (stderr is matched, never quoted). */
export function tmuxFailure(r: ExecResult | null): Failure {
  if (!r) return fail('unsupported', NO_TMUX);
  if (r.spawnError) return fail('unsupported', 'tmux could not be started');
  if (r.timedOut) return fail('timeout', 'tmux did not answer in time');
  if (/no server running|error connecting to/u.test(r.stderr)) return fail('not_found', 'tmux is not running');
  if (/can't find (?:pane|window|session)/u.test(r.stderr)) return fail('not_found', PANE_GONE);
  return fail('failed', r.code === null ? 'tmux failed' : `tmux failed (${r.code})`);
}

function ok(r: ExecResult | null): r is ExecResult {
  return r !== null && !r.spawnError && !r.timedOut && r.code === 0;
}

/** One screen line as a `#{C:}` pattern: no trailing white space (tmux trims each line), every GLOB_SPECIALS character and control as `?`. */
function globLine(line: string): string {
  let out = line.replace(/\s+$/u, '').replace(GATE_CONTROLS, '?');
  for (const ch of GLOB_SPECIALS) out = out.replaceAll(ch, '?');
  return out;
}

/**
 * The lines a gate checks for `expect` (the text a guarded read cut from the
 * screen, or its parts around a countdown): the first and last non-empty
 * lines, the pointer row and the longest line, each once, as `#{C:}`
 * patterns. The exact check is typeifFinds on a capture just before; these
 * re-check inside tmux, in the same step as the write.
 */
export function gateLines(expect: string | readonly string[]): string[] {
  const parts = typeof expect === 'string' ? [expect] : expect;
  const lines = parts
    .flatMap((p) => p.split('\n'))
    .map(globLine)
    .filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const longest = lines.reduce((a, b) => (b.length > a.length ? b : a));
  const pointer = lines.find((l) => l.includes(POINTER));
  const picks = [lines[0] as string, pointer, longest, lines[lines.length - 1] as string];
  const out: string[] = [];
  for (const l of picks) if (l !== undefined && !out.includes(l)) out.push(l);
  return out.slice(0, GATE_LINES_MAX);
}

/** The pane's state terms every gate holds besides its tty. */
const MODE_TERMS = ['#{==:#{pane_in_mode},0}', '#{==:#{pane_synchronized},0}', '#{==:#{pane_input_off},0}', '#{==:#{pane_dead},0}'];

/** The `if-shell -F` gate for a pane on `tty`, with the expected lines when given. */
export function tmuxGate(expect: string | readonly string[] | undefined, tty: string): string {
  if (!PTS_RE.test(tty)) throw new Error('a tmux gate needs a /dev/pts tty');
  const terms = [`#{==:#{pane_tty},${tty}}`, ...MODE_TERMS, ...(expect === undefined ? [] : gateLines(expect).map((l) => `#{C:${l}}`))];
  // tmux 3.2's && takes two operands: nest them.
  return terms.reduceRight((rest, term) => `#{&&:${term},${rest}}`);
}

/** Each byte of `keys` as its own two-digit hex token (send-keys -H). */
export function hexTokens(keys: string): string {
  return [...Buffer.from(keys, 'latin1')].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** The pane's flags, read when an ungated write was refused: which one stopped it. */
const FLAGS_FORMAT = ['#{pane_tty}', '#{pane_in_mode}', '#{pane_synchronized}', '#{pane_input_off}', '#{pane_dead}'].join(FIELD_SEP);

async function refusalOf(ctx: DaemonContext, opts: TmuxBackendOptions, pane: Pane): Promise<Failure> {
  const r = await runTmux(ctx, opts, ['display-message', '-p', '-t', pane.handle, FLAGS_FORMAT]);
  if (!ok(r)) return tmuxFailure(r);
  const [tty, inMode, sync, inputOff, dead] = r.stdout.replace(/\n$/u, '').split(FIELD_SEP);
  if (tty !== pane.tty) return fail('not_found', NOT_THIS_PANE);
  if (dead === '1') return fail('not_found', 'the program in the tmux pane has exited');
  if (inMode === '1') return fail('unsupported', 'the tmux pane is in copy mode: press q there');
  if (sync === '1') return fail('unsupported', 'synchronize-panes is on in that tmux window');
  if (inputOff === '1') return fail('unsupported', "the tmux pane's input is off");
  return fail('changed', CHANGED_REASON);
}

/** The one write primitive (load-buffer on stdin, then one gated if-shell). */
export async function tmuxWrite(ctx: DaemonContext, opts: TmuxBackendOptions, pane: Pane, write: TmuxWrite): Promise<OpResult> {
  if (!ctx.bins.tmux) return fail('unsupported', NO_TMUX);
  if (pane.backend !== 'tmux' || !PANE_ID_RE.test(pane.handle)) return fail('unsupported', 'not a tmux pane');
  if (!PTS_RE.test(pane.tty)) return fail('not_found', 'the tmux pane has no tty');
  const text = write.text ?? '';
  const keys = write.keys ?? '';
  if (FORBIDDEN_TEXT.test(text)) return fail('unsupported', 'the text contains control characters');
  if (keys !== '' && !KEY_BYTES_RE.test(keys)) return fail('unsupported', 'not key bytes');
  if (write.expect !== undefined && gateLines(write.expect).length === 0) {
    return fail('unsupported', 'there is nothing on screen to compare with; nothing was typed');
  }
  if (!text && !keys && !write.enter) return fail('unsupported', 'there is nothing to type');

  const t = pane.handle;
  const buffer = text ? `jantar-${newId()}` : null;
  if (buffer !== null && !BUFFER_RE.test(buffer)) return fail('failed', 'could not name a tmux buffer');
  const steps: string[] = [];
  if (keys) steps.push(`send-keys -t ${t} -H ${hexTokens(keys)}`);
  if (buffer) steps.push(`paste-buffer ${/[\n\t]/u.test(text) ? '-p ' : ''}-d -r -b ${buffer} -t ${t}`);
  if (write.enter) steps.push(`send-keys -t ${t} Enter`);
  const otherwise = buffer ? `delete-buffer -b ${buffer} ; display-message -p ${JANTAR_CHANGED}` : `display-message -p ${JANTAR_CHANGED}`;

  if (buffer) {
    const loaded = await runTmux(ctx, opts, ['load-buffer', '-b', buffer, '-'], { input: text });
    if (!ok(loaded)) {
      const why = tmuxFailure(loaded);
      ctx.log.warn('tmux load-buffer failed', { code: why.code });
      await dropBuffer(ctx, opts, buffer);
      // Nothing reached the pane.
      return why.code === 'not_found' ? why : fail('unsupported', why.reason);
    }
  }
  const r = await runTmux(ctx, opts, ['if-shell', '-F', '-t', t, tmuxGate(write.expect, pane.tty), steps.join(' ; '), otherwise]);
  if (!ok(r)) {
    const why = tmuxFailure(r);
    ctx.log.warn('tmux write failed', { code: why.code });
    if (buffer) await dropBuffer(ctx, opts, buffer);
    return why;
  }
  if (r.stdout.trim() !== JANTAR_CHANGED) return { ok: true };
  return write.expect !== undefined ? fail('changed', CHANGED_REASON) : refusalOf(ctx, opts, pane);
}

/** Best effort: a buffer left behind holds the text. */
async function dropBuffer(ctx: DaemonContext, opts: TmuxBackendOptions, buffer: string): Promise<void> {
  await runTmux(ctx, opts, ['delete-buffer', '-b', buffer]).catch(() => undefined);
}
