/**
 * jantar meetings (v0.5 spec 4.13): the Meetings switch and the meeting
 * library at the Mac.
 *
 * - With no action: on or off, meetings.db open or its broken sentence, the
 *   meetings kept (and how many run), the screenshots against their 5 GB
 *   ceiling, whether summaries can run, and the paired Chrome extension.
 * - `on` and `off` change settings meetings.enabled (Mac only), like
 *   `jantar intel on`; `on` says what stays on the Mac and what the summary
 *   sends, and says at once when meetings.db would not open.
 * - `export <id|last>` and `export --all` write each meeting into a new
 *   folder `<out>/<yyyy-mm-dd>-<slug>-<last 6 of id>/` (0700) holding
 *   `meeting.md` and `shots/<HHMMSS>-<n>.jpg` (0600), times in the meeting's
 *   zone as the daemon's meetings core has it (Life's time zone when one is
 *   set, else the Mac's), so the export's days and times match the
 *   summary's. Nothing is ever written into a folder that is already there:
 *   one meeting's export refuses it, `--all` skips it, so an `--all` that
 *   stopped part way runs again into the same folder. A screenshot the
 *   daemon cannot give (gone, or its file would not read) is left out:
 *   meeting.md keeps its time, stderr says which, and the export exits 1.
 *   It reads over ctl.sock only: status, list, get and the shot bytes are
 *   the meeting routes served there.
 * - `unpair` revokes every paired extension key.
 *
 * `pairExtension()` is `jantar pair --extension` (commands/pair.ts calls it):
 * print the line the extension's popup takes, then wait for its claim.
 */
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { expandHome } from '@jantar/daemon/files/deny';
import {
  EXTENSION_PAIR_PREFIX,
  LifeIdSchema,
  MEETING_LIMITS,
  MEETING_SHOTS_TOTAL_MAX_BYTES,
  PAIR_CODE_TTL_MS,
  ROUTES,
  buildPath,
  meetingMarkdown,
  type ExtPairStartReply,
  type ExtUnpairReply,
  type Meeting,
  type MeetingDetail,
  type MeetingsList,
  type MeetingsStatus,
} from '@jantar/protocol';
import { UsageError, parseArgs, type ParsedArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { CtlUnavailableError, DaemonError, callDaemon, isErrorBody } from '../ctl.js';
import { readSettings, readSettingsFile } from '../lib/settings.js';
import { changeSettings, onOff, parseOnOff } from '../lib/switches.js';
import { ago, clip, plural } from '../lib/text.js';

/** What `jantar meetings on` says (spec 1.2: said plainly where it matters). */
export const MEETINGS_DATA_FLOW =
  'Transcripts and screenshots stay in Jantar on this Mac. After a meeting, its transcript text (never a screenshot) goes to Claude through Claude Code on your account to write the summary.\n';
const PAIR_HINT = 'Pair the Chrome extension: jantar pair --extension (docs/extension.md)\n';
/** How often `pair --extension` asks whether the extension has claimed its code. */
export const PAIR_WAIT_EVERY_MS = 1_000;
/** A slug in an export's folder name is at most this long. */
const SLUG_MAX = 40;

const FLAGS = {
  all: { type: 'boolean', help: 'export: every meeting, one folder each' },
  out: { type: 'string', short: 'o', help: 'export: the folder to write into (default: the current folder)' },
} as const;

type Flags = ParsedArgs<typeof FLAGS>['flags'];

/** Refuse flags that belong to another action, so a typo never goes unnoticed. */
function only(flags: Flags, action: string, allowed: readonly (keyof typeof FLAGS)[]): void {
  for (const name of Object.keys(FLAGS) as (keyof typeof FLAGS)[]) {
    if (flags[name] !== undefined && !allowed.includes(name)) throw new UsageError(`--${name} is not for "${['meetings', action].filter(Boolean).join(' ')}"`);
  }
}

function getStatus(ctx: CliContext): Promise<MeetingsStatus> {
  return callDaemon<MeetingsStatus>(ctx.ctl, 'GET', ROUTES.meetingsStatus.path);
}

/** "2 KB", "340 MB", "1.2 GB" (1024-based, as the 5 GB ceiling is). */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return plural(bytes, 'byte');
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  const shown = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
  return `${shown} ${units[u]}`;
}

// ------------------------------------------------------------------ status

