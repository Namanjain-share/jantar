/**
 * Settings (`~/.jantar/config.json`). Repo defaults are deliberately safe:
 * autoswitch off, dry run on, empty hold list, Web Push only for "needs you"
 * kinds plus failed sends. Personal values belong in the user's own config.
 */
import { z } from 'zod';
import { DEFAULT_HOST, DEFAULT_PORT, SETTLE_MS } from './constants.js';
import {
  AccountIdSchema,
  DEFAULT_LAUNCH_FLAGS,
  IsoDateSchema,
  LaunchFlagsSchema,
  NotifyKindSchema,
  RewriteModelSchema,
  type Features,
  type NotifyKind,
} from './models.js';

export const DEFAULT_PROMPTS = {
  save:
    'Please save your work: finish or pause what is running, write down where each task stands ' +
    'and what comes next, then end your reply with READY-TO-SWITCH on its own line.',
  continue: 'Continue where you left off, using the notes you saved before the account switch.',
  ran_out:
    'The previous account ran out of usage before the work could be saved. Resume every task that ' +
    'was running, picking up where each one stopped.',
} as const;

export const DEFAULT_NOTIFY_KINDS: readonly NotifyKind[] = [
  'permission',
  'question',
  'plan',
  'send-failed',
];

const PromptsSchema = z.object({
  save: z.string().min(1).default(DEFAULT_PROMPTS.save),
  continue: z.string().min(1).default(DEFAULT_PROMPTS.continue),
  ran_out: z.string().min(1).default(DEFAULT_PROMPTS.ran_out),
});

export const AutoswitchSettingsSchema = z.object({
  on: z.boolean().default(false),
  dry_run: z.boolean().default(true),
  /** Accounts kept for other work: nothing moves off or onto them. */
  hold: z.array(AccountIdSchema).default(() => []),
  /** % of a 5-hour window treated as full. */
  ceiling: z.number().min(1).max(100).default(97),
  lead_min: z.number().min(0).default(10),
  park_lead_min: z.number().min(0).default(5),
  min_run_min: z.number().min(0).default(20),
  weekly_ceiling: z.number().min(1).max(100).default(95),
  /** %/min of a 5-hour window per session until measured. */
  burn_default: z.number().positive().default(1.0),
  save_timeout_min: z.number().positive().default(20),
  prompts: PromptsSchema.prefault({}),
});

export const NotifySettingsSchema = z.object({
  webpush: z.boolean().default(true),
  mac: z.boolean().default(false),
  telegram: z.boolean().default(false),
  reminders_min: z.array(z.number().positive()).default(() => [10, 30]),
  muted_until: IsoDateSchema.nullable().default(null),
  /** Push body detail: full text, a short summary, or a generic line. */
  bodies: z.enum(['full', 'short', 'generic']).default('full'),
  /** Which kinds are pushed. "send-failed" should stay on: a prompt that was not sent must be loud. */
  kinds: z.array(NotifyKindSchema).default(() => [...DEFAULT_NOTIFY_KINDS]),
  /** Permission cards wait this long before a push (auto-approvals land first). */
  settle_ms: z.number().int().min(0).max(60_000).default(SETTLE_MS),
  /**
   * v0.5.3: an urgent push when Claude's 2-minute auto-block countdown is on
   * an unattended ask's screen (jantar notify urgent on|off). It goes out as
   * a `permission` push, so `kinds` must hold permission.
   */
  urgent: z.boolean().default(true),
});

/** A root id: "desktop", "work". The API names it "r.<id>". */
export const RootIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/);

export const FolderRootSchema = z.object({
  id: RootIdSchema,
  /** Absolute or "~/..."; the daemon realpaths it at load and refuses /, /Users, ~/Library and denylisted dirs. */
  path: z.string().min(1),
  label: z.string().min(1).max(32),
});
export type FolderRoot = z.infer<typeof FolderRootSchema>;

/**
 * The one path policy Files and Folders share (Mac only). Roots are an array,
 * not a record: arrays replace wholesale in applySettingsPatch, so a new root
 * id is never an "unknown setting".
 */
