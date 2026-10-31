/**
 * Launch jobs end to end on fakes (spec 4.5.5): opening, starting, dialog,
 * answer, ready, prompting, done; the auto answers and cards (U8: trust is
 * always a card); every failure row the phone can show; restart recovery;
 * and the security rules L3 (the folder is re-validated at start), L5 (only
 * up, down and enter are pressed), L7 (rate limits), L9 (every start, dialog
 * and failure is pushed to all devices, one audit row per launch, no prompt
 * text). Nothing here opens a real window: the "window" is FakeBackend.
 *
 * v0.4 (at the end): Resume (the conversation's own id, a pinned account,
 * the history re-checked at start, the match by id or by window) and
 * single-account mode with claude mode (LL6), on a synthetic home whose
 * transcripts the fixtures' writePastSessions writes.
 */
import { mkdir, rm, symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAST_SESSIONS, makeFakeHome, writePastSessions, type FakeHome } from '@jantar/fixtures';
import { LAUNCH_HISTORY_LIMIT, V03_LAUNCH_FLAGS, type AccountsMode, type LaunchJob, type LaunchStartBody, type Move, type Session } from '@jantar/protocol';
import type { Actor } from '../../src/contracts.js';
import { CSWAP_MODE, NO_CSWAP_MODE, q } from '../../src/launcher/command.js';
import { NOT_IN_HISTORY, RESUME_RUNNING, RESUME_STARTING, pastSessions } from '../../src/launcher/history.js';
import { accountForProfileDir } from '../../src/sources/lib/cswap-files.js';
import { OPEN_TIMEOUT_SENTENCE, PERMISSION_SENTENCE, RESTART_REASON, SWITCHED_OFF_REASON, WINDOW_CLOSED, isFinal } from '../../src/launcher/launcher.js';
import { LAUNCH_OFF, LauncherService } from '../../src/launcher/service.js';
import { WebPushNotifier } from '../../src/notify/webpush.js';
import {
  BYPASS_SCREEN,
  CHROME_SCREEN,
  CS_MISSING_SCREEN,
  KEEP_MODEL_SCREEN,
  LOGIN_SCREEN,
  KEPT,
  READY_SCREEN,
  RETRY_SCREEN,
  SHELL_PROMPT,
  STARTING_SCREEN,
  T0,
  account,
  advance,
  device,
  filesWith,
  flush,
  makeRig,
  session,
  settle,
  trustScreen,
  until,
  type Rig,
  type RigOptions,
} from './helpers.js';

let rig: Rig;
afterEach(async () => {
  await rig?.close();
});

const PHONE: Actor = device('dev-launch', ['read', 'control', 'launch']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET = 'SECRET-PROMPT-7c1e Fix the flaky test in send.ts';

const body = (over: Partial<LaunchStartBody> = {}): LaunchStartBody => ({ root: 'r.work', path: 'alpha-app', account: 'auto', flags: { ...V03_LAUNCH_FLAGS }, ...over });

async function start(over: Partial<LaunchStartBody> = {}, actor: Actor = PHONE, key = `key-${Math.random()}`): Promise<LaunchJob> {
  const r = await rig.launcher.launch(body(over), actor, key);
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.job;
}

const job = (id: string): LaunchJob => {
  const r = rig.launcher.get(id);
  if (!r) throw new Error('no such job');
  return r.job;
};
const stage = (id: string) => job(id).stage;
const clock = () => rig.ctx.clock;

/** The new session's file shows up (claude-files would emit this). */
function sessionUp(j: LaunchJob, over: Partial<Session> = {}): void {
  const s = session({ sid: j.sid, cwd: j.folder, tty: '/dev/ttys014', account: j.account, name: j.name, startedAt: rig.ctx.clock.iso(), ...over });
  rig.ctx.store.emit({ type: 'session.added', sid: s.sid, data: { session: s } });
}

async function toStarting(over: Partial<LaunchStartBody> = {}): Promise<LaunchJob> {
  const j = await start(over);
  await until(clock(), () => stage(j.id) === 'starting');
  return j;
}

/** A launch that reaches ready with no dialog and finishes. */
async function toDone(j: LaunchJob): Promise<void> {
  rig.terminal.fg = 'claude';
  rig.terminal.screen = READY_SCREEN;
  sessionUp(j);
  await until(clock(), () => ['done', 'done-no-prompt', 'ready-prompt-failed'].includes(stage(j.id)));
}

const audits = (action: string) => rig.ctx.db.audit.list({ limit: 1000 }).filter((a) => a.action === action);
const titles = () => rig.notifier.sent.map((n) => n.title);

describe('a launch from start to finish', () => {
  it('opening, starting, dialog, answer, ready, prompting, done', async () => {
    rig = await makeRig();
    const t = rig.terminal;
    t.fg = 'other';
    const queued = await start({ prompt: SECRET });
    expect(queued).toMatchObject({
      stage: 'queued',
      account: 7,
      accountSource: 'auto',
      requested: 'auto',
      name: 'alpha-app',
      folder: join(rig.work, 'alpha-app'),
      display: '~/work/alpha-app',
      rootId: 'r.work',
      dangerous: true,
      actor: 'device:dev-launch',
      prompt: { length: SECRET.length },
    });
    expect(queued.sid).toMatch(UUID_RE);
    expect(t.opened).toEqual([]);

    await until(clock(), () => stage(queued.id) === 'starting');
    expect(t.opened).toEqual([
      `cd -- ${q(join(rig.work, 'alpha-app'))} && cs 7 -- --dangerously-skip-permissions --chrome --effort ultracode --session-id ${queued.sid} --name alpha-app`,
    ]);
    expect(job(queued.id)).toMatchObject({ tty: '/dev/ttys014', windowId: '9001' });
    expect(titles()).toEqual(['alpha-app started']);
    expect(rig.notifier.sent[0]).toMatchObject({ kind: 'launch', body: 'Start · alpha-app on 07', url: `/new?launch=${queued.id}`, tag: `launch:${queued.id}` });

    // Claude comes up and asks about trust: a card, never answered by the daemon (U8).
    t.fg = 'claude';
    t.screen = trustScreen(0);
    await until(clock(), () => stage(queued.id) === 'dialog');
    expect(job(queued.id).dialog).toEqual({ title: 'Accessing workspace:', options: ['No, exit', 'Yes, I trust this folder'], current: 0, since: expect.any(String) });
    expect(rig.launcher.get(queued.id)?.screenTail).toContain('Yes, I trust this folder');
    expect(rig.notifier.sent[1]).toMatchObject({ title: 'alpha-app needs you', body: 'Start · trust this folder?' });
    await advance(clock(), 10_000);
    expect(t.keys).toEqual([]);

    // The phone answers "Yes, I trust this folder".
    t.onKey = () => {
      t.screen = STARTING_SCREEN;
    };
    const answering = rig.launcher.answer(queued.id, { option: 1, title: 'Accessing workspace:' }, PHONE);
    await advance(clock(), 1_500);
    expect(await answering).toMatchObject({ ok: true, job: { stage: 'starting' } });
    expect(t.keys).toEqual([{ key: 'down', repeat: 1 }]);
    expect(rig.writer.locks).toBe(1);

    // The session file shows up and the input box appears: ready, then the first prompt.
    sessionUp(queued);
    t.screen = READY_SCREEN;
    await until(clock(), () => stage(queued.id) === 'done');
    expect(rig.writer.submits).toEqual([{ sid: queued.sid, text: SECRET, onDraft: 'refuse', idempotencyKey: `launch:${queued.id}`, actor: PHONE }]);
    const done = job(queued.id);
    expect(done.prompt?.sendJobId).toBeDefined();
    expect(done.reason).toBeUndefined();
    expect([...new Set(done.steps.map((s) => s.stage))]).toEqual(['queued', 'opening', 'starting', 'dialog', 'ready', 'prompting', 'done']);
    expect(done.steps.map((s) => s.detail)).toContain('Answered · Yes, I trust this folder');
    expect(done.steps.at(-1)?.detail).toBe('First prompt delivered');

    // L9: one audit row for the launch, one for the answer; no prompt text anywhere.
    expect(audits('session.launch')).toHaveLength(1);
    expect(audits('session.launch')[0]).toMatchObject({ actor: 'device:dev-launch', target: queued.id, result: 'ok', params: { stage: 'done', account: 7, promptLength: SECRET.length } });
    expect(audits('session.launch')[0]?.params).not.toHaveProperty('resumed');
    expect(audits('session.launch.answer')).toEqual([
      expect.objectContaining({ actor: 'device:dev-launch', params: { launchId: queued.id, title: 'Accessing workspace:', option: 1, auto: false } }),
    ]);
    const replay = rig.ctx.store.replay(0);
    const events = replay.kind === 'events' ? replay.events : [];
    expect(events.filter((e) => e.type === 'launch.progress').length).toBeGreaterThan(5);
    for (const blob of [JSON.stringify(events), JSON.stringify(rig.ctx.db.audit.list({ limit: 1000 })), JSON.stringify(rig.ctx.db.launches.list()), JSON.stringify(rig.notifier.sent), JSON.stringify(rig.ctx.log)]) {
      expect(blob).not.toContain('SECRET-PROMPT');
    }
    // The envelope names the session once it exists.
    expect(events.filter((e) => e.type === 'launch.progress').at(-1)?.sid).toBe(queued.sid);
    // This actor's flags start the next sheet.
    expect(rig.ctx.db.launchFlags.get('device:dev-launch')).toEqual(V03_LAUNCH_FLAGS);
  });

  it('with no first prompt it ends "done" at ready, and nothing is typed', async () => {
    rig = await makeRig();
    const j = await toStarting();
    await toDone(j);
    expect(stage(j.id)).toBe('done');
    expect(rig.writer.submits).toEqual([]);
    expect(rig.terminal.keys).toEqual([]);
  });

  it('ready needs two calm polls with the session idle, Claude in front and the input box up', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = READY_SCREEN;
    await advance(clock(), 10_000);
    expect(stage(j.id)).toBe('starting'); // no session file yet
    sessionUp(j, { status: 'working' });
    await advance(clock(), 10_000);
    expect(stage(j.id)).toBe('starting'); // not idle
    rig.ctx.store.emit({ type: 'session.updated', sid: j.sid, data: { patch: { status: 'idle' } } });
    await advance(clock(), 2_100);
    expect(stage(j.id)).toBe('starting'); // one calm poll
    await until(clock(), () => stage(j.id) === 'done', 5_000);
  });
});

