/**
 * v0.3 shapes: scopes, feature switches, Mac-only settings, rewrite and
 * launch jobs in state, the flags allowlist, slash commands and the route
 * table additions.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAUNCH_FLAGS,
  V03_LAUNCH_FLAGS,
  ERROR_STATUS,
  EVENT,
  FeaturesSchema,
  LAUNCH_CAP,
  LaunchFlagsSchema,
  LaunchJobSchema,
  LaunchPreviewQuerySchema,
  LaunchStartBodySchema,
  MAC_ONLY_SETTING_GROUPS,
  NO_FEATURES,
  PROTOCOL_VERSION,
  PromptBodySchema,
  REWRITE_CAP,
  ROUTES,
  RewriteJobSchema,
  RewriteStartBodySchema,
  ScopeSchema,
  ScreenshotQuerySchema,
  SessionCommandBodySchema,
  SessionModeBodySchema,
  CONFIRM_MODES,
  SessionOptionalKeySchema,
  SettingsSchema,
  SlashCommandSchema,
  StateSchema,
  applySettingsPatch,
  defaultSettings,
  emptyState,
  launchFlagArgs,
  launchFlagsDangerous,
  macOnlyGroupIn,
  parseEvent,
  reduce,
  settingsFeatures,
  stateFeatures,
  type LaunchJob,
  type RewriteJob,
  type RouteDef,
} from '../src/index.js';
import { T0, at, ev, resetSeq, session } from './helpers.js';

const routes = Object.entries(ROUTES) as [string, RouteDef][];
const v03 = routes.filter(([, r]) => r.phase === 'v0.3');

function rewriteJob(over: Partial<RewriteJob> = {}): RewriteJob {
  return {
    id: 'rw-1',
    sid: 'sid-a',
    deviceId: 'dev-1',
    state: 'queued',
    model: 'opus',
    input: { hash: 'h', length: 12 },
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function launchJob(over: Partial<LaunchJob> = {}): LaunchJob {
  return {
    id: 'l-1',
    createdAt: T0,
    updatedAt: T0,
    actor: 'device:dev-1',
    rootId: 'r.work',
    folder: '/home/test/Desktop/work/foo',
    display: '~/Desktop/work/foo',
    account: 7,
    accountSource: 'auto',
    requested: 'auto',
    flags: { ...DEFAULT_LAUNCH_FLAGS },
    dangerous: true,
    name: 'foo',
    sid: '0b4e7c4e-0000-4000-8000-000000000000',
    stage: 'queued',
    steps: [],
    ...over,
  };
}

describe('protocol 2', () => {
  it('is version 2 or later (3 since v0.4) and has the launch scope between control and admin', () => {
    expect(PROTOCOL_VERSION).toBe(3);
    expect(ScopeSchema.options).toEqual(['read', 'control', 'launch', 'admin']);
  });

  it('adds filesChanged as an optional session field', () => {
    expect(SessionOptionalKeySchema.options).toContain('filesChanged');
  });

  it('carries rewriteJobId on a prompt, and nothing else new', () => {
    expect(PromptBodySchema.parse({ text: 'hi', rewriteJobId: 'rw-1' })).toEqual({ text: 'hi', onDraft: 'refuse', rewriteJobId: 'rw-1' });
    expect(PromptBodySchema.parse({ text: 'hi' })).toEqual({ text: 'hi', onDraft: 'refuse' });
  });

  it('maps the v0.3 error codes to their statuses', () => {
    expect(ERROR_STATUS.unsupported_media_type).toBe(415);
    expect(ERROR_STATUS.screenshots_off).toBe(403);
    for (const c of ['mode_unavailable', 'input_not_empty', 'dialog_open', 'escape_unverified', 'tab_not_visible'] as const) {
      expect(ERROR_STATUS[c]).toBe(409);
    }
  });
});

describe('v0.3 settings', () => {
  it('ships every new switch off except controls, with the decided defaults', () => {
    const s = defaultSettings();
    expect(s.files).toEqual({ enabled: false });
    expect(s.folders).toEqual({ roots: [], sessionRoots: true, allow: [], extraDeny: [], showHidden: false });
    // v0.4 made the defaults safe for anyone (settings-v2.test.ts): the claude launch mode, Claude asks before tools.
    expect(s.launch).toMatchObject({ enabled: false, mode: 'claude', csCommand: 'cs', preLaunchArgv: null });
    expect(s.launch.defaultFlags).toEqual({ permission: 'manual', chrome: false, effort: 'default', model: 'default' });
    expect(s.launch.timeouts).toEqual({ claudeS: 90, readyS: 180, dialogMin: 30 });
    expect(s.launch.rate).toEqual({ perTenMin: 4, perDay: 30, inFlight: 2, foldersPerHour: 10 });
    expect(s.rewrite).toMatchObject({ enabled: false, model: 'opus', effort: 'low', fallbackModel: 'sonnet', ceilingPct: 85, timeoutS: 120 });
    // Escape and Clear draft were verified on a real Mac (30 Oct 2026, docs/real-mac-checks.md): on by default since 0.4.1.
    expect(s.controls).toEqual({ enabled: true, escapeVerified: true, clearVerified: true, interruptKey: 'interrupt' });
    expect(s.screenshots).toEqual({ enabled: false, maxEdge: 1600, allowSelect: false });
    expect(s.bins.sips).toBeNull();
    expect(SettingsSchema.parse({})).toEqual(s);
  });

  it('takes roots as arrays (replaced whole) and rejects bad ids and free-text flags', () => {
    const base = defaultSettings();
    const r = applySettingsPatch(base, { folders: { roots: [{ id: 'work', path: '~/Desktop/work', label: 'work' }] } });
    expect(r.ok).toBe(true);
    expect(applySettingsPatch(base, { folders: { roots: [{ id: 'Bad Id', path: '/x', label: 'x' }] } }).ok).toBe(false);
    expect(applySettingsPatch(base, { launch: { defaultFlags: { ...DEFAULT_LAUNCH_FLAGS, extra: '--settings x' } } }).ok).toBe(false);
    expect(applySettingsPatch(base, { launch: { profiles: [] } })).toMatchObject({ ok: false, path: 'launch.profiles' });
  });

  it('names the Mac-only groups and finds them in a patch however large', () => {
    // v0.4 added life, intel and accounts (settings-v2.test.ts); v0.5 meetings (v05.test.ts); v0.6 fleet (v06.test.ts).
    expect([...MAC_ONLY_SETTING_GROUPS].sort()).toEqual(['accounts', 'bins', 'controls', 'files', 'fleet', 'folders', 'intel', 'launch', 'life', 'meetings', 'remote', 'rewrite', 'screenshots']);
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 80; i++) many[`k${i}`] = i;
    expect(macOnlyGroupIn({ ...many, files: { enabled: true } })).toBe('files');
    expect(macOnlyGroupIn({ notify: { bodies: 'short' } })).toBeNull();
    expect(macOnlyGroupIn([])).toBeNull();
  });

  it('derives the feature switches clients see', () => {
    expect(settingsFeatures(defaultSettings())).toEqual({ ...NO_FEATURES, controls: true, escape: true, clearDraft: true });
    // A config that holds false keeps it: only the default changed.
    const saved = SettingsSchema.parse({ controls: { escapeVerified: false, clearVerified: false } });
    expect(saved.controls).toMatchObject({ escapeVerified: false, clearVerified: false });
    expect(settingsFeatures(saved)).toEqual({ ...NO_FEATURES, controls: true });
    const on = SettingsSchema.parse({
      files: { enabled: true },
      launch: { enabled: true },
      rewrite: { enabled: true },
      screenshots: { enabled: true, allowSelect: true },
      controls: { escapeVerified: true, clearVerified: true },
    });
    // v0.4's life and intel stay off here (v04.test.ts), v0.5's meetings (v05.test.ts) and v0.6's fleet (v06.test.ts).
    expect(settingsFeatures(on)).toEqual({ files: true, launch: true, rewrite: true, controls: true, screenshots: true, screenshotSelect: true, escape: true, clearDraft: true, life: false, intel: false, meetings: false, fleet: false });
    // Neither key while controls are off.
    expect(settingsFeatures(SettingsSchema.parse({ controls: { enabled: false, escapeVerified: true, clearVerified: true } }))).toMatchObject({ escape: false, clearDraft: false });
    // A daemon from before clearDraft existed sends no such key: off.
    const { clearDraft: _gone, ...older } = NO_FEATURES;
    expect(FeaturesSchema.parse({ ...older, controls: true }).clearDraft).toBe(false);
    // allowSelect means nothing while screenshots are off.
    expect(settingsFeatures(SettingsSchema.parse({ screenshots: { allowSelect: true } })).screenshotSelect).toBe(false);
    expect(FeaturesSchema.parse(NO_FEATURES)).toEqual(NO_FEATURES);
  });
});

describe('launch flags (U7)', () => {
  it('is a strict object: no free-text flags can ride along', () => {
    expect(LaunchFlagsSchema.safeParse(DEFAULT_LAUNCH_FLAGS).success).toBe(true);
    expect(LaunchFlagsSchema.safeParse({ ...DEFAULT_LAUNCH_FLAGS, args: ['--mcp-config', 'x'] }).success).toBe(false);
    expect(LaunchFlagsSchema.safeParse({ ...DEFAULT_LAUNCH_FLAGS, model: 'gpt' }).success).toBe(false);
  });

  it('turns picks into argv from the table, in its order', () => {
    expect(launchFlagArgs(V03_LAUNCH_FLAGS)).toEqual(['--dangerously-skip-permissions', '--chrome', '--effort', 'ultracode']);
    // v0.4's safe default names its mode: with no flag the account's own settings would pick it (spike L-manual).
    expect(launchFlagArgs(DEFAULT_LAUNCH_FLAGS)).toEqual(['--permission-mode', 'manual']);
    expect(launchFlagArgs({ permission: 'manual', chrome: true, effort: 'low', model: 'haiku' })).toEqual([
      '--permission-mode', 'manual', '--chrome', '--effort', 'low', '--model', 'haiku',
    ]);
    expect(launchFlagArgs({ permission: 'auto', chrome: false, effort: 'high', model: 'sonnet' })).toEqual([
      '--permission-mode', 'auto', '--effort', 'high', '--model', 'sonnet',
    ]);
    expect(launchFlagArgs({ permission: 'acceptEdits', chrome: true, effort: 'default', model: 'fable' })).toEqual([
      '--permission-mode', 'acceptEdits', '--chrome', '--model', 'fable',
    ]);
    expect(launchFlagArgs({ permission: 'plan', chrome: false, effort: 'max', model: 'default' })).toEqual(['--permission-mode', 'plan', '--effort', 'max']);
  });

  it('calls skip and auto dangerous', () => {
    expect(['skip', 'auto', 'acceptEdits', 'plan', 'manual'].map((p) => launchFlagsDangerous({ permission: p as 'skip' }))).toEqual([true, true, false, false, false]);
  });

  it('start bodies are strict and carry flags, never a profile or argv', () => {
    const ok = { root: 'r.work', path: 'foo', account: 'auto', flags: DEFAULT_LAUNCH_FLAGS };
    expect(LaunchStartBodySchema.safeParse(ok).success).toBe(true);
    expect(LaunchStartBodySchema.safeParse({ ...ok, account: 7, name: 'foo-2', prompt: 'go', confirmHeld: true }).success).toBe(true);
    for (const extra of [{ profile: 'ultracode' }, { args: ['--add-dir', '/'] }, { extraArgs: [] }, { trust: true }]) {
      expect(LaunchStartBodySchema.safeParse({ ...ok, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(LaunchStartBodySchema.safeParse({ ...ok, name: 'has space' }).success).toBe(false);
    expect(LaunchPreviewQuerySchema.parse({ root: 'r.work', chrome: '0', account: '7' })).toMatchObject({ path: '', account: 7, chrome: false });
    expect(LaunchPreviewQuerySchema.parse({ root: 'r.work' })).toMatchObject({ account: 'auto' });
    // An empty or non-numeric account is a 400, never account 0.
    for (const account of ['', ' ', '-1', '1.5', '0x1', '7a']) {
      expect(LaunchPreviewQuerySchema.safeParse({ root: 'r.work', account }).success, JSON.stringify(account)).toBe(false);
    }
    expect(LaunchPreviewQuerySchema.parse({ root: 'r.work', account: '0' })).toMatchObject({ account: 0 });
  });
});

describe('controls', () => {
  it('allowlists slash command arguments', () => {
    expect(SlashCommandSchema.safeParse({ name: 'plan' }).success).toBe(true);
    expect(SlashCommandSchema.safeParse({ name: 'plan', args: 'split the parser' }).success).toBe(true);
    expect(SlashCommandSchema.safeParse({ name: 'model', args: 'opus' }).success).toBe(true);
    expect(SlashCommandSchema.safeParse({ name: 'model' }).success).toBe(false);
    expect(SlashCommandSchema.safeParse({ name: 'model', args: 'opus; rm -rf' }).success).toBe(false);
    expect(SlashCommandSchema.safeParse({ name: 'effort', args: 'ultracode' }).success).toBe(true);
    expect(SlashCommandSchema.safeParse({ name: 'effort', args: 'huge' }).success).toBe(false);
    expect(SlashCommandSchema.safeParse({ name: 'compact', args: 'keep \u001b[A' }).success).toBe(false);
    expect(SlashCommandSchema.safeParse({ name: 'compact', args: 'x'.repeat(201) }).success).toBe(false);
    expect(SlashCommandSchema.safeParse({ name: 'clear', args: 'now' }).success).toBe(false);
    expect(SlashCommandSchema.safeParse({ name: 'login' }).success).toBe(false);
  });

  it('needs confirm for clear and rewind', () => {
    expect(SessionCommandBodySchema.safeParse({ name: 'clear' }).success).toBe(false);
    expect(SessionCommandBodySchema.safeParse({ name: 'rewind', confirm: false }).success).toBe(false);
    expect(SessionCommandBodySchema.safeParse({ name: 'clear', confirm: true }).success).toBe(true);
    expect(SessionCommandBodySchema.safeParse({ name: 'compact' }).success).toBe(true);
    // A mode that never asks needs the same confirmation; the others do not.
    expect(SessionModeBodySchema.safeParse({ mode: 'bypassPermissions' }).success).toBe(false);
    expect(SessionModeBodySchema.safeParse({ mode: 'auto', confirm: false }).success).toBe(false);
    expect(SessionModeBodySchema.safeParse({ mode: 'auto', confirm: true }).success).toBe(true);
    expect(SessionModeBodySchema.safeParse({ mode: 'plan' }).success).toBe(true);
    expect(CONFIRM_MODES).toEqual(['bypassPermissions', 'auto']);
  });

  it('parses screenshot queries', () => {
    expect(ScreenshotQuerySchema.parse({})).toEqual({ select: false, full: false });
    expect(ScreenshotQuerySchema.parse({ max: '800', format: 'jpeg', select: '1', full: '0' })).toEqual({ max: 800, format: 'jpeg', select: true, full: false });
    expect(ScreenshotQuerySchema.safeParse({ select: 'yes' }).success).toBe(false);
  });
});

describe('rewrite', () => {
  it('validates start bodies', () => {
    expect(RewriteStartBodySchema.safeParse({ text: 'fix the test' }).success).toBe(true);
    expect(RewriteStartBodySchema.safeParse({ text: 'x', model: 'sonnet' }).success).toBe(true);
    expect(RewriteStartBodySchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(RewriteStartBodySchema.safeParse({ text: 'x'.repeat(8001) }).success).toBe(false);
    expect(RewriteStartBodySchema.safeParse({ text: 'x', model: 'gpt' }).success).toBe(false);
    expect(RewriteStartBodySchema.safeParse({ text: 'x', audio: 'b64' }).success).toBe(false);
  });

  it('public jobs have no field that could hold text', () => {
    const keys = Object.keys(RewriteJobSchema.shape).sort();
    expect(keys).not.toContain('text');
    expect(keys).not.toContain('prompt' + 'Text');
    const job = RewriteJobSchema.parse(rewriteJob({ state: 'ready', prompt: { hash: 'p', length: 30, flags: { expanded: false, newTokens: 1, leading: null, preface: false } } }));
    expect(typeof job.prompt?.flags.newTokens).toBe('number');
  });
});

describe('state and reducer', () => {
  it('starts with empty rewrites and launches, and everything switched off', () => {
    const s = emptyState();
    expect(s.rewrites).toEqual({});
    expect(s.launches).toEqual({});
    expect(StateSchema.safeParse(s).success).toBe(true);
    expect(stateFeatures(s)).toEqual(NO_FEATURES);
  });

  it('records the switches from daemon.version (absent from older daemons)', () => {
    resetSeq();
    const features = { ...NO_FEATURES, files: true };
    let s = reduce(emptyState(), ev({ type: 'daemon.version', data: { protocol: 2, daemonVersion: '0.3.0', webHash: null, features } }));
    expect(stateFeatures(s)).toEqual(features);
    s = reduce(s, ev({ type: 'daemon.version', data: { protocol: 1, daemonVersion: '0.2.0', webHash: null } }));
    expect(stateFeatures(s)).toEqual(NO_FEATURES);
  });

  it('tracks rewrite jobs per id and caps them, dropping finished ones first', () => {
    resetSeq();
    let s = emptyState();
    s = reduce(s, ev({ type: 'rewrite.progress', sid: 'sid-a', data: { job: rewriteJob({ id: 'keep', state: 'writing', updatedAt: at(0) }) } }));
    for (let i = 0; i < REWRITE_CAP + 2; i++) {
      s = reduce(s, ev({ type: 'rewrite.progress', sid: 'sid-a', data: { job: rewriteJob({ id: `rw-${i}`, state: 'sent', updatedAt: at(i + 1) }) } }));
    }
    expect(Object.keys(s.rewrites)).toHaveLength(REWRITE_CAP);
    expect(s.rewrites.keep?.state).toBe('writing');
    expect(s.rewrites['rw-0']).toBeUndefined();
    expect(s.rewrites[`rw-${REWRITE_CAP + 1}`]).toBeDefined();
  });

  it('never lets unfinished rewrites or launches grow past the cap', () => {
    resetSeq();
    let s = emptyState();
    for (let i = 0; i < LAUNCH_CAP + 5; i++) {
      s = reduce(s, ev({ type: 'launch.progress', data: { job: launchJob({ id: `l-${i}`, stage: 'starting', updatedAt: at(i) }) } }));
    }
    expect(Object.keys(s.launches)).toHaveLength(LAUNCH_CAP);
    expect(s.launches['l-0']).toBeUndefined();
    expect(LaunchJobSchema.safeParse(s.launches[`l-${LAUNCH_CAP + 4}`]).success).toBe(true);
  });

  it('needs sid on rewrite.progress and files.changed, not on launch.progress', () => {
    const base = { seq: 1, ts: T0 };
    expect(() => parseEvent({ ...base, type: 'rewrite.progress', data: { job: rewriteJob() } })).toThrow(/requires sid/);
    const change = { changeId: 'c1', path: '/w/a.ts', tool: 'Edit', at: T0, status: 'ok', opId: 'o1', transcriptOffset: 10, byAgent: false };
    expect(() => parseEvent({ ...base, type: 'files.changed', data: change })).toThrow(/requires sid/);
    expect(parseEvent({ ...base, type: 'files.changed', sid: 'sid-a', data: change }).type).toBe(EVENT.FILES_CHANGED);
    expect(parseEvent({ ...base, type: 'launch.progress', data: { job: launchJob() } }).type).toBe(EVENT.LAUNCH_PROGRESS);
  });

  it('counts files.changed per session (nothing else) and patches filesChanged through session.updated', () => {
    resetSeq();
    let s = reduce(emptyState(), ev({ type: 'session.added', sid: 'sid-a', data: { session: session() } }));
    const before = s;
    s = reduce(s, ev({ type: 'files.changed', sid: 'sid-a', data: { changeId: 'c1', path: '/w/a.ts', tool: 'Write', at: T0, status: 'ok', opId: 'o1', transcriptOffset: 0, byAgent: false } }));
    expect({ ...s, seq: before.seq }).toEqual({ ...before, fileTicks: { 'sid-a': 1 } });
    s = reduce(s, ev({ type: 'session.updated', sid: 'sid-a', data: { patch: { filesChanged: 3 } } }));
    expect(s.sessions['sid-a']?.filesChanged).toBe(3);
    s = reduce(s, ev({ type: 'session.updated', sid: 'sid-a', data: { patch: {}, unset: ['filesChanged'] } }));
    expect(s.sessions['sid-a']?.filesChanged).toBeUndefined();
  });
});

describe('v0.3 routes', () => {
  it('are all under /v1 with a summary, and GETs carry no body', () => {
    expect(v03.length).toBe(26);
    for (const [name, r] of v03) {
      expect(r.path.startsWith('/v1/'), name).toBe(true);
      expect(r.summary.length, name).toBeGreaterThan(5);
      if (r.method === 'GET') expect(r.body, name).toBeUndefined();
    }
  });

  it('sit behind the right switch (device scopes behind none)', () => {
    const by = (f: string) => v03.filter(([, r]) => r.feature === f).map(([n]) => n).sort();
    expect(by('rewrite')).toEqual(['rewriteCancel', 'rewriteGet', 'rewriteStart']);
    expect(by('files')).toEqual(['filesChanges', 'filesList', 'filesRaw', 'filesRoots', 'filesStat', 'filesText', 'sessionChange', 'sessionChanges']);
    expect(by('launch')).toEqual(['foldersCreate', 'foldersList', 'foldersPin', 'foldersRecent', 'foldersRoots', 'launchAnswer', 'launchGet', 'launchList', 'launchPreview', 'launchStart']);
    expect(by('controls')).toEqual(['sessionCommand', 'sessionKey', 'sessionMode']);
    expect(by('screenshots')).toEqual(['sessionScreenshot']);
    expect(v03.filter(([, r]) => !r.feature).map(([n]) => n)).toEqual(['deviceScopes']);
    // v0.1 and v0.2 routes sit behind no switch (v0.4's are in v04-routes.test.ts).
    expect(routes.filter(([, r]) => (r.phase === 'v0.1' || r.phase === 'v0.2') && r.feature)).toEqual([]);
  });

  it('give launching its own scope and keep self-answering off ctl.sock', () => {
    expect(['foldersCreate', 'launchStart', 'launchAnswer'].map((n) => ROUTES[n as 'launchStart'].scope)).toEqual(['launch', 'launch', 'launch']);
    for (const n of ['launchAnswer', 'sessionKey', 'sessionMode', 'sessionCommand', 'sessionScreenshot'] as const) expect(ROUTES[n].ctl, n).toBe(false);
    expect(ROUTES.deviceScopes).toMatchObject({ scope: 'admin', localOnly: true, ctl: true });
    // Scopes are granted on the Mac only; pairing stays open to an admin phone (PairNew).
    expect(v03.filter(([, r]) => r.localOnly).map(([n]) => n)).toEqual(['deviceScopes']);
    // Rewrite jobs belong to the device that started them: started and cancelled from a device only.
    expect([ROUTES.rewriteStart.ctl, ROUTES.rewriteGet.ctl, ROUTES.rewriteCancel.ctl]).toEqual([false, true, false]);
  });

  it('marks only the byte routes as raw responses', () => {
    // v0.5 adds a meeting's screenshot.
    expect(routes.filter(([, r]) => r.rawResponse).map(([n]) => n).sort()).toEqual(['filesRaw', 'meetingShot', 'sessionScreenshot']);
  });

  it('has no audio, git or diff routes', () => {
    for (const [name, r] of v03) expect(`${name} ${r.path}`, name).not.toMatch(/voice|audio|diff|git/i);
  });
});
