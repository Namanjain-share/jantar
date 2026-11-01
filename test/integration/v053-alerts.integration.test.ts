/// <reference lib="dom" />
/**
 * v0.5.3 alerts and the missed-push retry end to end (spec 1, 2.2, 2.6,
 * 2.7): jantard in-process on a synthetic HOME (harness.ts) on a WarpClock,
 * a phone paired with read and control and one Web Push subscription. Web
 * Push sends nothing: the harness records each payload as it would leave the
 * Mac, and fails the way a Mac with no network does while the test says so.
 * The phone is the built app (packages/web/dist) as jantard serves it, in
 * playwright-core's own Chromium with its service worker; each recorded
 * payload is handed to that worker as a push (CDP
 * ServiceWorker.deliverPushMessage), with the app's Web Audio and speech
 * replaced by recorders.
 *
 *  1. `jantar notify test <group>` for each of the five groups: one push
 *     each, with the group's kind and its group in the payload.
 *  2. Claude's countdown on screen (the fake terminal shows a workflow
 *     agent's ask at 1:50) and the session waiting: one urgent push ("about
 *     2 min to answer", its TTL the seconds left, no word of the dialog) and
 *     no "needs you" push; at about a minute left, one repeat; past the
 *     deadline, nothing more.
 *  3. On the phone: each push plays its group's tone and says its phrase;
 *     it is shown silent when the app played it, never for medicines and
 *     reminders; the urgent repeat plays again.
 *  4. A yearly reminder due while the Mac has no network: nothing leaves,
 *     the scheduler says once that it waits; with the network back one push,
 *     marked late, then never another; Done moves it a year on at its time.
 *
 * Nothing runs osascript, claude or a real push service.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page, type Worker } from 'playwright-core';
import { DIALOG_SECRET, perfBudgetMs, workflowBashScreen, type FakeHome } from '@jantar/fixtures';
import {
  ALERT_GROUPS,
  ALERT_PHRASES,
  DEFAULT_TONES,
  DEVICE_COOKIE,
  type AlertGroup,
  type AlertTone,
  type PairStartResponse,
  type Pane,
  type TodosResponse,
} from '@jantar/protocol';
import { callDaemon, createCtlClient, defaultDeps, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { browserReady } from './browser.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret } from './http.js';
import { ScriptedTerminal } from './scripted-terminal.js';
import { WarpClock } from './warp-clock.js';

const SID = '53535353-5353-4535-8535-535353535353';
const PHONE_PUSH = 'https://fcm.googleapis.com/fcm/send/synthetic-alerts-phone';
const KEYS = { p256dh: 'BSyntheticP256dhKeyForTheAlertsRun', auth: 'synthetic-auth' };
/** Each tone's frequencies, in order (web/src/lib/sounds.ts TONE_NOTES). */
const TONE_HZ: Readonly<Record<AlertTone, readonly number[]>> = {
  alarm: [880, 880, 880],
  ding: [660, 990],
  success: [523.25, 659.25, 783.99, 1046.5],
  bell: [784, 784, 784],
  low: [440, 330],
  none: [],
};
/** The kind `jantar notify test` sends for each group (spec 1.8). */
const TEST_KINDS: Readonly<Record<AlertGroup, string>> = { urgent: 'permission', needs: 'permission', done: 'done', care: 'life', problem: 'send-failed' };

const DAY_MS = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Tomorrow on the wall clock: the reminder rings then, whatever the time now. */
const D1 = dayOf(Date.now() + DAY_MS);
/** An instant in the Life zone (UTC). */
const at = (day: string, hhmm: string, seconds = 0) => Date.parse(`${day}T${hhmm}:00.000Z`) + seconds * 1000;
/** The same date a year on (29 February falls on the 28th). */
const yearOn = (day: string) => `${Number(day.slice(0, 4)) + 1}${day.endsWith('-02-29') ? '-02-28' : day.slice(4)}`;
const quiet = (ms = 2_500) => new Promise((r) => setTimeout(r, ms));

interface Payload {
  v: number;
  kind: string;
  group?: string;
  title: string;
  body: string;
  tag?: string;
  url?: string;
  deadline?: string;
  ts?: string;
}

/** Terminal.app as the fake shows it: Claude's ask in place of its input box while `ask` is set. */
class CountdownTerminal extends ScriptedTerminal {
  ask: string | null = null;
  constructor(home: FakeHome) {
    super(home);
  }
  override screenFor(pane: Pane): string {
    return this.ask ?? super.screenFor(pane);
  }
}

