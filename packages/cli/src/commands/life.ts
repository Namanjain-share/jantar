/**
 * jantar life (v0.4): the Mac-only side of Life (settings life.*; a phone can
 * never change them). Turn the six modules on or off, set the Life time
 * zone, the currency label and whether names reach the lock screen, back
 * life.db up and put a backup back.
 *
 * Switches and settings go through the daemon over ctl.sock (with the
 * daemon down they land in config.json, lib/settings.ts). Status, backup
 * and restore ask the daemon (backup and restore are ctl.sock only: the
 * daemon refuses them over the network). Restore asks y/N first, or needs
 * --yes without a terminal to ask on; the current life.db is always kept
 * beside the restored one.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  LIFE_MODULES,
  LifeBackupNameSchema,
  ROUTES,
  type LifeBackupResponse,
  type LifeModule,
  type LifeRestoreResponse,
  type LifeStatus,
  type Settings,
} from '@jantar/protocol';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { CtlUnavailableError, callDaemon } from '../ctl.js';
import { readSettingsFile } from '../lib/settings.js';
import { changeSettings, onOff, parseOnOff } from '../lib/switches.js';
import { ago, plural } from '../lib/text.js';

const FLAGS = {
  yes: { type: 'boolean', short: 'y', help: 'restore: do not ask first' },
} as const;

/** What each module is, for the on/off lines. */
const MODULE_WORDS: Readonly<Record<LifeModule, string>> = {
  todos: 'projects, todos and reminders',
  medicines: 'medicines and their pings',
  food: 'food, calories and weight',
  places: 'cafés',
  finance: 'money and bills',
  posts: 'social posts and their reminders',
};

const ISO_4217 = /^[A-Z]{3}$/;

/** Whether this Node knows the IANA zone (the daemon checks again). */
function knownZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "todos medicines" or "all" -> the modules named, or a usage error. */
function parseModules(words: readonly string[], action: string): LifeModule[] {
  if (words.length === 0) throw new UsageError(`${action} needs a module: ${LIFE_MODULES.join(' ')} (or all)`);
  if (words.length === 1 && words[0] === 'all') return [...LIFE_MODULES];
  const out: LifeModule[] = [];
  for (const w of words) {
    if (!(LIFE_MODULES as readonly string[]).includes(w)) throw new UsageError(`unknown module "${w}" (${LIFE_MODULES.join(', ')} or all)`);
    if (!out.includes(w as LifeModule)) out.push(w as LifeModule);
  }
  return out;
}

function modulesLine(life: Readonly<Record<LifeModule, boolean>>): string {
  const on = LIFE_MODULES.filter((m) => life[m]);
  const off = LIFE_MODULES.filter((m) => !life[m]);
  if (on.length === 0) return `Life modules: all off (turn one on: jantar life on <module>; modules: ${LIFE_MODULES.join(' ')})\n`;
  return `Life modules on: ${on.join(', ')}${off.length ? `; off: ${off.join(', ')}` : ''}\n`;
}

/** The zone, currency and lock-screen lines; `zone` as it should read. */
function settingsLines(zone: string, life: Pick<Settings['life'], 'currency' | 'lockScreenDetails'>): string {
  return (
    `Time zone: ${zone}\n` +
    `Currency: ${life.currency ?? 'none (amounts show as plain numbers)'}\n` +
    `Lock screen details: ${onOff(life.lockScreenDetails)} (${life.lockScreenDetails ? 'medicine and bill names and where a post goes on the lock screen' : 'pushes say "Medicine due", "Bill due" and "Post due", no names'})\n`
  );
}

function pushLine(p: LifeStatus['push']): string {
  if (!p.webpush) return 'Medicine pings: none go out, because Web Push is off in the notification settings.\n';
  if (p.devices === 0) return 'Medicine pings: no device gets them. Turn notifications on for a phone with control (Devices > This device).\n';
  return `Medicine pings: ${plural(p.devices, 'device')} with notifications on\n`;
}

