/**
 * Resume over the real API pipeline with the real launcher (a fake path
 * policy, a fake Terminal window) on a synthetic home whose transcripts the
 * fixtures' writePastSessions writes. Security rule LL1: Resume stays an
 * allowlist. A `resume` that is not a UUID is 400 (start body and preview
 * query), one not in the folder's history 404, a running one 409, and an
 * unknown key anywhere in the start body 400; none reaches a window. Also
 * launchHistory: control scope, behind the launch switch, on ctl.sock for
 * the CLI, the path policy's refusals, the shared folders limiter, and
 * replies that carry masked first lines only.
 */
import { mkdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAST_SECRET_EMAIL, PAST_SECRET_TOKEN, PAST_SESSIONS, makeFakeHome, writePastSessions, type FakeHome } from '@jantar/fixtures';
import { IDEMPOTENCY_HEADER, LaunchHistoryResponseSchema, SettingsSchema, V03_LAUNCH_FLAGS, type LaunchJob } from '@jantar/protocol';
import type { FileRefusalCode } from '../../src/contracts.js';
import { V03_LIMITS } from '../../src/api/services.js';
import { NOT_IN_HISTORY, RESUME_RUNNING } from '../../src/launcher/history.js';
import { LauncherService } from '../../src/launcher/service.js';
import { accountForProfileDir } from '../../src/sources/lib/cswap-files.js';
import { DEFAULT_ACCOUNTS, FakeBackend, FakeCcw, FakePolicy, KEPT, T0, filesWith, session, until } from '../launcher/helpers.js';
import { h, makeApi, pairCookie, type TestApi } from './fakes.js';

const [NEWEST, ON_TWO, SECRET] = PAST_SESSIONS.map((s) => s.id) as [string, string, string];
const START = { root: 'r.work', path: 'alpha-app', account: 'auto', flags: { ...V03_LAUNCH_FLAGS } };

let api: TestApi;
let home: FakeHome;
let launcher: LauncherService;
let terminal: FakeBackend;
let denied: [string, string, FileRefusalCode][] = [];

afterEach(async () => {
  await launcher?.stop();
  await api?.close();
  await home?.cleanup();
});

/** An API whose launcher and history read the fake home; the folder `alpha-app` has PAST_SESSIONS. */
async function setup(launch: Record<string, unknown> = {}) {
  home = await makeFakeHome({ sessions: [] });
  const work = join(await realpath(home.home), 'work');
  const folder = join(work, 'alpha-app');
  await mkdir(join(work, 'beta'), { recursive: true });
  await mkdir(folder, { recursive: true });
  await writePastSessions(home, folder, PAST_SESSIONS);
  terminal = new FakeBackend();
  denied = [];
  const sessions = { start: async () => {}, stop: async () => {}, scan: async () => [], current: () => [], accountForConfigDir: (dir: string) => accountForProfileDir(basename(dir), null) };
  api = await makeApi({
    ctx: {
      userHome: home.home,
      settings: SettingsSchema.parse({ launch: { enabled: true, mode: 'cs-shell', defaultFlags: V03_LAUNCH_FLAGS, ...launch }, accounts: { kept: KEPT } }),
    },
    sessions: [],
    deps: (ctx, fakes) => {
      const files = {
        ...filesWith(new FakePolicy([{ id: 'r.work', label: 'work', real: work, display: '~/work' }])),
        denied: (_actor: unknown, root: string, rel: string, why: FileRefusalCode) => void denied.push([root, rel, why]),
      };
      launcher = new LauncherService(ctx, { sessions, terminal, writer: fakes.writer, usage: fakes.usage, ccwLegacy: new FakeCcw(), files, notifiers: [] });
      return { launcher, files, sessions };
    },
  });
  api.ctx.clock.set(T0);
  api.ctx.store.emit({ type: 'usage.updated', data: { accounts: DEFAULT_ACCOUNTS(), activeAccount: null, fetchedAt: T0, source: 'cache' } });
  await launcher.start();
  return { folder };
}

const post = (payload: unknown, cookie: string, key: string) =>
  api.tcp.inject({ method: 'POST', url: '/v1/launches', headers: h(cookie, { [IDEMPOTENCY_HEADER]: key }), payload: payload as object });
