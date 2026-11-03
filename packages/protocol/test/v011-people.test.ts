/**
 * v0.11 People shapes (`@jantar/protocol/people`): the agreement's rules
 * (spec 1.3.3, M19), presets as offer templates clamped to the built phase
 * (O7, D24), and the subpath staying out of the package index (his main
 * bundle never holds People).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ChatSendBodySchema } from '../src/chat.js';
import * as index from '../src/index.js';
import {
  AGREEMENT_FIELDS,
  AgreementPatchSchema,
  AgreementSchema,
  BUILT_PHASE,
  OwnerFoodViewSchema,
  PERSON_CHAT_ROUTES,
  PersonChatSendBodySchema,
  PersonFoodBodySchema,
  agreementProblem,
  agreementWithin,
  applyAgreementPatch,
  builtAreas,
  closeDependents,
  fieldValue,
  fieldsOn,
  levelOf,
  noAgreement,
  presetAgreement,
  phaseBuilt,
  unbuiltFieldsIn,
  withField,
} from '../src/people.js';

describe('the agreement', () => {
  it('P4 is the built phase; `assistant` is not built in this release', () => {
    expect(BUILT_PHASE).toBe('P4');
    expect(phaseBuilt('P1')).toBe(true);
    expect(phaseBuilt('P2')).toBe(true);
    expect(phaseBuilt('P3')).toBe(true);
    expect(phaseBuilt('P4')).toBe(true);
    expect(phaseBuilt('later')).toBe(false);
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
    const a = applyAgreementPatch(presetAgreement('everything'), { see: { food: 'off' } });
    expect(a).toEqual({
      see: { todos: true, meds: 'full', weight: true, food: 'off', plan: true, review: 'full', sleep: true, journal: true, chat: true },
      assign: { todos: true, meds: true, plan: true },
      editHers: { todos: true, meds: true, weight: true, plan: true },
      comment: { journal: true },
      assistant: false,
    });
  });

  it('food is built: off, counts or full; Standard and Everything carry it in full, Light leaves it off', () => {
    const f = AGREEMENT_FIELDS.find((x) => x.key === 'see.food');
    expect(f?.phase).toBe('P1');
    expect(f?.levels).toEqual(['off', 'counts', 'full']);
    expect(presetAgreement('light').see.food).toBe('off');
    expect(presetAgreement('standard').see.food).toBe('full');
    expect(presetAgreement('everything').see.food).toBe('full');
    expect(builtAreas()).toContain('food');
    expect(fieldsOn(presetAgreement('standard'))).toContain('see.food');
    // A level lower than another is within it; counts is not within off.
    const counts = applyAgreementPatch(presetAgreement('standard'), { see: { food: 'counts' } });
    expect(agreementWithin(counts, presetAgreement('standard'))).toBe(true);
    expect(agreementWithin(counts, applyAgreementPatch(counts, { see: { food: 'off' } }))).toBe(false);
  });

  it('see.food stored as the old off switch reads off; a patch may name a level or the old switch', () => {
    const stored = { version: 1, see: { todos: true, meds: 'full', weight: true, food: false }, assign: { todos: true, meds: true }, editHers: { todos: true } };
    expect(AgreementSchema.parse(stored).see.food).toBe('off');
    expect(AgreementSchema.parse({ ...stored, see: { todos: true, meds: 'full', weight: true } }).see.food).toBe('off');
    expect(AgreementPatchSchema.parse({ see: { food: 'counts' } }).see?.food).toBe('counts');
    expect(AgreementPatchSchema.parse({ see: { food: false } }).see?.food).toBe('off');
    expect(AgreementPatchSchema.safeParse({ see: { food: 'some' } }).success).toBe(false);
  });

  it('her food body takes calories or leaves them out; his view at counts names nothing', () => {
    expect(PersonFoodBodySchema.safeParse({ day: '2026-11-04', name: 'Dal and rice' }).success).toBe(true);
    expect(PersonFoodBodySchema.safeParse({ day: '2026-11-04', name: 'Dal and rice', kcal: 450, save: true }).success).toBe(true);
    expect(PersonFoodBodySchema.safeParse({ day: '2026-11-04', name: 'Dal', space: 'x' }).success).toBe(false);
    const counts = OwnerFoodViewSchema.parse({ level: 'counts', day: '2026-11-04', today: '2026-11-04', meals: 2, days: [{ day: '2026-11-04', meals: 2, kcal: 900 }], items: [] });
    expect(JSON.stringify(counts)).not.toMatch(/kcal|items/);
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
    const stored = { version: 1, see: { todos: true, meds: 'full', weight: true, food: 'off' }, assign: { todos: true, meds: true }, editHers: { todos: true } };
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
    // Food is built (spec 3.5): any level of it asks for nothing unbuilt.
    expect(unbuiltFieldsIn({ see: { food: 'off' } })).toEqual([]);
    expect(unbuiltFieldsIn({ see: { food: 'full' } })).toEqual([]);
    expect(unbuiltFieldsIn({ see: { chat: false } }, 'P2')).toEqual([]);
  });
});

describe('the subpath stays out of the index', () => {
  it('the package index exports no People route table or schema', () => {
    for (const k of Object.keys(index)) expect(k, k).not.toMatch(/^(PERSON_|PEOPLE_|Person[A-Z]|Agreement)/);
    const text = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(text).not.toMatch(/people/);
  });
});

describe('her chat send body (0.12 merge, spec 9.10)', () => {
  const ULID = '01JABCDEFGHJKMNPQRSTVWXYZ0';
  it('is text and photos only: the "Looking at" context is his, and hers is refused', () => {
    expect(PERSON_CHAT_ROUTES.personChatSend.body).toBe(PersonChatSendBodySchema);
    expect(PersonChatSendBodySchema.safeParse({ text: 'hi', photos: [ULID] }).success).toBe(true);
    expect(PersonChatSendBodySchema.safeParse({ text: 'hi', context: { kind: 'place', id: ULID } }).success).toBe(false);
    expect(PersonChatSendBodySchema.safeParse({ text: ' ' }).success).toBe(false);
    // His keeps it.
    expect(ChatSendBodySchema.safeParse({ text: 'hi', context: { kind: 'place', id: ULID } }).success).toBe(true);
  });
});