function extensionLine(list: MeetingsStatus['extensions'], now: number): string {
  if (list.length === 0) return `Chrome extension: not paired. ${PAIR_HINT}`;
  const used = list.map((e) => e.lastSeenAt).filter((t): t is string => t !== null).sort();
  const last = used.at(-1);
  if (list.length === 1) {
    const e = list[0] as MeetingsStatus['extensions'][number];
    return `Chrome extension: paired ${ago(e.pairedAt, now)}, ${last ? `last used ${ago(last, now)}` : 'not used yet'}\n`;
  }
  return `Chrome extensions: ${list.length} paired, ${last ? `the last used ${ago(last, now)}` : 'none used yet'}\n`;
}

async function status(ctx: CliContext): Promise<number> {
  let st: MeetingsStatus;
  try {
    st = await getStatus(ctx);
  } catch (e) {
    if (!(e instanceof CtlUnavailableError)) throw e;
    const { settings } = await readSettingsFile(ctx);
    ctx.io.out(`jantard is not running; from ${ctx.paths.configFile}:\nMeetings: ${onOff(settings.meetings.enabled)}\n`);
    return EXIT.ok;
  }
  if (!st.on) {
    ctx.io.out('Meetings: off. Your meetings stay on this Mac. Turn them on: jantar meetings on\n');
  } else {
    ctx.io.out(`Meetings: on\nMeetings data: ${st.broken ? `broken: ${st.broken}` : st.open ? 'open' : 'not open'}\n`);
    if (st.open) {
      ctx.io.out(`Meetings kept: ${st.meetings}${st.running ? ` (${st.running} running)` : ''}\n`);
      ctx.io.out(`Screenshots: ${sizeText(st.shotsBytes)} of ${sizeText(MEETING_SHOTS_TOTAL_MAX_BYTES)}\n`);
      ctx.io.out(`Summaries: ${st.summary.available ? 'available' : `not available${st.summary.reason ? `: ${st.summary.reason}` : ''}`}\n`);
    }
  }
  ctx.io.out(extensionLine(st.extensions, ctx.deps.now()));
  return EXIT.ok;
}

// ------------------------------------------------------------------ on, off

async function switchMeetings(ctx: CliContext, on: boolean): Promise<number> {
  const r = await changeSettings(ctx, { meetings: { enabled: on } }, () =>
    on
      ? `Meetings are on. The phone shows them under More > Meetings.\n${MEETINGS_DATA_FLOW}`
      : 'Meetings are off. The extension saves nothing and the phone no longer shows them; your meetings stay on this Mac.\n',
  );
  if (on) {
    // The daemon opens meetings.db as the switch turns on: a file it refused is said here, not only in the status.
    const st = r.via === 'daemon' ? await getStatus(ctx).catch(() => null) : null;
    if (st?.broken) ctx.io.err(`${st.broken}\n`);
    // Point at pairing until an extension is paired (with the daemon down nothing says whether one is).
    if (!st || st.extensions.length === 0) ctx.io.out(PAIR_HINT);
  }
  return EXIT.ok;
}

// ------------------------------------------------------------------ unpair

async function unpair(ctx: CliContext): Promise<number> {
  const r = await callDaemon<ExtUnpairReply>(ctx.ctl, 'POST', ROUTES.extUnpair.path, undefined, { idempotencyKey: ctx.deps.randomId() });
  if (r.revoked === 0) {
    ctx.io.out('No extension was paired.\n');
    return EXIT.ok;
  }
  ctx.io.out(
    `Unpaired ${plural(r.revoked, 'extension')}: ${r.revoked === 1 ? 'its key no longer works' : 'their keys no longer work'}. ` +
      'Pair again with: jantar pair --extension\n',
  );
  return EXIT.ok;
}

// ------------------------------------------------------------------ pair --extension

/**
 * `jantar pair --extension`: note the extensions paired now, start a
 * one-time extension code, print `jantar-ext:<port>:<code>` on its own line,
 * then ask every second until an extension id not seen before appears
 * ("Paired.") or the code expires (exit 1). Ctrl-C stops the wait only; the
 * code keeps working until it expires.
 *
 * Any new id counts as this code's claim: the status names extensions, not
 * the code each came from. With two `pair --extension` runs waiting at once,
 * the first claim makes both say "Paired."; each code still pairs its own
 * extension when it is claimed.
 */