describe('startup dialogs', () => {
  it('the Chrome intro is answered with Return, by the daemon, audited as auto', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = CHROME_SCREEN;
    rig.terminal.onKey = () => {
      rig.terminal.screen = READY_SCREEN;
    };
    sessionUp(j);
    await until(clock(), () => stage(j.id) === 'done');
    expect(rig.terminal.keys).toEqual([{ key: 'enter' }]);
    expect(job(j.id).steps.some((s) => s.stage === 'dialog')).toBe(false);
    expect(audits('session.launch.answer')).toEqual([expect.objectContaining({ actor: 'system', params: { launchId: j.id, title: 'Claude in Chrome', option: 0, auto: true } })]);
  });

  it('a dialog the daemon answers that never goes away ends at the ready timeout (only cards pause the clock)', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = CHROME_SCREEN;
    sessionUp(j);
    await until(clock(), () => stage(j.id) === 'failed', 200_000, 1_000);
    expect(job(j.id).reason).toBe("Didn't become ready within 180 s. Check the window on the Mac.");
    // Answered again each time the same title outlived the 20 s it is left alone, never in between.
    expect(rig.terminal.keys.length).toBeGreaterThanOrEqual(2);
    expect(rig.terminal.keys.length).toBeLessThanOrEqual(10);
  });

  it('"Retry now" is chosen once by the daemon; the second time it is a card', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = RETRY_SCREEN;
    await until(clock(), () => stage(j.id) === 'dialog', 60_000);
    expect(rig.terminal.keys).toEqual([{ key: 'enter' }]);
    expect(job(j.id).dialog?.options).toEqual(['Retry now', 'Exit']);
  });

  it('the bypass warning is a card, never answered by the daemon', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = BYPASS_SCREEN;
    await until(clock(), () => stage(j.id) === 'dialog');
    await advance(clock(), 30_000);
    expect(rig.terminal.keys).toEqual([]);
    expect(titles()).toContain('alpha-app needs you');
  });

  it('a login screen fails the launch: the account needs a re-login at the Mac', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = LOGIN_SCREEN;
    await until(clock(), () => stage(j.id) === 'failed');
    expect(job(j.id).reason).toBe('07 needs a re-login on the Mac (cswap)');
    expect(rig.launcher.get(j.id)?.screenTail).toContain('Anthropic Console account');
    expect(titles()).toEqual(['alpha-app started', "alpha-app didn't start"]);
    expect(audits('session.launch')[0]).toMatchObject({ result: 'failed', params: { stage: 'failed', reason: '07 needs a re-login on the Mac (cswap)' } });
    expect(rig.terminal.keys).toEqual([]);
  });

  it('a card closes when the dialog is answered at the Mac', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = trustScreen(0);
    await until(clock(), () => stage(j.id) === 'dialog');
    // The pointer moves at the Mac: the card follows.
    rig.terminal.screen = trustScreen(1);
    await until(clock(), () => job(j.id).dialog?.current === 1, 5_000);
    rig.terminal.screen = READY_SCREEN;
    sessionUp(j);
    await until(clock(), () => stage(j.id) === 'done');
    expect(job(j.id).steps.map((s) => s.detail)).toContain('Answered on the Mac');
    expect(rig.terminal.keys).toEqual([]);
  });

  it('one read without the dialog (a repaint) does not close the card or push it again', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = trustScreen(0);
    await until(clock(), () => stage(j.id) === 'dialog');
    // Polls run every 2 s: exactly one of them sees the screen without the dialog.
    rig.terminal.screen = STARTING_SCREEN;
    await advance(clock(), 2_000);
    rig.terminal.screen = trustScreen(0);
    await advance(clock(), 30_000, 1_000);
    expect(stage(j.id)).toBe('dialog');
    expect(job(j.id).steps.map((s) => s.detail)).not.toContain('Answered on the Mac');
    expect(titles().filter((t) => t === 'alpha-app needs you')).toHaveLength(1);
  });

  it('a card nobody answers ends the launch as stalled after launch.timeouts.dialogMin', async () => {
    rig = await makeRig({ settings: { launch: { enabled: true, timeouts: { dialogMin: 5 } } } });
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = trustScreen(0);
    await until(clock(), () => stage(j.id) === 'dialog');
    await advance(clock(), 4 * 60_000, 2_000);
    expect(stage(j.id)).toBe('dialog');
    await until(clock(), () => stage(j.id) === 'stalled', 2 * 60_000, 2_000);
    expect(job(j.id).reason).toBe('Nobody answered "Accessing workspace:" in 5 min. Answer it on the Mac.');
    expect(rig.launcher.get(j.id)?.screenTail).toContain('No, exit');
    expect(titles().at(-1)).toBe("alpha-app didn't start");
  });

  it('the ready clock pauses while a card waits', async () => {
    rig = await makeRig({ settings: { launch: { enabled: true, timeouts: { claudeS: 10, readyS: 20 } } } });
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = trustScreen(1);
    await until(clock(), () => stage(j.id) === 'dialog');
    await advance(clock(), 10 * 60_000, 5_000);
    expect(stage(j.id)).toBe('dialog');
    rig.terminal.onKey = () => {
      rig.terminal.screen = READY_SCREEN;
    };
    const answering = rig.launcher.answer(j.id, { option: 1, title: 'Accessing workspace:' }, PHONE);
    await flush();
    expect(await answering).toMatchObject({ ok: true });
    expect(rig.terminal.keys).toEqual([{ key: 'enter' }]);
    sessionUp(j);
    await until(clock(), () => stage(j.id) === 'done', 15_000);
  });

  it('L8 (launcher side): an answer is refused when the title changed, when no card is open, or for a bad option', async () => {
    rig = await makeRig();
    const j = await toStarting();
    expect(await rig.launcher.answer(j.id, { option: 0, title: 'Accessing workspace:' }, PHONE)).toMatchObject({ ok: false, code: 'conflict' });
    rig.terminal.fg = 'claude';
    rig.terminal.screen = trustScreen(0);
    await until(clock(), () => stage(j.id) === 'dialog');
    expect(await rig.launcher.answer(j.id, { option: 1, title: 'Something else' }, PHONE)).toEqual({
      ok: false,
      code: 'conflict',
      reason: 'The dialog on the Mac has changed; look at it again',
    });
    expect(await rig.launcher.answer(j.id, { option: 5, title: 'Accessing workspace:' }, PHONE)).toMatchObject({ ok: false, code: 'invalid_request' });
    // The screen moved on between the card and the tap.
    rig.terminal.screen = BYPASS_SCREEN;
    const late = rig.launcher.answer(j.id, { option: 1, title: 'Accessing workspace:' }, PHONE);
    await advance(clock(), 1_500);
    expect(await late).toMatchObject({ ok: false, code: 'conflict' });
    expect(await rig.launcher.answer('nope', { option: 0, title: 'x' }, PHONE)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await rig.launcher.answer(j.id, { option: 1, title: 'Accessing workspace:' }, device('ro', ['read', 'control']))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(rig.terminal.keys).toEqual([]);
  });

  it('L8: an answer is refused when the dialog keeps its title but the option at that place changed', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = trustScreen(0);
    await until(clock(), () => stage(j.id) === 'dialog');
    // Same title, the options in another order: option 1 is now "No, exit".
    rig.terminal.screen = trustScreen(0).replace(' ❯ No, exit', ' ❯ Yes, I trust this folder').replace('   Yes, I trust this folder', '   No, exit');
    const r = rig.launcher.answer(j.id, { option: 1, title: 'Accessing workspace:' }, PHONE);
    await advance(clock(), 1_500);
    expect(await r).toEqual({ ok: false, code: 'conflict', reason: 'The dialog on the Mac has changed; look at it again' });
    expect(rig.terminal.keys).toEqual([]);
  });

  it("an answer waits at most lockWaitMs for the pane's writer lock, and types nothing when it gets the lock late", async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = trustScreen(0);
    await until(clock(), () => stage(j.id) === 'dialog');
    let release!: () => void;
    const held = new Promise<void>((res) => {
      release = res;
    });
    rig.writer.withPaneLock = async (_pane, task) => {
      await held;
      return task();
    };
    const r = rig.launcher.answer(j.id, { option: 1, title: 'Accessing workspace:' }, PHONE);
    await advance(clock(), 9_000);
    expect(await r).toEqual({ ok: false, code: 'unavailable', reason: 'The answer could not be typed: a prompt is still being sent to this window' });
    release();
    await flush();
    expect(rig.terminal.keys).toEqual([]);
    expect(stage(j.id)).toBe('dialog');
  });

  it('stop() does not wait for an answer stuck behind the writer lock', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = trustScreen(0);
    await until(clock(), () => stage(j.id) === 'dialog');
    rig.writer.withPaneLock = () => new Promise<never>(() => undefined);
    const r = rig.launcher.answer(j.id, { option: 1, title: 'Accessing workspace:' }, PHONE);
    await advance(clock(), 1_500);
    let stopped = false;
    void rig.launcher.stop().then(() => {
      stopped = true;
    });
    await settle(() => stopped, 1_000);
    expect(await r).toEqual({ ok: false, code: 'unavailable', reason: 'The daemon is stopping; answer it on the Mac' });
    expect(rig.terminal.keys).toEqual([]);
    expect(rig.ctx.db.launches.get(j.id)?.stage).toBe('dialog');
  });

  it('a key that cannot be typed (pressKey unsupported) is reported, and the card stays', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = trustScreen(0);
    rig.terminal.pressResult = { ok: false, code: 'unsupported', reason: 'pressing keys is not built yet' };
    await until(clock(), () => stage(j.id) === 'dialog');
    const r = rig.launcher.answer(j.id, { option: 1, title: 'Accessing workspace:' }, PHONE);
    await advance(clock(), 1_500);
    expect(await r).toEqual({ ok: false, code: 'unavailable', reason: 'The answer could not be typed: pressing keys is not built yet' });
    expect(stage(j.id)).toBe('dialog');
  });

  it('L5: the launcher only ever presses up, down and enter', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = RETRY_SCREEN;
    await until(clock(), () => stage(j.id) === 'dialog', 60_000);
    rig.terminal.screen = trustScreen(1);
    await until(clock(), () => job(j.id).dialog?.title === 'Accessing workspace:', 10_000).catch(() => undefined);
    const r = rig.launcher.answer(j.id, { option: 0, title: job(j.id).dialog?.title ?? '' }, PHONE);
    await advance(clock(), 1_500);
    await r;
    expect(rig.terminal.keys.length).toBeGreaterThan(0);
    for (const k of rig.terminal.keys) expect(['up', 'down', 'enter']).toContain(k.key);
  });
});