export const FoldersSettingsSchema = z.object({
  roots: z.array(FolderRootSchema).max(20).default(() => []),
  /** Every live session's folder is a root too. */
  sessionRoots: z.boolean().default(true),
  /** Home-mode exceptions, e.g. "~/.config/nvim". */
  allow: z.array(z.string().min(1)).max(50).default(() => []),
  /** Names or paths added to the hard denylist (which cannot be shortened). */
  extraDeny: z.array(z.string().min(1)).max(200).default(() => []),
  showHidden: z.boolean().default(false),
});

/** Files: which files sessions changed, a folder browser and a read-only viewer. Off until turned on at the Mac. */
export const FilesSettingsSchema = z.object({
  enabled: z.boolean().default(false),
});

export const LaunchSettingsSchema = z.object({
  /** Optional command run before `cswap run`; "{n}" is replaced by the account number. */
  preLaunch: z.string().nullable().default(null),
  shareHistory: z.boolean().default(true),
  extraArgs: z.array(z.string()).default(() => []),
  /** v0.3: starting sessions (and creating folders) from the phone. Off until turned on at the Mac. */
  enabled: z.boolean().default(false),
  /**
   * How a new tab starts Claude.
   * - "claude" (v0.4, the default): `cd -- <folder> && <bins.claude> ...`, one Claude login, no account pick.
   * - "cswap-run": `<bins.cswap> run N -- ...` on the account picked.
   * - "cs-shell": `<csCommand> N -- ...`, for a shell function that wraps `cswap run`
   *   (kept for configs written before v0.4; `init` does not offer it).
   */
  mode: z.enum(['claude', 'cs-shell', 'cswap-run']).default('claude'),
  /** The shell function cs-shell mode types. */
  csCommand: z.string().min(1).default('cs'),
  /** argv run once per account before its first start, "{n}" = the account (e.g. an adopt script). */
  preLaunchArgv: z.array(z.string().min(1)).min(1).nullable().default(null),
  /** Where the start sheet's pickers begin for a device that never started one (U7). */
  defaultFlags: LaunchFlagsSchema.default(() => ({ ...DEFAULT_LAUNCH_FLAGS })),
  timeouts: z
    .object({
      /** Claude in the foreground of the new tab. */
      claudeS: z.number().int().min(10).max(600).default(90),
      /** The session ready for its first prompt. */
      readyS: z.number().int().min(10).max(1800).default(180),
      /** A startup dialog card waits this long before the launch is "stalled". */
      dialogMin: z.number().int().min(1).max(240).default(30),
    })
    .prefault({}),
  rate: z
    .object({
      perTenMin: z.number().int().min(1).max(100).default(4),
      perDay: z.number().int().min(1).max(1000).default(30),
      inFlight: z.number().int().min(1).max(10).default(2),
      foldersPerHour: z.number().int().min(1).max(100).default(10),
    })
    .prefault({}),
});

/** Rewrite (U5, U6): a throwaway headless Claude run turns dictated text into a prompt. Mac only. */
export const RewriteSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  model: RewriteModelSchema.default('opus'),
  effort: z.enum(['low', 'medium', 'high']).default('low'),
  fallbackModel: RewriteModelSchema.default('sonnet'),
  /** Accounts over this % of their 5-hour window are never used. */
  ceilingPct: z.number().min(1).max(100).default(85),
  /** Never used for rewrites, on top of the autoswitch hold list and ccw's. */
  excludeAccounts: z.array(AccountIdSchema).default(() => []),
  /** Words the prompt writer should spell exactly (project names, tools). */
  glossary: z.array(z.string().min(1).max(64)).max(200).default(() => []),
  timeoutS: z.number().int().min(5).max(300).default(120),
  /** The chosen account is kept this long while it still qualifies. */
  stickyMin: z.number().int().min(0).max(240).default(30),
});

/**
 * Controls (keys, modes, slash commands). Mac only.
 *
 * escapeVerified and clearVerified default to true since 0.4.1, after a run
 * on macOS 26.6, Terminal.app and Claude Code 2.1.314 (docs/real-mac-checks.md,
 * which says how to try them again): Escape as it ships (spike S2), and End
 * with Ctrl+U on a two-row draft (spike S1). Only the default changed: a
 * config.json that holds false keeps it (`jantar controls escape on` and
 * `jantar controls clear-draft on` switch them).
 */
