/**
 * v0.4 shapes: protocol 3, the med and life notify kinds, the one text-free
 * `life.changed` tick (LP8, protocol part), the two feature flags, accounts
 * mode, resume on a start, and the Life and Intel schemas' edges.
 */
import { describe, expect, it } from 'vitest';
import {
  BillPaidBodySchema,
  DayKeySchema,
  DoseBodySchema,
  ERROR_STATUS,
  EVENT,
  FeaturesSchema,
  FoodBodySchema,
  FoodEstimateBodySchema,
  FoodEstimateSchema,
  FoodTargetsBodySchema,
  FOOD_ESTIMATE_TEXT_MAX,
  HhMmSchema,
  IntelCaptureBodySchema,
  IntelIdSchema,
  IntelItemSchema,
  LaunchJobSchema,
  LaunchPreviewQuerySchema,
  LaunchStartBodySchema,
  LifeIdSchema,
  LifeRestoreBodySchema,
  MedScheduleBodySchema,
  MedScheduleSchema,
  MedicineBodySchema,
  MedicinePatchSchema,
  MonthKeySchema,
  NO_FEATURES,
  NotifyKindSchema,
  PROTOCOL_VERSION,
  PastSessionSchema,
  PlaceBodySchema,
  RepeatSchema,
  StateSchema,
  TodoBodySchema,
  TodoPatchSchema,
  V03_LAUNCH_FLAGS,
  emptyState,
  parseEvent,
  reduce,
  type LaunchJob,
} from '../src/index.js';
import { T0, ev, resetSeq } from './helpers.js';

const ULID = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const UUID = '0b4e7c4e-0000-4000-8000-000000000000';

describe('protocol 3', () => {
  it('is version 3, with med and life notify kinds and the two v0.4 error codes', () => {
    expect(PROTOCOL_VERSION).toBe(3);
    expect(NotifyKindSchema.options).toEqual(expect.arrayContaining(['med', 'life']));
    expect(ERROR_STATUS.life_unavailable).toBe(503);
    expect(ERROR_STATUS.estimate_failed).toBe(502);
  });
});

describe('life.changed (LP8, protocol part)', () => {
  it('carries nothing: any key in its data is refused', () => {
    resetSeq();
    expect(() => parseEvent({ seq: 1, ts: T0, type: 'life.changed', data: {} })).not.toThrow();
    for (const data of [{ area: 'medicines' }, { id: ULID }, { text: 'x' }]) {
      expect(() => parseEvent({ seq: 1, ts: T0, type: 'life.changed', data })).toThrow();
    }
    expect(EVENT.LIFE_CHANGED).toBe('life.changed');
  });

  it('moves one counter, lifeTick, and nothing else', () => {
    resetSeq();
    const s0 = emptyState();
    expect(s0.lifeTick).toBe(0);
    const s1 = reduce(s0, ev({ type: 'life.changed', data: {} }));
    const s2 = reduce(s1, ev({ type: 'life.changed', data: {} }));
    expect(s2.lifeTick).toBe(2);
    expect({ ...s2, seq: 0, lifeTick: 0 }).toEqual(s0);
    // A state from an older daemon has no counter: the first tick makes it 1.
    const { lifeTick: _gone, ...older } = s0;
    expect(StateSchema.parse(older).lifeTick).toBeUndefined();
    expect(reduce({ ...older, seq: 0 }, ev({ type: 'life.changed', data: {} })).lifeTick).toBe(1);
  });

  it('gives clients life and intel only, never a per-module flag', () => {
    expect(Object.keys(NO_FEATURES).sort()).toEqual(
      // v0.5 adds meetings (v05.test.ts), v0.6 fleet (v06.test.ts).
      ['clearDraft', 'controls', 'escape', 'files', 'fleet', 'intel', 'launch', 'life', 'meetings', 'rewrite', 'screenshotSelect', 'screenshots'].sort(),
    );
    for (const m of ['todos', 'medicines', 'food', 'places', 'finance']) expect(Object.keys(FeaturesSchema.shape)).not.toContain(m);
    // An older daemon sends neither: both off.
    const { life: _l, intel: _i, ...older } = NO_FEATURES;
    expect(FeaturesSchema.parse({ ...older, files: true })).toMatchObject({ life: false, intel: false });
  });

  it('carries the accounts mode on daemon.version into state.daemon', () => {
    resetSeq();
    const s = reduce(
      emptyState(),
      ev({ type: 'daemon.version', data: { protocol: 3, daemonVersion: '0.4.0', webHash: null, features: { ...NO_FEATURES }, accountsMode: 'single' } }),
    );
    expect(s.daemon?.accountsMode).toBe('single');
    expect(() => parseEvent({ seq: 9, ts: T0, type: 'daemon.version', data: { protocol: 3, daemonVersion: '0.4.0', webHash: null, accountsMode: 'many' } })).toThrow();
  });
});