describe('failures the receipt shows', () => {
  it('Terminal automation not allowed: the System Settings sentence', async () => {
    rig = await makeRig();
    rig.terminal.openResult = { ok: false, code: 'permission', reason: 'x' };
    const j = await start();
    await until(clock(), () => stage(j.id) === 'failed');
    expect(job(j.id).reason).toBe(PERMISSION_SENTENCE);
    expect(titles()).toEqual(["alpha-app didn't start"]);
  });

  it('osascript timed out: the window may have opened anyway, and the receipt says so', async () => {
    rig = await makeRig();
    rig.terminal.openResult = { ok: false, code: 'timeout', reason: 'Terminal did not answer in time' };
    const j = await start();
    await until(clock(), () => stage(j.id) === 'failed');
    expect(job(j.id).reason).toBe(OPEN_TIMEOUT_SENTENCE);
    expect(OPEN_TIMEOUT_SENTENCE).toMatch(/may have opened/);
  });

  it('a window Terminal ran the command in but could not find by its tty is watched by the tty alone', async () => {
    rig = await makeRig();
    rig.terminal.openResult = { ok: true, tty: '/dev/ttys014', windowId: '' };
    const j = await toStarting();
    expect(job(j.id).tty).toBe('/dev/ttys014');
    expect(job(j.id).windowId).toBeUndefined();
    await toDone(j);
    expect(stage(j.id)).toBe('done');
  });

  it('Terminal too busy to find the tab is not a closed window; a tab that is gone is', async () => {
    rig = await makeRig();
    rig.terminal.findError = { code: 'timeout', reason: 'Terminal did not answer in time' };
    const j = await toStarting();
    await advance(clock(), 12_000, 1_000);
    expect(stage(j.id)).toBe('starting');
    rig.terminal.findError = { code: 'not_found', reason: 'that Terminal tab is no longer open' };
    await until(clock(), () => stage(j.id) === 'failed', 10_000);
    expect(job(j.id).reason).toBe('The window was closed');
  });

  it('the shell does not know cs', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'shell';
    rig.terminal.screen = CS_MISSING_SCREEN;
    await until(clock(), () => stage(j.id) === 'failed');
    expect(job(j.id).reason).toMatch(/doesn't know `cs`.*jantar launch mode cswap-run/);
  });

  it('cswap gives up and the shell comes back without Claude', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'shell';
    rig.terminal.screen = `${SHELL_PROMPT}Error: profile 7 is locked`;
    await advance(clock(), 6_000);
    expect(stage(j.id)).toBe('starting');
    await until(clock(), () => stage(j.id) === 'failed', 20_000);
    expect(job(j.id).reason).toBe("cswap couldn't start account 07. Check the window on the Mac.");
  });

  it('Claude never takes the foreground within launch.timeouts.claudeS', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'other';
    await advance(clock(), 85_000, 1_000);
    expect(stage(j.id)).toBe('starting');
    await until(clock(), () => stage(j.id) === 'failed', 10_000);
    expect(job(j.id).reason).toBe("Claude didn't start within 90 s. Check the window on the Mac.");
  });

  it('the window is closed', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'gone';
    await until(clock(), () => stage(j.id) === 'failed', 10_000);
    expect(job(j.id).reason).toBe('The window was closed');
  });

  it('Claude exits before it is ready (say "No, exit" at the Mac)', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = STARTING_SCREEN;
    await advance(clock(), 4_000);
    rig.terminal.fg = 'shell';
    rig.terminal.screen = SHELL_PROMPT;
    await until(clock(), () => stage(j.id) === 'failed', 10_000);
    expect(job(j.id).reason).toBe('Claude exited before it was ready');
  });

  it("Claude is up but its session file never shows: not ready within launch.timeouts.readyS", async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = READY_SCREEN;
    await until(clock(), () => stage(j.id) === 'failed', 200_000, 1_000);
    expect(job(j.id).reason).toBe('Claude started, but its session never showed up. Check the window on the Mac.');
  });

  it('a session on another account than asked is a warning, not a failure', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = READY_SCREEN;
    sessionUp(j, { account: 4 });
    await until(clock(), () => stage(j.id) === 'done');
    expect(job(j.id).actualAccount).toBe(4);
    expect(job(j.id).steps.map((s) => s.detail)).toContain('Started on 04, not 07');
  });

  it('without our session id, the session on our tty, started after us, in our folder, is the one (after 20 s)', async () => {
    rig = await makeRig();
    const j = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = READY_SCREEN;
    const other = session({ sid: 'found-by-tty', cwd: j.folder, tty: '/dev/ttys014', account: 7, startedAt: rig.ctx.clock.iso() });
    rig.ctx.store.emit({ type: 'session.added', sid: other.sid, data: { session: other } });
    await advance(clock(), 16_000);
    expect(stage(j.id)).toBe('starting');
    await until(clock(), () => stage(j.id) === 'done', 20_000);
    expect(job(j.id).sid).toBe('found-by-tty');
    expect(job(j.id).steps.map((s) => s.detail)).toContain('Found the session by its window');
  });
});

describe('the first prompt', () => {
  it('a writer refusal ends ready-prompt-failed and is pushed (nobody else would say so)', async () => {
    rig = await makeRig();
    rig.writer.submitResult = () => ({ ok: false, code: 'refused', reason: 'a permission card is open for this session; answer it first' });
    const j = await toStarting({ prompt: 'go' });
    await toDone(j);
    expect(job(j.id)).toMatchObject({ stage: 'ready-prompt-failed', reason: "Started, but the first prompt wasn't sent: a permission card is open for this session; answer it first" });
    expect(rig.notifier.sent.at(-1)).toMatchObject({ title: 'alpha-app started', body: expect.stringMatching(/^First prompt not sent/) });
  });

  it("a send that never gets its proof ends ready-prompt-failed (the writer's own push says it)", async () => {
    rig = await makeRig();
    rig.writer.finalStage = 'failed';
    const j = await toStarting({ prompt: 'go' });
    await toDone(j);
    expect(job(j.id)).toMatchObject({ stage: 'ready-prompt-failed', reason: "Started, but the first prompt wasn't confirmed: no proof in the transcript" });
    expect(titles()).toEqual(['alpha-app started']);
  });

  it('stop() does not wait for the first prompt\'s proof; the job stays "prompting" for the next start to settle', async () => {
    rig = await makeRig();
    rig.writer.wait = () => new Promise<never>(() => undefined);
    const j = await toStarting({ prompt: 'go' });
    rig.terminal.fg = 'claude';
    rig.terminal.screen = READY_SCREEN;
    sessionUp(j);
    await until(clock(), () => rig.writer.submits.length === 1);
    let stopped = false;
    void rig.launcher.stop().then(() => {
      stopped = true;
    });
    await settle(() => stopped, 1_000);
    expect(rig.ctx.db.launches.get(j.id)).toMatchObject({ stage: 'prompting', prompt: { sendJobId: expect.any(String) } });
    expect(audits('session.launch')).toEqual([]);
    const next = new LauncherService(rig.ctx, {
      sessions: { start: async () => {}, stop: async () => {}, scan: async () => [], current: () => [], accountForConfigDir: () => null },
      terminal: rig.terminal,
      writer: rig.writer,
      usage: { start: async () => {}, stop: async () => {}, read: async () => null, latest: () => null, requestRefresh: () => ({ queued: false, nextAllowedAt: null }), isPolling: () => false },
      ccwLegacy: rig.ccw,
      files: filesWith(rig.policy),
      notifiers: [rig.notifier],
    });
    await next.start();
    expect(next.get(j.id)?.job.stage).toBe('done-no-prompt');
    await next.stop();
  });

  it('waits while ccw moves the new session, then sends', async () => {
    rig = await makeRig();
    rig.ccw.isPresent = true;
    const j = await toStarting({ prompt: 'go' });
    const move: Move = { sid: j.sid, from: 7, to: 4, step: 'saving', why: 'full', since: T0 };
    rig.ccw.movesFor.set(j.sid, move);
    rig.terminal.fg = 'claude';
    rig.terminal.screen = READY_SCREEN;
    sessionUp(j);
    await until(clock(), () => stage(j.id) === 'prompting');
    await advance(clock(), 30_000, 1_000);
    expect(rig.writer.submits).toEqual([]);
    expect(job(j.id).steps.at(-1)?.detail).toBe('Waiting · ccw is moving this session (saving)');
    rig.ccw.movesFor.delete(j.sid);
    await until(clock(), () => stage(j.id) === 'done', 20_000, 1_000);
    expect(rig.writer.submits).toHaveLength(1);
  });
});

describe('launching turned off at the Mac', () => {
  it('ends every run where it stands and types nothing more: no answer, no first prompt', async () => {
    rig = await makeRig();
    const t = rig.terminal;
    // One waiting on its trust card, one ready and waiting for ccw to finish a move before its prompt.
    const carded = await toStarting();
    t.fg = 'claude';
    t.screen = trustScreen(0);
    await until(clock(), () => stage(carded.id) === 'dialog');
    rig.ccw.isPresent = true;
    t.screen = READY_SCREEN;
    const prompted = await toStarting({ path: 'beta', prompt: 'go', account: 3 });
    rig.ccw.movesFor.set(prompted.sid, { sid: prompted.sid, from: 3, to: 4, step: 'saving', why: 'full', since: T0 });
    sessionUp(prompted);
    await until(clock(), () => stage(prompted.id) === 'prompting');

    await rig.ctx.settings.patch({ launch: { enabled: false } });
    await until(clock(), () => isFinal(stage(carded.id)) && isFinal(stage(prompted.id)));
    expect(job(carded.id)).toMatchObject({ stage: 'failed', reason: SWITCHED_OFF_REASON });
    expect(job(prompted.id)).toMatchObject({ stage: 'ready-prompt-failed', reason: "Starting from the phone was turned off: the first prompt wasn't sent" });
    rig.ccw.movesFor.delete(prompted.sid);
    t.screen = trustScreen(1);
    await advance(clock(), 60_000, 1_000);
    expect(t.keys).toEqual([]);
    expect(rig.writer.submits).toEqual([]);
    expect(stage(carded.id)).toBe('failed');
  });

  it('notes the folders sessions run in only while launching is on (no realpath for a switched-off feature)', async () => {
    rig = await makeRig({ settings: { launch: { enabled: false } }, folders: ['app'], start: false });
    rig.ctx.store.emit({ type: 'session.added', sid: 'early', data: { session: session({ sid: 'early', cwd: join(rig.work, 'app'), account: 3 }) } });
    await rig.launcher.start();
    rig.ctx.store.emit({ type: 'session.added', sid: 'later', data: { session: session({ sid: 'later', cwd: join(rig.work, 'alpha-app'), account: 4 }) } });
    await advance(clock(), 1_000);
    expect(rig.ctx.db.folders.recentSeen(5)).toEqual([]);
    // Turned on: the live sessions are noted then.
    await rig.ctx.settings.patch({ launch: { enabled: true } });
    await settle(() => rig.ctx.db.folders.recentSeen(5).length === 2);
    expect(rig.ctx.db.folders.recentSeen(5).map((f) => f.cwd).sort()).toEqual([join(rig.work, 'alpha-app'), join(rig.work, 'app')]);
  });
});