async function status(ctx: CliContext): Promise<number> {
  let st: LifeStatus;
  try {
    st = await callDaemon<LifeStatus>(ctx.ctl, 'GET', ROUTES.lifeStatus.path);
  } catch (e) {
    if (!(e instanceof CtlUnavailableError)) throw e;
    const { settings } = await readSettingsFile(ctx);
    const life = settings.life;
    ctx.io.out(`jantard is not running; from ${ctx.paths.configFile}:\n${modulesLine(life)}${settingsLines(life.timezone ?? "the Mac's", life)}`);
    return EXIT.ok;
  }
  const state = st.broken ? `broken: ${st.broken}` : st.open ? 'open' : 'closed (no module is on)';
  ctx.io.out(`Life data: ${state}\n${modulesLine(st.modules)}`);
  ctx.io.out(settingsLines(`${st.timezone} (today is ${st.today})`, st));
  ctx.io.out(pushLine(st.push));
  if (st.modules.food) ctx.io.out(`Ask Claude (calories): ${st.estimate.available ? 'available' : `not available${st.estimate.reason ? `: ${st.estimate.reason}` : ''}`}\n`);
  ctx.io.out(
    st.backups.count === 0
      ? `Backups: none yet in ${ctx.paths.backupsDir} (nightly at 03:30; now: jantar life backup)\n`
      : `Backups: ${st.backups.count} in ${ctx.paths.backupsDir}, the newest ${ago(st.backups.last, ctx.deps.now())}\n`,
  );
  return EXIT.ok;
}

async function switchModules(ctx: CliContext, on: boolean, words: readonly string[]): Promise<number> {
  const mods = parseModules(words, on ? 'on' : 'off');
  const patch = Object.fromEntries(mods.map((m) => [m, on]));
  await changeSettings(ctx, { life: patch }, (s) => {
    const what = mods.map((m) => `${m} (${MODULE_WORDS[m]})`).join(', ');
    return `${on ? 'On' : 'Off'}: ${what}.\n${modulesLine(s.life)}`;
  });
  return EXIT.ok;
}

async function set(ctx: CliContext, key: string | undefined, value: string | undefined, rest: readonly string[]): Promise<number> {
  if (key === undefined || value === undefined) throw new UsageError('set needs a key and a value: timezone <IANA>|none, currency <XXX>|none, lock-screen-details on|off');
  if (rest.length) throw new UsageError(`unexpected argument "${rest[0]}"`);
  switch (key) {
    case 'timezone': {
      const zone = value === 'none' ? null : value;
      if (zone !== null && !knownZone(zone)) throw new UsageError(`"${value}" is not a time zone this Mac knows (an IANA name such as Asia/Kolkata or Europe/London, or none for the Mac's own)`);
      await changeSettings(ctx, { life: { timezone: zone } }, (s) => `Time zone: ${s.life.timezone ?? "the Mac's"}. Days and ping times follow it.\n`);
      return EXIT.ok;
    }
    case 'currency': {
      const code = value === 'none' ? null : value.toUpperCase();
      if (code !== null && !ISO_4217.test(code)) throw new UsageError(`"${value}" is not a currency code (three letters such as INR, USD or EUR, or none)`);
      await changeSettings(ctx, { life: { currency: code } }, (s) => `Currency: ${s.life.currency ?? 'none (amounts show as plain numbers)'}\n`);
      return EXIT.ok;
    }
    case 'lock-screen-details': {
      const on = parseOnOff(value, 'lock-screen-details');
      await changeSettings(ctx, { life: { lockScreenDetails: on } }, (s) =>
        s.life.lockScreenDetails
          ? 'Lock screen details: on. Medicine, bill and post pushes name the medicine, the bill and its amount, and where a post goes.\n'
          : 'Lock screen details: off. Pushes say "Medicine due", "Bill due" and "Post due", no names.\n',
      );
      return EXIT.ok;
    }
    default:
      throw new UsageError(`unknown setting "${key}" (timezone, currency or lock-screen-details)`);
  }
}

async function backup(ctx: CliContext): Promise<number> {
  const r = await callDaemon<LifeBackupResponse>(ctx.ctl, 'POST', ROUTES.lifeBackup.path, undefined, { idempotencyKey: ctx.deps.randomId() });
  ctx.io.out(`Backed up to ${join(ctx.paths.backupsDir, r.file)}\n`);
  return EXIT.ok;
}