describe('resume on a start', () => {
  const start = { root: 'r.work', path: 'foo', account: 'auto' as const, flags: { ...V03_LAUNCH_FLAGS } };

  it('takes a uuid only, and stays strict', () => {
    expect(LaunchStartBodySchema.safeParse({ ...start, resume: UUID }).success).toBe(true);
    expect(LaunchStartBodySchema.safeParse({ ...start, resume: 'last' }).success).toBe(false);
    expect(LaunchStartBodySchema.safeParse({ ...start, resume: `${UUID} --dangerously-skip-permissions` }).success).toBe(false);
    expect(LaunchStartBodySchema.safeParse({ ...start, continue: true }).success).toBe(false);
    expect(LaunchPreviewQuerySchema.parse({ root: 'r.work', resume: UUID }).resume).toBe(UUID);
    expect(LaunchPreviewQuerySchema.safeParse({ root: 'r.work', resume: '../x' }).success).toBe(false);
  });

  it('marks a resumed launch, its pinned account, and a past session', () => {
    const job: LaunchJob = {
      id: 'l-1',
      createdAt: T0,
      updatedAt: T0,
      actor: 'cli',
      rootId: 'r.work',
      folder: '/synthetic/work/foo',
      display: '~/work/foo',
      account: 3,
      accountSource: 'resume',
      requested: 'auto',
      flags: { ...V03_LAUNCH_FLAGS },
      dangerous: true,
      name: 'foo',
      sid: UUID,
      resumed: true,
      stage: 'queued',
      steps: [],
    };
    expect(LaunchJobSchema.parse(job)).toEqual(job);
    expect(PastSessionSchema.safeParse({ id: UUID, account: null, lastAt: T0, first: 'fix the push', live: false }).success).toBe(true);
    expect(PastSessionSchema.safeParse({ id: UUID, account: 3, lastAt: T0, first: 'x'.repeat(81), live: false }).success).toBe(false);
  });
});