export const ControlsSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** Escape (CSI-u): interrupts a busy turn without resending it, and leaves an idle draft alone (spike S2). */
  escapeVerified: z.boolean().default(true),
  /**
   * Clear draft: End once per row of the draft and two more, two Ctrl+U per
   * row and six more, then Terminal's Return in the empty box (spike S1). Its
   * bytes are cut to the rows Claude's input box shows; one Ctrl+U alone
   * cleared only the cursor's row, and the Return sent the rest. Refused
   * where the rows shown may be fewer than the draft's, or in vim NORMAL
   * mode (controls/keys.ts in the daemon).
   */
  clearVerified: z.boolean().default(true),
  /** What Interrupt sends. */
  interruptKey: z.enum(['interrupt', 'escape']).default('interrupt'),
});

/** Terminal screenshots. Off by default: the screen can show secrets. Mac only. */
export const ScreenshotsSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Long edge in px after resizing. */
  maxEdge: z.number().int().min(320).max(4000).default(1600),
  /** `select=1`: briefly select a background tab to capture it (it flickers on the Mac). */
  allowSelect: z.boolean().default(false),
});

export const TerminalSettingsSchema = z.object({
  order: z
    .array(z.enum(['tmux', 'terminal-app', 'iterm2']))
    .default(() => ['tmux' as const, 'terminal-app' as const]),
});

export const RemoteSettingsSchema = z.object({
  /** "lan" binds beyond loopback over plain http and is for development only. */
  mode: z.enum(['loopback', 'tailscale', 'cloudflare', 'lan']).default('loopback'),
  host: z.string().min(1).default(DEFAULT_HOST),
  port: z.number().int().min(1).max(65_535).default(DEFAULT_PORT),
  /** Extra origins accepted on writes and WebSocket upgrades (e.g. the Tailscale Serve URL). */
  allowedOrigins: z.array(z.string()).default(() => []),
  /** Public base URL used in pairing links, e.g. https://mac.tailnet.ts.net */
  publicUrl: z.string().nullable().default(null),
});

/**
 * Absolute paths to external binaries, resolved at install time. launchd's PATH
 * is minimal, so the daemon never relies on PATH lookup at runtime.
 * null = not configured (config.ts falls back to well-known locations).
 */
export const BinsSettingsSchema = z.object({
  cswap: z.string().nullable().default(null),
  claude: z.string().nullable().default(null),
  osascript: z.string().nullable().default(null),
  ps: z.string().nullable().default(null),
  lsof: z.string().nullable().default(null),
  node: z.string().nullable().default(null),
  terminalNotifier: z.string().nullable().default(null),
  screencapture: z.string().nullable().default(null),
  tmux: z.string().nullable().default(null),
  sips: z.string().nullable().default(null),
});

/** An IANA time zone this runtime knows ("Asia/Kolkata", "UTC"). */
function knownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** What an IANA zone name looks like: "UTC", "Asia/Kolkata", "America/Argentina/Buenos_Aires", "Etc/GMT+5". */
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const ZONE_MESSAGE = 'an IANA time zone, e.g. Asia/Kolkata';

/**
 * v0.4 Life: five small modules, each off until turned on at the Mac
 * (`jantar life on <module>`). Mac only: the switches, the time zone, the
 * currency and the lock-screen details change only there. The calorie target
 * and goal weight are values the phone sets; they live in life.db.
 */
export const LifeSettingsSchema = z.object({
  /** Projects and todos (a reminder is a todo with a time). */
  todos: z.boolean().default(false),
  medicines: z.boolean().default(false),
  /** Food, calories and weight. */
  food: z.boolean().default(false),
  /** Cafés. */
  places: z.boolean().default(false),
  finance: z.boolean().default(false),
  /**
   * IANA zone for day keys and ping times; null = the Mac's zone at daemon
   * start. The file only needs a zone's shape: one this Node's ICU does not
   * know must not make the whole config invalid (the daemon would run on
   * defaults and its next write would replace the file), so Life uses the
   * Mac's zone instead. A patch that sets a zone needs a known one
   * (applySettingsPatch).
   */
  timezone: z.string().max(64).regex(ZONE_SHAPE, { message: ZONE_MESSAGE }).nullable().default(null),
  /** ISO 4217 code, a label only (amounts are hundredths whatever it is); null = plain numbers. */
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
  /** Medicine names and bill names and amounts on the lock screen. Off: "Medicine due", "Bill due". */
  lockScreenDetails: z.boolean().default(false),
});