describe('v0.5.3 alerts: the groups, the countdown and the missed-push retry', () => {
  const clock = new WarpClock();
  let d: Daemon;
  let ctl: CtlClient;
  let phone = '';
  let term: CountdownTerminal;
  let offline = false;
  /** The pushes the phone gets in part 3, in the order they left the Mac. */
  const toPhone: Payload[] = [];

  const pushes = (): Array<Payload & { ttl: number }> => d.webPushes.map((p) => ({ ...(JSON.parse(p.payload) as Payload), ttl: p.ttl }));
  const ofSession = () => pushes().filter((p) => p.tag === `s:${SID}`);
  const lifePushes = () => pushes().filter((p) => p.kind === 'life' && !p.tag?.startsWith('test:'));
  const logged = (msg: string) => d.log.records.filter((r) => r.msg === msg);

  async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const io = memoryIo(d.home.env);
    const code = await main(argv, { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    return { code, out: io.stdout, err: io.stderr };
  }

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = method === 'GET' ? {} : { 'idempotency-key': `k-${Math.random().toString(36).slice(2)}` };
    const r = await http(d.port, method, path, { cookie: phone, headers, ...(body === undefined ? {} : { body }) });
    expect(r.status, `${method} ${path}: ${r.text}`).toBe(200);
    return r.body;
  }

  beforeAll(async () => {
    d = await bootDaemon({
      clock,
      home: { sessions: [{ sid: SID, pid: 75301, account: 1, project: 'web-app', status: 'idle', tty: 'ttys053', transcript: [] }] },
      terminal: (home) => (term = new CountdownTerminal(home)),
      pushOffline: () => offline,
      settings: { notify: { settle_ms: 0, urgent: true }, life: { todos: true, timezone: 'UTC' } },
    });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'Example phone', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'Example phone' } });
    expect(claim.status, claim.text).toBe(200);
    phone = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(phone, claim.body);
    const sub = await http(d.port, 'POST', '/v1/push/subscribe', { cookie: phone, body: { subscription: { endpoint: PHONE_PUSH, keys: KEYS } } });
    expect(sub.status, sub.text).toBe(200);
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('1. jantar notify test: one push per group, with its kind and group', async () => {
    for (const group of ALERT_GROUPS) {
      const r = await cli('notify', 'test', group);
      // The phone, and the harness's recorder, which stands in as a second Web Push channel.
      expect(r, group).toMatchObject({ code: 0, out: 'Sent to 2 devices.\n' });
    }
    const tests = pushes().filter((p) => p.tag?.startsWith('test:'));
    expect(d.webPushes.filter((p) => (JSON.parse(p.payload) as Payload).tag?.startsWith('test:')).map((p) => p.endpoint)).toEqual(ALERT_GROUPS.map(() => PHONE_PUSH));
    expect(tests.map((p) => [p.tag, p.kind, p.group])).toEqual(ALERT_GROUPS.map((g) => [`test:${g}`, TEST_KINDS[g], g]));
    const urgent = tests.find((p) => p.group === 'urgent');
    expect(urgent?.deadline).toBeDefined();
    // The TTL is the seconds left: a stale "answer now" is noise. The others keep the hour.
    expect(urgent?.ttl).toBeLessThanOrEqual(120);
    expect(tests.filter((p) => p.group !== 'urgent').every((p) => p.ttl === 3600 && p.deadline === undefined)).toBe(true);
    // needs, done, care, problem first, then urgent: the phone plays each once (part 3).
    toPhone.push(...tests.filter((p) => p.group !== 'urgent'), urgent as Payload);
  }, perfBudgetMs(30_000));

  it("2. Claude's countdown on screen: one urgent push, no waiting push, one repeat at a minute left, never a third", async () => {
    term.ask = workflowBashScreen('1:50');
    const since = Date.now();
    await d.home.updateSessionFile(SID, { status: 'waiting', waitingFor: 'approve Bash', updatedAt: since, statusUpdatedAt: since });
    const first = await eventually(async () => ofSession().find((p) => p.group === 'urgent'), 15_000, 'the urgent push');
    expect(first).toMatchObject({ kind: 'permission', title: 'web-app · about 2 min to answer', body: 'Claude blocks this ask by itself if nobody answers.', url: `/s/${SID}` });
    const deadline = Date.parse(first.deadline ?? '');
    expect(deadline - clock.now()).toBeGreaterThan(90_000);
    expect(deadline - clock.now()).toBeLessThanOrEqual(110_000);
    expect(first.ttl).toBeGreaterThan(90);
    expect(first.ttl).toBeLessThanOrEqual(110);
    // The urgent push covers the ask: no "needs you" push for it.
    await quiet();
    expect(ofSession().map((p) => p.group)).toEqual(['urgent']);

    // About a minute left, the same ask still on screen (the arrow moved): one repeat.
    term.ask = workflowBashScreen('1:01').replace(' ❯ 1. Yes\n   2. No', '   1. Yes\n ❯ 2. No');
    clock.jumpTo(deadline - 60_000 + 500);
    await eventually(async () => ofSession().length === 2, 15_000, 'the repeat');
    expect(ofSession()[1]).toMatchObject({ group: 'urgent', title: 'web-app · about 1 min to answer', deadline: first.deadline });
    // One line per channel (Web Push and the harness's recorder), with no text: the first, then the repeat.
    const lines = logged('notification sent').filter((r) => r.fields?.urgent === true);
    expect(lines.map((r) => r.fields?.repeat)).toEqual([false, false, true, true]);
    // The repeat's seconds left come from its own read of the screen ("1:01"), less the moments since.
    const left = lines.map((r) => Number(r.fields?.left));
    expect(left[0]).toBeGreaterThan(90);
    for (const l of left.slice(2)) {
      expect(l).toBeGreaterThanOrEqual(55);
      expect(l).toBeLessThanOrEqual(61);
    }

    // Past the deadline: nothing more.
    clock.jumpTo(deadline + 5_000);
    await quiet();
    expect(ofSession().map((p) => p.group)).toEqual(['urgent', 'urgent']);
    // Not a word of the dialog anywhere: its command, its title, its secret.
    for (const p of d.webPushes) for (const word of [DIALOG_SECRET, 'night-check', 'rm -rf', 'proceed']) expect(p.payload).not.toContain(word);
    for (const r of d.log.records) expect(JSON.stringify(r)).not.toContain(DIALOG_SECRET);
    toPhone.push(...ofSession());

    // The ask answered: the session goes back to its turn.
    term.ask = null;
    await d.home.updateSessionFile(SID, { status: 'idle', updatedAt: clock.now(), statusUpdatedAt: clock.now() });
    await eventually(async () => d.ctx.store.getState().sessions[SID]?.status !== 'waiting', 15_000, 'the session back to its turn');
  }, perfBudgetMs(60_000));

  describe('3. on the phone', () => {
    let browser: Browser | null = null;
    let ctx: BrowserContext;
    let page: Page;
    let sw: Worker;
    let cdp: CDPSession;
    let registrationId = '';
    let ready = false;

    beforeAll(async () => {
      ready = await browserReady('v053-alerts');
      if (!ready) return;
      browser = await chromium.launch();
      ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'allow', locale: 'en-GB' });
      // Web Audio and speech as recorders; this device's Sounds on, with Speak.
      await ctx.addInitScript((tones) => {
        const w = window as unknown as { __notes: number[]; __said: string[] };
        w.__notes = [];
        w.__said = [];
        const param = { setValueAtTime: (v: number) => void w.__notes.push(v), linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} };
        const silent = { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} };
        class RecordingAudio {
          state = 'running';
          currentTime = 0;
          destination = {};
          resume() {
            return Promise.resolve();
          }
          createOscillator() {
            return { type: '', frequency: param, connect() {}, start() {}, stop() {} };
          }
          createGain() {
            return { gain: silent, connect() {} };
          }
        }
        (window as unknown as { AudioContext: unknown }).AudioContext = RecordingAudio;
        const speech = window.speechSynthesis;
        let speaking = false;
        Object.defineProperty(speech, 'speaking', { get: () => speaking, configurable: true });
        speech.speak = (u: SpeechSynthesisUtterance) => {
          speaking = true;
          if (u.text) w.__said.push(u.text);
        };
        speech.cancel = () => undefined;
        localStorage.setItem('jantar:alert-sounds', JSON.stringify({ v: 1, on: true, speak: true, tones }));
      }, DEFAULT_TONES);
      page = await ctx.newPage();
      cdp = await ctx.newCDPSession(page);
      const regs: Array<{ registrationId: string; isDeleted: boolean }> = [];
      cdp.on('ServiceWorker.workerRegistrationUpdated', (e: { registrations: typeof regs }) => regs.push(...e.registrations));
      await cdp.send('ServiceWorker.enable');
      const swSeen = ctx.waitForEvent('serviceworker', { timeout: perfBudgetMs(15_000) });
      await page.goto(`http://127.0.0.1:${d.port}/`, { waitUntil: 'load' });
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      sw = ctx.serviceWorkers()[0] ?? (await swSeen);
      registrationId = (await eventually(async () => regs.find((r) => !r.isDeleted), 10_000, 'the registration')).registrationId;
      // One tap: iOS (and so the app) opens audio only inside one.
      await page.touchscreen.tap(195, 600);
    }, perfBudgetMs(60_000));

    afterAll(async () => {
      await browser?.close();
    }, perfBudgetMs(30_000));

    /** Hands one payload to the service worker as a push; what the app played and said, and how the push was shown. */
    async function deliver(p: Payload): Promise<{ hz: number[]; said: string[]; silent: boolean }> {
      await page.evaluate(() => {
        const w = window as unknown as { __notes: number[]; __said: string[] };
        w.__notes.length = 0;
        w.__said.length = 0;
      });
      // Every showNotification recorded (Chromium without a display has no notification permission to show one).
      await sw.evaluate(() => {
        const g = self as unknown as { __shown?: Array<{ title: string; silent: boolean }>; registration: ServiceWorkerRegistration };
        g.__shown = [];
        const reg = g.registration as ServiceWorkerRegistration & { __wrapped?: boolean };
        if (reg.__wrapped) return;
        const show = reg.showNotification.bind(reg);
        reg.showNotification = (title: string, o?: NotificationOptions) => {
          g.__shown?.push({ title, silent: o?.silent === true });
          return show(title, o).catch(() => undefined);
        };
        reg.__wrapped = true;
      });
      await cdp.send('ServiceWorker.deliverPushMessage', { origin: `http://127.0.0.1:${d.port}`, registrationId, data: JSON.stringify(p) });
      const shown = await eventually(
        async () => (await sw.evaluate(() => (self as unknown as { __shown?: Array<{ title: string; silent: boolean }> }).__shown ?? [])).at(0),
        10_000,
        `the ${p.group} push shown`,
      );
      expect(shown.title).toBe(p.title);
      const heard = await page.evaluate(() => {
        const w = window as unknown as { __notes: number[]; __said: string[] };
        return { hz: [...w.__notes], said: [...w.__said] };
      });
      return { ...heard, silent: shown.silent };
    }

    it('each push plays its group tone and says its phrase; silent only when played, never for care; the repeat plays again', async (t) => {
      if (!ready) return t.skip();
      expect(toPhone.map((p) => p.group)).toEqual(['needs', 'done', 'care', 'problem', 'urgent', 'urgent', 'urgent']);
      let lastUrgent = 0;
      for (const p of toPhone) {
        const group = p.group as AlertGroup;
        // The same group within 3 s plays once (a repeat push and the dock's own mark): space the urgent ones out.
        if (group === 'urgent') await quiet(Math.max(0, lastUrgent + 3_200 - Date.now()));
        const heard = await deliver(p);
        if (group === 'urgent') lastUrgent = Date.now();
        expect(heard, `${group}: ${p.title}`).toEqual({ hz: TONE_HZ[DEFAULT_TONES[group]], said: [ALERT_PHRASES[group]], silent: group !== 'care' });
      }
    }, perfBudgetMs(90_000));
  });

  it('4. a yearly reminder due with no network: waits, goes out once marked late when it is back, then Done moves it a year on', async () => {
    const { id } = (await call('POST', '/v1/todos', { title: 'Example renewal', due: { day: D1, time: '08:00' }, repeat: { freq: 'yearly' } })) as { id: string };
    const listed = (await call('GET', '/v1/todos')) as TodosResponse;
    expect(listed.todos.find((t) => t.id === id)?.repeat).toMatchObject({ freq: 'yearly', at: '08:00' });

    offline = true;
    clock.jumpTo(at(D1, '07:59', 57));
    await eventually(async () => logged('life push waiting for the network').length === 1, 15_000, 'the scheduler waiting for the network');
    expect(lifePushes()).toEqual([]);
    // Still no network at the next sweeps: tried again, said once, nothing counted as failed.
    clock.jumpTo(at(D1, '08:01'));
    await quiet();
    clock.jumpTo(at(D1, '08:01', 31));
    await quiet();
    expect(logged('life push waiting for the network')).toHaveLength(1);
    expect(logged('life push not delivered')).toEqual([]);
    expect(lifePushes()).toEqual([]);

    // The network back: one push at the next sweep, marked late.
    offline = false;
    clock.jumpTo(at(D1, '08:03'));
    await eventually(async () => lifePushes().length === 1, 15_000, 'the late push');
    expect(lifePushes()[0]).toMatchObject({ title: 'Todo due', body: 'Missed at 08:00 · Example renewal · 08:00', url: `/todos?id=${id}` });
    expect(logged('life push sent').at(-1)?.fields).toMatchObject({ kind: 'todo', rows: 1, late: true, waited: true });
    // Never twice.
    clock.jumpTo(at(D1, '08:05'));
    await quiet();
    clock.jumpTo(at(D1, '09:00'));
    await quiet();
    expect(lifePushes()).toHaveLength(1);

    // Done: a year on, at its own time.
    await call('POST', `/v1/todos/${id}/done`, { done: true });
    const after = ((await call('GET', '/v1/todos')) as TodosResponse).todos.find((t) => t.id === id);
    expect(after?.due).toEqual({ day: yearOn(D1), time: '08:00' });
  }, perfBudgetMs(90_000));
});