describe('before the window opens', () => {
  it('waits while ccw restarts a session, then goes on', async () => {
    rig = await makeRig();
    const move: Move = { sid: 'other', from: 3, to: 4, step: 'restarting', why: 'full', since: T0 };
    rig.ctx.store.emit({ type: 'move.restarting', sid: 'other', data: { move } });
    const j = await start();
    await advance(clock(), 30_000, 1_000);
    expect(stage(j.id)).toBe('queued');
    expect(job(j.id).steps.at(-1)?.detail).toBe('Waiting for ccw to finish restarting a session');
    rig.ctx.store.emit({ type: 'move.cleared', sid: 'other', data: {} });
    await until(clock(), () => stage(j.id) === 'starting', 10_000);
  });

  it('gives up after 2 minutes of a ccw restart', async () => {
    rig = await makeRig();
    rig.ctx.store.emit({ type: 'move.restarting', sid: 'other', data: { move: { sid: 'other', from: 3, to: 4, step: 'restarting', why: 'full', since: T0 } } });
    const j = await start();
    await until(clock(), () => stage(j.id) === 'refused', 3 * 60_000, 1_000);
    expect(rig.terminal.opened).toEqual([]);
  });

  it('L3: a folder swapped for a symlink to ~ after the preview is refused at start; nothing opens', async () => {
    rig = await makeRig();
    expect((await rig.launcher.preview({ root: 'r.work', path: 'alpha-app', account: 'auto' }, PHONE)).ok).toBe(true);
    await rm(join(rig.work, 'alpha-app'), { recursive: true });
    await symlink(rig.tmp, join(rig.work, 'alpha-app'));
    const r = await rig.launcher.launch(body(), PHONE, 'k');
    expect(r).toMatchObject({ ok: false, code: 'forbidden' });
    expect(rig.terminal.opened).toEqual([]);
    expect(rig.ctx.db.launches.list()).toEqual([]);
  });

  it('L3: a swap between the start and the window opening ends the job refused; nothing opens', async () => {
    rig = await makeRig();
    const j = await start();
    await rm(join(rig.work, 'alpha-app'), { recursive: true });
    await symlink(rig.tmp, join(rig.work, 'alpha-app'));
    await until(clock(), () => stage(j.id) === 'refused');
    expect(job(j.id).reason).toBe('that folder is outside its root');
    expect(rig.terminal.opened).toEqual([]);
    expect(titles()).toEqual(["alpha-app didn't start"]);
    expect(audits('session.launch')[0]).toMatchObject({ result: 'refused' });
  });

  it('L3: a folder swapped for another one inside the root is refused too (the command types the realpath)', async () => {
    rig = await makeRig({ folders: ['alpha-app', 'beta'] });
    const j = await start();
    await rm(join(rig.work, 'alpha-app'), { recursive: true });
    await symlink(join(rig.work, 'beta'), join(rig.work, 'alpha-app'));
    await until(clock(), () => stage(j.id) === 'refused');
    expect(job(j.id).reason).toBe('The folder changed after it was checked; pick it again');
    expect(rig.terminal.opened).toEqual([]);
  });
});

