/**
 * Synthetic v0.4 data for the README's screenshots (scripts/screenshots.mjs)
 * and the browser checks of the built web app: the v0.3 board fixture with
 * Life and the Intel shelf on, plus what every v0.4 route answers. Every
 * name, medicine, place, amount, link and folder is made up.
 *
 * The day it tells: Friday 30 October 2026, 13:25 in Europe/London (V04_NOW,
 * V04_TZ). Freeze the browser's clock there (Playwright's
 * `clock.setFixedTime`) and set its zone, or the Life screens judge what is
 * due by the real clock. Another `now` moves every day and time with it.
 *
 * - Today: two medicines due at 13:00 (Placebin 10 mg, Testamol 500 mg), the
 *   morning ones taken and one more tonight; two overdue todos and four for
 *   today; two bills within three days; 1,240 of 1,500 kcal and 81.6 kg.
 * - Todos: five projects (two linked to Board folders, so Board rows carry
 *   their chip), reminders, a daily and a weekly repeat.
 * - Food: five entries, saved foods, 20 weights over 30 days, a goal.
 * - Cafés: six places, best first, two still to try.
 * - Finance: this month in GBP, budgets (Food just over), four bills.
 * - Intel: 40 items over the ten types, from a bot's file and the captures.
 * - Resume: four past conversations in ~/Desktop/work/jantar, the newest
 *   still running (Last takes the one before it).
 *
 * `accounts: 'single'` gives one Claude login (account 0, no cswap): no
 * usage, holds or moves anywhere, and the start sheet types `claude`.
 *
 * `v04.answer(method, url)` is what a v0.4 route answers (a GET from the
 * data here; a write `{ id }` or `{ ok: true }`, changing nothing), or null
 * for any other path. `v03.preview` knows `resume`.
 */
import {
  DEFAULT_CATEGORIES,
  DEFAULT_LAUNCH_FLAGS,
  IdReplySchema,
  IntelItemSchema,
  LaunchPreviewSchema,
  LifeStatusSchema,
  MedicineViewSchema,
  MedsDaySchema,
  PastSessionSchema,
  ROUTES,
  TodaySchema,
  launchFlagArgs,
  type Account,
  type Alert,
  type Bill,
  type FoodDay,
  type FoodEntry,
  type IntelItem,
  type IntelListItem,
  type IntelListResponse,
  type LaunchFlags,
  type LaunchPreview,
  type LifeStatus,
  type MedicineView,
  type MedsDay,
  type MedsDayItem,
  type MoneyEntry,
  type MoneyMonth,
  type PastSession,
  type Place,
  type ProjectView,
  type RouteDef,
  type SavedFood,
  type Session,
  type Settings,
  type Today,
  type Todo,
  type Weight,
} from '@jantar/protocol';
import { launchCommand } from '@jantar/daemon/launcher/command';
import { singleAccount } from '@jantar/daemon/sources/cswap/single';
import { dayKeyOf, instantAt, monthOf, shiftDay, shiftMonths, weekdayOf } from '../../packages/life-core/src/index.js';
import { sidOf } from './web-fixture.js';
import { webFixtureV03, type WebFixtureV03 } from './web-fixture-v03.js';

/** Friday 30 October 2026, 13:25 in London (GMT: the clocks went back on the 25th). */
export const V04_NOW = Date.parse('2026-10-30T13:25:00Z');
export const V04_TZ = 'Europe/London';
export const V04_CURRENCY = 'GBP';

/** The folder the start sheet opens on (session 4's, "jantar · board redesign"), as root and path. */
export const RESUME_FOLDER = { root: 'r.work', path: 'jantar' } as const;
/** Where the fixture's cswap and claude live (only ever shown in a command line). */
const CSWAP_BIN = '/usr/local/bin/cswap';
const CLAUDE_BIN = '/usr/local/bin/claude';

const MIN = 60_000;

/** A ulid-shaped id: a fixed head and a number, so every run has the same ids. */
export function lid(n: number): string {
  return `01JV0000000000000000${String(n).padStart(6, '0')}`;
}

/** A 1 x 1 PNG: the v0.3 fixture's terminal screenshot when no real one is passed. */
const DOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqF9fDwAEqQHkV9nOhgAAAABJRU5ErkJggg==',
  'base64',
);

export interface V04Reply {
  status: number;
  body: unknown;
}

export interface V04Fixture {
  status: LifeStatus;
  today: Today;
  projects: ProjectView[];
  /** Open todos, by due. */
  todos: Todo[];
  /** Done todos, newest first. */
  done: Todo[];
  medicines: MedicineView[];
  meds: MedsDay;
  food: FoodDay;
  places: Place[];
  money: MoneyMonth;
  /** Newest first. */
  intel: IntelItem[];
  past: PastSession[];
  /** `/today?dose=` for the first dose due now (Placebin at 13:00). */
  doseKey: string;
  /** What a v0.4 route answers, or null when `url` is not one. Writes change nothing, so no body is read. */
  answer(method: string, url: URL): V04Reply | null;
}