/** v0.4 Intel shelf: JSONL files named on the Mac, read and followed for appends. */
export const IntelSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Absolute paths of JSONL files, checked at load. A source's id and label come from its file name; no path ever leaves the Mac. */
  sources: z.array(z.string().min(1).max(1024)).max(10).default(() => []),
});

/**
 * v0.5 Meetings: the Chrome extension's captions and screenshots, kept in
 * meetings.db on the Mac. Off until turned on at the Mac
 * (`jantar meetings on`); only the switch lives here.
 */
export const MeetingsSettingsSchema = z.object({
  enabled: z.boolean().default(false),
});

export const AccountsSettingsSchema = z.object({
  /**
   * Accounts kept for other work: Auto, Rewrite and Ask Claude never pick one (a manual
   * start still can, behind confirmHeld). Merged live with autoswitch.hold and ccw's hold list.
   */
  kept: z.array(AccountIdSchema).max(50).default(() => []),
  /**
   * Prime free 5-hour windows (`jantar accounts prime on`): when an account's
   * window has not started, one tiny Haiku run on it starts the clock now, so
   * the window resets sooner once the account is used. cswap's accounts only;
   * never while ccw primes them itself.
   */
  prime: z.boolean().default(false),
  /** Prime kept and held accounts too (`jantar accounts prime on --kept`). */
  primeKept: z.boolean().default(false),
});

export const UsageSettingsSchema = z.object({
  /**
   * "auto": run the single `cswap list --json` poller only while ccw's own bot
   * is not running (it already keeps cswap's cache fresh).
   */
  poller: z.enum(['auto', 'on', 'off']).default('auto'),
  interval_s: z.number().int().min(60).max(3600).default(120),
  /** Alert when a window crosses these percentages. */
  thresholds: z.array(z.number().min(1).max(100)).default(() => [80, 95]),
});

/**
 * The config file's version. 2 (v0.4): life, intel and accounts, the
 * `claude` launch mode and safe launch defaults. A version-1 file is migrated
 * by the daemon (and the CLI) before it is read: daemon config.ts
 * `migrateSettingsFile`, which keeps a byte copy as config.json.v1.
 */
export const SETTINGS_VERSION = 2;