const history = (cookie: string, path = 'alpha-app') => api.tcp.inject({ method: 'GET', url: `/v1/launch/history?root=r.work&path=${encodeURIComponent(path)}`, headers: h(cookie) });

describe('LL1: Resume stays an allowlist', () => {
  it('a resume that is not a UUID is 400 in the start body and the preview query; nothing reaches the launcher', async () => {
    await setup();
    const { cookie } = await pairCookie(api, ['launch']);
    const launch = vi.spyOn(launcher, 'launch');
    const preview = vi.spyOn(launcher, 'preview');
    const bad = ['last', 'continue', `${NEWEST} --fork-session`, `${NEWEST};rm -rf ~`, '../../../etc/passwd', '--dangerously-skip-permissions', '', 'x'.repeat(36), 42, null, [NEWEST]];
    for (const [i, resume] of bad.entries()) {
      const res = await post({ ...START, resume }, cookie, `bad-${i}`);
      expect(res.statusCode, JSON.stringify(resume)).toBe(400);
    }
    for (const resume of ['last', `${NEWEST} --fork-session`, '']) {
      const res = await api.tcp.inject({ method: 'GET', url: `/v1/launch/preview?root=r.work&path=alpha-app&resume=${encodeURIComponent(resume)}`, headers: h(cookie) });
      expect(res.statusCode, resume).toBe(400);
    }
    expect(launch).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    expect(terminal.opened).toEqual([]);
  });

  it('unknown keys anywhere in a start with resume are 400', async () => {
    await setup();
    const { cookie } = await pairCookie(api, ['launch']);
    const bad: unknown[] = [
      { ...START, resume: NEWEST, forkSession: true },
      { ...START, resume: NEWEST, continue: true },
      { ...START, resume: NEWEST, sessionId: NEWEST },
      { ...START, resume: NEWEST, args: ['--fork-session'] },
      { ...START, flags: { ...V03_LAUNCH_FLAGS, resume: NEWEST } },
      { ...START, flags: { ...V03_LAUNCH_FLAGS, continue: true } },
    ];
    for (const [i, payload] of bad.entries()) {
      const res = await post(payload, cookie, `unknown-${i}`);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(terminal.opened).toEqual([]);
  });

  it("an id not in this folder's history is 404, a running one 409, with the launcher's sentences", async () => {
    await setup();
    const { cookie } = await pairCookie(api, ['launch']);
    const other = '0b4e7c4e-9999-4999-8999-000000000009';
    const notHere = await post({ ...START, resume: other }, cookie, 'nf');
    expect(notHere.statusCode).toBe(404);
    expect(notHere.json().error).toEqual({ code: 'not_found', message: NOT_IN_HISTORY });
    // A conversation of another folder is not this one's.
    const elsewhere = await post({ ...START, path: 'beta', resume: NEWEST }, cookie, 'beta');
    expect(elsewhere.statusCode).toBe(404);
    const pre = await api.tcp.inject({ method: 'GET', url: `/v1/launch/preview?root=r.work&path=alpha-app&resume=${other}`, headers: h(cookie) });
    expect(pre.statusCode).toBe(404);

    api.ctx.store.emit({ type: 'session.added', sid: NEWEST, data: { session: session({ sid: NEWEST }) } });
    const live = await post({ ...START, resume: NEWEST }, cookie, 'live');
    expect(live.statusCode).toBe(409);
    expect(live.json().error).toEqual({ code: 'conflict', message: RESUME_RUNNING });
    expect(terminal.opened).toEqual([]);
  });
});

describe('a start with resume', () => {
  it('202: --resume <id> and no --session-id, the job resumed under that id; the audit says resumed, never the first line', async () => {
    await setup();
    const { cookie } = await pairCookie(api, ['launch']);
    const pre = await api.tcp.inject({ method: 'GET', url: `/v1/launch/preview?root=r.work&path=alpha-app&resume=${NEWEST}`, headers: h(cookie) });
    expect(pre.statusCode, pre.body).toBe(200);
    expect(pre.json().command).toMatch(new RegExp(` -- --dangerously-skip-permissions --chrome --effort ultracode --resume ${NEWEST} --name alpha-app$`));

    const res = await post({ ...START, resume: NEWEST }, cookie, 'go');
    expect(res.statusCode, res.body).toBe(202);
    const job = res.json().job as LaunchJob;
    expect(job).toMatchObject({ resumed: true, sid: NEWEST, account: 7, accountSource: 'auto' });
    await until(api.ctx.clock, () => terminal.opened.length === 1);
    expect(terminal.opened[0]).toContain(`--resume ${NEWEST} --name alpha-app`);
    expect(terminal.opened[0]).not.toContain('--session-id');
    const row = api.ctx.db.audit.list({ limit: 100 }).find((a) => a.action === 'launchStart');
    expect(row).toMatchObject({ result: 'ok', params: { resumed: true, resume: NEWEST, sid: NEWEST } });
    expect(JSON.stringify(api.ctx.db.audit.list({ limit: 100 }))).not.toContain('push example');
  });

  it("a profile's own conversation pins its account over the account asked for", async () => {
    await setup();
    const { cookie } = await pairCookie(api, ['launch']);
    // ON_TWO lives on account 2, one of the kept accounts: it starts there only when confirmed.
    expect((await post({ ...START, account: 7, resume: ON_TWO }, cookie, 'p1')).statusCode).toBe(409);
    const res = await post({ ...START, account: 7, resume: ON_TWO, confirmHeld: true }, cookie, 'p2');
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().job).toMatchObject({ account: 2, accountSource: 'resume', requested: 7, sid: ON_TWO });
  });

  it('the CLI can resume over ctl.sock', async () => {
    await setup();
    const res = await api.ctl.inject({ method: 'POST', url: '/v1/launches', headers: { [IDEMPOTENCY_HEADER]: 'cli-r' }, payload: { ...START, resume: NEWEST } });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().job).toMatchObject({ actor: 'cli', resumed: true, sid: NEWEST });
  });
});