describe('what a start is refused for', () => {
  it('the switch, the scope, held and unusable accounts, names, prompts and flags', async () => {
    rig = await makeRig({ accounts: [account(1, 0), account(4, 30, { usageStatus: 'relogin_required' }), account(5, 30, { disabled: true }), account(7, 12)] });
    const refused = async (over: Partial<LaunchStartBody>, actor: Actor = PHONE) => {
      const r = await rig.launcher.launch(body(over), actor, `k-${Math.random()}`);
      if (r.ok) throw new Error('started');
      return { code: r.code, reason: r.reason };
    };
    expect(await refused({}, device('ctl-only', ['read', 'control']))).toMatchObject({ code: 'forbidden', reason: expect.stringMatching(/devices grant/) });
    expect(await refused({}, { kind: 'system' })).toMatchObject({ code: 'forbidden' });
    expect(await refused({ account: 1 })).toEqual({ code: 'conflict', reason: '01 is held for other work: confirm to start there anyway' });
    expect(await refused({ account: 4 })).toEqual({ code: 'refused', reason: '04 needs a re-login on the Mac (cswap)' });
    expect(await refused({ account: 5 })).toEqual({ code: 'refused', reason: "05 can't be used: disabled" });
    expect(await refused({ account: 42 })).toEqual({ code: 'invalid_request', reason: 'There is no account 42' });
    expect(await refused({ prompt: '!rm -rf /' })).toMatchObject({ code: 'invalid_request', reason: expect.stringMatching(/^The first prompt can't be sent/) });
    expect(await refused({ name: 'two words' })).toMatchObject({ code: 'invalid_request' });
    expect(await refused({ flags: { ...V03_LAUNCH_FLAGS, extra: '--settings x' } as never })).toMatchObject({ code: 'invalid_request' });
    expect(await refused({ path: '../..' })).toMatchObject({ code: 'invalid_request' });
    rig.ctx.store.emit({ type: 'session.added', sid: 'named', data: { session: session({ sid: 'named', name: 'busy-name' }) } });
    expect(await refused({ name: 'busy-name' })).toEqual({ code: 'conflict', reason: 'A session named busy-name is already running or starting' });
    expect(rig.terminal.opened).toEqual([]);

    // A held account starts with confirmHeld.
    const held = await start({ account: 1, confirmHeld: true });
    expect(held).toMatchObject({ account: 1, accountSource: 'manual', requested: 1 });

    await rig.ctx.settings.patch({ launch: { enabled: false } });
    expect(await refused({})).toEqual({ code: 'forbidden', reason: LAUNCH_OFF });
  });

  it('Auto with no room is refused with the sentence; a manual pick past the ceiling still works', async () => {
    rig = await makeRig({ accounts: [account(1, 0), account(7, 99)] });
    const r = await rig.launcher.launch(body(), PHONE, 'k1');
    expect(r).toEqual({ ok: false, code: 'refused', reason: 'No account has room until 13:40 (07 resets)' });
    expect((await rig.launcher.launch(body({ account: 7 }), PHONE, 'k2')).ok).toBe(true);
  });

  it('one launch per account at a time: Auto moves on; a manual pick of the busy account waits its turn', async () => {
    rig = await makeRig();
    const first = await start();
    expect(first.account).toBe(7);
    const second = await start();
    expect(second.account).toBe(4);
    expect(await rig.launcher.launch(body({ account: 7, path: 'beta' }), device('other-phone'), 'k')).toEqual({
      ok: false,
      code: 'conflict',
      reason: 'A session is already starting on 07; wait for it to be ready',
    });
  });

  it('the default name gets -2 while another launch or live session has it', async () => {
    rig = await makeRig();
    rig.ctx.store.emit({ type: 'session.added', sid: 'x', data: { session: session({ sid: 'x', name: 'alpha-app' }) } });
    expect((await start()).name).toBe('alpha-app-2');
    expect((await start({}, device('p2'))).name).toBe('alpha-app-3');
  });

  it('no window can be opened on this terminal backend', async () => {
    rig = await makeRig();
    rig.terminal.avail = false;
    expect(await rig.launcher.launch(body(), PHONE, 'k')).toEqual({ ok: false, code: 'unavailable', reason: "This Mac's terminal can't open new windows" });
  });
});

describe('L7: rate limits', () => {
  it('a 3rd start while 2 are in flight is refused', async () => {
    rig = await makeRig();
    await start();
    await start();
    const r = await rig.launcher.launch(body({ path: 'beta' }), PHONE, 'k3');
    expect(r).toMatchObject({ ok: false, code: 'rate_limited', reason: 'At most 2 starts at a time; wait for one to finish' });
    // Another device has its own budget.
    expect((await rig.launcher.launch(body({ path: 'beta' }), device('dev-b'), 'k4')).ok).toBe(true);
  });

  it('a 5th start in 10 minutes is refused, with when to try again; then it is allowed', async () => {
    rig = await makeRig();
    rig.terminal.openResult = { ok: false, code: 'failed', reason: 'no window' };
    for (let i = 0; i < 4; i++) {
      const j = await start({}, PHONE, `k${i}`);
      await until(clock(), () => stage(j.id) === 'failed');
      await advance(clock(), 60_000, 5_000);
    }
    const r = await rig.launcher.launch(body(), PHONE, 'k5');
    expect(r).toMatchObject({ ok: false, code: 'rate_limited', reason: 'At most 4 starts in 10 minutes; try again later' });
    expect(!r.ok && (r as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThan(0);
    await advance(clock(), 10 * 60_000, 30_000);
    expect((await rig.launcher.launch(body(), PHONE, 'k6')).ok).toBe(true);
  });

  it('and launch.rate.perDay a day', async () => {
    rig = await makeRig({ settings: { launch: { enabled: true, rate: { perTenMin: 100, perDay: 3 } } } });
    rig.terminal.openResult = { ok: false, code: 'failed', reason: 'no window' };
    for (let i = 0; i < 3; i++) {
      const j = await start({}, PHONE, `k${i}`);
      await until(clock(), () => stage(j.id) === 'failed');
    }
    expect(await rig.launcher.launch(body(), PHONE, 'k9')).toMatchObject({ ok: false, code: 'rate_limited', reason: 'At most 3 starts a day; try again later' });
  });
});

describe('L9: every start, dialog and failure reaches all devices', () => {
  it('through web push, even devices that chose other kinds; one audit row per launch, no prompt text', async () => {
    const sent: { endpoint: string; payload: string }[] = [];
    rig = await makeRig({
      notifiers: (ctx) => [
        new WebPushNotifier(ctx, {
          vapid: { publicKey: 'BTestPublicKey', privateKey: 'test-private-key', subject: 'mailto:test@example.com', createdAt: T0 },
          sender: async (sub, payload) => void sent.push({ endpoint: sub.endpoint, payload }),
        }),
      ],
    });
    for (const [id, endpoint] of [
      ['dev-a', 'https://web.push.apple.com/a'],
      ['dev-b', 'https://fcm.googleapis.com/fcm/send/b'],
    ] as const) {
      rig.ctx.db.devices.insert({ id, name: id, keyHash: `h-${id}`, scopes: ['read', 'control'], createdAt: T0, lastSeenAt: T0 });
      rig.ctx.db.pushSubs.upsert({ subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, deviceId: id, createdAt: T0, kinds: ['permission'] });
    }
    const j = await toStarting({ prompt: SECRET });
    rig.terminal.fg = 'claude';
    rig.terminal.screen = trustScreen(0);
    await until(clock(), () => stage(j.id) === 'dialog');
    rig.terminal.screen = LOGIN_SCREEN;
    await until(clock(), () => stage(j.id) === 'failed');
    await flush();
    const byKind = (title: string) => sent.filter((p) => (JSON.parse(p.payload) as { title: string }).title === title).map((p) => p.endpoint).sort();
    const both = ['https://fcm.googleapis.com/fcm/send/b', 'https://web.push.apple.com/a'];
    expect(byKind('alpha-app started')).toEqual(both);
    expect(byKind('alpha-app needs you')).toEqual(both);
    expect(byKind("alpha-app didn't start")).toEqual(both);
    expect(audits('session.launch')).toHaveLength(1);
    expect(JSON.stringify(rig.ctx.db.audit.list({ limit: 1000 }))).not.toContain('SECRET-PROMPT');
    expect(JSON.stringify(sent)).not.toContain('SECRET-PROMPT');
  });

  it('bodies "generic" sends no folder, name or account', async () => {
    rig = await makeRig({ settings: { launch: { enabled: true }, notify: { bodies: 'generic' } } });
    await toStarting();
    expect(rig.notifier.sent[0]).toMatchObject({ title: 'A session was started from a phone', body: '' });
  });
});

describe('idempotency', () => {
  it('a retried start with the same key gets the same job and one window, also after a restart', async () => {
    rig = await makeRig();
    const a = await rig.launcher.launch(body({ prompt: 'go' }), PHONE, 'same-key');
    const b = await rig.launcher.launch(body({ prompt: 'go' }), PHONE, 'same-key');
    expect(a.ok && b.ok && b.job.id === a.job.id && b.duplicate).toBe(true);
    expect(await rig.launcher.launch(body({ prompt: 'different' }), PHONE, 'same-key')).toMatchObject({ ok: false, code: 'conflict' });
    await until(clock(), () => a.ok && stage(a.job.id) === 'starting');
    expect(rig.terminal.opened).toHaveLength(1);
    // Another actor's key is its own.
    expect((await rig.launcher.launch(body({ path: 'beta' }), device('dev-b'), 'same-key')).ok).toBe(true);

    const again = new LauncherService(rig.ctx, {
      sessions: { start: async () => {}, stop: async () => {}, scan: async () => [], current: () => [], accountForConfigDir: () => null },
      terminal: rig.terminal,
      writer: rig.writer,
      usage: { start: async () => {}, stop: async () => {}, read: async () => null, latest: () => null, requestRefresh: () => ({ queued: false, nextAllowedAt: null }), isPolling: () => false },
      ccwLegacy: rig.ccw,
      files: filesWith(rig.policy),
      notifiers: [rig.notifier],
    });
    const c = await again.launch(body({ prompt: 'go' }), PHONE, 'same-key');
    expect(c.ok && a.ok && c.job.id === a.job.id && c.duplicate).toBe(true);
    await again.stop();
  });
});

describe('restart recovery', () => {
  function stored(over: Partial<LaunchJob>): LaunchJob {
    return {
      id: `l-${Math.random().toString(36).slice(2)}`,
      createdAt: T0,
      updatedAt: T0,
      actor: 'device:dev-launch',
      rootId: 'r.work',
      folder: join(rig.work, 'alpha-app'),
      display: '~/work/alpha-app',
      account: 7,
      accountSource: 'auto',
      requested: 'auto',
      flags: { ...V03_LAUNCH_FLAGS },
      dangerous: true,
      name: 'alpha-app',
      sid: '11111111-2222-4333-8444-555555555555',
      stage: 'starting',
      tty: '/dev/ttys014',
      windowId: '9001',
      steps: [
        { at: T0, stage: 'queued', detail: 'Queued' },
        { at: T0, stage: 'opening', detail: 'Opened a window · ttys014' },
      ],
      ...over,
    };
  }

  it('a job before ready whose session runs resumes at ready-checking with no prompt', async () => {
    rig = await makeRig({ start: false });
    const j = stored({ stage: 'dialog', prompt: { hash: 'h', length: 2 } });
    rig.ctx.db.launches.save(j);
    sessionUp(j);
    rig.terminal.fg = 'claude';
    rig.terminal.screen = READY_SCREEN;
    await rig.launcher.start();
    await until(clock(), () => stage(j.id) === 'done-no-prompt');
    expect(job(j.id).steps.map((s) => s.detail)).toContain('Picked up after a daemon restart');
    expect(rig.writer.submits).toEqual([]);
  });

  it('a launch waiting on the trust card whose session file has not appeared yet recovers: the card again, answered, ready', async () => {
    rig = await makeRig({ start: false });
    const since = '2026-01-15T09:59:00.000Z';
    const j = stored({ stage: 'dialog', prompt: { hash: 'h', length: 2 }, dialog: { title: 'Accessing workspace:', options: ['No, exit', 'Yes, I trust this folder'], current: 0, since } });
    rig.ctx.db.launches.save(j);
    const t = rig.terminal;
    t.fg = 'claude';
    t.screen = trustScreen(0);
    await rig.launcher.start();
    await flush();
    // Not failed: watched again from the window, and the card is back (pushed again: the phone was told before the restart).
    expect(stage(j.id)).toBe('starting');
    await until(clock(), () => stage(j.id) === 'dialog');
    expect(job(j.id).dialog).toMatchObject({ title: 'Accessing workspace:', current: 0 });
    expect(job(j.id).steps.map((s) => s.detail)).toContain('Picked up after a daemon restart');
    expect(rig.notifier.sent.map((n) => n.title)).toEqual(['alpha-app needs you']);
    expect(t.keys).toEqual([]);

    t.onKey = () => {
      t.screen = STARTING_SCREEN;
    };
    const answering = rig.launcher.answer(j.id, { option: 1, title: 'Accessing workspace:' }, PHONE);
    await advance(clock(), 1_500);
    expect(await answering).toMatchObject({ ok: true, job: { stage: 'starting' } });
    expect(t.keys).toEqual([{ key: 'down', repeat: 1 }]);
    // Past the dialog Claude writes its session file; the prompt lived in memory only, so nothing is typed.
    sessionUp(j);
    t.screen = READY_SCREEN;
    await until(clock(), () => isFinal(stage(j.id)));
    expect(job(j.id)).toMatchObject({ stage: 'done-no-prompt', reason: 'The daemon restarted before the first prompt was sent. Send it again.' });
    expect(rig.writer.submits).toEqual([]);
  });

  it('a recovered card whose window was closed, or whose Claude exited, fails for that reason', async () => {
    rig = await makeRig({ start: false });
    const closed = stored({ stage: 'dialog' });
    rig.ctx.db.launches.save(closed);
    rig.terminal.findError = { code: 'not_found', reason: 'no tab on that tty' };
    await rig.launcher.start();
    await until(clock(), () => isFinal(stage(closed.id)));
    expect(job(closed.id)).toMatchObject({ stage: 'failed', reason: 'The window was closed' });
    await rig.close();

    rig = await makeRig({ start: false });
    const exited = stored({ stage: 'dialog' });
    rig.ctx.db.launches.save(exited);
    rig.terminal.fg = 'shell';
    rig.terminal.screen = SHELL_PROMPT;
    await rig.launcher.start();
    await until(clock(), () => isFinal(stage(exited.id)));
    expect(job(exited.id)).toMatchObject({ stage: 'failed', reason: 'Claude exited before it was ready' });
  });

  it('a job whose session is not running ends failed; one that was sending its prompt ends done-no-prompt', async () => {
    rig = await makeRig({ start: false });
    const lost = stored({ stage: 'opening', tty: undefined, sid: 'aaaaaaaa-2222-4333-8444-555555555555' });
    const sending = stored({ stage: 'prompting', prompt: { hash: 'h', length: 2, sendJobId: 'w1' } });
    const done = stored({ stage: 'done' });
    for (const x of [lost, sending, done]) rig.ctx.db.launches.save(x);
    sessionUp(sending);
    await rig.launcher.start();
    expect(job(lost.id)).toMatchObject({ stage: 'failed', reason: RESTART_REASON });
    expect(job(sending.id).stage).toBe('done-no-prompt');
    expect(job(done.id).stage).toBe('done');
    expect(audits('session.launch')).toHaveLength(2);
  });

  it('a job left before ready whose waits ran out, or with launching off, is not watched again', async () => {
    rig = await makeRig({ start: false });
    // Five days old, at a dialog card: a stored tty that old belongs to some other tab now.
    const old = '2026-01-10T10:00:00.000Z';
    const stale = stored({ createdAt: old, updatedAt: old, steps: [{ at: old, stage: 'queued', detail: 'Queued' }] });
    // Just past the longest wait (dialogMin 30 min, plus a minute).
    const late = stored({ stage: 'dialog', updatedAt: '2026-01-15T09:28:59.000Z', sid: 'bbbbbbbb-2222-4333-8444-555555555555' });
    const fresh = stored({ updatedAt: '2026-01-15T09:59:00.000Z', sid: 'cccccccc-2222-4333-8444-555555555555' });
    for (const x of [stale, late, fresh]) rig.ctx.db.launches.save(x);
    rig.terminal.fg = 'claude';
    rig.terminal.screen = KEEP_MODEL_SCREEN;
    await rig.launcher.start();
    await flush();
    expect(job(stale.id)).toMatchObject({ stage: 'failed', reason: RESTART_REASON });
    expect(job(late.id)).toMatchObject({ stage: 'failed', reason: RESTART_REASON });
    expect(stage(fresh.id)).toBe('starting');
    await rig.close();

    rig = await makeRig({ start: false, settings: { launch: { enabled: false } } });
    const off = stored({});
    rig.ctx.db.launches.save(off);
    rig.terminal.screen = KEEP_MODEL_SCREEN;
    await rig.launcher.start();
    await advance(clock(), 10_000);
    expect(job(off.id)).toMatchObject({ stage: 'failed', reason: RESTART_REASON });
    expect(rig.terminal.keys).toEqual([]);
  });

  it('a resumed launch with no session watches its tty only while the tab is the window it opened', async () => {
    // The tty is now a tab opened after the launch's window (its oldest process is younger).
    rig = await makeRig({ start: false });
    const reused = stored({});
    rig.ctx.db.launches.save(reused);
    rig.terminal.ttyStarts = ['Thu Jan 15 10:05:00 2026', 'Thu Jan 15 10:05:01 2026'];
    rig.terminal.screen = KEEP_MODEL_SCREEN;
    await rig.launcher.start();
    await advance(clock(), 10_000);
    expect(job(reused.id)).toMatchObject({ stage: 'failed', reason: WINDOW_CLOSED });
    expect(rig.terminal.keys).toEqual([]);
    expect(rig.terminal.calls.filter((c) => c.startsWith('findPane'))).toEqual([]);
    await rig.close();

    // Same age, but the tab is in another window than the one the launch opened.
    rig = await makeRig({ start: false });
    const moved = stored({});
    rig.ctx.db.launches.save(moved);
    rig.terminal.windowId = '9002';
    rig.terminal.screen = KEEP_MODEL_SCREEN;
    await rig.launcher.start();
    await until(clock(), () => isFinal(stage(moved.id)));
    expect(job(moved.id)).toMatchObject({ stage: 'failed', reason: WINDOW_CLOSED });
    expect(rig.terminal.keys).toEqual([]);
    await rig.close();

    // No process on the tty, or no window id recorded: nothing to check against.
    for (const over of [{ ttyStarts: null }, { windowId: '' }] as const) {
      rig = await makeRig({ start: false });
      const j = stored('windowId' in over ? { windowId: '' } : {});
      rig.ctx.db.launches.save(j);
      if ('ttyStarts' in over) rig.terminal.ttyStarts = null;
      rig.terminal.screen = KEEP_MODEL_SCREEN;
      await rig.launcher.start();
      await advance(clock(), 10_000);
      expect(job(j.id)).toMatchObject({ stage: 'failed', reason: WINDOW_CLOSED });
      expect(rig.terminal.keys).toEqual([]);
      await rig.close();
    }

    // With its session running, the session's own tty is watched (its --session-id is ours).
    rig = await makeRig({ start: false });
    const known = stored({ windowId: '' });
    rig.ctx.db.launches.save(known);
    sessionUp(known);
    rig.terminal.screen = READY_SCREEN;
    await rig.launcher.start();
    await until(clock(), () => isFinal(stage(known.id)));
    expect(stage(known.id)).toBe('done');
  });

  it('stop() leaves a running job unfinished for the next start to pick up', async () => {
    rig = await makeRig();
    const j = await toStarting();
    await rig.launcher.stop();
    expect(rig.ctx.db.launches.get(j.id)?.stage).toBe('starting');
    // Its window is still starting Claude (no session file yet): the next start watches it on.
    const next = new LauncherService(rig.ctx, {
      sessions: { start: async () => {}, stop: async () => {}, scan: async () => [], current: () => [], accountForConfigDir: () => null },
      terminal: rig.terminal,
      writer: rig.writer,
      usage: { start: async () => {}, stop: async () => {}, read: async () => null, latest: () => null, requestRefresh: () => ({ queued: false, nextAllowedAt: null }), isPolling: () => false },
      ccwLegacy: rig.ccw,
      files: filesWith(rig.policy),
      notifiers: [rig.notifier],
    });
    await next.start();
    await flush();
    expect(next.get(j.id)?.job.steps.at(-1)).toMatchObject({ stage: 'starting', detail: 'Picked up after a daemon restart' });
    rig.terminal.screen = READY_SCREEN;
    sessionUp(j);
    await until(clock(), () => isFinal(next.get(j.id)?.job.stage ?? 'queued'));
    expect(next.get(j.id)?.job.stage).toBe('done');
    await next.stop();
  });
});

describe('reads', () => {
  it('list: newest first, ?active only the unfinished ones; get: the screen tail only for dialogs and failures', async () => {
    rig = await makeRig();
    rig.terminal.openResult = { ok: false, code: 'failed', reason: 'no window' };
    const failed = await start();
    await until(clock(), () => stage(failed.id) === 'failed');
    rig.terminal.openResult = null;
    const running = await start({ path: 'beta' }, device('p2'));
    await until(clock(), () => stage(running.id) === 'starting');
    expect(rig.launcher.list({ active: false }).map((j) => j.id)).toEqual([running.id, failed.id]);
    expect(rig.launcher.list({ active: true }).map((j) => j.id)).toEqual([running.id]);
    expect(rig.launcher.get(running.id)?.screenTail).toBeUndefined();
    expect(rig.launcher.get('nope')).toBeNull();
  });

  it('the folder made by mkdir right before can be launched in', async () => {
    rig = await makeRig({ folders: [] });
    await mkdir(join(rig.work, 'fresh'));
    expect((await start({ path: 'fresh' })).folder).toBe(join(rig.work, 'fresh'));
  });
});

describe('preview and account choice with ccw running', () => {
  const preview = async (q: { account?: number | 'auto'; path?: string } = {}) => {
    const r = await rig.launcher.preview({ root: 'r.work', path: q.path ?? 'alpha-app', account: q.account ?? 'auto' }, PHONE);
    if (!r.ok) throw new Error(r.reason);
    return r.preview;
  };

  it("ccw's hold list and ceilings are the ones in force while it runs", async () => {
    rig = await makeRig({ settings: { launch: { enabled: true }, autoswitch: { hold: [] } } });
    // Nothing held in settings, and no ccw: 5 (1 %) has the most room, but the kept accounts (1, 2, 5) are always held.
    expect((await preview()).account.pick).toBe(7);
    expect((await preview()).accounts.filter((a) => a.held).map((a) => a.id)).toEqual(KEPT);
    // A manual pick of one still needs confirmHeld.
    expect(await rig.launcher.launch(body({ account: 5 }), PHONE, 'k-kept')).toEqual({ ok: false, code: 'conflict', reason: '05 is held for other work: confirm to start there anyway' });
    rig.ccw.isPresent = true;
    rig.ccw.hold = [7];
    expect((await preview()).account.pick).toBe(4);
    rig.ccw.ceiling = 10;
    expect((await preview()).account).toEqual({ pick: null, source: 'auto', reason: 'No account has room until 13:40 (03 resets)' });
  });

  it("U3: Auto takes the most room even when the folder's ccw group is on another account; the group is a warning", async () => {
    rig = await makeRig();
    rig.ccw.isPresent = true;
    rig.ccw.hold = [...KEPT];
    rig.ccw.groups = [['alpha-app', 'web']];
    // The group lives on 04 (5h 40 %); 07 (12 %) has more room.
    rig.ctx.store.emit({ type: 'session.added', sid: 'web', data: { session: session({ sid: 'web', folder: 'web', cwd: '/synthetic/web', account: 4 }) } });
    const auto = await preview();
    expect(auto.account).toEqual({ pick: 7, source: 'auto', reason: 'most room · 5h 12% · resets in 3h40 · 13:40' });
    expect(auto.warnings).toEqual([{ kind: 'group', text: 'Group alpha-app+web is on 04. Starting on 07 splits it; ccw may move it.', account: 4 }]);
    // The warning's "Use 04" quick choice is a manual pick of the group's account.
    const join = await preview({ account: 4 });
    expect(join.account).toEqual({ pick: 4, source: 'group', reason: 'joins group alpha-app+web on 04 · 5h 40% · resets in 3h40 · 13:40' });
    expect(join.warnings).toEqual([]);
    const elsewhere = await preview({ account: 3 });
    expect(elsewhere.account).toMatchObject({ pick: 3, source: 'manual', reason: 'you picked 03 · 5h 60% · resets in 3h40 · 13:40' });
    expect(elsewhere.warnings).toEqual([{ kind: 'group', text: 'Group alpha-app+web is on 04. Starting on 03 splits it; ccw may move it.', account: 4 }]);
    // Starts record where they went and why.
    expect(await start()).toMatchObject({ account: 7, accountSource: 'auto', requested: 'auto' });
    expect(await start({ account: 4 }, device('p2'))).toMatchObject({ account: 4, accountSource: 'group', requested: 4 });
  });

  it('a group on the account with the most room: Auto joins it, with no warning', async () => {
    rig = await makeRig();
    rig.ccw.isPresent = true;
    rig.ccw.hold = [...KEPT];
    rig.ccw.groups = [['alpha-app', 'web']];
    rig.ctx.store.emit({ type: 'session.added', sid: 'web', data: { session: session({ sid: 'web', folder: 'web', cwd: '/synthetic/web', account: 7 }) } });
    const auto = await preview();
    expect(auto.account).toMatchObject({ pick: 7, source: 'auto' });
    expect(auto.warnings).toEqual([]);
  });

  it('a manual pick that cannot be used still previews, with the reason; an unknown one is refused', async () => {
    rig = await makeRig({ accounts: [account(4, 30, { usageStatus: 'token_expired' }), account(7, 12)] });
    expect((await preview({ account: 4 })).account).toEqual({ pick: 4, source: 'manual', reason: '04 · token expired' });
    expect(await rig.launcher.preview({ root: 'r.work', path: 'alpha-app', account: 9 }, PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: 'There is no account 09' });
  });

  it('cswap-run with no cswap on this Mac is a setup problem, not the folder', async () => {
    rig = await makeRig({ settings: { launch: { enabled: true, mode: 'cswap-run' } } });
    Object.assign(rig.ctx.bins, { cswap: null });
    const want = {
      ok: false,
      code: 'unavailable',
      reason: "This Mac isn't set up to start sessions from the phone: cswap was not found (install it, or on the Mac run: jantar launch mode cs-shell)",
    };
    expect(await rig.launcher.preview({ root: 'r.work', path: 'alpha-app', account: 'auto' }, PHONE)).toEqual(want);
    expect(await rig.launcher.launch(body(), PHONE, 'k')).toEqual(want);
    expect(rig.terminal.opened).toEqual([]);
  });

  it('reads the launches table once per preview, and once more after the waits of a start', async () => {
    rig = await makeRig();
    const list = vi.spyOn(rig.ctx.db.launches, 'list');
    await preview();
    expect(list).toHaveBeenCalledTimes(1);
    list.mockClear();
    await start();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('the suggested name skips names in use; the command shows the pick', async () => {
    rig = await makeRig();
    rig.ctx.store.emit({ type: 'session.added', sid: 'x', data: { session: session({ sid: 'x', name: 'alpha-app' }) } });
    const p = await preview();
    expect(p.name).toBe('alpha-app-2');
    expect(p.command).toMatch(/ && cs 7 -- .* --session-id <session id> --name alpha-app-2$/);
  });
});

// ---------------------------------------------------------------------------
// v0.4

type HistoryRig = Rig & { home: FakeHome; folder: string };

/**
 * The rig with its launcher reading a synthetic home's projects dirs (the
 * shared one and each cswap profile's), profiles mapped to accounts by their
 * "<n>-" prefix as cswap names them, in the accounts mode asked for.
 */
async function historyRig(opts: RigOptions & { mode?: AccountsMode } = {}): Promise<HistoryRig> {
  const base = await makeRig({ ...opts, start: false });
  const home = await makeFakeHome({ sessions: [] });
  Object.assign(base.ctx.paths, { claudeProjects: home.paths.claudeProjects, cswapProfiles: home.paths.cswapProfiles });
  if (opts.mode) Object.assign(base.ctx, { accountsMode: () => opts.mode });
  const launcher = new LauncherService(
    base.ctx,
    {
      sessions: { start: async () => {}, stop: async () => {}, scan: async () => [], current: () => [], accountForConfigDir: (dir) => accountForProfileDir(basename(dir), null) },
      terminal: base.terminal,
      writer: base.writer,
      usage: { start: async () => {}, stop: async () => {}, read: async () => null, latest: () => null, requestRefresh: () => ({ queued: false, nextAllowedAt: null }), isPolling: () => false },
      ccwLegacy: base.ccw,
      files: filesWith(base.policy),
      notifiers: [base.notifier],
    },
    opts.launcher,
  );
  await launcher.start();
  return {
    ...base,
    launcher,
    home,
    folder: join(base.work, 'alpha-app'),
    async close() {
      await launcher.stop();
      await base.close();
      await home.cleanup();
    },
  };
}

const [NEWEST, ON_TWO] = PAST_SESSIONS.map((p) => p.id) as [string, string];
const ON_THREE = '0b4e7c4e-4444-4444-8444-000000000004';
const ON_FOUR = '0b4e7c4e-5555-4555-8555-000000000005';

async function past(h: HistoryRig, extra: { id: string; account?: number }[] = []): Promise<void> {
  await writePastSessions(h.home, h.folder, PAST_SESSIONS);
  await writePastSessions(
    h.home,
    h.folder,
    extra.map((e) => ({ id: e.id, first: 'an older task', at: '2026-01-10T10:00:00.000Z', ...(e.account !== undefined ? { account: e.account } : {}) })),
  );
}

const previewOf = async (q: { resume?: string; account?: number | 'auto' } = {}) => {
  const r = await rig.launcher.preview({ root: 'r.work', path: 'alpha-app', account: q.account ?? 'auto', ...(q.resume ? { resume: q.resume } : {}) }, PHONE);
  if (!r.ok) throw new Error(r.reason);
  return r.preview;
};

describe('v0.4: Resume', () => {
  it('a shared-dir conversation: --resume <id> and no --session-id, Auto as usual, ready under that id', async () => {
    const h = await historyRig();
    rig = h;
    await past(h);
    const p = await previewOf({ resume: NEWEST });
    expect(p.command).toBe(`cd -- ${q(h.folder)} && cs 7 -- --dangerously-skip-permissions --chrome --effort ultracode --resume ${NEWEST} --name alpha-app`);
    expect(p.account).toEqual({ pick: 7, source: 'auto', reason: 'most room · 5h 12% · resets in 3h40 · 13:40' });
    expect(p.accounts.every((a) => a.why === undefined)).toBe(true);

    const j = await start({ resume: NEWEST });
    expect(j).toMatchObject({ resumed: true, sid: NEWEST, account: 7, accountSource: 'auto', requested: 'auto' });
    await until(clock(), () => stage(j.id) === 'starting');
    expect(rig.terminal.opened).toEqual([p.command]);
    expect(rig.terminal.opened[0]).not.toContain('--session-id');
    expect(job(j.id).steps.map((s) => s.detail)).toEqual(expect.arrayContaining(['Queued · 07 · auto', 'Resuming a conversation · cs 7']));
    await toDone(j);
    expect(job(j.id)).toMatchObject({ stage: 'done', sid: NEWEST, resumed: true });
    expect(audits('session.launch')[0]).toMatchObject({ result: 'ok', params: { sid: NEWEST, stage: 'done', resumed: true } });
    // The conversation's first line never leaves the history route.
    const replay = rig.ctx.store.replay(0);
    for (const blob of [JSON.stringify(replay), JSON.stringify(rig.ctx.db.audit.list({ limit: 1000 })), JSON.stringify(rig.ctx.db.launches.list()), JSON.stringify(rig.notifier.sent), JSON.stringify(rig.ctx.log)]) {
      expect(blob).not.toContain('push example');
    }
  });

  it("a conversation in a profile's own dir pins its account: the preview marks the rest, the start goes there whatever was asked", async () => {
    const h = await historyRig();
    rig = h;
    await past(h, [{ id: ON_THREE, account: 3 }]);
    for (const account of ['auto', 7] as const) {
      const p = await previewOf({ resume: ON_THREE, account });
      expect(p.account).toEqual({ pick: 3, source: 'resume', reason: 'This conversation is on 03' });
      expect(p.accounts.filter((a) => a.selectable).map((a) => a.id)).toEqual([3]);
      expect(new Set(p.accounts.filter((a) => a.id !== 3).map((a) => a.why))).toEqual(new Set(['This conversation is on 03']));
      expect(p.command).toContain(`&& cs 3 -- --dangerously-skip-permissions --chrome --effort ultracode --resume ${ON_THREE} --name alpha-app`);
    }
    const j = await start({ resume: ON_THREE, account: 7 });
    expect(j).toMatchObject({ account: 3, accountSource: 'resume', requested: 7, sid: ON_THREE, resumed: true });
    expect(j.steps[0]?.detail).toBe('Queued · 03 · resume');
    await until(clock(), () => rig.terminal.opened.length === 1);
    expect(rig.terminal.opened[0]).toContain(`&& cs 3 -- `);
  });

  it('a pinned account that is held needs confirmHeld, like a manual pick; one that cannot be used, or is gone, is refused', async () => {
    const h = await historyRig({ accounts: [account(1, 5), account(2, 3), account(3, 30, { usageStatus: 'relogin_required' }), account(7, 12)] });
    rig = h;
    await past(h, [{ id: ON_THREE, account: 3 }, { id: ON_FOUR, account: 4 }]);
    // ON_TWO lives in account 2's own dir, and 2 is one of the rig's kept accounts.
    const held = await previewOf({ resume: ON_TWO });
    expect(held.account).toEqual({ pick: 2, source: 'resume', reason: 'This conversation is on 02' });
    expect(held.warnings).toEqual([{ kind: 'held', text: 'Held for other work. ccw will never move this session, even when 02 fills up.', account: 2 }]);
    expect(await rig.launcher.launch(body({ resume: ON_TWO }), PHONE, 'k1')).toEqual({ ok: false, code: 'conflict', reason: '02 is held for other work: confirm to start there anyway' });
    expect(await start({ resume: ON_TWO, confirmHeld: true })).toMatchObject({ account: 2, accountSource: 'resume' });
    expect((await previewOf({ resume: ON_THREE })).account).toEqual({ pick: 3, source: 'resume', reason: 'This conversation is on 03 · needs a re-login' });
    expect(await rig.launcher.launch(body({ resume: ON_THREE }), device('p2'), 'k2')).toEqual({ ok: false, code: 'refused', reason: '03 needs a re-login on the Mac (cswap)' });
    const gone = { ok: false, code: 'refused', reason: 'This conversation is on 04, which cswap no longer lists' };
    expect(await rig.launcher.preview({ root: 'r.work', path: 'alpha-app', account: 'auto', resume: ON_FOUR }, PHONE)).toEqual(gone);
    expect(await rig.launcher.launch(body({ resume: ON_FOUR }), device('p3'), 'k3')).toEqual(gone);
  });

  it("LL1 (launcher side): an id not in this folder's history is 404, a running one 409, one already starting 409; nothing more opens", async () => {
    const h = await historyRig();
    rig = h;
    await past(h);
    await writePastSessions(h.home, join(h.work, 'beta'), [{ id: ON_THREE, first: 'another folder', at: '2026-01-15T09:00:00.000Z' }]);
    const notHere = { ok: false, code: 'not_found', reason: NOT_IN_HISTORY };
    for (const id of ['0b4e7c4e-9999-4999-8999-000000000009', ON_THREE]) {
      expect(await rig.launcher.preview({ root: 'r.work', path: 'alpha-app', account: 'auto', resume: id }, PHONE)).toEqual(notHere);
      expect(await rig.launcher.launch(body({ resume: id }), PHONE, `k-${id}`)).toEqual(notHere);
    }
    rig.ctx.store.emit({ type: 'session.added', sid: NEWEST, data: { session: session({ sid: NEWEST, cwd: h.folder }) } });
    const running = { ok: false, code: 'conflict', reason: RESUME_RUNNING };
    expect(await rig.launcher.preview({ root: 'r.work', path: 'alpha-app', account: 'auto', resume: NEWEST }, PHONE)).toEqual(running);
    expect(await rig.launcher.launch(body({ resume: NEWEST }), PHONE, 'k-live')).toEqual(running);
    rig.ctx.store.emit({ type: 'session.removed', sid: NEWEST, data: { reason: 'exited' } });
    const first = await start({ resume: NEWEST });
    expect(await rig.launcher.launch(body({ resume: NEWEST, name: 'other' }), device('p2'), 'k-twice')).toEqual({ ok: false, code: 'conflict', reason: RESUME_STARTING });
    await until(clock(), () => rig.terminal.opened.length === 1);
    expect(rig.terminal.opened).toHaveLength(1);
    expect(stage(first.id)).toBe('starting');
  });

  it('an entry picked from the list still starts after newer conversations push it past the newest 20', async () => {
    const h = await historyRig();
    rig = h;
    await past(h);
    const listed = () => pastSessions({ ctx: rig.ctx, sessions: { accountForConfigDir: (dir) => accountForProfileDir(basename(dir), null) } }, h.folder);
    expect((await listed())[0]?.id).toBe(NEWEST);
    // A session opened there since (or a /clear in one) writes newer transcripts.
    await writePastSessions(
      h.home,
      h.folder,
      Array.from({ length: LAUNCH_HISTORY_LIMIT }, (_, i) => ({
        id: `0b4e7c4e-0000-4000-8000-${String(i).padStart(12, '0')}`,
        first: `newer task ${i}`,
        at: new Date(Date.parse('2026-01-20T00:00:00.000Z') + i * 60_000).toISOString(),
      })),
    );
    expect((await listed()).map((p) => p.id)).not.toContain(NEWEST);
    expect((await previewOf({ resume: ON_TWO })).account).toMatchObject({ pick: 2, source: 'resume' });
    const j = await start({ resume: NEWEST });
    expect(j).toMatchObject({ resumed: true, sid: NEWEST });
    await until(clock(), () => rig.terminal.opened.length === 1);
    expect(rig.terminal.opened[0]).toContain(`--resume ${NEWEST} --name alpha-app`);
  });

  it("the conversation's earlier, ended run in the store is not the match; its new run is", async () => {
    const h = await historyRig();
    rig = h;
    await past(h);
    const before = new Date(Date.parse(T0) - 3_600_000).toISOString();
    rig.ctx.store.emit({ type: 'session.added', sid: NEWEST, data: { session: session({ sid: NEWEST, cwd: h.folder, status: 'ended', startedAt: before }) } });
    const j = await start({ resume: NEWEST });
    await until(clock(), () => stage(j.id) === 'starting');
    rig.terminal.fg = 'claude';
    rig.terminal.screen = READY_SCREEN;
    await advance(clock(), 10_000);
    expect(stage(j.id)).toBe('starting');
    sessionUp(j);
    await until(clock(), () => stage(j.id) === 'done', 10_000);
    expect(job(j.id).sid).toBe(NEWEST);
  });

  it('a resumed session that comes up under a new id is found by its window, and the job takes that id', async () => {
    const h = await historyRig();
    rig = h;
    await past(h);
    const j = await start({ resume: NEWEST });
    await until(clock(), () => stage(j.id) === 'starting');
    rig.terminal.fg = 'claude';
    rig.terminal.screen = READY_SCREEN;
    const other = session({ sid: 'resumed-new-id', cwd: j.folder, tty: '/dev/ttys014', account: 7, startedAt: rig.ctx.clock.iso() });
    rig.ctx.store.emit({ type: 'session.added', sid: other.sid, data: { session: other } });
    await until(clock(), () => stage(j.id) === 'done', 40_000);
    expect(job(j.id)).toMatchObject({ sid: 'resumed-new-id', resumed: true });
    expect(job(j.id).steps.map((s) => s.detail)).toContain('Found the session by its window');
  });
});

describe('v0.4: single-account mode and claude mode (LL6)', () => {
  const SINGLE = { mode: 'single' as const, settings: { launch: { mode: 'claude' } } };

  it('Auto is account 0 with no hold, usage, group or busy logic; the command is claude itself', async () => {
    // No roster at all, and a kept 0: single mode reads neither.
    rig = await historyRig({ ...SINGLE, accounts: [], settings: { ...SINGLE.settings, accounts: { kept: [0] }, groups: [['alpha-app', 'web']] } });
    rig.ctx.store.emit({ type: 'session.added', sid: 'web', data: { session: session({ sid: 'web', folder: 'web', cwd: '/synthetic/web', account: 0 }) } });
    clock().advance(30 * 60_000);
    const p = await rig.launcher.preview({ root: 'r.work', path: 'alpha-app', account: 'auto', effort: 'high' }, PHONE);
    if (!p.ok) throw new Error(p.reason);
    expect(p.preview.account).toEqual({ pick: 0, source: 'auto', reason: 'one Claude login' });
    expect(p.preview.accounts).toEqual([{ id: 0, label: 'Claude', live: 1, selectable: true, held: false }]);
    // No stale-usage, effort (account moves) or group warning.
    expect(p.preview.warnings).toEqual([]);
    expect(p.preview.command).toBe(`cd -- ${q(join(rig.work, 'alpha-app'))} && /fake/bin/claude --dangerously-skip-permissions --chrome --effort high --session-id <session id> --name alpha-app`);

    const a = await start();
    // One launch per account does not apply: the second start goes at once.
    const b = await start({}, device('p2'));
    expect([a, b].map((j) => [j.account, j.accountSource, j.name])).toEqual([
      [0, 'auto', 'alpha-app'],
      [0, 'auto', 'alpha-app-2'],
    ]);
    expect(await start({ account: 0, path: 'beta' }, device('p3'))).toMatchObject({ account: 0, accountSource: 'manual' });
    expect(await rig.launcher.launch(body({ account: 7 }), device('p4'), 'k7')).toEqual({ ok: false, code: 'invalid_request', reason: 'There is no account 07' });
    await until(clock(), () => rig.terminal.opened.length === 3);
    // The runs open their windows side by side, in no fixed order.
    expect(rig.terminal.opened).toContain(
      `cd -- ${q(join(rig.work, 'alpha-app'))} && /fake/bin/claude --dangerously-skip-permissions --chrome --effort ultracode --session-id ${a.sid} --name alpha-app`,
    );
    // One login: no account is named in the steps the phone shows.
    expect(job(a.id).steps.map((s) => s.detail)).toEqual(expect.arrayContaining(['Queued', 'Starting · claude']));
    expect(job(a.id).steps.some((s) => /\b00\b/.test(s.detail))).toBe(false);
    await toDone(a);
    expect(stage(a.id)).toBe('done');
  });

  it('a cs-shell or cswap-run start refuses with its sentence in single mode; nothing opens', async () => {
    for (const mode of ['cs-shell', 'cswap-run']) {
      rig = await historyRig({ mode: 'single', settings: { launch: { mode } } });
      const want = { ok: false, code: 'unavailable', reason: NO_CSWAP_MODE };
      expect(await rig.launcher.preview({ root: 'r.work', path: 'alpha-app', account: 'auto' }, PHONE)).toEqual(want);
      expect(await rig.launcher.launch(body(), PHONE, `k-${mode}`)).toEqual(want);
      expect(rig.terminal.opened).toEqual([]);
      await rig.close();
    }
    rig = await makeRig();
  });

  it('cswap mode: a claude-mode start refuses with its sentence', async () => {
    rig = await historyRig({ settings: { launch: { mode: 'claude' } } });
    const want = { ok: false, code: 'unavailable', reason: CSWAP_MODE };
    expect(await rig.launcher.preview({ root: 'r.work', path: 'alpha-app', account: 'auto' }, PHONE)).toEqual(want);
    expect(await rig.launcher.launch(body(), PHONE, 'k')).toEqual(want);
    expect(rig.terminal.opened).toEqual([]);
  });

  it('claude mode with no claude found is a setup problem, not the folder', async () => {
    rig = await historyRig(SINGLE);
    Object.assign(rig.ctx.bins, { claude: null });
    const want = { ok: false, code: 'unavailable', reason: "This Mac isn't set up to start sessions from the phone: claude (Claude Code) was not found on this Mac" };
    expect(await rig.launcher.preview({ root: 'r.work', path: 'alpha-app', account: 'auto' }, PHONE)).toEqual(want);
    expect(await rig.launcher.launch(body(), PHONE, 'k')).toEqual(want);
  });

  it("a resume in single mode: the shared dir's conversations only, on account 0, typed with claude", async () => {
    const h = await historyRig(SINGLE);
    rig = h;
    await past(h);
    expect(await rig.launcher.preview({ root: 'r.work', path: 'alpha-app', account: 'auto', resume: ON_TWO }, PHONE)).toEqual({ ok: false, code: 'not_found', reason: NOT_IN_HISTORY });
    const j = await start({ resume: NEWEST });
    expect(j).toMatchObject({ account: 0, accountSource: 'auto', sid: NEWEST, resumed: true });
    await until(clock(), () => stage(j.id) === 'starting');
    expect(rig.terminal.opened).toEqual([`cd -- ${q(h.folder)} && /fake/bin/claude --dangerously-skip-permissions --chrome --effort ultracode --resume ${NEWEST} --name alpha-app`]);
    expect(job(j.id).steps.map((s) => s.detail)).toContain('Resuming a conversation · claude');
  });

  it('failures name claude, not cswap: a login screen, and a shell that never runs claude', async () => {
    rig = await historyRig(SINGLE);
    const login = await toStarting();
    rig.terminal.fg = 'claude';
    rig.terminal.screen = LOGIN_SCREEN;
    await until(clock(), () => stage(login.id) === 'failed');
    expect(job(login.id).reason).toBe('Claude needs a login on the Mac: run claude in Terminal and log in, then start again.');
    await rig.close();

    rig = await historyRig(SINGLE);
    const shell = await toStarting();
    rig.terminal.fg = 'shell';
    rig.terminal.screen = `${SHELL_PROMPT}zsh: no such file or directory: /fake/bin/claude`;
    await until(clock(), () => stage(shell.id) === 'failed', 30_000);
    expect(job(shell.id).reason).toBe("Claude didn't start. Check the window on the Mac.");
  });
});
