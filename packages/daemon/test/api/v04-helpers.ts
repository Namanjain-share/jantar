/**
 * Requests that pass validation for every v0.4 route, so a status says
 * something about the pipeline (auth, scope, switch, broken life.db, stub),
 * and settings with every v0.4 switch on or off. Synthetic values only.
 */
import { DEFAULT_LAUNCH_FLAGS, ROUTES, SettingsSchema, type RouteDef, type RouteName, type Settings } from '@jantar/protocol';
import { h, type TestApi } from './fakes.js';

export const ULID = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
export const DOSE_ULID = '01JFZ8X8Y3T0V5G9WQK2M4N6PS';
export const DAY = '2026-10-30';

/** Every v0.4 route, in table order. */
export const V04 = (Object.entries(ROUTES) as [RouteName, RouteDef][]).filter(([, d]) => d.phase === 'v0.4');

/** Every Life module, the shelf and launching on (Life on with them). */
export const V04_ON: Settings = SettingsSchema.parse({
  life: { todos: true, medicines: true, food: true, places: true, finance: true },
  intel: { enabled: true },
  launch: { enabled: true },
});
/** Everything v0.4 off (the defaults). */
export const V04_OFF: Settings = SettingsSchema.parse({});

const PARAMS: Record<string, string> = { id: ULID, doseId: DOSE_ULID, day: DAY };

export const V04_REQ: Partial<Record<RouteName, { query?: string; body?: unknown; params?: Record<string, string> }>> = {
  lifeToday: { query: `?day=${DAY}` },
  lifeRestore: { body: { file: `life-${DAY}.db` } },
  projectCreate: { body: { name: 'Example project' } },
  projectUpdate: { body: { status: 'paused' } },
  todosList: { query: '?done=0' },
  todoCreate: { body: { title: 'Example todo', due: { day: DAY, time: '11:00' } } },
  todoUpdate: { body: { priority: 'high' } },
  todoDone: { body: { done: true } },
  todoSnooze: { body: { preset: 'tomorrow' } },
  medsGet: { query: `?day=${DAY}` },
  medCreate: { body: { name: 'Testamol', dose: '500 mg', times: ['08:00', '21:00'], schedule: { freq: 'daily' }, pills: { left: 10 } } },
  medUpdate: { body: { notes: 'with food' } },
  doseLog: { body: { day: DAY, slot: '08:00', status: 'taken' } },
  foodDay: { query: `?day=${DAY}` },
  foodAdd: { body: { day: DAY, name: 'Roti', kcal: 120 } },
  foodUpdate: { body: { kcal: 130 } },
  foodTargets: { body: { kcalTarget: 1800 } },
  foodEstimate: { body: { text: '2 rotis and dal' } },
  weightSet: { body: { kg: 72.4 } },
  placesList: { query: '?filter=tried' },
  placeCreate: { body: { name: 'Example Café', dishes: [{ name: 'Sample Dosa', rating: 5 }] } },
  placeUpdate: { body: { tried: true } },
  moneyMonth: { query: '?month=2026-10' },
  moneyAdd: { body: { kind: 'expense', amount: 124000, category: 'Groceries', day: DAY } },
  moneyUpdate: { body: { amount: 100 } },
  budgetSet: { body: { category: 'Food', amount: 1000000 } },
  billCreate: { body: { name: 'Example Stream', amount: 64900, category: 'Bills', repeat: 'monthly', nextDue: '2026-11-03' } },
  billUpdate: { body: { amount: 64900 } },
  billPaid: { body: {} },
  intelList: { query: '?q=hooks&limit=10' },
  intelGet: { params: { id: 'captures:01JFZ8X8Y3T0V5G9WQK2M4N6PR' } },
  intelCapture: { body: { title: 'Example capture', url: 'https://example.com/new' } },
  launchHistory: { query: '?root=r.work&path=foo' },
};

export function v04Url(name: RouteName): string {
  const def = ROUTES[name] as RouteDef;
  const params = { ...PARAMS, ...V04_REQ[name]?.params };
  return def.path.replace(/:([A-Za-z]+)/g, (_m, n: string) => encodeURIComponent(params[n] ?? 'x')) + (V04_REQ[name]?.query ?? '');
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** One request to a v0.4 route over a transport, with the valid body when it takes one. */
export function v04Call(api: TestApi, transport: 'tcp' | 'ctl', name: RouteName, headers: Record<string, string> = {}, body?: unknown) {
  const def = ROUTES[name] as RouteDef;
  const payload = body ?? V04_REQ[name]?.body;
  return api[transport].inject({
    method: def.method as Method,
    url: v04Url(name),
    headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

export { DEFAULT_LAUNCH_FLAGS, h };