export const SettingsSchema = z.object({
  version: z.literal(SETTINGS_VERSION).default(SETTINGS_VERSION),
  autoswitch: AutoswitchSettingsSchema.prefault({}),
  /** Folder-name groups that move together (ccw's "groups"). */
  groups: z.array(z.array(z.string().min(1)).min(1)).default(() => []),
  notify: NotifySettingsSchema.prefault({}),
  launch: LaunchSettingsSchema.prefault({}),
  terminal: TerminalSettingsSchema.prefault({}),
  remote: RemoteSettingsSchema.prefault({}),
  bins: BinsSettingsSchema.prefault({}),
  usage: UsageSettingsSchema.prefault({}),
  folders: FoldersSettingsSchema.prefault({}),
  files: FilesSettingsSchema.prefault({}),
  rewrite: RewriteSettingsSchema.prefault({}),
  controls: ControlsSettingsSchema.prefault({}),
  screenshots: ScreenshotsSettingsSchema.prefault({}),
  /** v0.4 */
  life: LifeSettingsSchema.prefault({}),
  intel: IntelSettingsSchema.prefault({}),
  accounts: AccountsSettingsSchema.prefault({}),
  /** v0.5 (no version bump: an older daemon drops the unknown group) */
  meetings: MeetingsSettingsSchema.prefault({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Settings groups only the Mac may change (ctl.sock, the CLI). A TCP
 * `PATCH /v1/settings` touching any of them is refused with 403, even from an
 * admin device: a phone must not widen its own reach, and `bins` names the
 * programs the daemon runs.
 */
export const MAC_ONLY_SETTING_GROUPS = [
  'files',
  'folders',
  'launch',
  'rewrite',
  'bins',
  'remote',
  'controls',
  'screenshots',
  // v0.4: Life's switches and zone, the shelf's source paths, the kept accounts.
  'life',
  'intel',
  'accounts',
  // v0.5: the Meetings switch.
  'meetings',
] as const;
export type MacOnlySettingGroup = (typeof MAC_ONLY_SETTING_GROUPS)[number];

/** The Mac-only group a settings patch touches first, if any (top-level keys; nothing is capped). */
export function macOnlyGroupIn(patch: unknown): MacOnlySettingGroup | null {
  if (!isPlainObject(patch)) return null;
  for (const key of Object.keys(patch)) {
    if ((MAC_ONLY_SETTING_GROUPS as readonly string[]).includes(key)) return key as MacOnlySettingGroup;
  }
  return null;
}

/** A fresh copy of the defaults. */
export function defaultSettings(): Settings {
  return SettingsSchema.parse({});
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze(defaultSettings());

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export type SettingsPatch = DeepPartial<Settings>;

/** Body of `PATCH /v1/settings`; `applySettingsPatch` does the real validation. */
export const SettingsPatchSchema = z.record(z.string(), z.unknown());

export type PatchResult =
  | { ok: true; settings: Settings }
  | { ok: false; error: string; path?: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `patch` into `current` and validate the result.
 * - Objects merge key by key; arrays and scalars replace.
 * - Unknown keys are rejected (a typo must not be silently dropped).
 * - The input objects are not modified.
 */
export function applySettingsPatch(current: Settings, patch: unknown): PatchResult {
  if (!isPlainObject(patch)) return { ok: false, error: 'settings patch must be a JSON object' };
  const unknownKey = findUnknownKey(DEFAULT_SETTINGS as unknown as Record<string, unknown>, patch, '');
  if (unknownKey) return { ok: false, error: `unknown setting: ${unknownKey}`, path: unknownKey };
  const merged = deepMerge(current as unknown as Record<string, unknown>, patch);
  const parsed = SettingsSchema.safeParse(merged);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue ? issue.path.join('.') : '';
    return { ok: false, error: `invalid setting${path ? ` ${path}` : ''}: ${issue?.message ?? 'invalid'}`, path };
  }
  // A zone being set must be one this runtime knows (a stored one is only shape-checked).
  const zone = isPlainObject(patch.life) ? patch.life.timezone : undefined;
  if (typeof zone === 'string' && !knownZone(zone)) return { ok: false, error: `invalid setting life.timezone: ${ZONE_MESSAGE}`, path: 'life.timezone' };
  return { ok: true, settings: parsed.data };
}

function findUnknownKey(
  shape: Record<string, unknown>,
  patch: Record<string, unknown>,
  prefix: string,
): string | null {
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(shape, key)) return path;
    const ref = shape[key];
    if (isPlainObject(ref) && isPlainObject(value)) {
      const nested = findUnknownKey(ref, value, path);
      if (nested) return nested;
    }
  }
  return null;
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const prev = base[key];
    out[key] = isPlainObject(prev) && isPlainObject(value) ? deepMerge(prev, value) : value;
  }
  return out;
}

/** The feature switches clients see (state.daemon.features), from settings. */
export function settingsFeatures(s: Settings): Features {
  return {
    files: s.files.enabled,
    launch: s.launch.enabled,
    rewrite: s.rewrite.enabled,
    controls: s.controls.enabled,
    screenshots: s.screenshots.enabled,
    screenshotSelect: s.screenshots.enabled && s.screenshots.allowSelect,
    escape: s.controls.enabled && s.controls.escapeVerified,
    clearDraft: s.controls.enabled && s.controls.clearVerified,
    life: lifeOn(s),
    intel: s.intel.enabled,
    meetings: s.meetings.enabled,
  };
}

/** The five Life modules, in the order the phone lists them. */
export const LIFE_MODULES = ['todos', 'medicines', 'food', 'places', 'finance'] as const;

/** Whether any Life module is on. */
export function lifeOn(s: Pick<Settings, 'life'>): boolean {
  return LIFE_MODULES.some((m) => s.life[m]);
}
