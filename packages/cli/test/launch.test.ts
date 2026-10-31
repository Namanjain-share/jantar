/**
 * launch and new against an in-memory daemon on a synthetic HOME: the
 * switch and its hints, the default flag picks (U7: fixed lists only),
 * cs-shell / cswap-run, the pre-launch argv, and `jantar new` from a folder
 * to a finished launch, loud whenever a session or its first prompt did not
 * make it. Nothing here opens a Terminal window.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import {
  DEFAULT_LAUNCH_FLAGS,
  V03_LAUNCH_FLAGS,
  launchFlagArgs,
  type DevicePublic,
  type FileRoot,
  type LaunchFlags,
  type LaunchJob,
  type LaunchPreview,
} from '@jantar/protocol';
import launch from '../src/commands/launch.js';
import newSession from '../src/commands/new.js';
import { EXIT } from '../src/command.js';
import { locateIn } from '../src/lib/launch.js';
import type { CtlResponse } from '../src/ctl.js';
import { contextFor, fail, fakeCtl, fakeSettings, ok, type CtlCall, type Handler } from './helpers.js';

const SID = '77777777-7777-4777-8777-777777777777';
const AT = '2026-01-15T10:00:00.000Z';
const LAUNCH_ID = '01JSYNTHLAUNCH000000000000';

let home: FakeHome;

beforeEach(async () => {
  home = await makeFakeHome({ sessions: [] });
  for (const d of ['Desktop/work/app', 'Elsewhere']) await mkdir(join(home.home, d), { recursive: true });
});

afterEach(async () => {
  await home.cleanup();
});

/** A Mac configured as v0.3 shipped (cs-shell, skip, Chrome, ultracode): v0.4's own defaults are the safe ones. */
const V03_MAC = { launch: { mode: 'cs-shell', defaultFlags: V03_LAUNCH_FLAGS } } as const;

function device(name: string, scopes: DevicePublic['scopes']): DevicePublic {
  return { id: `01JSYNTH${name.toUpperCase().padEnd(18, '0')}`, name, scopes, createdAt: AT, lastSeenAt: AT };
}

