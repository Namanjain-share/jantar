/**
 * v0.12 People, M20 (P1, P2): the join page and Sharing are generated from the
 * explicit fields. For every preset and every level of every built field:
 * each `see` field has exactly one line, no unbuilt feature appears, the
 * words "everything" and "full access" never do, "What … can't do" and
 * "Always yours" are always there, and a switch only lowers.
 */
import { describe, expect, it } from 'vitest';
import { AGREEMENT_FIELDS, closeDependents, phaseBuilt, presetAgreement, withField } from '@jantar/protocol/people-core';
import { joinCopy, lowerLevels } from '../../src/partner/join/copy.js';

const all = (c: ReturnType<typeof joinCopy>) => [c.heading, c.intro, ...c.sees.map((l) => l.text), ...c.does.map((l) => l.text), ...c.cant, ...c.yours, ...c.smallPrint].join('\n');

describe('M20: the join page', () => {
  for (const preset of ['light', 'standard', 'everything'] as const) {
    for (const f of AGREEMENT_FIELDS.filter((x) => phaseBuilt(x.phase) && x.key.startsWith('see.'))) {
      for (const level of f.levels) {
        it(`${preset}, ${f.key} = ${String(level)}`, () => {
          const a = closeDependents(withField(presetAgreement(preset), f, level));
          for (const food of [true, false]) {
            const c = joinCopy('Sam', a, { built: 'P2', foodModule: food });
            const seeKeys = c.sees.map((l) => l.key);
            const built = AGREEMENT_FIELDS.filter((x) => phaseBuilt(x.phase) && x.key.startsWith('see.')).map((x) => x.key);
            expect(seeKeys.sort()).toEqual([...built].sort());
            const text = all(c);
            expect(text).not.toMatch(/\beverything\b|full access/i);
            // P3 and P4 features never appear in a P2 build.
            expect(text).not.toMatch(/\bchat\b|assistant|caf[eé]|shared list/i);
            expect(c.cant.length).toBeGreaterThan(0);
            expect(c.yours.length).toBeGreaterThan(0);
            for (const line of c.sees) {
              if (line.levels && line.level !== undefined) {
                for (const lower of lowerLevels(line)) expect(line.levels.indexOf(lower)).toBeLessThan(line.levels.indexOf(line.level));
              }
            }
          }
        });
      }
    }
  }

  it('a P1 build names no P2 feature', () => {
    const c = joinCopy('Sam', presetAgreement('everything', 'P2'), { built: 'P1', foodModule: false });
    expect(all(c)).not.toMatch(/journal|sleep|day plan|evening review|assistant/i);
  });

  it("food off: the line says it isn't part of the space", () => {
    const c = joinCopy('Sam', presetAgreement('everything'), { built: 'P1', foodModule: false });
    expect(c.sees.find((l) => l.key === 'see.food')?.text).toMatch(/not part of your space/);
  });
});
