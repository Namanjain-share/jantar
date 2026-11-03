/**
 * v0.12 People shapes (`@jantar/protocol/people`): the agreement's rules
 * (spec 1.3.3, M19), presets as offer templates clamped to the built phase
 * (O7, D24), and the subpath staying out of the package index (his main
 * bundle never holds People).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as index from '../src/index.js';
import {
  AGREEMENT_FIELDS,
  AgreementSchema,
  BUILT_PHASE,
  agreementProblem,
  agreementWithin,
  applyAgreementPatch,
  closeDependents,
  fieldValue,
  levelOf,
  noAgreement,
  presetAgreement,
  phaseBuilt,
  unbuiltFieldsIn,
  withField,
} from '../src/people.js';

describe('the agreement', () => {
  it('P3 is the built phase; later phases are not; `assistant` is not built in this release', () => {
    expect(BUILT_PHASE).toBe('P3');
    expect(phaseBuilt('P1')).toBe(true);
    expect(phaseBuilt('P2')).toBe(true);
    expect(phaseBuilt('P3')).toBe(true);
    expect(phaseBuilt('P4')).toBe(false);
    expect(phaseBuilt('later', 'P4')).toBe(false);
    expect(AGREEMENT_FIELDS.find((f) => f.key === 'assistant')?.phase).toBe('later');
  });

  it('presets fill only built fields; assistant is in none', () => {
    for (const p of ['light', 'standard', 'everything'] as const) {
      const a = presetAgreement(p);
      for (const f of AGREEMENT_FIELDS) if (!phaseBuilt(f.phase)) expect(levelOf(a, f), `${p} ${f.key}`).toBe(0);
      expect(a.assistant).toBe(false);
      expect(agreementProblem(a)).toBeNull();
    }
    expect(presetAgreement('everything', 'P4').see.journal).toBe(true);
    expect(presetAgreement('everything', 'P4').assistant).toBe(false);
  });

  it("Everything with food off is this build's offer field by field", () => {
    const a = applyAgreementPatch(presetAgreement('everything'), { see: { food: false } });
    expect(a).toEqual({
      see: { todos: true, meds: 'full', weight: true, food: false, plan: true, review: 'full', sleep: true, journal: true, chat: true },
      assign: { todos: true, meds: true, plan: true },
      editHers: { todos: true, meds: true, weight: true, plan: true },
      comment: { journal: true },
      assistant: false,
    });
  });

  it('every dependency is enforced; closing a see field closes what needs it', () => {
    const base = presetAgreement('everything');
    expect(agreementProblem({ ...base, see: { ...base.see, todos: false } })).toMatch(/needs see.todos/);
    expect(agreementProblem({ ...base, see: { ...base.see, meds: 'adherence' } })).toMatch(/needs see.meds full/);
    expect(agreementProblem({ ...base, see: { ...base.see, weight: false } })).toMatch(/editHers.weight/);
    const noPlan = { ...base, assign: { ...base.assign, plan: false }, editHers: { ...base.editHers, plan: false } };
    expect(agreementProblem({ ...noPlan, see: { ...base.see, plan: false, review: 'counts' } })).toMatch(/see.review needs see.plan/);
    expect(agreementProblem({ ...base, see: { ...base.see, journal: false } })).toMatch(/comment.journal/);
    const closed = closeDependents({ ...base, see: { ...base.see, todos: false, meds: 'adherence' } });
    expect(agreementProblem(closed)).toBeNull();
    expect([closed.assign.todos, closed.editHers.todos, closed.assign.meds, closed.editHers.meds]).toEqual([false, false, false, false]);
    expect(AgreementSchema.safeParse({ ...base, version: 1, see: { ...base.see, todos: false } }).success).toBe(false);
  });

  it('an agreement stored before an area existed reads it off (D24)', () => {
    const stored = { version: 1, see: { todos: true, meds: 'full', weight: true, food: false }, assign: { todos: true, meds: true }, editHers: { todos: true } };
    const a = AgreementSchema.parse(stored);
    expect([a.see.plan, a.see.review, a.see.sleep, a.see.journal, a.see.chat, a.comment.journal, a.assistant, a.editHers.meds]).toEqual([false, 'off', false, false, false, false, false, false]);
  });

  it('within: every field at or below; each field one step wider is not', () => {
    const offer = presetAgreement('standard');
    expect(agreementWithin(offer, offer)).toBe(true);
    expect(agreementWithin(noAgreement(), offer)).toBe(true);
    for (const f of AGREEMENT_FIELDS) {
      const i = levelOf(offer, f);
      if (i + 1 >= f.levels.length) continue;
      const wider = withField(offer, f, f.levels[i + 1] as boolean | string);
      expect(agreementWithin(wider, offer), f.key).toBe(false);
      expect(fieldValue(wider, f)).toBe(f.levels[i + 1]);
    }
  });

  it('a patch naming an unbuilt field is named back', () => {
    expect(unbuiltFieldsIn({ see: { chat: true, journal: true, todos: false } })).toEqual([]);
    expect(unbuiltFieldsIn({ see: { chat: true } }, 'P2')).toEqual(['see.chat']);
    expect(unbuiltFieldsIn({ assistant: true })).toEqual(['assistant']);
    expect(unbuiltFieldsIn({ see: { meds: 'off' } })).toEqual([]);
  });
});

describe('the subpath stays out of the index', () => {
  it('the package index exports no People route table or schema', () => {
    for (const k of Object.keys(index)) expect(k, k).not.toMatch(/^(PERSON_|PEOPLE_|Person[A-Z]|Agreement)/);
    const text = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(text).not.toMatch(/people/);
  });
});
