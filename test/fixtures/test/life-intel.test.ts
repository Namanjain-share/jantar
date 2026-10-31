/**
 * The v0.4 fixtures: every Life body passes its schema, marked or not, and a
 * marked one carries LIFE_MARKER in every text field; the intel writer's
 * lines and counts are what the follower should end up with.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BillBodySchema,
  DoseBodySchema,
  FoodBodySchema,
  FoodEstimateBodySchema,
  IntelCaptureBodySchema,
  MedicineBodySchema,
  MoneyBodySchema,
  PlaceBodySchema,
  ProjectBodySchema,
  TodoBodySchema,
  WeightBodySchema,
} from '@jantar/protocol';
import {
  EXAMPLEX,
  INTEL_PARTIAL_LINE,
  LIFE_MARKER,
  MARKER_KG,
  PLACEBIN,
  appendIntel,
  billBody,
  captureBody,
  doseBody,
  estimateText,
  foodBody,
  intelRecord,
  medBody,
  moneyBody,
  placeBody,
  projectBody,
  todoBody,
  weightBody,
  writeIntelJsonl,
} from '../src/index.js';

describe('Life bodies', () => {
  const cases = [
    ['project', ProjectBodySchema, projectBody],
    ['todo', TodoBodySchema, todoBody],
    ['medicine', MedicineBodySchema, medBody],
    ['food', FoodBodySchema, foodBody],
    ['place', PlaceBodySchema, placeBody],
    ['money', MoneyBodySchema, moneyBody],
    ['bill', BillBodySchema, billBody],
  ] as const;

  it('pass their schemas, marked or not', () => {
    for (const [what, schema, make] of cases) {
      for (const marked of [false, true]) expect(schema.safeParse((make as (o: object, m: object) => unknown)({}, { marked })).success, `${what} ${marked}`).toBe(true);
    }
    expect(DoseBodySchema.safeParse(doseBody()).success).toBe(true);
    expect(WeightBodySchema.parse(weightBody({}, { marked: true }))).toEqual({ kg: MARKER_KG });
    expect(FoodEstimateBodySchema.safeParse({ text: estimateText({ marked: true }) }).success).toBe(true);
    expect(IntelCaptureBodySchema.safeParse(captureBody({}, { marked: true })).success).toBe(true);
    for (const m of [PLACEBIN, EXAMPLEX]) expect(MedicineBodySchema.safeParse(m).success).toBe(true);
  });

  it('a marked body carries the marker in every text field, an unmarked one in none', () => {
    const strings = (v: unknown): string[] =>
      typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];
    const TEXT_KEYS = /^(name|title|notes?|dose|area|category)$/;
    for (const [what, , make] of cases) {
      const marked = (make as (o: object, m: object) => Record<string, unknown>)({}, { marked: true });
      for (const [k, v] of Object.entries(marked)) if (TEXT_KEYS.test(k)) expect(String(v), `${what}.${k}`).toContain(LIFE_MARKER);
      expect(JSON.stringify((make as (o: object, m: object) => unknown)({}, {}))).not.toContain(LIFE_MARKER);
      expect(strings(marked).some((s) => s.includes(LIFE_MARKER)), what).toBe(true);
    }
    expect(placeBody({}, { marked: true }).dishes?.every((d) => d.name.includes(LIFE_MARKER))).toBe(true);
    expect(todoBody({}, { timed: { time: '11:00' } }).due).toEqual({ day: '2026-10-30', time: '11:00' });
  });
});

describe('intel JSONL', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jantar-intel-fx-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes bot-shaped records, then the edge lines and a partial last line, with the counts spec 4.9 expects', async () => {
    const file = join(dir, 'bot', 'intel.jsonl');
    const r = await writeIntelJsonl(file, { count: 5, extras: true });
    expect(r).toMatchObject({ items: 9, skipped: 4 });
    expect(r.ids.slice(0, 5)).toEqual(['ex-0', 'ex-1', 'ex-2', 'ex-3', 'ex-4']);
    const text = await readFile(file, 'utf8');
    expect(text.endsWith(INTEL_PARTIAL_LINE)).toBe(true);
    const first = JSON.parse(text.split('\n')[0] as string) as Record<string, unknown>;
    expect(first).toMatchObject({ id: 'ex-0', title: 'Example tool 0', url: 'https://example.com/0', source_handle: '@example', workspace: 'example' });
    expect(text).toContain('javascript:alert(1)');
    expect(text).toContain('<script>window.__pwned=1</script>');
    expect(text.split('\n').some((l) => l.length > 300 * 1024)).toBe(true);
    await appendIntel(file, intelRecord(6));
    expect(await readFile(file, 'utf8')).toContain(`${INTEL_PARTIAL_LINE}{"id":"ex-6"`);
  });
});
