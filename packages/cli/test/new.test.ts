/**
 * v0.4 (WP-LA): `jantar new --resume <id|last>` against an in-memory daemon
 * on a synthetic HOME. `last` is the newest entry of the folder's history
 * that is not running, sent as its id like any other (no --continue); an id
 * is a UUID or a usage error; the preview shows the conversation and the
 * daemon's command; the start body carries `resume` and nothing else new.
 * In claude mode (one Claude login) no account is printed. Also `launch mode
 * claude`, the mode the daemon names for a Mac without cswap. Nothing here
 * opens a Terminal window.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import {
  LaunchStartBodySchema,
  V03_LAUNCH_FLAGS,
  launchFlagArgs,
  type FileRoot,
  type LaunchFlags,
  type LaunchJob,
  type LaunchPreview,
  type PastSession,
} from '@jantar/protocol';
import launch from '../src/commands/launch.js';
import newSession from '../src/commands/new.js';
import { EXIT, main } from '../src/index.js';
import { memoryIo } from '../src/io.js';
import type { CtlResponse } from '../src/ctl.js';
import { contextFor, fail, fakeCtl, fakeSettings, ok, type CtlCall, type Handler } from './helpers.js';

const AT = '2026-01-15T10:00:00.000Z';
const LAUNCH_ID = '01JSYNTHLAUNCH000000000000';
const NEWEST = '0b4e7c4e-1111-4111-8111-000000000001';
const ON_TWO = '0b4e7c4e-2222-4222-8222-000000000002';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const HISTORY: PastSession[] = [
  { id: NEWEST, account: null, lastAt: '2026-01-15T09:30:00.000Z', first: 'fix the push example in the service worker', live: false },
  { id: ON_TWO, account: 2, lastAt: '2026-01-14T18:00:00.000Z', first: 'write tests for the folder browser', live: false },
];

let home: FakeHome;

beforeEach(async () => {
  home = await makeFakeHome({ sessions: [] });
  await mkdir(join(home.home, 'Desktop', 'work', 'app'), { recursive: true });
});

afterEach(async () => {
  await home.cleanup();
});

function job(over: Partial<LaunchJob> = {}): LaunchJob {
  return {
    id: LAUNCH_ID,
    createdAt: AT,
    updatedAt: AT,
    actor: 'cli',
    rootId: 'r.work',
    folder: join(home.home, 'Desktop', 'work', 'app'),
    display: '~/Desktop/work/app',
    account: 7,
    accountSource: 'auto',
    requested: 'auto',
    flags: { ...V03_LAUNCH_FLAGS },
    dangerous: true,
    name: 'app',
    sid: NEWEST,
    stage: 'queued',
    steps: [{ at: AT, stage: 'queued', detail: 'Queued · 07 · auto' }],
    ...over,
  };
}

/**
 * A launch-capable daemon with Resume: the roots, settings, GET
 * /v1/launch/history answering `history`, a preview that pins the account of
 * a conversation kept on one and types `--resume <id>`, and a start that
 * echoes the resume back as the job's sid.
 */
function daemon(opts: { history?: PastSession[]; preview?: Handler; single?: boolean } = {}) {
  const single = opts.single === true;
  const s = fakeSettings({ launch: { mode: single ? 'claude' : 'cs-shell', defaultFlags: V03_LAUNCH_FLAGS, enabled: true } });
  const work = join(home.home, 'Desktop', 'work');
  const history = opts.history ?? HISTORY;
  const routes: Record<string, Handler | CtlResponse> = {
    ...s.routes,
    'GET /v1/folders/roots': ok({ roots: [{ id: 'r.work', kind: 'configured', label: 'work', display: '~/Desktop/work', home: false, path: work } satisfies FileRoot] }),
    'GET /v1/launch/history': ok({ sessions: history }),
    'GET /v1/launch/preview':
      opts.preview ??
      ((call: CtlCall) => {
        const q = new URL(`http://ctl${call.path}`).searchParams;
        const flags: LaunchFlags = { permission: q.get('permission') as LaunchFlags['permission'], chrome: q.get('chrome') === '1', effort: q.get('effort') as LaunchFlags['effort'], model: q.get('model') as LaunchFlags['model'] };
        const resume = q.get('resume');
        const pinned = history.find((x) => x.id === resume)?.account ?? null;
        const pick = single ? 0 : (pinned ?? 7);
        const session = resume ? `--resume ${resume}` : '--session-id <session id>';
        const preview: LaunchPreview = {
          root: 'r.work',
          path: q.get('path') ?? '',
          display: '~/Desktop/work/app',
          account: single
            ? { pick, source: 'auto', reason: 'one Claude login' }
            : pinned === null
              ? { pick, source: 'auto', reason: 'most room · 5h 12% · resets in 3h40' }
              : { pick, source: 'resume', reason: `This conversation is on 0${pinned}` },
          accounts: [],
          flags,
          defaults: s.settings.launch.defaultFlags,
          args: launchFlagArgs(flags),
          command: `cd -- ${join(work, 'app')} && ${single ? '/synthetic/bin/claude' : `cs ${pick} --`} ${launchFlagArgs(flags).join(' ')} ${session} --name app`,
          name: 'app',
          warnings: [],
        };
        return ok(preview);
      }),
    'POST /v1/launches': (call: CtlCall) => {
      const b = call.body as { resume?: string };
      const pinned = HISTORY.find((x) => x.id === b.resume)?.account ?? null;
      const on: Partial<LaunchJob> = single
        ? { account: 0, steps: [{ at: AT, stage: 'queued', detail: 'Queued' }] }
        : pinned !== null
          ? { account: pinned, accountSource: 'resume' }
          : {};
      return ok({ job: job({ ...(b.resume ? { sid: b.resume, resumed: true } : {}), ...on }) }, 202);
    },
    [`GET /v1/launches/${LAUNCH_ID}`]: () => ok({ job: job({ stage: 'done', resumed: true, ...(single ? { account: 0, steps: [{ at: AT, stage: 'queued', detail: 'Queued' }] } : {}) }) }),
  };
  return fakeCtl(routes);
}