export interface WebFixtureV04 extends WebFixtureV03 {
  v04: V04Fixture;
  /** The instant the data is built around (freeze the browser's clock here). */
  now: number;
  timezone: string;
  accountsMode: 'single' | 'cswap';
}

export interface WebFixtureV04Options {
  now?: number;
  accounts?: 'single' | 'cswap';
  /** The terminal screenshot's bytes for the v0.3 Screen tab (a PNG); a 1 x 1 dot when left out. */
  png?: Buffer;
}

const notFound = (message: string): V04Reply => ({ status: 404, body: { error: { code: 'not_found', message } } });

/** The v0.4 routes as matchers: method, a path pattern with named groups, and the route. */
const V04_ROUTES = (Object.entries(ROUTES) as Array<[string, RouteDef]>)
  .filter(([, r]) => r.phase === 'v0.4')
  .map(([name, r]) => ({ name, method: r.method, re: new RegExp(`^${r.path.replace(/:([A-Za-z]+)/g, '(?<$1>[^/]+)')}$`) }));

function routeOf(method: string, path: string): { name: string; params: Record<string, string> } | null {
  for (const r of V04_ROUTES) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (m) return { name: r.name, params: Object.fromEntries(Object.entries(m.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)])) };
  }
  return null;
}

export function webFixtureV04(opts: WebFixtureV04Options = {}): WebFixtureV04 {
  const now = opts.now ?? V04_NOW;
  const mode = opts.accounts ?? 'cswap';
  const tz = V04_TZ;
  const base = webFixtureV03(opts.png ?? DOT_PNG, now);
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();
  const today = dayKeyOf(new Date(now), tz);
  const day = (n: number) => shiftDay(today, n);
  const at = (d: string, hhmm: string) => instantAt(d, hhmm, tz).toISOString();
  const month = monthOf(today);
  let fresh = 9000;

  // ----- The board: Life and the shelf on, and the accounts mode -----
  const st = base.state.state as unknown as {
    sessions: Record<string, Session>;
    accounts: Record<string, Account>;
    activeAccount: number | null;
    moves: Record<string, unknown>;
    alerts: Alert[];
    launches: Record<string, unknown>;
    lifeTick: number;
    daemon: Record<string, unknown>;
  };
  st.daemon = {
    ...st.daemon,
    protocol: 3,
    daemonVersion: '0.4.0',
    accountsMode: mode,
    features: { ...(st.daemon.features as object), life: true, intel: true },
  };
  st.lifeTick = 1;
  // The Board as it usually is: no start in flight (v03.launches still answers their routes).
  st.launches = {};
  if (mode === 'single') {
    // One login: every session on account 0, nothing about usage, holds or moves.
    st.accounts = { '0': singleAccount() };
    st.activeAccount = 0;
    st.moves = {};
    for (const s of Object.values(st.sessions)) {
      s.account = 0;
      delete (s as { move?: unknown }).move;
    }
    st.alerts = st.alerts.filter((a) => a.kind !== 'limit');
    const plan = base.plan as unknown as { accounts: unknown[]; next: number | null };
    plan.accounts = [];
    plan.next = null;
    base.v03.accounts = [{ id: 0, label: 'Claude', live: Object.values(st.sessions).filter((s) => s.status !== 'ended').length, selectable: true, held: false }];
  }

  // ----- Projects and todos -----
  const P = { docs: lid(101), landing: lid(102), move: lid(103), tax: lid(104), shed: lid(105) };
  const todo = (n: number, title: string, over: Partial<Todo> = {}): Todo => ({
    id: lid(n),
    title,
    priority: 'normal',
    createdAt: iso(60 * 24 * 6 + n),
    updatedAt: iso(60 * 24 + n),
    ...over,
  });
  const wd = weekdayOf(today);
  const sunday = day((7 - wd) % 7 || 7);
  const todos: Todo[] = [
    todo(214, 'Check the new pricing copy', { due: { day: day(-2) }, projectId: P.landing }),
    todo(201, 'Send the insurance form', { due: { day: day(-1) }, priority: 'high', notes: 'The one with the blue header.' }),
    todo(203, 'Review the changelog draft', { due: { day: today }, projectId: P.docs }),
    todo(202, 'Call the landlord about the boiler', { due: { day: today, time: '15:30' }, projectId: P.move }),
    todo(208, 'Stretch break', { due: { day: today, time: '16:00' }, repeat: { freq: 'daily' } }),
    todo(204, 'Water the plants', { due: { day: today, time: '18:30' }, repeat: { freq: 'daily' } }),
    todo(205, 'Book a dentist appointment', { due: { day: day(1), time: '09:30' } }),
    todo(213, 'Update the hero screenshot', { due: { day: day(1) }, projectId: P.landing }),
    todo(206, 'Write the release notes', { due: { day: day(2) }, priority: 'high', projectId: P.docs }),
    todo(209, 'Weekly review', { due: { day: sunday, time: '19:00' }, repeat: { freq: 'weekly', byWeekday: [0] } }),
    todo(207, 'Order moving boxes', { due: { day: day(3) }, projectId: P.move }),
    todo(210, 'Pay back the shared dinner', { due: { day: day(5) } }),
    todo(211, 'Read the hooks guide', { projectId: P.docs }),
    todo(212, 'Try a split keyboard layout'),
  ].sort((a, b) => `${a.due?.day ?? '9'} ${a.due?.time ?? ''}`.localeCompare(`${b.due?.day ?? '9'} ${b.due?.time ?? ''}`));
  const done: Todo[] = [
    todo(215, 'Renew the domain', { due: { day: day(-1) }, doneAt: iso(60 * 20) }),
    todo(216, 'Back up the photos', { doneAt: iso(60 * 30) }),
    todo(217, 'Fix the dripping tap', { due: { day: day(-3) }, projectId: P.move, doneAt: iso(60 * 50) }),
  ];
  const counts = (id: string) => {
    const mine = todos.filter((t) => t.projectId === id);
    return { open: mine.length, overdue: mine.filter((t) => t.due && t.due.day < today).length };
  };
  const project = (id: string, name: string, status: ProjectView['status'], over: Partial<ProjectView> = {}): ProjectView => ({
    id,
    name,
    status,
    createdAt: iso(60 * 24 * 40),
    updatedAt: iso(60 * 24 * 2),
    ...counts(id),
    ...over,
  });
  const projects: ProjectView[] = [
    project(P.docs, 'Jantar docs', 'active', { folder: '/Users/you/Desktop/work/jantar', due: day(6), notes: 'README, screenshots and the security notes for 0.4.' }),
    project(P.landing, 'Landing page', 'active', { folder: '/Users/you/Desktop/work/landing' }),
    project(P.move, 'Move flat', 'active', { due: day(29), notes: 'Keys on the 28th.' }),
    project(P.tax, 'Tax return', 'paused', { due: shiftMonths(today, 3) }),
    project(P.shed, 'Garden shed', 'done'),
  ];

  // ----- Medicines -----
  const M = { testamol: lid(301), placebin: lid(302), examplex: lid(303), sampleprofen: lid(304) };
  const med = (id: string, name: string, dose: string, times: string[], schedule: MedicineView['schedule'], over: Partial<MedicineView> = {}): MedicineView =>
    MedicineViewSchema.parse({
      id,
      name,
      dose,
      times,
      schedule,
      history: [{ from: schedule.startDay, schedule }],
      startedOn: schedule.startDay,
      createdAt: at(schedule.startDay, '09:00'),
      updatedAt: iso(60 * 5),
      supply: null,
      adherencePct: null,
      ...over,
    });
  const medicines: MedicineView[] = [
    med(M.placebin, 'Placebin', '10 mg', ['13:00'], { freq: 'daily', startDay: day(-90) }, {
      pills: { left: 52, perDose: 1 },
      supply: { daysLeft: 52, runsOut: day(52), low: false },
      adherencePct: 100,
    }),
    med(M.testamol, 'Testamol', '500 mg', ['08:00', '13:00', '20:00'], { freq: 'daily', startDay: day(-60) }, {
      pills: { left: 14, perDose: 1 },
      supply: { daysLeft: 4, runsOut: day(4), low: true },
      adherencePct: 94,
      notes: 'After food.',
    }),
    med(M.examplex, 'Examplex', '1000 IU', ['08:00'], { freq: 'weekly', byWeekday: [...new Set([wd, (wd + 3) % 7])].sort((a, b) => a - b), startDay: day(-120) }, {
      adherencePct: 88,
    }),
    med(M.sampleprofen, 'Sampleprofen', '200 mg', ['21:00'], { freq: 'daily', startDay: day(-30) }, { stoppedOn: day(-12), adherencePct: 91 }),
  ];
  const item = (medId: string, name: string, dose: string, slot: string, status: MedsDayItem['status'], over: Partial<MedsDayItem> = {}): MedsDayItem => ({
    medId,
    name,
    dose,
    slot,
    status,
    overdue: false,
    ...over,
  });
  const groups = (items: MedsDayItem[]): MedsDay['groups'] => {
    const period = (slot: string) => (slot < '12:00' ? 'morning' : slot < '18:00' ? 'afternoon' : 'night');
    return (['morning', 'afternoon', 'night'] as const)
      .map((p) => ({ period: p, items: items.filter((i) => period(i.slot) === p).sort((a, b) => a.slot.localeCompare(b.slot) || a.name.localeCompare(b.name)) }))
      .filter((g) => g.items.length > 0);
  };
  /** The day's checklist: today as the story says; an earlier day all taken but one missed dose two days back. */
  const medsDay = (d: string): MedsDay => {
    if (d === today) {
      return MedsDaySchema.parse({
        day: d,
        today,
        groups: groups([
          item(M.testamol, 'Testamol', '500 mg', '08:00', 'taken', { doseId: lid(401), at: at(d, '08:12') }),
          item(M.examplex, 'Examplex', '1000 IU', '08:00', 'taken', { doseId: lid(402), at: at(d, '08:12') }),
          item(M.placebin, 'Placebin', '10 mg', '13:00', 'pending'),
          item(M.testamol, 'Testamol', '500 mg', '13:00', 'pending'),
          item(M.testamol, 'Testamol', '500 mg', '20:00', 'pending'),
        ]),
      });
    }
    const n = Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
    const taken = (medId: string, name: string, dose: string, slot: string, k: number) =>
      n === -2 && slot === '20:00'
        ? item(medId, name, dose, slot, 'missed')
        : item(medId, name, dose, slot, 'taken', { doseId: lid(500 + Math.abs(n) * 10 + k), at: at(d, `${slot.slice(0, 3)}0${k}`) });
    return MedsDaySchema.parse({
      day: d,
      today,
      groups: groups([
        taken(M.testamol, 'Testamol', '500 mg', '08:00', 1),
        taken(M.testamol, 'Testamol', '500 mg', '13:00', 2),
        taken(M.placebin, 'Placebin', '10 mg', '13:00', 3),
        taken(M.testamol, 'Testamol', '500 mg', '20:00', 4),
      ]),
    });
  };
  const meds = medsDay(today);

  // ----- Food and weight -----
  const entry = (n: number, hhmm: string, name: string, kcal: number, d = today): FoodEntry => ({
    id: lid(n),
    day: d,
    at: at(d, hhmm),
    name,
    kcal,
    createdAt: at(d, hhmm),
    updatedAt: at(d, hhmm),
  });
  const entries: FoodEntry[] = [
    entry(601, '08:40', 'Poha', 280),
    entry(602, '10:15', 'Flat white', 120),
    entry(603, '11:30', 'Apple', 95),
    entry(604, '13:05', 'Rajma and rice', 545),
    entry(605, '13:20', 'Dark chocolate, two squares', 200),
  ];
  const saved: SavedFood[] = [
    { id: lid(651), name: 'Flat white', kcal: 120, uses: 14 },
    { id: lid(652), name: 'Poha', kcal: 280, uses: 9 },
    { id: lid(653), name: 'Apple', kcal: 95, uses: 7 },
    { id: lid(654), name: 'Greek yoghurt and honey', kcal: 190, uses: 5 },
    { id: lid(655), name: 'Dal and two rotis', kcal: 420, uses: 4 },
  ];
  // Newest first; 7 and 30 days back are on the list, so the changes read -0.6 and -1.6.
  const KG: Array<[number, number]> = [
    [0, 81.6], [-1, 81.8], [-2, 81.7], [-3, 82.0], [-5, 81.9], [-6, 82.1], [-7, 82.2], [-9, 82.3], [-10, 82.2], [-12, 82.5],
    [-14, 82.4], [-16, 82.7], [-17, 82.6], [-19, 82.8], [-21, 83.0], [-23, 82.9], [-24, 83.1], [-26, 83.0], [-28, 83.3], [-30, 83.2],
  ];
  const recent: Weight[] = KG.map(([n, kg]) => ({ day: day(n), kg }));
  const weight = { latest: recent[0] ?? null, change7: -0.6, change30: -1.6, goalKg: 78, recent };
  // The daily target a new Life starts with (KCAL_TARGET_DEFAULT).
  const TARGET = 1500;
  const foodDay = (d: string): FoodDay => {
    const list = d === today ? entries : [];
    return { day: d, today, target: TARGET, kcal: list.reduce((s, e) => s + e.kcal, 0), entries: list, saved, weight };
  };
  const food = foodDay(today);

  // ----- Cafés -----
  const place = (n: number, name: string, area: string, tried: boolean, dishes: Place['dishes'], over: Partial<Place> = {}): Place => ({
    id: lid(n),
    name,
    area,
    tried,
    dishes,
    best: dishes.length ? Math.max(...dishes.map((x) => x.rating)) : null,
    createdAt: iso(60 * 24 * (n - 680)),
    updatedAt: iso(60 * 24 * (n - 690 + 3)),
    ...over,
  });
  const places: Place[] = [
    place(701, 'Sample Dosa House', 'Market Street', true, [
      { name: 'Ghee roast dosa', rating: 5 },
      { name: 'Filter coffee', rating: 5 },
      { name: 'Rava idli', rating: 3 },
    ], { link: 'https://maps.example.com/?q=sample-dosa-house', notes: 'Go before noon on weekends.' }),
    place(702, 'Example Café', 'Old Town', true, [
      { name: 'Cardamom bun', rating: 5 },
      { name: 'Flat white', rating: 4 },
    ], { link: 'https://maps.example.com/?q=example-cafe' }),
    place(703, 'Placeholder Pizza', 'Riverside', true, [
      { name: 'Margherita', rating: 4 },
      { name: 'Garlic knots', rating: 3 },
    ]),
    place(704, 'Demo Noodle Bar', 'Station Road', true, [{ name: 'Dan dan noodles', rating: 4 }]),
    place(705, 'Fixture Bakery', 'Hill Lane', false, [], { notes: 'Sourdough on Saturdays.' }),
    place(706, 'Mock Ramen', 'Canal Side', false, []),
  ];

  // ----- Finance -----
  const B = { gym: lid(901), stream: lid(902), phone: lid(903), domain: lid(904) };
  const bill = (id: string, name: string, amount: number, category: string, repeat: Bill['repeat'], nextDue: string): Bill => ({
    id,
    name,
    amount,
    category,
    repeat,
    nextDue,
    byMonthDay: Number(nextDue.slice(8)),
    createdAt: iso(60 * 24 * 200),
    updatedAt: iso(60 * 24 * 20),
  });
  const bills: Bill[] = [
    bill(B.gym, 'Gym', 3500, 'Health', 'monthly', day(2)),
    bill(B.stream, 'Example Stream', 1099, 'Bills', 'monthly', day(3)),
    bill(B.phone, 'Phone plan', 1500, 'Bills', 'monthly', day(6)),
    bill(B.domain, 'Domain renewal', 1200, 'Bills', 'yearly', shiftMonths(today, 4)),
  ];
  // [days back, kind, hundredths, category, note, bill]
  const MONEY: Array<[number, MoneyEntry['kind'], number, string, string, string?]> = [
    [0, 'expense', 1240, 'Food', 'Example Café'],
    [-1, 'expense', 4875, 'Groceries', 'Weekly shop'],
    [-2, 'expense', 1800, 'Fun', 'Cinema'],
    [-4, 'expense', 2380, 'Food', 'Sample Dosa House'],
    [-5, 'expense', 3500, 'Shopping', 'Desk lamp'],
    [-7, 'expense', 6420, 'Groceries', 'Weekly shop'],
    [-9, 'expense', 950, 'Health', 'Pharmacy'],
    [-11, 'expense', 7200, 'Bills', 'Electricity'],
    [-12, 'expense', 4600, 'Food', 'Placeholder Pizza, with friends'],
    [-14, 'expense', 5210, 'Groceries', 'Weekly shop'],
    [-18, 'expense', 8900, 'Transport', 'Train pass'],
    [-20, 'expense', 3150, 'Food', 'Lunches'],
    [-21, 'expense', 5980, 'Groceries', 'Weekly shop'],
    [-25, 'expense', 4200, 'Food', 'Takeaway'],
    [-26, 'income', 15000, 'Other', 'Sold the old monitor'],
    [-27, 'expense', 1099, 'Bills', 'Example Stream', B.stream],
    [-28, 'income', 320000, 'Salary', 'Salary'],
    [-29, 'expense', 115000, 'Rent', 'Rent'],
  ];
  const moneyEntries: MoneyEntry[] = MONEY.map(([n, kind, amount, category, note, billId], i) => ({
    id: lid(801 + i),
    kind,
    amount,
    category,
    note,
    day: day(n),
    ...(billId ? { billId } : {}),
    createdAt: at(day(n), '19:00'),
    updatedAt: at(day(n), '19:00'),
  }));
  const BUDGETS: Record<string, number> = { Food: 15000, Groceries: 25000, Fun: 6000, Transport: 12000 };
  const moneyMonth = (m: string): MoneyMonth => {
    const list = moneyEntries.filter((e) => monthOf(e.day) === m);
    const spentBy = new Map<string, number>();
    for (const e of list) if (e.kind === 'expense') spentBy.set(e.category, (spentBy.get(e.category) ?? 0) + e.amount);
    for (const c of Object.keys(BUDGETS)) if (!spentBy.has(c)) spentBy.set(c, 0);
    return {
      month: m,
      currency: V04_CURRENCY,
      entries: list,
      spent: list.filter((e) => e.kind === 'expense').reduce((s, e) => s + e.amount, 0),
      income: list.filter((e) => e.kind === 'income').reduce((s, e) => s + e.amount, 0),
      byCategory: [...spentBy].map(([category, spent]) => ({ category, spent, budget: BUDGETS[category] ?? null })).sort((a, b) => b.spent - a.spent),
      categories: [...new Set([...DEFAULT_CATEGORIES.expense, ...DEFAULT_CATEGORIES.income])],
      bills,
    };
  };
  const money = moneyMonth(month);

  // ----- Status and Today -----
  const status: LifeStatus = LifeStatusSchema.parse({
    open: true,
    timezone: tz,
    today,
    currency: V04_CURRENCY,
    lockScreenDetails: false,
    // v0.7's Posts stay off here, as on a Mac that has not turned them on (web-fixture-v051.ts's 'posts' variant shows them).
    modules: { todos: true, medicines: true, food: true, places: true, finance: true, posts: false },
    estimate: { available: true },
    backups: { last: at(today, '03:30'), count: 30 },
    push: { devices: 2, webpush: true },
  });
  const todayView: Today = TodaySchema.parse({
    day: today,
    meds,
    todos: { overdue: todos.filter((t) => t.due && t.due.day < today), today: todos.filter((t) => t.due?.day === today) },
    food: { kcal: food.kcal, target: TARGET, weight: weight.latest },
    bills: bills.filter((b) => b.nextDue <= day(3)),
  });

  // ----- Intel -----
  // [type, title, what it is, tags]
  const SHELF: Array<[string, string, string, string[]]> = [
    ['tool', 'Hook recipes for permission prompts', 'A small set of PreToolUse hooks that stop destructive shell commands before they run.', ['claude-code', 'hooks']],
    ['repo', 'Terminal tab lister in Swift', 'Lists every Terminal tab with its process, its folder and how long it has been idle.', ['macos', 'terminal']],
    ['teardown', 'How a usage-based pricing page explains overages', 'Walks through one pricing page: the free tier, the meter and the first bill.', ['pricing', 'saas']],
    ['design', 'Dense tables that still read on a phone', 'Two-line rows, a mono column for numbers and no horizontal scroll.', ['ui', 'mobile']],
    ['prompt', 'Review a diff for missing tests', 'A short prompt that lists the changed functions and asks which have no test.', ['prompts', 'testing']],
    ['market-signal', 'Teams budgeting agent seats per developer', 'Several hiring posts now list an agent budget beside the laptop budget.', ['agents', 'market']],
    ['resource-list', 'Reading list: local-first sync', 'Ten essays and talks on CRDTs, sync engines and offline apps.', ['local-first', 'sync']],
    ['feature-idea', 'Show where a session will move before it moves', 'A line on the session card: the next account and why it was picked.', ['accounts', 'ux']],
    ['business-idea', 'A weekly digest of a team\'s agent sessions', 'What each session shipped, what it was stuck on, what it cost.', ['agents', 'reporting']],
    ['person', '@example: phone-first dashboard studies', 'Posts one small dashboard study a week, always drawn at phone width first.', ['design', 'people']],
    ['tool', 'A CLI that turns a folder into a PDF book', 'Markdown in, one PDF out, with a table of contents and page numbers.', ['cli', 'docs']],
    ['repo', 'Tiny SQLite migration runner', 'Numbered SQL files, one transaction each, and a schema version in a meta table.', ['sqlite', 'node']],
    ['design', 'Status glyphs that survive grayscale', 'Every state gets its own shape, so colour is never the only signal.', ['ui', 'accessibility']],
    ['teardown', 'Onboarding of a notes app in four screens', 'Each screen asks for one thing; the empty state teaches the first action.', ['onboarding', 'mobile']],
    ['prompt', 'Turn a voice note into a task list', 'Splits dictated text into short, checkable tasks and keeps the names.', ['prompts', 'voice']],
    ['market-signal', 'More job posts ask for evaluation skills', 'Roles now mention writing evals and reading traces, not only prompts.', ['agents', 'jobs']],
    ['tool', 'Menu bar meter for API spend', 'Shows today\'s spend against a daily cap and warns at 80%.', ['macos', 'costs']],
    ['resource-list', 'Accessible colour palettes', 'Palettes with contrast ratios listed for text, borders and charts.', ['design', 'accessibility']],
    ['feature-idea', 'Undo for deletes instead of confirm dialogs', 'A five-second Undo bar is faster than a dialog and just as safe.', ['ux', 'life']],
    ['repo', 'Push notifications without a server SDK', 'Web Push with VAPID and the aes128gcm encoding, in one small module.', ['web-push', 'node']],
    ['business-idea', 'Calorie estimates for home cooking', 'Type what you ate; get editable rows, not a food database.', ['food', 'ai']],
    ['teardown', 'A finance app that only tracks categories', 'No bank sync: amounts by hand, budgets by category, bills that remind.', ['finance', 'simple']],
    ['person', '@example: writes about calm software', 'Essays on apps that do less and stay out of the way.', ['writing', 'people']],
    ['tool', 'QR pairing for a local web app', 'One-time codes in the URL fragment, so they never reach a server log.', ['security', 'pairing']],
    ['design', 'A ledger look for dashboards', 'Cream and navy, hairline rules, mono numbers, one accent colour.', ['ui', 'style']],
    ['prompt', 'Ask for a plan before any edit', 'Makes the model list the files it will touch and wait for an answer.', ['prompts', 'claude-code']],
    ['repo', 'Medicine schedule logic with tests', 'Dose times, every N days, weekdays and adherence over 30 days.', ['health', 'library']],
    ['market-signal', 'Fair-source licences on new dev tools', 'More tools ship under licences that turn permissive after two years.', ['licensing', 'market']],
    ['resource-list', 'Writing good error messages', 'What happened, why, and the one thing to do next.', ['writing', 'ux']],
    ['tool', 'Tunnel with an identity check in front', 'Exposes a local port only to people who signed in first.', ['networking', 'security']],
    ['feature-idea', 'Prime an idle account\'s window early', 'Start the five-hour clock on an unused account so it resets sooner.', ['accounts', 'limits']],
    ['teardown', 'Pricing for a per-seat agent product', 'Seats, a usage pool and a hard cap per workspace.', ['pricing', 'agents']],
    ['design', 'Bottom sheets that respect the keyboard', 'The sheet grows with the keyboard; the primary button stays in reach.', ['mobile', 'ui']],
    ['repo', 'JSONL follower with partial-line handling', 'Reads appends, holds a partial last line and skips oversized lines.', ['node', 'files']],
    ['person', '@example: small business automation threads', 'Threads on replacing spreadsheets with one small script at a time.', ['automation', 'people']],
    ['business-idea', 'Shared shelf of links for a small team', 'Bots and people add links; everyone searches one list.', ['knowledge', 'teams']],
    ['prompt', 'Summarise a long transcript in five lines', 'What was asked, what changed, what is left, and any risk.', ['prompts', 'summaries']],
    ['market-signal', 'Phones as the main screen for agent work', 'More people approve and steer agent runs from a phone.', ['mobile', 'agents']],
    ['tool', 'Captured from the phone: a cron expression explainer', 'Paste a cron line, read when it runs in plain words.', ['cli', 'time']],
    ['resource-list', 'Captured from the CLI: SQLite pragmas worth knowing', 'WAL, busy timeout, foreign keys and quick_check.', ['sqlite', 'reference']],
  ];
  const intel: IntelItem[] = SHELF.map(([type, title, summary, tags], i) => {
    const captured = i >= SHELF.length - 2;
    const n = SHELF.length - i;
    return IntelItemSchema.parse({
      id: captured ? `captures:c-${String(n).padStart(4, '0')}` : `intel:rec-${String(n).padStart(4, '0')}`,
      source: captured ? 'captures' : 'intel',
      // Captures are the oldest two here; the rest are about four hours apart, newest first.
      at: iso(25 + i * 237),
      title,
      url: `https://example.com/shelf/${n}`,
      type,
      tags,
      summary,
      why: 'Close to what we are building; worth a closer look when there is time.',
      fields: captured
        ? [{ key: 'via', value: i === SHELF.length - 1 ? 'cli' : 'phone' }]
        : [
            { key: 'source_post_url', value: `https://example.com/post/${n}` },
            { key: 'source_handle', value: '@example' },
            { key: 'product_angle', value: 'A smaller version could live inside an existing tool.' },
            { key: 'replicable', value: n % 3 === 0 ? 'no' : 'yes' },
            { key: 'depth', value: n % 2 === 0 ? 'deep' : 'skim' },
            { key: 'status', value: 'new' },
          ],
    });
  });
  const listItem = (x: IntelItem): IntelListItem => ({
    id: x.id,
    source: x.source,
    at: x.at,
    title: x.title,
    ...(x.url ? { url: x.url } : {}),
    ...(x.type ? { type: x.type } : {}),
    tags: x.tags,
    ...(x.summary ? { summary: x.summary.slice(0, 240) } : {}),
  });
  const intelList = (q: URLSearchParams): IntelListResponse => {
    const text = (q.get('q') ?? '').trim().toLowerCase();
    const type = q.get('type');
    const tag = q.get('tag');
    const matching = intel.filter(
      (x) => (!text || `${x.title} ${x.summary ?? ''}`.toLowerCase().includes(text)) && (!type || x.type === type) && (!tag || x.tags.includes(tag)),
    );
    const limit = Math.min(100, Math.max(1, Number(q.get('limit') ?? 50) || 50));
    const before = q.get('before');
    const from = before ? matching.findIndex((x) => x.id === before) + 1 : 0;
    const page = matching.slice(from, from + limit);
    const tally = (keys: string[]) => {
      const m = new Map<string, number>();
      for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
      return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    };
    return {
      items: page.map(listItem),
      next: from + limit < matching.length ? (page.at(-1)?.id ?? null) : null,
      total: matching.length,
      types: tally(intel.flatMap((x) => (x.type ? [x.type] : []))).map(([t, n]) => ({ type: t, n })),
      tags: tally(intel.flatMap((x) => x.tags))
        .slice(0, 30)
        .map(([t, n]) => ({ tag: t, n })),
    };
  };
  const sources = [
    { id: 'intel', label: 'intel', items: intel.filter((x) => x.source === 'intel').length, skipped: 0, updatedAt: iso(25) },
    { id: 'captures', label: 'captures', items: intel.filter((x) => x.source === 'captures').length, skipped: 0, updatedAt: iso(25 + 38 * 237) },
  ];

  // ----- Resume: the folder's past conversations, and the preview that knows them -----
  const past: PastSession[] = [
    { id: sidOf(4), account: null, lastAt: iso(2), first: 'redesign the board rails for the phone', live: true },
    { id: '0b4e7c4e-1111-4111-8111-00000000a001', account: null, lastAt: iso(185), first: 'tighten the density gates on the board', live: false },
    { id: '0b4e7c4e-2222-4222-8222-00000000a002', account: mode === 'single' ? null : 7, lastAt: iso(60 * 26), first: 'write the start sheet copy for Resume', live: false },
    { id: '0b4e7c4e-3333-4333-8333-00000000a003', account: null, lastAt: iso(60 * 50), first: 'add type and tag filters to the shelf', live: false },
  ].map((p) => PastSessionSchema.parse(p));
  const launch = { mode: mode === 'single' ? 'claude' : 'cswap-run', shareHistory: true, csCommand: 'cs', preLaunchArgv: [] } as unknown as Settings['launch'];
  base.v03.preview = (q: URLSearchParams): LaunchPreview => {
    const flags: LaunchFlags = { ...DEFAULT_LAUNCH_FLAGS };
    const permission = q.get('permission');
    if (permission) flags.permission = permission as LaunchFlags['permission'];
    const chrome = q.get('chrome');
    if (chrome !== null) flags.chrome = chrome === '1';
    const effort = q.get('effort');
    if (effort) flags.effort = effort as LaunchFlags['effort'];
    const model = q.get('model');
    if (model) flags.model = model as LaunchFlags['model'];
    const path = q.get('path') ?? '';
    const name = path.split('/').pop() || 'work';
    const resumed = past.find((p) => p.id === q.get('resume'));
    const asked = q.get('account');
    let account: LaunchPreview['account'];
    if (mode === 'single') account = { pick: 0, source: 'auto', reason: 'one Claude login' };
    else if (resumed && resumed.account !== null) account = { pick: resumed.account, source: 'resume', reason: `This conversation is on ${String(resumed.account).padStart(2, '0')}` };
    else if (asked !== null && asked !== 'auto') account = { pick: Number(asked), source: 'manual', reason: `${asked.padStart(2, '0')} · resets in 2h10` };
    else account = { pick: 7, source: 'auto', reason: 'most room · 5h 12% · resets in 3h02 · 16:27' };
    const args = launchFlagArgs(flags);
    const built = launchCommand({
      folder: path ? `/Users/you/Desktop/work/${path}` : '/Users/you/Desktop/work',
      account: account.pick,
      args,
      sid: resumed ? resumed.id : null,
      resume: resumed !== undefined,
      name,
      launch,
      cswap: CSWAP_BIN,
      claude: CLAUDE_BIN,
    });
    if (!built.ok) throw new Error(`the fixture's command did not build: ${built.reason}`);
    return LaunchPreviewSchema.parse({
      root: q.get('root') ?? RESUME_FOLDER.root,
      path,
      display: path ? `~/Desktop/work/${path}` : '~/Desktop/work',
      account,
      accounts: base.v03.accounts,
      flags,
      defaults: DEFAULT_LAUNCH_FLAGS,
      args,
      command: built.command,
      name,
      warnings: [],
    });
  };

  // ----- What each v0.4 route answers -----
  const answer = (method: string, url: URL): V04Reply | null => {
    const r = routeOf(method, url.pathname);
    if (!r) return null;
    const q = url.searchParams;
    const ok = (b: unknown): V04Reply => ({ status: 200, body: b });
    const qDay = q.get('day');
    switch (r.name) {
      case 'lifeStatus':
        return ok(status);
      case 'lifeToday':
        return ok(todayView);
      case 'projectsList':
        return ok({ projects });
      case 'todosList': {
        const p = q.get('project');
        const list = q.get('done') === '1' ? done : todos;
        return ok({ today, todos: p ? list.filter((t) => (p === 'none' ? !t.projectId : t.projectId === p)) : list });
      }
      case 'medsGet':
        return ok({ day: medsDay(qDay && qDay <= today ? qDay : today), medicines });
      case 'foodDay':
        return ok(foodDay(qDay && qDay <= today ? qDay : today));
      case 'placesList': {
        const f = q.get('filter');
        return ok({ places: places.filter((p) => (f === 'tried' ? p.tried : f === 'want' ? !p.tried : true)) });
      }
      case 'moneyMonth':
        return ok(moneyMonth(q.get('month') ?? month));
      case 'intelList':
        return ok(intelList(q));
      case 'intelGet': {
        const x = intel.find((i) => i.id === r.params.id);
        return x ? ok({ item: x }) : notFound('no such item on the shelf');
      }
      case 'intelSources':
        return ok({ sources });
      case 'intelCapture':
        return ok({ id: `captures:c-${++fresh}`, duplicate: false });
      case 'foodEstimate':
        return ok({ items: [{ name: 'Roti', kcal: 240 }, { name: 'Dal', kcal: 180 }], note: 'Two medium rotis and one bowl of dal.' });
      case 'launchHistory':
        return ok({ sessions: (q.get('path') ?? '') === RESUME_FOLDER.path ? past : [] });
      case 'lifeBackup':
      case 'lifeRestore':
        return { status: 403, body: { error: { code: 'forbidden', message: 'Only the Mac can do this: jantar life backup' } } };
      default: {
        // Every other v0.4 route is a write: an id for a create, else ok. Nothing changes.
        const wantsId = (ROUTES[r.name as keyof typeof ROUTES] as RouteDef).response === IdReplySchema;
        return ok(wantsId ? { id: lid(++fresh) } : { ok: true });
      }
    }
  };

  return {
    ...base,
    now,
    timezone: tz,
    accountsMode: mode,
    v04: {
      status,
      today: todayView,
      projects,
      todos,
      done,
      medicines,
      meds,
      food,
      places,
      money,
      intel,
      past,
      doseKey: `${M.placebin}@1300`,
      answer,
    },
  };
}

/** The same fixture on a Mac with one Claude login and no cswap. */
export function webFixtureV04Single(opts: Omit<WebFixtureV04Options, 'accounts'> = {}): WebFixtureV04 {
  return webFixtureV04({ ...opts, accounts: 'single' });
}