export async function pairExtension(ctx: CliContext): Promise<number> {
  const before = await getStatus(ctx);
  const known = new Set(before.extensions.map((e) => e.id));
  const start = await callDaemon<ExtPairStartReply>(ctx.ctl, 'POST', ROUTES.extPairStart.path, undefined, {
    idempotencyKey: ctx.deps.randomId(),
  });
  if (start.port === null) throw new Error('jantard is not listening on a TCP port, so the extension cannot reach it (see: jantar doctor)');
  ctx.io.out(`In Chrome, click the Jantar icon and paste:\n\n${EXTENSION_PAIR_PREFIX}:${start.port}:${start.code}\n\nIt works once, within 10 minutes.\n`);
  if (!before.on) ctx.io.out('Meetings are off: jantar meetings on\n');
  ctx.io.out('Waiting for the extension (Ctrl-C stops waiting; the code still works).\n');
  // An expiry that does not parse still waits the code's ten minutes, never one look.
  const at = Date.parse(start.expiresAt);
  const expires = Number.isFinite(at) ? at : ctx.deps.now() + PAIR_CODE_TTL_MS;
  for (;;) {
    await ctx.deps.sleep(PAIR_WAIT_EVERY_MS);
    const after = await getStatus(ctx);
    // A claim that lands in the code's last second still counts.
    if (after.extensions.some((e) => !known.has(e.id))) {
      ctx.io.out('Paired.\n');
      return EXIT.ok;
    }
    if (!(ctx.deps.now() < expires)) throw new Error('The code expired. Run jantar pair --extension again.');
  }
}

// ------------------------------------------------------------------ export

function knownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone an export writes its days and times in, as the daemon's meetings
 * core reads it (`core.tz()`, which the summary's [HH:MM] stamps and the
 * todos' "From the meeting" day follow): Life's time zone when one is set,
 * else the Mac's (TZ when this Node knows it, else the system's).
 */