const query = (call: CtlCall | undefined) => Object.fromEntries(new URL(`http://ctl${call?.path ?? ''}`).searchParams);

describe('jantar new --resume', () => {
  it('last: the newest conversation of the folder, sent as its id to the preview and the start', async () => {
    const ctl = daemon();
    const { ctx, io } = contextFor(home, { ctl });
    expect(await newSession.run(['~/Desktop/work/app', '--resume', 'last'], ctx), io.stderr).toBe(EXIT.ok);
    const hist = ctl.calls.find((c) => c.path.startsWith('/v1/launch/history'));
    expect(query(hist)).toEqual({ root: 'r.work', path: 'app' });
    expect(query(ctl.calls.find((c) => c.path.startsWith('/v1/launch/preview')))).toMatchObject({ root: 'r.work', path: 'app', resume: NEWEST });
    const post = ctl.calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ root: 'r.work', path: 'app', account: 'auto', flags: V03_LAUNCH_FLAGS, resume: NEWEST });
    // The body is the daemon's strict schema: no --continue, no free text.
    expect(LaunchStartBodySchema.parse(post?.body)).toEqual(post?.body);
    expect(io.stdout).toContain(`  resume   ${NEWEST} · 2026-01-15 09:30 UTC · "fix the push example in the service worker"\n`);
    expect(io.stdout).toContain(`--resume ${NEWEST} --name app`);
    expect(io.stdout).not.toContain('--session-id');
    expect(io.stderr).toContain(`Resuming conversation ${NEWEST} as app in ~/Desktop/work/app on account 7 (launch ${LAUNCH_ID})`);
    expect(io.stdout).toContain(`Session started · app in ~/Desktop/work/app on account 7 · session ${NEWEST}`);
  });

  it('an id: sent as given (lower case); a conversation kept on one account starts there', async () => {
    const ctl = daemon();
    const { ctx, io } = contextFor(home, { ctl });
    expect(await newSession.run(['~/Desktop/work/app', '--resume', ON_TWO.toUpperCase(), '--account', '7'], ctx), io.stderr).toBe(EXIT.ok);
    expect(query(ctl.calls.find((c) => c.path.startsWith('/v1/launch/preview')))).toMatchObject({ resume: ON_TWO, account: '7' });
    expect(ctl.calls.find((c) => c.method === 'POST')?.body).toMatchObject({ resume: ON_TWO, account: 7 });
    expect(io.stdout).toContain('  account  2 · This conversation is on 02\n');
    expect(io.stdout).toContain(`  resume   ${ON_TWO} · 2026-01-14 18:00 UTC · on account 2 · "write tests for the folder browser"\n`);
    expect(io.stderr).toContain('on account 2');
  });

  it('--preview shows the conversation and the command, and starts nothing', async () => {
    const ctl = daemon();
    const { ctx, io } = contextFor(home, { ctl });
    expect(await newSession.run(['~/Desktop/work/app', '--resume', 'last', '--preview'], ctx)).toBe(EXIT.ok);
    expect(io.stdout).toContain(`  resume   ${NEWEST}`);
    expect(io.stdout).toContain(`  command  cd -- ${join(home.home, 'Desktop', 'work', 'app')} && cs 7 -- --dangerously-skip-permissions --chrome --effort ultracode --resume ${NEWEST} --name app`);
    expect(ctl.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('only an id or last: anything else is a usage error before the daemon is asked', async () => {
    for (const bad of ['yesterday', 'continue', '../../etc', `${NEWEST} --fork-session`, '12345', '']) {
      const ctl = daemon();
      const c = contextFor(home, { ctl });
      expect(await newSession.run(['~/Desktop/work/app', '--resume', bad], c.ctx), bad).toBe(EXIT.usage);
      expect(c.io.stderr).toContain('--resume takes a conversation id or last');
      expect(ctl.calls).toEqual([]);
    }
    const missing = contextFor(home, { ctl: daemon() });
    expect(await newSession.run(['~/Desktop/work/app', '--resume'], missing.ctx)).toBe(EXIT.usage);
  });

  it('last skips a conversation that runs now (it is open already); when every one runs: loud, and nothing starts', async () => {
    const running: PastSession = { id: '0b4e7c4e-3333-4333-8333-000000000003', account: null, lastAt: '2026-01-15T09:50:00.000Z', first: 'refactor the parser', live: true };
    const ctl = daemon({ history: [running, ...HISTORY] });
    const { ctx, io } = contextFor(home, { ctl });
    expect(await newSession.run(['~/Desktop/work/app', '--resume', 'last', '--preview'], ctx), io.stderr).toBe(EXIT.ok);
    expect(query(ctl.calls.find((c) => c.path.startsWith('/v1/launch/preview')))).toMatchObject({ resume: NEWEST });
    expect(io.stdout).toContain(`  resume   ${NEWEST} · `);

    const all = daemon({ history: [running, ...HISTORY.map((x) => ({ ...x, live: true }))] });
    const c = contextFor(home, { ctl: all });
    expect(await newSession.run(['~/Desktop/work/app', '--resume', 'last'], c.ctx)).toBe(EXIT.failed);
    expect(c.io.stderr).toContain('Session NOT started: every past conversation in ~/Desktop/work/app is running now.');
    expect(all.calls.some((x) => x.path.startsWith('/v1/launch/preview') || x.method === 'POST')).toBe(false);
  });

  it('last in a folder with no past conversations: loud, and nothing starts', async () => {
    const ctl = daemon({ history: [] });
    const { ctx, io } = contextFor(home, { ctl });
    expect(await newSession.run(['~/Desktop/work/app', '--resume', 'last'], ctx)).toBe(EXIT.failed);
    expect(io.stderr).toContain('Session NOT started: there is no past conversation in ~/Desktop/work/app to resume.');
    expect(ctl.calls.some((c) => c.path.startsWith('/v1/launch/preview') || c.method === 'POST')).toBe(false);
  });

  it("the daemon's refusal (not in the history, running now) is printed, and nothing starts", async () => {
    for (const [status, code, message] of [
      [404, 'not_found', "That conversation isn't in this folder's history."],
      [409, 'conflict', 'That conversation is running. Open it on the Board.'],
    ] as const) {
      const ctl = daemon({ preview: () => fail(code, message, status) });
      const { ctx, io } = contextFor(home, { ctl });
      expect(await newSession.run(['~/Desktop/work/app', '--resume', '0b4e7c4e-9999-4999-8999-000000000009'], ctx)).toBe(EXIT.failed);
      expect(io.stderr).toContain(message);
      expect(ctl.calls.some((c) => c.method === 'POST')).toBe(false);
    }
  });

  it('without --resume nothing about history is asked or sent', async () => {
    const ctl = daemon();
    const { ctx, io } = contextFor(home, { ctl });
    expect(await newSession.run(['~/Desktop/work/app'], ctx), io.stderr).toBe(EXIT.ok);
    expect(ctl.calls.some((c) => c.path.startsWith('/v1/launch/history'))).toBe(false);
    expect(query(ctl.calls.find((c) => c.path.startsWith('/v1/launch/preview'))).resume).toBeUndefined();
    expect(ctl.calls.find((c) => c.method === 'POST')?.body).not.toHaveProperty('resume');
    expect(io.stdout).not.toContain('resume');
    expect(io.stderr).toContain('Starting app in ~/Desktop/work/app');
  });

  it('one Claude login (claude mode): no account in the preview, the start or the result', async () => {
    const ctl = daemon({ single: true });
    const { ctx, io } = contextFor(home, { ctl });
    expect(await newSession.run(['~/Desktop/work/app', '--resume', 'last'], ctx), io.stderr).toBe(EXIT.ok);
    expect(io.stdout).toContain('Start in ~/Desktop/work/app\n  flags    ');
    expect(io.stdout).toContain(`&& /synthetic/bin/claude --dangerously-skip-permissions --chrome --effort ultracode --resume ${NEWEST} --name app`);
    expect(io.stderr).toContain(`Resuming conversation ${NEWEST} as app in ~/Desktop/work/app (launch ${LAUNCH_ID})`);
    expect(io.stdout).toContain(`Session started · app in ~/Desktop/work/app · session ${NEWEST}`);
    for (const out of [io.stdout, io.stderr]) {
      expect(out).not.toMatch(/\baccount\b/);
      expect(out).not.toContain('one Claude login');
      expect(out).not.toMatch(/\b00?\b/);
    }
  });

  it('the help names --resume', async () => {
    const io = memoryIo(home.env);
    expect(await main(['new', '--help'], { io })).toBe(EXIT.ok);
    expect(io.stdout).toContain('[--resume ID|last]');
    expect(io.stdout).toContain('--resume opens a past conversation of the folder');
    expect(UUID_RE.test(NEWEST)).toBe(true);
  });
});

describe('jantar launch mode claude', () => {
  it('sets claude mode and says what it types; the other modes and the help still work', async () => {
    const s = fakeSettings({ launch: { mode: 'cs-shell' } });
    const ctl = fakeCtl(s.routes);
    const a = contextFor(home, { ctl });
    expect(await launch.run(['mode', 'claude'], a.ctx), a.io.stderr).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ launch: { mode: 'claude' } }]);
    expect(a.io.stdout).toBe('Mode: claude (types: cd -- <folder> && claude <flags> ..., for one Claude login without cswap)\n');
    expect(a.io.stderr).toBe('');
    const status = contextFor(home, { ctl });
    expect(await launch.run(['status'], status.ctx)).toBe(EXIT.ok);
    expect(status.io.stdout).toContain('Mode: claude (types: cd -- <folder> && claude <flags>');
    expect(await launch.run(['mode', 'cswap-run'], contextFor(home, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.launch.mode).toBe('cswap-run');
    const bad = contextFor(home, { ctl });
    expect(await launch.run(['mode', 'claude-code'], bad.ctx)).toBe(EXIT.usage);
    expect(bad.io.stderr).toContain('mode must be claude, cs-shell or cswap-run');
    const help = memoryIo(home.env);
    expect(await main(['launch', '--help'], { io: help })).toBe(EXIT.ok);
    expect(help.stdout).toContain('mode <claude|cs-shell|cswap-run>');
  });

  it('claude mode runs no pre-launch: status and setting one say it applies in cswap-run mode only', async () => {
    const s = fakeSettings({ launch: { mode: 'claude', preLaunchArgv: [process.execPath, '-v'] } });
    const ctl = fakeCtl(s.routes);
    const status = contextFor(home, { ctl });
    expect(await launch.run(['status'], status.ctx)).toBe(EXIT.ok);
    expect(status.io.stdout).toContain(`Pre-launch: ${process.execPath} -v (cswap-run mode only)`);
    const set = contextFor(home, { ctl });
    expect(await launch.run(['pre-launch', '--', process.execPath, '-v'], set.ctx), set.io.stderr).toBe(EXIT.ok);
    expect(set.io.stdout).toContain('It applies in cswap-run mode only: claude mode starts claude with nothing before it.');
    // cswap-run runs it: no note.
    await launch.run(['mode', 'cswap-run'], contextFor(home, { ctl }).ctx);
    const run = contextFor(home, { ctl });
    expect(await launch.run(['status'], run.ctx)).toBe(EXIT.ok);
    expect(run.io.stdout).toContain(`Pre-launch: ${process.execPath} -v\n`);
  });

  it('with no daemon it writes config.json (the Mac without cswap is told to run exactly this)', async () => {
    const { ctx, io } = contextFor(home);
    expect(await launch.run(['mode', 'claude'], ctx), io.stderr).toBe(EXIT.ok);
    expect(io.stdout).toContain('Mode: claude');
    expect(io.stdout).toContain('Saved to config.json');
  });

  it('defaults --reset goes back to the safe v0.4 defaults (manual, no Chrome)', async () => {
    const s = fakeSettings({ launch: { defaultFlags: V03_LAUNCH_FLAGS } });
    const ctl = fakeCtl(s.routes);
    expect(await launch.run(['defaults', '--reset'], contextFor(home, { ctl }).ctx)).toBe(EXIT.ok);
    expect(s.settings.launch.defaultFlags).toEqual({ permission: 'manual', chrome: false, effort: 'default', model: 'default' });
  });
});