describe('launchHistory', () => {
  it("a folder's past conversations, newest first, first lines masked; over ctl.sock too", async () => {
    await setup();
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const res = await history(cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const { sessions } = LaunchHistoryResponseSchema.parse(res.json());
    expect(sessions.map((s) => [s.id, s.account, s.live])).toEqual([
      [NEWEST, null, false],
      [ON_TWO, 2, false],
      [SECRET, null, false],
    ]);
    expect(sessions[0]?.first).toBe('fix the push example in the service worker');
    expect(res.body).not.toContain(PAST_SECRET_EMAIL);
    expect(res.body).not.toContain(PAST_SECRET_TOKEN);
    expect(res.body).not.toContain(home.home);
    const viaCtl = await api.ctl.inject({ method: 'GET', url: '/v1/launch/history?root=r.work&path=alpha-app' });
    expect(viaCtl.statusCode).toBe(200);
    expect(viaCtl.json()).toEqual(res.json());
    // A folder with none: an empty list.
    expect((await history(cookie, 'beta')).json()).toEqual({ sessions: [] });
  });

  it('needs control scope and the launch switch; a refused folder is audited by Files', async () => {
    await setup();
    const reader = await pairCookie(api, ['read']);
    expect((await history(reader.cookie)).statusCode).toBe(403);
    const { cookie } = await pairCookie(api, ['read', 'control']);
    expect((await history(cookie, '../..')).statusCode).toBe(400);
    expect((await history(cookie, '.ssh')).statusCode).toBe(403);
    expect(denied).toEqual([
      ['r.work', '../..', 'bad_path'],
      ['r.work', '.ssh', 'protected'],
    ]);
    await api.ctx.settings.patch({ launch: { enabled: false } });
    expect((await history(cookie)).statusCode).toBe(403);
  });

  it('shares the folders limiter with the preview: 429 with retry-after past it', async () => {
    await setup();
    const { cookie } = await pairCookie(api, ['read', 'control']);
    for (let i = 0; i < V03_LIMITS.folders.limit; i++) {
      const url = i % 2 ? '/v1/launch/history?root=r.work&path=alpha-app' : '/v1/launch/preview?root=r.work&path=alpha-app';
      expect((await api.tcp.inject({ method: 'GET', url, headers: h(cookie) })).statusCode, url).toBe(200);
    }
    const over = await history(cookie);
    expect(over.statusCode).toBe(429);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
  });
});