async function exportZone(ctx: CliContext): Promise<string> {
  const life = (await readSettings(ctx)).settings.life.timezone;
  if (life && knownZone(life)) return life;
  const tz = ctx.io.env.TZ;
  return tz && knownZone(tz) ? tz : Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** `{ day: '2026-10-30', time: '100500' }` of `iso` in `zone`. */
function zoned(iso: string, zone: string): { day: string; time: string } {
  const p: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (const part of fmt.formatToParts(new Date(iso))) p[part.type] = part.value;
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}${p.minute}${p.second}` };
}

/** A meeting name as lowercase ASCII letters, digits and hyphens, at most 40; "meeting" when nothing is left. */
export function slugOf(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return s || 'meeting';
}

/** `<yyyy-mm-dd>-<slug>-<last 6 of id>`, the day in `zone`. */
export function exportFolderName(m: Pick<Meeting, 'id' | 'name' | 'startedAt'>, zone: string): string {
  return `${zoned(m.startedAt, zone).day}-${slugOf(m.name)}-${m.id.slice(-6).toLowerCase()}`;
}

function listPage(ctx: CliContext, limit: number, before?: string): Promise<MeetingsList> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (before) q.set('before', before);
  return callDaemon<MeetingsList>(ctx.ctl, 'GET', `${ROUTES.meetingsList.path}?${q}`);
}

/** Every meeting, newest first, a page at a time. */
async function listAll(ctx: CliContext): Promise<Meeting[]> {
  const all: Meeting[] = [];
  const seen = new Set<string>();
  let before: string | undefined;
  for (;;) {
    const page = await listPage(ctx, MEETING_LIMITS.page, before);
    all.push(...page.meetings);
    // A cursor seen before would page forever.
    if (!page.next || seen.has(page.next)) return all;
    seen.add(page.next);
    before = page.next;
  }
}

/**
 * A screenshot's bytes over ctl.sock. An error answer comes back as JSON and
 * throws a DaemonError carrying the daemon's own sentence.
 */
async function shotBytes(ctx: CliContext, id: string, shotId: string): Promise<Buffer> {
  const res = await ctx.ctl.bytes(buildPath(ROUTES.meetingShot, { id, shotId }));
  if (res.status === 200 && res.type.startsWith('image/jpeg')) return res.body;
  let code = 'internal';
  let message = `daemon answered HTTP ${res.status}`;
  try {
    const body: unknown = JSON.parse(res.body.toString('utf8'));
    if (isErrorBody(body)) {
      code = body.error.code;
      message = body.error.message;
    }
  } catch {
    // not JSON: keep the status
  }
  throw new DaemonError(res.status, code, message);
}

/**
 * The answers that mean this one screenshot cannot be had: its row or file
 * is gone (404), or it would not read (503). The export goes on without it,
 * so one bad screenshot never stops the rest. Any other answer stops it.
 */
const SHOT_LEFT_OUT = new Set([404, 503]);

/**
 * Write one meeting into the new folder `dir`: the screenshots first, then
 * meeting.md pointing at them. A folder already there is refused untouched;
 * a failure part way removes the folder this export made, so it can run
 * again. A screenshot the daemon cannot give is left out (meeting.md shows
 * its time only) and said on stderr; the count left out is returned.
 */
async function writeMeeting(ctx: CliContext, d: MeetingDetail, dir: string, zone: string): Promise<number> {
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${dir} is already there; nothing was written. Export into another folder with --out <dir>`);
    throw e;
  }
  try {
    // n in the file name is the screenshot's place in time, as meetingMarkdown counts it.
    const shots = [...d.shots].sort((a, b) => a.at.localeCompare(b.at));
    const files = new Map<string, string>();
    let leftOut = 0;
    for (const [i, s] of shots.entries()) {
      const time = zoned(s.at, zone).time;
      let body: Buffer;
      try {
        body = await shotBytes(ctx, d.meeting.id, s.id);
      } catch (e) {
        if (!(e instanceof DaemonError)) throw e;
        if (!SHOT_LEFT_OUT.has(e.status)) throw new Error(`a screenshot could not be read: ${e.message}`);
        ctx.io.err(`"${clip(d.meeting.name, 60)}": the screenshot at ${time.slice(0, 2)}:${time.slice(2, 4)} is left out (${clip(e.message, 160)})\n`);
        leftOut += 1;
        continue;
      }
      const name = `${time}-${i + 1}.jpg`;
      if (files.size === 0) await mkdir(join(dir, 'shots'), { mode: 0o700 });
      await writeFile(join(dir, 'shots', name), body, { mode: 0o600, flag: 'wx' });
      files.set(s.id, name);
    }
    const md = meetingMarkdown(d, {
      timeZone: zone,
      shotRef: (s) => {
        const f = files.get(s.id);
        return f ? `shots/${f}` : null;
      },
    });
    await writeFile(join(dir, 'meeting.md'), md, { mode: 0o600, flag: 'wx' });
    ctx.io.out(exportedLine(d, dir, files.size, leftOut));
    return leftOut;
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

function getMeeting(ctx: CliContext, id: string): Promise<MeetingDetail> {
  return callDaemon<MeetingDetail>(ctx.ctl, 'GET', buildPath(ROUTES.meetingGet, { id }));
}

function exportedLine(d: MeetingDetail, dir: string, written: number, leftOut: number): string {
  const shots = written ? ` and ${plural(written, 'screenshot')}` : '';
  const missed = leftOut ? `; ${leftOut} left out` : '';
  return `Exported "${clip(d.meeting.name, 60)}" to ${dir} (meeting.md${shots}${missed})\n`;
}

/** After the folders are written: exit 1 when a screenshot was left out, saying how to try again. */
function leftOutEnd(leftOut: number): number {
  if (leftOut === 0) return EXIT.ok;
  throw new Error(
    `${plural(leftOut, 'screenshot')} could not be read and ${leftOut === 1 ? 'is' : 'are'} left out (above); meeting.md shows ${leftOut === 1 ? 'its' : 'their'} time only. ` +
      "To try again, delete the meeting's folder and export it again.",
  );
}

async function exportOne(ctx: CliContext, which: string, out: string): Promise<number> {
  const zone = await exportZone(ctx);
  let id = which;
  if (which === 'last') {
    const newest = (await listPage(ctx, 1)).meetings[0];
    if (!newest) throw new Error('there are no meetings yet');
    id = newest.id;
  }
  const d = await getMeeting(ctx, id);
  return leftOutEnd(await writeMeeting(ctx, d, join(out, exportFolderName(d.meeting, zone)), zone));
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

async function exportAll(ctx: CliContext, out: string): Promise<number> {
  const zone = await exportZone(ctx);
  const all = await listAll(ctx);
  if (all.length === 0) {
    ctx.io.out('No meetings yet: nothing to export.\n');
    return EXIT.ok;
  }
  // Every folder is named before anything is written, so two meetings never write into one.
  const plan = all.map((m) => ({ id: m.id, dir: join(out, exportFolderName(m, zone)) }));
  const names = new Set<string>();
  for (const p of plan) {
    if (names.has(p.dir)) throw new Error(`two meetings would share the folder ${p.dir}; export them one at a time`);
    names.add(p.dir);
  }
  let done = 0;
  let there = 0;
  let leftOut = 0;
  try {
    for (const p of plan) {
      // A folder already there was written by an earlier run (a failed one removes its own), or is not ours: kept as it is.
      if (await exists(p.dir)) {
        there += 1;
        continue;
      }
      const d = await getMeeting(ctx, p.id).catch((e: unknown) => {
        if (e instanceof DaemonError && e.status === 404) return null;
        throw e;
      });
      if (!d) {
        ctx.io.out(`Skipped ${p.id}: deleted since the list was read.\n`);
        continue;
      }
      leftOut += await writeMeeting(ctx, d, p.dir, zone);
      done += 1;
    }
  } catch (e) {
    if (done + there > 0) ctx.io.err('Stopped part way. The same command again exports the rest and leaves the folders already there as they are.\n');
    throw e;
  }
  ctx.io.out(`Exported ${plural(done, 'meeting')} to ${out}${there ? ` (${there} already there, left as they were)` : ''}\n`);
  return leftOutEnd(leftOut);
}

function exportArgs(rest: readonly string[], flags: Flags, userHome: string): { which: string | null; out: string } {
  const [which, extra] = rest;
  if (extra !== undefined) throw new UsageError(`unexpected argument "${clip(extra, 40)}"`);
  if (flags.all && which !== undefined) throw new UsageError('give a meeting id, last or --all, not two of them');
  if (!flags.all && which === undefined) throw new UsageError('export needs a meeting id, last or --all');
  if (which !== undefined && which !== 'last' && !LifeIdSchema.safeParse(which).success) {
    throw new UsageError(`"${clip(which, 40)}" is not a meeting id (26 letters and digits, as the phone's Export shows it) or last`);
  }
  if (flags.out !== undefined && flags.out.trim() === '') throw new UsageError('--out needs a folder');
  return { which: which ?? null, out: resolve(flags.out === undefined ? process.cwd() : expandHome(flags.out.trim(), userHome)) };
}

export default defineCommand(
  {
    name: 'meetings',
    summary: 'Meetings from the Chrome extension: on or off, export with the screenshots, unpair the extension.',
    usage: 'jantar meetings [on | off | export <id|last|--all> [--out <dir>] | unpair]',
    owner: 'WP-MC',
    help:
      '  meetings                       on or off, meetings kept and running, screenshots of 5 GB, summaries, the extension\n' +
      '  meetings on | off              turn Meetings on or off (off keeps every meeting on this Mac)\n' +
      '  meetings export <id> | last [--out <dir>]\n' +
      '                                 one meeting as Markdown with its screenshots, in a new folder under <dir>\n' +
      '                                 (default: the current folder): <yyyy-mm-dd>-<name>-<id end>/meeting.md, shots/\n' +
      '  meetings export --all [--out <dir>]\n' +
      '                                 every meeting, a folder each (Time Machine and this are the only copies);\n' +
      '                                 folders already there are left as they are, so a stopped run can go again\n' +
      '  meetings unpair                revoke every paired Chrome extension (it asks to pair again)\n' +
      'Pair the extension with: jantar pair --extension (docs/extension.md).',
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(argv, FLAGS);
    const [action, ...rest] = positionals;
    switch (action) {
      case undefined:
        only(flags, '', []);
        return status(ctx);
      case 'on':
      case 'off':
        only(flags, action, []);
        if (rest.length) throw new UsageError(`${action} takes no argument`);
        return switchMeetings(ctx, parseOnOff(action, 'meetings'));
      case 'export': {
        only(flags, action, ['all', 'out']);
        const { which, out } = exportArgs(rest, flags, ctx.paths.userHome);
        return which === null ? exportAll(ctx, out) : exportOne(ctx, which, out);
      }
      case 'unpair':
        only(flags, action, []);
        if (rest.length) throw new UsageError('unpair takes no argument');
        return unpair(ctx);
      default:
        throw new UsageError(`unknown action "${clip(action, 20)}" (on, off, export or unpair)`);
    }
  },
);
