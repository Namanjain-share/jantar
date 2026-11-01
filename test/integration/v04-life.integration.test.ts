/**
 * v0.4 Life and the Intel shelf end to end (spec 9.3, flows 1 to 7 and 9,
 * then the privacy sweep, 10): jantard in-process on a synthetic HOME with
 * the production wiring, a phone paired with read, control and admin and a
 * read-only device, both with their event streams open from the start and a
 * Web Push subscription each. Web Push sends nothing (the harness records
 * every payload as it would leave the Mac), and the daemon runs on a
 * WarpClock the test moves forward to each ping's time, in the UTC Life zone.
 *
 *  1. Switches: with everything off Today and the shelf 403 naming the Mac
 *     command; a TCP settings patch is 403; `jantar life on ...` over the
 *     real ctl.sock turns the modules on (features.life, no module key).
 *  2. Ask Claude (the fake claude through the fake cswap): two editable rows,
 *     nothing saved; broken JSON is 502 with the sentence.
 *  3. Tomorrow 06:00: a project with a folder, todos, two reminders, two
 *     medicines and a bill due today; Today lists them. v0.5.3: over
 *     ctl.sock (`jantar mcp`'s routes) a todo added by a folder inside the
 *     project's lands in it, and the folder's open todos list it.
 *  4. 08:00: one reminder push and one "Medicines due · 2", no names.
 *  5. Today with the medicines due: Taken leaves 9 pills, Skip; Today agrees.
 *  6. 09:00: one "Bill due" push with no name or amount; Paid logs it.
 *  7. The daemon down across 10:00: one "Missed at 10:00" push after restart.
 *     In 4, 6 and 7 a wait that runs out names the scheduler's rows (kind,
 *     due time, failures, claimed or not; no ids) and its push lines, so a
 *     late push says which path it took (v0.5.3, the Ubuntu CI timeout).
 *  8. Food: the estimated rows confirmed (420 kcal), weights with their 7 and
 *     30 day changes, the target; Today shows 420 / 1,800 and 72.4.
 *  9. Cafés: the best dish first; Want to try filters.
 * 10. Finance: the month's totals, a budget over, the paid bill's expense.
 * 11. Intel: a JSONL source with edge lines, an appended line within 5 s with
 *     a tick, `jantar intel add` and its duplicate, no path on the wire.
 * 12. A broken life.db: 503 with the sentence, the file untouched, the Board
 *     still up; `jantar life restore` brings Life back.
 * 13. Everything off again: nothing new is visible.
 * 14. The sweep: LIFE_MARKER (in every Life and Intel text field) and
 *     MARKER_KG are in no WS frame, the ring, the stored events, an audit
 *     row, a log line, a push or a write reply; the read-only device's
 *     frames hold no Life id; Life pushes reached only the control device.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LAUNCH_HELD,
  LIFE_MARKER,
  MARKER_KG,
  PLACEBIN,
  appendIntel,
  billBody,
  captureBody,
  estimateText,
  intelRecord,
  launchAccounts,
  markersIn,
  medBody,
  moneyBody,
  perfBudgetMs,
  placeBody,
  projectBody,
  setFakeClaude,
  todoBody,
  writeIntelJsonl,
} from '@jantar/fixtures';
import {
  DEVICE_COOKIE,
  eventsSocketProtocols,
  type Features,
  type FolderTodosResponse,
  type FoodDay,
  type FoodEstimate,
  type IntelListResponse,
  type IntelSourcesResponse,
  type LifeStatus,
  type MedicinesResponse,
  type MoneyMonth,
  type PairStartResponse,
  type PlacesResponse,
  type StateResponse,
  type Today,
} from '@jantar/protocol';
import { callDaemon, createCtlClient, defaultDeps, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret, type HttpResult } from './http.js';
import { WarpClock } from './warp-clock.js';

// The `ws` client @fastify/websocket itself depends on (the daemon's own dependency; test only).
const daemonRequire = createRequire(new URL('../../packages/daemon/package.json', import.meta.url));
interface WsClient {
  on(ev: 'message', fn: (data: unknown) => void): void;
  on(ev: 'error', fn: (e: Error) => void): void;
  once(ev: 'open', fn: () => void): void;
  close(): void;
}
const WebSocket = createRequire(daemonRequire.resolve('@fastify/websocket'))('ws') as new (
  url: string,
  protocols: string[],
  opts: { headers: Record<string, string> },
) => WsClient;

const SID = '71717171-7171-4717-8717-717171717171';
const PHONE_PUSH = 'https://fcm.googleapis.com/fcm/send/synthetic-life-phone';
const READER_PUSH = 'https://fcm.googleapis.com/fcm/send/synthetic-life-reader';
const KEYS = { p256dh: 'BSyntheticP256dhKeyForTheLifeRun', auth: 'synthetic-auth' };

const DAY_MS = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const shift = (day: string, n: number) => dayOf(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS);
/** An instant in the Life zone (UTC). */
const at = (day: string, hhmm: string, seconds = 0) => Date.parse(`${day}T${hhmm}:00.000Z`) + seconds * 1000;
/** Tomorrow on the wall clock: every ping of the run lands on it, whatever the time now. */
const D1 = dayOf(Date.now() + DAY_MS);
const MARKERS = [LIFE_MARKER, String(MARKER_KG)];
const p2 = (n: number) => String(n).padStart(2, '0');
/** The same date a month on, clamped to the month's end (a monthly bill's next due day). */
function nextMonthOf(day: string): string {
  const [y, m, dd] = day.split('-').map(Number) as [number, number, number];
  const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${p2(nm)}-${p2(Math.min(dd, last))}`;
}

interface PushSeen {
  endpoint: string;
  kind: string;
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

describe('v0.4 Life and the Intel shelf end to end', () => {
  const clock = new WarpClock();
  let d: Daemon;
  let ctl: CtlClient;
  let phone: string;
  let reader: string;
  const sockets: WsClient[] = [];
  /** Every WS frame each device got, as sent. */
  const frames = { phone: [] as string[], reader: [] as string[] };
  /** Every reply to a write, and to a read. */
  const writes: Array<{ what: string; text: string }> = [];
  const reads: Array<{ what: string; text: string }> = [];
  /** Life ids made during the run (none may reach the read-only device). */
  const ids: Record<string, string> = {};
  let estimated: FoodEstimate | null = null;
  let intelPath = '';

  const dumpLog = () =>
    d?.log.records
      .filter((r) => r.level === 'warn' || r.level === 'error')
      .slice(-20)
      .map((r) => `${r.level} ${r.msg} ${JSON.stringify(r.fields)}`)
      .join('\n');

  /**
   * The scheduler as it stands: its rows from life.db (read-only; kind, the
   * dose time, next_at, failures, claimed or not, never a ref) and its
   * `life push`, `life ping` and `life sweep` lines at every level.
   */
  function schedulerDump(): string {
    let rows: string;
    try {
      const db = new DatabaseSync(d.ctx.paths.lifeDb, { readOnly: true });
      try {
        const all = db.prepare('SELECT kind, sub, next_at, failures, claimed_at FROM pings ORDER BY next_at').all() as { kind: string; sub: string; next_at: string | null; failures: number; claimed_at: string | null }[];
        rows = all.map((r) => `${r.kind}${r.sub ? ` ${r.sub}` : ''} next=${r.next_at} failures=${r.failures} claimed=${r.claimed_at !== null}`).join('\n');
      } finally {
        db.close();
      }
    } catch (e) {
      rows = `(unreadable: ${String(e)})`;
    }
    const lines = d.log.records
      .filter((r) => /^life (push|ping|sweep)/.test(r.msg))
      .slice(-30)
      .map((r) => `${r.level} ${r.msg} ${JSON.stringify(r.fields)}`)
      .join('\n');
    return `now ${new Date(clock.now()).toISOString()}\nscheduler rows:\n${rows || '(none)'}\nlife push lines:\n${lines || '(none)'}\n${dumpLog()}`;
  }

  /** Waits for `n` Life pushes in all; running out says what the scheduler holds. */
  async function pushesReach(n: number, what: string): Promise<void> {
    try {
      await eventually(async () => lifePushes().length >= n, 15_000, what);
    } catch (e) {
      throw new Error(`${(e as Error).message}\n${schedulerDump()}`);
    }
  }

  async function call(method: string, path: string, body?: unknown, cookie = phone): Promise<HttpResult> {
    // Every write keeps one key, as the web does; Ask Claude goes without one (LP3: never cached).
    const keyed = method !== 'GET' && path !== '/v1/food/estimate';
    const headers: Record<string, string> = keyed ? { 'idempotency-key': `k-${Math.random().toString(36).slice(2)}` } : {};
    const r = await http(d.port, method, path, { cookie, headers, ...(body === undefined ? {} : { body }) });
    (method === 'GET' ? reads : writes).push({ what: `${method} ${path}`, text: r.text });
    return r;
  }

  async function ok<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await call(method, path, body);
    expect(r.status, `${method} ${path}: ${r.text}\n${dumpLog()}`).toBe(200);
    return r.body as T;
  }
  const get = <T>(path: string) => ok<T>('GET', path);
  const made = async (name: string, method: string, path: string, body: unknown): Promise<string> => {
    const { id } = await ok<{ id: string }>(method, path, body);
    ids[name] = id;
    return id;
  };

  async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const io = memoryIo(d.home.env);
    const code = await main(argv, { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    return { code, out: io.stdout, err: io.stderr };
  }

  async function features(): Promise<Features> {
    const r = await http(d.port, 'GET', '/v1/state', { cookie: phone });
    expect(r.status, r.text).toBe(200);
    const f = (r.body as StateResponse).state.daemon?.features;
    if (!f) throw new Error('the state carries no feature switches');
    return f;
  }

  async function pair(name: string, scopes: string[]): Promise<{ cookie: string; secret: string }> {
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name, scopes });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name } });
    expect(claim.status, claim.text).toBe(200);
    const cookie = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(cookie, claim.body);
    return { cookie, secret: (claim.body as { deviceSecret: string }).deviceSecret };
  }

  const secrets = { phone: '', reader: '' };
  async function listen(who: 'phone' | 'reader'): Promise<void> {
    const cookie = who === 'phone' ? phone : reader;
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/v1/events`, eventsSocketProtocols(secrets[who]), { headers: { origin: `http://127.0.0.1:${d.port}`, cookie } });
    ws.on('message', (data) => frames[who].push(String(data)));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.on('error', reject);
    });
    sockets.push(ws);
  }

  const lifePushes = (): PushSeen[] =>
    d.webPushes
      .map((p) => ({ endpoint: p.endpoint, ...(JSON.parse(p.payload) as Omit<PushSeen, 'endpoint'>) }))
      .filter((p) => p.kind === 'med' || p.kind === 'life');
  const eventTypes = () => frames.phone.map((f) => JSON.parse(f) as { kind: string; event?: { type: string } }).flatMap((m) => (m.kind === 'event' && m.event ? [m.event.type] : []));
  const ticks = () => eventTypes().filter((t) => t === 'life.changed').length;
  /** No new push for a while: the scheduler's sweep (30 s) is not waited for, but the near timer and the claim are. */
  const settle = () => new Promise((r) => setTimeout(r, 2_500));

  beforeAll(async () => {
    d = await bootDaemon({
      clock,
      home: {
        accounts: launchAccounts(),
        sessions: [{ sid: SID, pid: 71001, account: 5, project: 'demo-app', status: 'idle', tty: 'ttys071', transcript: [] }],
      },
      // Lock-screen todo bodies generic (LP4); kept accounts synthetic.
      settings: { notify: { settle_ms: 0, bodies: 'generic' }, accounts: { kept: [...LAUNCH_HELD] } },
    });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const p = await pair('life phone', ['read', 'control', 'admin']);
    const r = await pair('life reader', ['read']);
    phone = p.cookie;
    reader = r.cookie;
    secrets.phone = p.secret;
    secrets.reader = r.secret;
    await listen('phone');
    await listen('reader');
    for (const [cookie, endpoint] of [
      [phone, PHONE_PUSH],
      [reader, READER_PUSH],
    ] as const) {
      const sub = await http(d.port, 'POST', '/v1/push/subscribe', { cookie, body: { subscription: { endpoint, keys: KEYS } } });
      expect(sub.status, sub.text).toBe(200);
    }
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    for (const ws of sockets) ws.close();
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('1. switches: everything off says so; jantar life on over ctl.sock turns the modules on', async () => {
    const off = await call('GET', '/v1/life/today');
    expect(off.status).toBe(403);
    expect((off.body as { error: { message: string } }).error.message).toBe('Life is off. Turn a part of it on at your Mac: jantar life on todos');
    expect((await call('GET', '/v1/intel')).status).toBe(403);
    expect(await features()).toMatchObject({ life: false, intel: false });
    // LG3: an admin device cannot switch Life on over TCP.
    const patch = await call('PATCH', '/v1/settings', { life: { todos: true } });
    expect(patch.status).toBe(403);

    for (const argv of [
      ['life', 'on', 'todos', 'medicines', 'food', 'places', 'finance'],
      ['life', 'set', 'timezone', 'UTC'],
      ['life', 'set', 'currency', 'INR'],
    ]) {
      const run = await cli(...argv);
      expect(run.code, `jantar ${argv.join(' ')}: ${run.err}\n${dumpLog()}`).toBe(0);
    }
    const f = await features();
    expect(f.life).toBe(true);
    for (const m of ['todos', 'medicines', 'food', 'places', 'finance']) expect(Object.keys(f)).not.toContain(m);
    const status = await get<LifeStatus>('/v1/life/status');
    expect(status).toMatchObject({ open: true, timezone: 'UTC', currency: 'INR', modules: { todos: true, medicines: true, food: true, places: true, finance: true }, push: { devices: 1, webpush: true } });
    expect(status.estimate.available).toBe(true);
  });

  it('2. Ask Claude: two editable rows and nothing saved; broken JSON is 502 with the sentence', async () => {
    const today = dayOf(clock.now());
    const r = await call('POST', '/v1/food/estimate', { text: estimateText({ marked: true }) });
    expect(r.status, `${r.text}\n${dumpLog()}`).toBe(200);
    estimated = r.body as FoodEstimate;
    expect(estimated.items).toEqual([
      { name: 'Roti', kcal: 240 },
      { name: 'Dal', kcal: 180 },
    ]);
    const day = await get<FoodDay>(`/v1/food?day=${today}`);
    expect(day.entries).toEqual([]);
    expect(day.kcal).toBe(0);

    await setFakeClaude(d.home, { mode: 'food-bad-json' });
    const bad = await call('POST', '/v1/food/estimate', { text: estimateText() });
    expect(bad.status).toBe(502);
    expect((bad.body as { error: { message: string } }).error.message).toBe("Claude couldn't estimate that. Type the calories instead.");
    await setFakeClaude(d.home, { mode: 'food-ok' });
  }, perfBudgetMs(60_000));

  it('3. tomorrow 06:00: a project, todos, two reminders, two medicines and a bill; Today lists them', async () => {
    clock.jumpTo(at(D1, '06:00'));
    await made('project', 'POST', '/v1/projects', projectBody({ folder: d.home.session(SID).cwd, due: D1 }, { marked: true }));
    await made('todo', 'POST', '/v1/todos', todoBody({ projectId: ids.project }, { marked: true }));
    await made('remind8', 'POST', '/v1/todos', todoBody({}, { marked: true, timed: { day: D1, time: '08:00' } }));
    await made('remind10', 'POST', '/v1/todos', todoBody({}, { marked: true, timed: { day: D1, time: '10:00' } }));
    await made('testamol', 'POST', '/v1/medicines', medBody({}, { marked: true }));
    await made('placebin', 'POST', '/v1/medicines', PLACEBIN);
    await made('bill', 'POST', '/v1/bills', billBody({ nextDue: D1 }, { marked: true }));

    const today = await get<Today>('/v1/life/today');
    expect(today.day).toBe(D1);
    expect(today.todos?.today.map((t) => t.id).sort()).toEqual([ids.remind8, ids.remind10].sort());
    const morning = today.meds?.groups.find((g) => g.period === 'morning');
    expect(morning?.items.map((i) => [i.medId, i.status]).sort()).toEqual(
      [
        [ids.testamol, 'pending'],
        [ids.placebin, 'pending'],
      ].sort(),
    );
    expect(today.bills?.map((b) => b.id)).toEqual([ids.bill]);
    expect(lifePushes()).toEqual([]);

    // v0.5.3: jantar mcp's routes, over the real ctl.sock: a folder inside the project's is the project's.
    const inside = join(d.home.session(SID).cwd, 'src');
    const folderBody = { folder: inside, title: `Example folder todo ${LIFE_MARKER}`, notes: `Synthetic ${LIFE_MARKER}` };
    const added = await callDaemon<{ id: string }>(ctl, 'POST', '/v1/folder/todos', folderBody);
    writes.push({ what: 'POST /v1/folder/todos (ctl)', text: JSON.stringify(added) });
    expect(Object.keys(added)).toEqual(['id']);
    ids.folderTodo = added.id;
    const here = await callDaemon<FolderTodosResponse>(ctl, 'GET', `/v1/folder/todos?folder=${encodeURIComponent(inside)}`);
    reads.push({ what: 'GET /v1/folder/todos (ctl)', text: JSON.stringify(here) });
    expect(here.project?.id).toBe(ids.project);
    expect(here.todos.map((t) => t.id).sort()).toEqual([ids.todo, ids.folderTodo].sort());
    expect(here.todos.find((t) => t.id === ids.folderTodo)).toMatchObject({ projectId: ids.project, title: folderBody.title });
    // Not over TCP, even for the admin phone.
    expect((await call('GET', `/v1/folder/todos?folder=${encodeURIComponent(inside)}`)).status).toBe(403);
  });

  it('4. 08:00: one reminder push and one "Medicines due · 2", with no names on the lock screen', async () => {
    clock.jumpTo(at(D1, '07:59', 57));
    await pushesReach(2, 'the 08:00 pushes');
    await settle();
    const pushes = lifePushes();
    expect(pushes, schedulerDump()).toHaveLength(2);
    expect(pushes.find((p) => p.kind === 'life')).toEqual(
      expect.objectContaining({ endpoint: PHONE_PUSH, title: 'Todo due', body: 'Tap to open · 08:00', url: `/todos?id=${ids.remind8}`, tag: `life:todo:${ids.remind8}` }),
    );
    expect(pushes.find((p) => p.kind === 'med')).toEqual(expect.objectContaining({ endpoint: PHONE_PUSH, title: 'Medicines due · 2', body: 'Tap to log · 08:00', url: '/today', tag: 'med:08:00' }));
  }, perfBudgetMs(30_000));

  it('5. Today with the medicines due: Taken leaves 9 pills, Skip; Today and the checklist agree', async () => {
    clock.jumpTo(at(D1, '08:05'));
    const before = await get<Today>('/v1/life/today');
    expect(before.meds?.groups.flatMap((g) => g.items).every((i) => i.status === 'pending')).toBe(true);
    await made('dose', 'POST', `/v1/medicines/${ids.testamol}/doses`, { day: D1, slot: '08:00', status: 'taken' });
    await made('skip', 'POST', `/v1/medicines/${ids.placebin}/doses`, { day: D1, slot: '08:00', status: 'skipped' });

    const after = await get<Today>('/v1/life/today');
    const items = after.meds?.groups.flatMap((g) => g.items) ?? [];
    expect(items.find((i) => i.medId === ids.testamol && i.slot === '08:00')).toMatchObject({ status: 'taken', doseId: ids.dose });
    expect(items.find((i) => i.medId === ids.placebin)).toMatchObject({ status: 'skipped' });
    expect(items.find((i) => i.medId === ids.testamol && i.slot === '21:00')).toMatchObject({ status: 'pending' });
    const meds = await get<MedicinesResponse>('/v1/medicines');
    const testamol = meds.medicines.find((m) => m.id === ids.testamol);
    expect(testamol?.pills?.left).toBe(9);
    expect(testamol?.adherencePct).toBe(100);
  });

  it('6. 09:00: one "Bill due" push with no name or amount; Paid logs the expense and moves the due day a month', async () => {
    clock.jumpTo(at(D1, '08:59', 57));
    await pushesReach(3, 'the 09:00 bill push');
    await settle();
    const pushes = lifePushes();
    expect(pushes, schedulerDump()).toHaveLength(3);
    expect(pushes[2]).toEqual(expect.objectContaining({ endpoint: PHONE_PUSH, kind: 'life', title: 'Bill due', body: 'Due today', url: `/money?bill=${ids.bill}`, tag: `life:bill:${ids.bill}` }));
    await made('billPaid', 'POST', `/v1/bills/${ids.bill}/paid`, {});
    const month = await get<MoneyMonth>(`/v1/money?month=${D1.slice(0, 7)}`);
    expect(month.entries.find((e) => e.id === ids.billPaid)).toMatchObject({ billId: ids.bill, amount: 64900, day: D1 });
    expect(month.bills.find((b) => b.id === ids.bill)?.nextDue).toBe(nextMonthOf(D1));
  }, perfBudgetMs(30_000));

  it('7. the daemon down across 10:00: after the restart the reminder and the refill (10 pills, 5 days) each ring once, "Missed at 10:00"', async () => {
    for (const ws of sockets.splice(0)) ws.close();
    await d.restart(() => clock.jumpTo(at(D1, '10:30')));
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket after the restart');
    await listen('phone');
    await listen('reader');
    await pushesReach(5, 'the catch-up pushes');
    await settle();
    const caught = lifePushes().slice(3);
    expect(caught, schedulerDump()).toHaveLength(2);
    expect(caught.find((p) => p.kind === 'life')).toEqual(
      expect.objectContaining({ endpoint: PHONE_PUSH, title: 'Todo due', body: 'Missed at 10:00 · Tap to open · 10:00', url: `/todos?id=${ids.remind10}` }),
    );
    expect(caught.find((p) => p.kind === 'med')).toEqual(
      expect.objectContaining({ endpoint: PHONE_PUSH, title: 'Medicine running low', body: 'Missed at 10:00 · Refill soon', url: `/meds?med=${ids.testamol}` }),
    );
  }, perfBudgetMs(60_000));

  it('8. food and weight: the estimate confirmed is 420 kcal, the changes over 7 and 30 days, the target; Today shows them', async () => {
    for (const item of estimated?.items ?? []) await made(`food:${item.name}`, 'POST', '/v1/food', { day: D1, name: item.name, kcal: item.kcal });
    // A marked food, saved for one tap, on another day.
    await made('marked food', 'POST', '/v1/food', { day: shift(D1, -1), name: `Sample Idli ${LIFE_MARKER}`, kcal: 150, save: true });
    for (const [day, kg] of [
      [shift(D1, -60), MARKER_KG],
      [shift(D1, -30), 74.0],
      [shift(D1, -7), 73.0],
      [D1, 72.4],
    ] as const) {
      expect((await call('PUT', `/v1/weights/${day}`, { kg })).status).toBe(200);
    }
    expect((await call('PUT', '/v1/food/targets', { kcalTarget: 1800, goalKg: MARKER_KG })).status).toBe(200);

    const food = await get<FoodDay>('/v1/food');
    expect(food).toMatchObject({ day: D1, kcal: 420, target: 1800 });
    expect(food.weight).toMatchObject({ latest: { day: D1, kg: 72.4 }, change7: -0.6, change30: -1.6, goalKg: MARKER_KG });
    expect(food.saved.map((s) => s.name)).toEqual([`Sample Idli ${LIFE_MARKER}`]);
    const today = await get<Today>('/v1/life/today');
    expect(today.food).toEqual({ kcal: 420, target: 1800, weight: { day: D1, kg: 72.4 } });
  });

  it('9. cafés: the best dish first; Want to try filters', async () => {
    await made('cafe', 'POST', '/v1/places', placeBody({}, { marked: true }));
    await made('diner', 'POST', '/v1/places', { name: 'Sample Diner', tried: false, dishes: [{ name: 'Sample Thali', rating: 3 }] });
    const all = await get<PlacesResponse>('/v1/places');
    expect(all.places.map((p) => [p.id, p.best])).toEqual([
      [ids.cafe, 5],
      [ids.diner, 3],
    ]);
    const want = await get<PlacesResponse>('/v1/places?filter=want');
    expect(want.places.map((p) => p.id)).toEqual([ids.diner]);
  });

  it('10. finance: the month totals, a budget over, the paid bill counted', async () => {
    await made('expense', 'POST', '/v1/money', moneyBody({ day: D1 }, { marked: true }));
    await made('lunch', 'POST', '/v1/money', moneyBody({ day: D1, amount: 50000, category: 'Food', note: 'Sample lunch' }));
    await made('dinner', 'POST', '/v1/money', moneyBody({ day: D1, amount: 30000, category: 'Food', note: 'Sample dinner' }));
    await made('income', 'POST', '/v1/money', moneyBody({ kind: 'income', day: D1, amount: 5_000_000, category: 'Salary', note: 'Sample pay' }));
    expect((await call('PUT', '/v1/money/budgets', { category: 'Food', amount: 60000 })).status).toBe(200);
    const month = await get<MoneyMonth>(`/v1/money?month=${D1.slice(0, 7)}`);
    expect(month.currency).toBe('INR');
    expect(month.spent).toBe(124000 + 50000 + 30000 + 64900);
    expect(month.income).toBe(5_000_000);
    expect(month.byCategory.find((c) => c.category === 'Food')).toEqual({ category: 'Food', spent: 80000, budget: 60000 });
  });

  it('11. Intel: a JSONL source followed, an appended line within 5 s with a tick, jantar intel add and its duplicate, no path on the wire', async () => {
    intelPath = join(d.home.home, 'bot', 'intel', 'intel.jsonl');
    const written = await writeIntelJsonl(intelPath, { count: 30, extras: true });
    // The fixture ends on a partial line; the bot finishes it.
    await writeFile(intelPath, `${await readFile(intelPath, 'utf8')}"}\n`);
    for (const argv of [
      ['intel', 'source', 'add', intelPath],
      ['intel', 'on'],
    ]) {
      const run = await cli(...argv);
      expect(run.code, `jantar ${argv.join(' ')}: ${run.out}${run.err}\n${dumpLog()}`).toBe(0);
    }
    expect((await features()).intel).toBe(true);
    const list = await eventually(async () => {
      const r = await get<IntelListResponse>('/v1/intel?limit=100');
      return r.total === written.items + 1 ? r : null;
    }, 10_000, 'the shelf to read the source');
    expect(list.items[0]?.id).toBeDefined();
    const tools = await get<IntelListResponse>('/v1/intel?type=tool&limit=100');
    expect(tools.total).toBeGreaterThan(0);
    expect(tools.items.every((i) => i.type === 'tool')).toBe(true);
    const sources = await get<IntelSourcesResponse>('/v1/intel/sources');
    expect(sources.sources.map((s) => s.skipped)).toContain(written.skipped);

    const before = ticks();
    await appendIntel(intelPath, intelRecord(5000, { id: 'ex-appended', title: `Example appended ${LIFE_MARKER}`, what_it_is: `Synthetic ${LIFE_MARKER}` }));
    const found = await eventually(async () => {
      const r = await get<IntelListResponse>('/v1/intel?q=appended');
      return r.items.length ? r.items : null;
    }, 7_000, 'the appended line');
    // An item's id is its source's and the record's own.
    expect(found.map((i) => i.id)).toEqual([expect.stringMatching(/:ex-appended$/)]);
    await eventually(async () => ticks() > before, 5_000, 'a life.changed tick');

    const capture = captureBody({}, { marked: true });
    const add = await cli('intel', 'add', capture.title, '--url', capture.url as string, '--note', capture.note as string);
    expect(add.code, `${add.out}${add.err}\n${dumpLog()}`).toBe(0);
    const again = await cli('intel', 'add', capture.title, '--url', capture.url as string);
    expect(again.code, again.err).toBe(0);
    expect(again.out).toMatch(/^Already on the shelf \(.+\): nothing added\.$/m);
    const captured = await eventually(async () => {
      const r = await get<IntelListResponse>('/v1/intel?q=capture');
      return r.items.length ? r.items : null;
    }, 7_000, 'the capture on the shelf');
    expect(captured.map((i) => i.url)).toEqual(['https://example.com/new']);

    // No source path, nor the home it lives in, crosses the wire.
    const wire = JSON.stringify(await get<IntelSourcesResponse>('/v1/intel/sources'));
    expect(wire).not.toContain(intelPath);
    expect(wire).not.toContain(d.home.home);
  }, perfBudgetMs(60_000));

  it('12. a broken life.db: 503 with the sentence, the file untouched, the Board up; jantar life restore brings Life back', async () => {
    const backup = await cli('life', 'backup');
    expect(backup.code, `${backup.out}${backup.err}`).toBe(0);
    // One backup a day, named for it: this one holds everything so far.
    const name = /Backed up to .*\/(life-[^/\s]+\.db)$/m.exec(backup.out)?.[1];
    expect(name, backup.out).toBe(`life-${D1}.db`);
    const lifeDb = d.ctx.paths.lifeDb;
    const garbage = Buffer.alloc(4096, 0x5a);
    for (const ws of sockets.splice(0)) ws.close();
    await d.restart(async () => {
      await writeFile(lifeDb, garbage);
      await rm(`${lifeDb}-wal`, { force: true });
      await rm(`${lifeDb}-shm`, { force: true });
    });
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket after the restart');
    await listen('phone');
    await listen('reader');
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

    const status = await get<LifeStatus>('/v1/life/status');
    expect(status.open).toBe(false);
    expect(status.broken).toMatch(/jantar life restore/);
    const today = await call('GET', '/v1/life/today');
    expect(today.status).toBe(503);
    expect((today.body as { error: { code: string; message: string } }).error).toEqual({ code: 'life_unavailable', message: status.broken });
    expect((await call('GET', '/v1/sessions')).status).toBe(200);
    expect(sha(await readFile(lifeDb))).toBe(sha(garbage));

    const restore = await cli('life', 'restore', name as string, '--yes');
    expect(restore.code, `${restore.out}${restore.err}\n${dumpLog()}`).toBe(0);
    expect((await get<LifeStatus>('/v1/life/status')).open).toBe(true);
    const back = await get<Today>('/v1/life/today');
    expect(back.food?.kcal).toBe(420);
    expect((await readdir(d.ctx.paths.home)).some((f) => f.startsWith('life.db.before-restore-'))).toBe(true);
  }, perfBudgetMs(60_000));

  it('13. everything off again: nothing new is visible, Life status still answers', async () => {
    expect((await cli('life', 'off', 'all')).code).toBe(0);
    expect((await cli('intel', 'off')).code).toBe(0);
    expect(await features()).toMatchObject({ life: false, intel: false });
    for (const path of ['/v1/life/today', '/v1/todos', '/v1/medicines', '/v1/food', '/v1/places', '/v1/money', '/v1/intel']) {
      expect((await call('GET', path)).status, path).toBe(403);
    }
    expect((await call('GET', '/v1/life/status')).status).toBe(200);
  });

  it('14. the sweep: no marker in a frame, the ring, the stored events, an audit row, a log line, a push or a write reply', async () => {
    await eventually(async () => frames.phone.length > 0 && frames.reader.length > 0, 5_000, 'frames on both sockets');
    const replay = d.ctx.store.replay(0);
    const ring = replay.kind === 'events' ? replay.events : [];
    const sources: Record<string, unknown> = {
      'WS frames (phone)': frames.phone.map((f) => JSON.parse(f) as unknown),
      'WS frames (read-only)': frames.reader.map((f) => JSON.parse(f) as unknown),
      'event ring': ring,
      'stored events': d.ctx.db.events.since(0),
      'audit rows': d.ctx.db.audit.list({ after: 0, limit: 100_000 }),
      'log lines': d.log.records,
      pushes: d.webPushes,
      'write replies': writes,
    };
    for (const [what, value] of Object.entries(sources)) expect(markersIn(value, MARKERS), what).toEqual([]);
    // The markers were in play: the reads carried them back.
    expect(markersIn(reads, MARKERS)).toEqual(MARKERS);

    // LP8: the read-only device learned no module: life.changed is {}, and no Life id reached it.
    const lifeEvents = [...frames.phone, ...frames.reader]
      .map((f) => JSON.parse(f) as { kind: string; event?: { type: string; data?: unknown } })
      .flatMap((m) => (m.kind === 'event' && m.event?.type === 'life.changed' ? [m.event] : []));
    expect(lifeEvents.length).toBeGreaterThan(10);
    expect(lifeEvents.every((e) => JSON.stringify(e.data) === '{}')).toBe(true);
    const readerText = frames.reader.join('\n');
    for (const [name, id] of Object.entries(ids)) expect(readerText, name).not.toContain(id);
    // LP5: every Life push went to the control device only.
    expect(lifePushes().every((p) => p.endpoint === PHONE_PUSH)).toBe(true);
  });
});