describe('Life schemas', () => {
  it('ids, days, months and times', () => {
    expect(LifeIdSchema.safeParse(ULID).success).toBe(true);
    expect(LifeIdSchema.safeParse(ULID.toLowerCase()).success).toBe(false);
    expect(LifeIdSchema.safeParse('01JFZ8X8Y3T0V5G9WQK2M4N6PI').success).toBe(false); // I is not Crockford
    expect(DayKeySchema.safeParse('2026-10-30').success).toBe(true);
    for (const d of ['2026-13-01', '2026-10-32', '26-10-30', '2026-1-3']) expect(DayKeySchema.safeParse(d).success, d).toBe(false);
    expect(MonthKeySchema.safeParse('2026-10').success).toBe(true);
    expect(HhMmSchema.safeParse('23:59').success).toBe(true);
    expect(HhMmSchema.safeParse('24:00').success).toBe(false);
  });

  it('a repeat is daily, weekly on chosen days or monthly, and needs a due day', () => {
    expect(RepeatSchema.safeParse({ freq: 'weekly', byWeekday: [1, 3] }).success).toBe(true);
    for (const r of [{ freq: 'yearly' }, { freq: 'daily', interval: 2 }, { freq: 'weekly', byWeekday: [] }, { freq: 'weekly', byWeekday: [7] }]) {
      expect(RepeatSchema.safeParse(r).success, JSON.stringify(r)).toBe(false);
    }
    // byMonthDay keeps a monthly repeat's date (the daemon sets it); only a monthly repeat has one.
    expect(RepeatSchema.safeParse({ freq: 'monthly', byMonthDay: 31 }).success).toBe(true);
    for (const r of [{ freq: 'weekly', byMonthDay: 3 }, { freq: 'monthly', byMonthDay: 0 }, { freq: 'monthly', byMonthDay: 32 }]) {
      expect(RepeatSchema.safeParse(r).success, JSON.stringify(r)).toBe(false);
    }
    expect(TodoBodySchema.safeParse({ title: 'Water the plants', repeat: { freq: 'daily' } }).success).toBe(false);
    expect(TodoBodySchema.safeParse({ title: 'Water the plants', due: { day: '2026-10-30' }, repeat: { freq: 'daily' } }).success).toBe(true);
    expect(TodoPatchSchema.safeParse({ repeat: { freq: 'daily' }, due: null }).success).toBe(false);
    expect(TodoPatchSchema.safeParse({ notes: null, projectId: null }).success).toBe(true);
    expect(TodoBodySchema.safeParse({ title: '   ' }).success).toBe(false);
  });

  it('a medicine schedule keeps interval with every N days and weekdays with weekly', () => {
    expect(MedScheduleSchema.safeParse({ freq: 'interval', interval: 3, startDay: '2026-10-01' }).success).toBe(true);
    expect(MedScheduleSchema.safeParse({ freq: 'interval', startDay: '2026-10-01' }).success).toBe(false);
    expect(MedScheduleSchema.safeParse({ freq: 'daily', interval: 3, startDay: '2026-10-01' }).success).toBe(false);
    expect(MedScheduleSchema.safeParse({ freq: 'daily', byWeekday: [1], startDay: '2026-10-01' }).success).toBe(false);
    expect(MedScheduleSchema.safeParse({ freq: 'daily' }).success).toBe(false);
    // A body may leave startDay to the daemon (today).
    expect(MedScheduleBodySchema.safeParse({ freq: 'daily' }).success).toBe(true);
    const body = MedicineBodySchema.parse({ name: 'Testamol', dose: '500 mg', times: ['21:00', '08:00'], schedule: { freq: 'daily' }, pills: { left: 10 } });
    expect(body.pills).toEqual({ left: 10, perDose: 1 });
    expect(MedicineBodySchema.safeParse({ name: 'Testamol', times: [], schedule: { freq: 'daily' } }).success).toBe(false);
    expect(MedicineBodySchema.safeParse({ name: 'Testamol', times: Array(9).fill('08:00'), schedule: { freq: 'daily' } }).success).toBe(false);
    expect(MedicineBodySchema.safeParse({ name: 'Testamol', times: ['08:00'], schedule: { freq: 'daily' }, history: [] }).success).toBe(false);
    // A refill keeps perDose when it is left out.
    expect(MedicinePatchSchema.parse({ pills: { left: 30 } }).pills).toEqual({ left: 30 });
    expect(DoseBodySchema.safeParse({ day: '2026-10-30', slot: '08:00', status: 'missed' }).success).toBe(false);
  });

  it('food: a name and kcal, or a saved id; targets need one of two; estimate text is capped', () => {
    expect(FoodBodySchema.safeParse({ day: '2026-10-30', name: 'Roti', kcal: 120, save: true }).success).toBe(true);
    expect(FoodBodySchema.safeParse({ day: '2026-10-30', savedId: ULID }).success).toBe(true);
    expect(FoodBodySchema.safeParse({ day: '2026-10-30', savedId: ULID, kcal: 1 }).success).toBe(false);
    expect(FoodBodySchema.safeParse({ day: '2026-10-30', name: 'Roti', kcal: -1 }).success).toBe(false);
    expect(FoodTargetsBodySchema.safeParse({}).success).toBe(false);
    expect(FoodTargetsBodySchema.safeParse({ goalKg: null }).success).toBe(true);
    expect(FoodTargetsBodySchema.safeParse({ kcalTarget: 700 }).success).toBe(false);
    expect(FoodEstimateBodySchema.safeParse({ text: 'x'.repeat(FOOD_ESTIMATE_TEXT_MAX + 1) }).success).toBe(false);
    expect(FoodEstimateSchema.safeParse({ items: Array(21).fill({ name: 'Roti', kcal: 120 }) }).success).toBe(false);
    expect(FoodEstimateSchema.safeParse({ items: [{ name: 'Roti', kcal: -5 }] }).success).toBe(false);
  });

  it('places take an https link only; money is whole hundredths', () => {
    expect(PlaceBodySchema.safeParse({ name: 'Example Café', link: 'https://maps.example.com/x' }).success).toBe(true);
    for (const link of ['http://maps.example.com/x', 'javascript:alert(1)', 'data:text/html,x']) {
      expect(PlaceBodySchema.safeParse({ name: 'Example Café', link }).success, link).toBe(false);
    }
    expect(PlaceBodySchema.safeParse({ name: 'Example Café', dishes: [{ name: 'Sample Dosa', rating: 6 }] }).success).toBe(false);
    expect(BillPaidBodySchema.safeParse({ amount: 649.5 }).success).toBe(false);
    expect(BillPaidBodySchema.safeParse({ amount: 64950 }).success).toBe(true);
  });

  it('a restore names a backup file, never a path', () => {
    expect(LifeRestoreBodySchema.safeParse({ file: 'life-2026-10-30.db' }).success).toBe(true);
    for (const file of ['../life.db', 'backups/life-2026-10-30.db', '/tmp/life-x.db', 'life.db', 'life-x.sqlite']) {
      expect(LifeRestoreBodySchema.safeParse({ file }).success, file).toBe(false);
    }
  });
});

describe('Intel schemas', () => {
  it('ids are printable, links http(s) only', () => {
    expect(IntelIdSchema.safeParse('intel:abc-123').success).toBe(true);
    expect(IntelIdSchema.safeParse('a b').success).toBe(false);
    expect(IntelIdSchema.safeParse('x'.repeat(161)).success).toBe(false);
    expect(IntelCaptureBodySchema.safeParse({ title: 'Example tool', url: 'http://example.com/a' }).success).toBe(true);
    expect(IntelCaptureBodySchema.safeParse({ title: 'Example tool', cwd: '/synthetic/home/work/bot' }).success).toBe(true);
    for (const cwd of ['work/bot', '', '/synthetic/\u0007bell']) {
      expect(IntelCaptureBodySchema.safeParse({ title: 'Example tool', cwd }).success, cwd).toBe(false);
    }
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '/relative', 'ftp://example.com']) {
      expect(IntelCaptureBodySchema.safeParse({ title: 'Example tool', url }).success, url).toBe(false);
    }
    const item = { id: 'intel:1', source: 'intel', at: null, title: '<script>window.__pwned=1</script>', tags: [], fields: [] };
    expect(IntelItemSchema.safeParse(item).success).toBe(true);
    expect(IntelItemSchema.safeParse({ ...item, url: 'javascript:alert(1)' }).success).toBe(false);
  });
});