/** The backup names in the local backups folder, newest first. */
function localBackups(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: { name: string; at: number }[] = [];
  for (const name of names) {
    if (!LifeBackupNameSchema.safeParse(name).success) continue;
    try {
      const st = statSync(join(dir, name));
      if (st.isFile()) files.push({ name, at: st.mtimeMs });
    } catch {
      // gone since the listing
    }
  }
  return files.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name)).map((f) => f.name);
}

async function restore(ctx: CliContext, file: string | undefined, rest: readonly string[], yes: boolean): Promise<number> {
  if (file === undefined) {
    const names = localBackups(ctx.paths.backupsDir);
    const list = names.length ? `Backups in ${ctx.paths.backupsDir}, newest first:\n${names.map((n) => `  ${n}\n`).join('')}` : `No backups in ${ctx.paths.backupsDir}.\n`;
    throw new UsageError(`restore needs a backup's file name.\n${list}`);
  }
  if (rest.length) throw new UsageError(`unexpected argument "${rest[0]}"`);
  if (!LifeBackupNameSchema.safeParse(file).success) throw new UsageError(`"${file}" is not a backup name (life-<date>.db, a name inside ${ctx.paths.backupsDir}, no folder)`);
  if (!yes) {
    if (!ctx.io.ask) {
      ctx.io.err('jantar life: restore replaces life.db; there is no terminal to ask on, so add --yes.\n');
      return EXIT.usage;
    }
    const answer = (await ctx.io.ask(`Put ${file} back as life.db? The current life.db is kept beside it. [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      ctx.io.out('Not restored.\n');
      return EXIT.ok;
    }
  }
  const r = await callDaemon<LifeRestoreResponse>(ctx.ctl, 'POST', ROUTES.lifeRestore.path, { file }, { idempotencyKey: ctx.deps.randomId() });
  ctx.io.out(`Restored ${file}.${r.kept ? ` The previous life.db is kept as ${join(ctx.paths.home, r.kept)}` : ''}\n`);
  return EXIT.ok;
}

export default defineCommand(
  {
    name: 'life',
    summary: 'Turn Life modules on or off, set its zone and currency, back it up and restore it.',
    usage: 'jantar life <status|on|off|set|backup|restore> ...',
    owner: 'WP-LS',
    help:
      '  life status                           modules, zone, currency, who gets medicine pings, backups\n' +
      `  life on <module...> | all             turn modules on (${LIFE_MODULES.join(' ')})\n` +
      '  life off <module...> | all            turn modules off (their data stays in life.db)\n' +
      "  life set timezone <IANA>|none         the zone days and ping times follow (none: the Mac's)\n" +
      '  life set currency <XXX>|none          a label for amounts (none: plain numbers)\n' +
      '  life set lock-screen-details on|off   medicine and bill names and where a post goes on the lock screen (off: "Medicine due")\n' +
      '  life backup                           copy life.db into the backups folder now (nightly at 03:30)\n' +
      '  life restore <file> [--yes]           put a backup back; asks first, and keeps the current life.db\n' +
      'The switches, zone, currency and lock-screen details change only here, at the Mac.',
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(argv, FLAGS, { min: 1 });
    const [action, ...rest] = positionals;
    if (flags.yes && action !== 'restore') throw new UsageError('--yes goes with restore');
    switch (action) {
      case 'status':
        if (rest.length) throw new UsageError('status takes no argument');
        return status(ctx);
      case 'on':
      case 'off':
        return switchModules(ctx, action === 'on', rest);
      case 'set':
        return set(ctx, rest[0], rest[1], rest.slice(2));
      case 'backup':
        if (rest.length) throw new UsageError('backup takes no argument');
        return backup(ctx);
      case 'restore':
        return restore(ctx, rest[0], rest.slice(1), flags.yes === true);
      default:
        throw new UsageError(`unknown action "${action}" (status, on, off, set, backup or restore)`);
    }
  },
);