describe('jantar launch', () => {
  it('on says where sessions can start and that no device may start one yet; off keeps running sessions', async () => {
    const s = fakeSettings(V03_MAC);
    const ctl = fakeCtl({ ...s.routes, 'GET /v1/devices': ok({ devices: [device('iPhone', ['read', 'control'])] }) });
    const on = contextFor(home, { ctl });
    expect(await launch.run(['on'], on.ctx)).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ launch: { enabled: true } }]);
    expect(on.io.stdout).toContain('Starting sessions from the phone is on. The start sheet begins from:');
    expect(on.io.stdout).toContain('claude --dangerously-skip-permissions --chrome --effort ultracode');
    expect(on.io.stdout).toContain("Claude won't ask before running commands in this session.");
    expect(on.io.stdout).toContain("It can start in live sessions' folders. Add more: jantar folders add-root ~/Desktop");
    expect(on.io.stdout).toContain('No paired device may start sessions yet: jantar devices grant <device> launch');

    const granted = fakeSettings({ folders: { roots: [{ id: 'desk', path: join(home.home, 'Desktop'), label: 'Desktop' }] } });
    const ctl2 = fakeCtl({ ...granted.routes, 'GET /v1/devices': ok({ devices: [device('iPhone', ['read', 'control', 'launch'])] }) });
    const b = contextFor(home, { ctl: ctl2 });
    expect(await launch.run(['on'], b.ctx)).toBe(EXIT.ok);
    expect(b.io.stdout).not.toContain('folders add-root');
    expect(b.io.stdout).not.toContain('devices grant');

    const off = contextFor(home, { ctl });
    expect(await launch.run(['off'], off.ctx)).toBe(EXIT.ok);
    expect(s.settings.launch.enabled).toBe(false);
    expect(off.io.stdout).toContain('Sessions already started keep running.');

    // daemon down: config.json, and no device hint (nobody to ask)
    const down = contextFor(home);
    expect(await launch.run(['on'], down.ctx)).toBe(EXIT.ok);
    expect(down.io.stdout).toContain('Saved to config.json');
    expect(down.io.stdout).not.toContain('devices grant');
  });

  it('status shows the switch, the mode, the pre-launch argv, the default flags and the limits', async () => {
    const s = fakeSettings({ launch: { ...V03_MAC.launch, enabled: true, preLaunchArgv: ['/usr/bin/python3', '-I', '/x/adopt.py', 'adopt', '{n}'] } });
    const { ctx, io } = contextFor(home, { ctl: fakeCtl(s.routes) });
    expect(await launch.run(['status'], ctx)).toBe(EXIT.ok);
    expect(io.stdout).toContain('Starting sessions from the phone: on');
    expect(io.stdout).toContain('Mode: cs-shell (types: cd -- <folder> && cs <account> -- <flags> ...)');
    expect(io.stdout).toContain("Pre-launch: /usr/bin/python3 -I /x/adopt.py adopt '{n}' (cswap-run mode only)");
    expect(io.stdout).toContain('permissions skip all checks · Chrome on · effort ultracode · model default');
    expect(io.stdout).toContain('Limits: 4 starts per 10 min, 30 per day, 2 starting at once');
  });

  it('defaults takes picks from the fixed lists only, keeps the rest, and resets', async () => {
    const s = fakeSettings(V03_MAC);
    const ctl = fakeCtl(s.routes);
    const show = contextFor(home, { ctl });
    expect(await launch.run(['defaults'], show.ctx)).toBe(EXIT.ok);
    expect(show.io.stdout).toContain('claude --dangerously-skip-permissions --chrome --effort ultracode');
    expect(s.patches).toEqual([]);

    const set = contextFor(home, { ctl });
    expect(await launch.run(['defaults', '--permission', 'plan', '--no-chrome', '--effort', 'high'], set.ctx)).toBe(EXIT.ok);
    const planned: LaunchFlags = { permission: 'plan', chrome: false, effort: 'high', model: 'default' };
    expect(s.patches).toEqual([{ launch: { defaultFlags: planned } }]);
    expect(set.io.stdout).toContain('claude --permission-mode plan --effort high');
    expect(set.io.stdout).not.toContain("won't ask");

    expect(await launch.run(['defaults', '--model', 'sonnet'], contextFor(home, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.launch.defaultFlags).toEqual({ ...planned, model: 'sonnet' });
    expect(await launch.run(['defaults', '--reset', '--model', 'opus'], contextFor(home, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.launch.defaultFlags).toEqual({ ...DEFAULT_LAUNCH_FLAGS, model: 'opus' });

    // never free text: unknown values and unknown flags are usage errors, and nothing is patched
    const before = s.patches.length;
    for (const bad of [
      ['defaults', '--permission', 'yolo'],
      ['defaults', '--effort', 'turbo'],
      ['defaults', '--model', 'gpt-5'],
      ['defaults', '--dangerously-skip-permissions'],
      ['defaults', '--', '--add-dir', '/'],
      ['on', '--permission', 'plan'],
      ['defaults', '--chrome=yes'],
    ]) {
      const c = contextFor(home, { ctl });
      expect(await launch.run(bad, c.ctx), bad.join(' ')).toBe(EXIT.usage);
    }
    expect(s.patches).toHaveLength(before);
  });

  it('mode switches between cs-shell and cswap-run', async () => {
    const s = fakeSettings();
    const ctl = fakeCtl(s.routes);
    const a = contextFor(home, { ctl });
    expect(await launch.run(['mode', 'cswap-run'], a.ctx)).toBe(EXIT.ok);
    expect(s.settings.launch.mode).toBe('cswap-run');
    expect(a.io.stdout).toContain('Mode: cswap-run');
    expect(await launch.run(['mode', 'cs-shell'], contextFor(home, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.launch.mode).toBe('cs-shell');
    const show = contextFor(home, { ctl });
    expect(await launch.run(['mode'], show.ctx)).toBe(EXIT.ok);
    expect(show.io.stdout).toContain('Mode: cs-shell');
    expect(await launch.run(['mode', 'tmux'], contextFor(home, { ctl }).ctx)).toBe(EXIT.usage);
    expect(await launch.run(['mode', 'cs-shell', 'x'], contextFor(home, { ctl }).ctx)).toBe(EXIT.usage);
  });

  it('pre-launch stores an argv whose program is an absolute executable, and clears it', async () => {
    const s = fakeSettings(V03_MAC);
    const ctl = fakeCtl(s.routes);
    const argv = [process.execPath, '-I', '~/bin/adopt.js', 'adopt', '{n}'];
    const a = contextFor(home, { ctl });
    expect(await launch.run(['pre-launch', '--', ...argv], a.ctx)).toBe(EXIT.ok);
    expect(s.settings.launch.preLaunchArgv).toEqual(argv);
    expect(a.io.stdout).toContain('with {n} replaced by the account');
    expect(a.io.stdout).toContain('It applies in cswap-run mode only: jantar launch mode cswap-run');

    const plain = join(home.root, 'plain.txt');
    await writeFile(plain, 'not a program\n', { mode: 0o600 });
    for (const [bad, why] of [
      [['python3', 'adopt'], 'absolute path'],
      [[plain], 'is not an executable file'],
      [[process.execPath, 'a\nb'], 'control character'],
      [[process.execPath, ''], '1 to 1024 characters'],
    ] as const) {
      const c = contextFor(home, { ctl });
      expect(await launch.run(['pre-launch', '--', ...bad], c.ctx), bad.join(' ')).toBe(EXIT.usage);
      expect(c.io.stderr).toContain(why);
    }
    expect(await launch.run(['pre-launch', '--clear', '--', process.execPath], contextFor(home, { ctl }).ctx)).toBe(EXIT.usage);
    expect(s.settings.launch.preLaunchArgv).toEqual(argv);

    const show = contextFor(home, { ctl });
    expect(await launch.run(['pre-launch'], show.ctx)).toBe(EXIT.ok);
    expect(show.io.stdout).toContain(`Pre-launch: ${process.execPath} -I`);
    expect(await launch.run(['pre-launch', '--clear'], contextFor(home, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.launch.preLaunchArgv).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// jantar new

function root(id: string, kind: FileRoot['kind'], path: string): FileRoot {
  return { id, kind, label: id, display: path, home: false, path };
}

function job(over: Partial<LaunchJob> = {}): LaunchJob {
  const flags = over.flags ?? { ...V03_LAUNCH_FLAGS };
  return {
    id: LAUNCH_ID,
    createdAt: AT,
    updatedAt: AT,
    actor: 'cli',
    rootId: 'r.work',
    folder: '/synthetic/home/Desktop/work/app',
    display: '~/Desktop/work/app',
    account: 7,
    accountSource: 'auto',
    requested: 'auto',
    flags,
    dangerous: flags.permission === 'skip' || flags.permission === 'auto',
    name: 'app',
    sid: SID,
    stage: 'queued',
    steps: [{ at: AT, stage: 'queued', detail: 'Queued · 07 · auto' }],
    ...over,
  };
}

const STEP = (stage: LaunchJob['stage'], detail: string) => ({ at: AT, stage, detail });

/**
 * A launch-capable daemon: roots, settings, a preview that echoes the picks,
 * POST /v1/launches, and GET /v1/launches/:id answering `stages` in turn.
 */
function launcher(opts: { stages?: Array<Partial<LaunchJob>>; settings?: Record<string, unknown>; start?: Handler; pick?: number | null } = {}) {
  const s = fakeSettings({ launch: { ...V03_MAC.launch, enabled: true }, ...opts.settings });
  const desk = join(home.home, 'Desktop');
  let polls = 0;
  const stages = opts.stages ?? [{ stage: 'done' }];
  const routes: Record<string, Handler | CtlResponse> = {
    ...s.routes,
    'GET /v1/folders/roots': ok({
      roots: [
        root('r.desk', 'configured', desk),
        root(`s.${SID}`, 'session', join(desk, 'work', 'app')),
        root('r.work', 'configured', join(desk, 'work')),
      ],
    }),
    'GET /v1/launch/preview': (call: CtlCall) => {
      const q = new URL(`http://ctl${call.path}`).searchParams;
      const flags: LaunchFlags = {
        permission: q.get('permission') as LaunchFlags['permission'],
        chrome: q.get('chrome') === '1',
        effort: q.get('effort') as LaunchFlags['effort'],
        model: q.get('model') as LaunchFlags['model'],
      };
      const pick = opts.pick === undefined ? 7 : opts.pick;
      // A Name given is the one the command shows; else the daemon's suggestion.
      const name = q.get('name') ?? 'app';
      const preview: LaunchPreview = {
        root: q.get('root') ?? '',
        path: q.get('path') ?? '',
        display: '~/Desktop/work/app',
        account: { pick, source: 'auto', reason: pick === null ? 'every account is held or full' : 'most room · 5h 12% · resets in 3h40' },
        accounts: [],
        flags,
        defaults: s.settings.launch.defaultFlags,
        args: launchFlagArgs(flags),
        command: `cd -- ${join(desk, 'work', 'app')} && cs ${pick ?? '<account>'} -- ${launchFlagArgs(flags).join(' ')} --session-id <session id> --name ${name}`,
        name,
        warnings: flags.effort === 'ultracode' ? [] : [{ kind: 'effort', text: 'An account move restarts it with ultracode effort (ccw adds --effort ultracode)' }],
      };
      return ok(preview);
    },
    'POST /v1/launches': opts.start ?? ((call: CtlCall) => ok({ job: job({ flags: (call.body as { flags: LaunchFlags }).flags }) }, 202)),
    [`GET /v1/launches/${LAUNCH_ID}`]: () => ok({ job: job(stages[Math.min(polls++, stages.length - 1)] ?? {}) }),
  };
  return { s, ctl: fakeCtl(routes) };
}

describe('jantar new', () => {
  it('starts in the deepest configured root with the picks over the Mac defaults, and follows it to done', async () => {
    const { ctl } = launcher({
      stages: [
        { stage: 'opening', steps: [STEP('queued', 'Queued · 07 · auto'), STEP('opening', 'Opening a Terminal window')] },
        {
          stage: 'dialog',
          steps: [STEP('queued', 'Queued · 07 · auto'), STEP('opening', 'Opening a Terminal window'), STEP('dialog', 'Waiting on the phone')],
          dialog: { title: 'Do you trust the files in this folder?', options: ['Yes, proceed', 'No, exit'], current: 0, since: AT },
        },
        {
          stage: 'dialog',
          steps: [STEP('queued', 'Queued · 07 · auto'), STEP('opening', 'Opening a Terminal window'), STEP('dialog', 'Waiting on the phone')],
          dialog: { title: 'Do you trust the files in this folder?', options: ['Yes, proceed', 'No, exit'], current: 0, since: AT },
        },
        {
          stage: 'done',
          prompt: { hash: 'h', length: 5, sendJobId: 'send-1' },
          steps: [
            STEP('queued', 'Queued · 07 · auto'),
            STEP('opening', 'Opening a Terminal window'),
            STEP('dialog', 'Waiting on the phone'),
            STEP('ready', 'Ready'),
            STEP('done', 'First prompt delivered'),
          ],
        },
      ],
    });
    const { ctx, io } = contextFor(home, { ctl });
    const code = await newSession.run(['~/Desktop/work/app', '--permission', 'plan', '--no-chrome', '--name', 'app-1', '--prompt', 'hello'], ctx);
    expect(code, io.stderr).toBe(EXIT.ok);

    const preview = ctl.calls.find((c) => c.path.startsWith('/v1/launch/preview')) as CtlCall;
    expect(Object.fromEntries(new URL(`http://ctl${preview.path}`).searchParams)).toEqual({
      root: 'r.work',
      path: 'app',
      account: 'auto',
      permission: 'plan',
      chrome: '0',
      effort: 'ultracode',
      model: 'default',
      name: 'app-1',
    });
    const post = ctl.calls.find((c) => c.method === 'POST') as CtlCall;
    expect(post.path).toBe('/v1/launches');
    expect(post.body).toEqual({
      root: 'r.work',
      path: 'app',
      account: 'auto',
      flags: { permission: 'plan', chrome: false, effort: 'ultracode', model: 'default' },
      name: 'app-1',
      prompt: 'hello',
    });
    expect(post.opts.idempotencyKey).toBeTruthy();

    expect(io.stdout).toContain('Start in ~/Desktop/work/app\n  account  7 · most room · 5h 12% · resets in 3h40\n');
    expect(io.stdout).toContain('  flags    permissions plan · Chrome off · effort ultracode · model default\n');
    expect(io.stdout).toContain('--permission-mode plan --effort ultracode --session-id <session id>');
    expect(io.stdout).not.toContain("won't ask");
    expect(io.stderr).toContain('  opening: Opening a Terminal window\n');
    expect(io.stderr.match(/Waiting on "Do you trust the files in this folder\?" \(Yes, proceed \/ No, exit\)/g)).toHaveLength(1);
    expect(io.stderr).toContain('Answer it on your phone (a card) or in the new Terminal window.');
    expect(io.stdout).toContain(`Session started · app in ~/Desktop/work/app on account 7 · session ${SID} · first prompt proven by the transcript`);
  });

  it('--preview starts nothing; skip and auto carry the warning sentence', async () => {
    const { ctl } = launcher();
    const { ctx, io } = contextFor(home, { ctl });
    expect(await newSession.run([join(home.home, 'Desktop'), '--preview', '--effort', 'high', '-a', '4'], ctx)).toBe(EXIT.ok);
    const preview = ctl.calls.find((c) => c.path.startsWith('/v1/launch/preview')) as CtlCall;
    expect(new URL(`http://ctl${preview.path}`).searchParams.get('root')).toBe('r.desk');
    expect(new URL(`http://ctl${preview.path}`).searchParams.get('path')).toBe('');
    expect(new URL(`http://ctl${preview.path}`).searchParams.get('account')).toBe('4');
    expect(io.stdout).toContain("  ! Claude won't ask before running commands in this session.");
    expect(io.stdout).toContain('  ! An account move restarts it with ultracode effort');
    expect(ctl.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('--preview --name asks the daemon with that name, as the start sends it, and starts nothing', async () => {
    const { ctl } = launcher();
    const { ctx, io } = contextFor(home, { ctl });
    expect(await newSession.run(['~/Desktop/work/app', '--preview', '--name', 'app-2', '--permission', 'manual'], ctx), io.stderr).toBe(EXIT.ok);
    const preview = ctl.calls.find((c) => c.path.startsWith('/v1/launch/preview')) as CtlCall;
    expect(new URL(`http://ctl${preview.path}`).searchParams.get('name')).toBe('app-2');
    expect(io.stdout).toContain('  name     app-2\n');
    expect(io.stdout).toContain(' -- --permission-mode manual --chrome --effort ultracode --session-id <session id> --name app-2\n');
    expect(ctl.calls.some((c) => c.method === 'POST')).toBe(false);
    // With no --name the daemon suggests one: the query carries none.
    const plain = launcher();
    const c = contextFor(home, { ctl: plain.ctl });
    expect(await newSession.run(['~/Desktop/work/app', '--preview'], c.ctx)).toBe(EXIT.ok);
    const asked = plain.ctl.calls.find((x) => x.path.startsWith('/v1/launch/preview')) as CtlCall;
    expect(new URL(`http://ctl${asked.path}`).searchParams.has('name')).toBe(false);
    expect(c.io.stdout).toContain('  name     app\n');
  });

  it('refuses a folder outside every root, a missing folder, and bad picks, before anything starts', async () => {
    const { ctl } = launcher();
    const outside = contextFor(home, { ctl });
    expect(await newSession.run(['~/Elsewhere'], outside.ctx)).toBe(EXIT.failed);
    expect(outside.io.stderr).toContain('~/Elsewhere is not under a folder the phone may use. Add one first: jantar folders add-root <folder>');
    const missing = contextFor(home, { ctl });
    expect(await newSession.run(['~/nope'], missing.ctx)).toBe(EXIT.failed);
    expect(missing.io.stderr).toContain(`no such folder: ${join(home.home, 'nope')}`);
    for (const bad of [
      ['~/Desktop', '--effort', 'turbo'],
      ['~/Desktop', '--permission', 'yolo'],
      ['~/Desktop', '--model', 'gpt-5'],
      ['~/Desktop', '--account', 'seven'],
      ['~/Desktop', '--name', 'two words'],
      ['~/Desktop', '--timeout', '0'],
      ['~/Desktop', '--prompt', '   '],
      ['~/Desktop', '--dangerously-skip-permissions'],
      ['~/Desktop', '~/Elsewhere'],
      [],
    ]) {
      const c = contextFor(home, { ctl });
      expect(await newSession.run(bad, c.ctx), bad.join(' ')).toBe(EXIT.usage);
    }
    expect(ctl.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('is loud when the session did not start or its first prompt was not sent', async () => {
    const held = launcher({ start: () => fail('conflict', '07 is held for other work: confirm to start there anyway', 409) });
    const a = contextFor(home, { ctl: held.ctl });
    expect(await newSession.run(['~/Desktop/work', '--account', '7'], a.ctx)).toBe(EXIT.failed);
    expect(a.io.stderr).toContain('Session NOT started: 07 is held for other work: confirm to start there anyway (to start there anyway: --confirm-held)');
    const confirmed = contextFor(home, { ctl: held.ctl });
    await newSession.run(['~/Desktop/work', '--account', '7', '--confirm-held'], confirmed.ctx);
    expect(held.ctl.calls.filter((c) => c.method === 'POST').at(-1)?.body).toMatchObject({ account: 7, confirmHeld: true });

    const failed = launcher({ stages: [{ stage: 'failed', reason: "Claude didn't start within 90 s. Check the window on the Mac." }] });
    const b = contextFor(home, { ctl: failed.ctl });
    expect(await newSession.run(['~/Desktop/work'], b.ctx)).toBe(EXIT.failed);
    expect(b.io.stderr).toContain("Session NOT started · app in ~/Desktop/work/app on account 7 · failed: Claude didn't start within 90 s.");

    const unsent = launcher({ stages: [{ stage: 'ready-prompt-failed', reason: "Started, but the first prompt wasn't sent: a dialog is open" }] });
    const c = contextFor(home, { ctl: unsent.ctl });
    expect(await newSession.run(['~/Desktop/work', '--prompt', 'go'], c.ctx)).toBe(EXIT.failed);
    expect(c.io.stderr).toContain('Session started, but the first prompt was NOT sent');
    expect(c.io.stdout).not.toContain('Session started ·');

    const slow = launcher({ stages: [{ stage: 'starting' }] });
    const d = contextFor(home, { ctl: slow.ctl });
    expect(await newSession.run(['~/Desktop/work', '--timeout', '3'], d.ctx)).toBe(EXIT.failed);
    expect(d.io.stderr).toContain(`still "starting" after 3s. The daemon keeps going (launch ${LAUNCH_ID})`);

    const noAccount = launcher({ pick: null });
    const e = contextFor(home, { ctl: noAccount.ctl });
    expect(await newSession.run(['~/Desktop/work'], e.ctx)).toBe(EXIT.failed);
    expect(e.io.stderr).toContain('no account can take it (every account is held or full). Pick one with --account N.');
    expect(noAccount.ctl.calls.some((x) => x.method === 'POST')).toBe(false);
  });

  it("prints the daemon's sentence when launching is off, and --no-wait returns once queued", async () => {
    const off = fakeCtl({ 'GET /v1/folders/roots': fail('forbidden', 'Starting sessions from the phone is off. Turn it on at your Mac: jantar launch on', 403) });
    const a = contextFor(home, { ctl: off });
    expect(await newSession.run(['~/Desktop'], a.ctx)).toBe(EXIT.failed);
    expect(a.io.stderr).toContain('Turn it on at your Mac: jantar launch on');

    const { ctl } = launcher({ stages: [{ stage: 'opening' }] });
    const b = contextFor(home, { ctl });
    expect(await newSession.run(['~/Desktop/work/app', '--no-wait', '--json'], b.ctx)).toBe(EXIT.ok);
    expect(JSON.parse(b.io.stdout.slice(b.io.stdout.indexOf('{'))).job.id).toBe(LAUNCH_ID);
    expect(b.io.stderr).toContain('Queued.');
    expect(ctl.calls.some((c) => c.path === `/v1/launches/${LAUNCH_ID}`)).toBe(false);

    const down = contextFor(home);
    expect(await newSession.run(['~/Desktop'], down.ctx)).toBe(EXIT.daemonDown);
  });

  it('locateIn prefers a configured root, then the deepest', () => {
    const roots = [root('r.a', 'configured', '/h/a'), root('s.1', 'session', '/h/a/b/c'), root('r.ab', 'configured', '/h/a/b'), root('s.2', 'session', '/x')];
    expect(locateIn(roots, '/h/a/b/c/d')).toMatchObject({ root: { id: 'r.ab' }, rel: 'c/d' });
    expect(locateIn(roots, '/h/a')).toMatchObject({ root: { id: 'r.a' }, rel: '' });
    expect(locateIn(roots, '/x/y')).toMatchObject({ root: { id: 's.2' }, rel: 'y' });
    expect(locateIn(roots, '/h/ab')).toBeNull();
  });
});
