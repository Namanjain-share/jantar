/**
 * v0.12 People, M20 (P1, P2): the join page and Sharing are generated from the
 * explicit fields. For every preset and every level of every built field:
 * each `see` field has exactly one line, no unbuilt feature appears, the
 * words "everything" and "full access" never do, "What … can't do" and
 * "Always yours" are always there, and a switch only lowers.
 */
import { describe, expect, it } from 'vitest';
import { AGREEMENT_FIELDS, BUILT_PHASE, closeDependents, phaseBuilt, presetAgreement, withField } from '@jantar/protocol/people-core';
import { joinCopy, levelLabel, lowerLevels, switchLabel } from '../../src/partner/join/copy.js';

const all = (c: ReturnType<typeof joinCopy>) => [c.heading, c.intro, ...c.sees.map((l) => l.text), ...c.does.map((l) => l.text), ...c.cant, ...c.yours, ...c.smallPrint].join('\n');

describe('M20: the join page', () => {
  for (const preset of ['light', 'standard', 'everything'] as const) {
    for (const f of AGREEMENT_FIELDS.filter((x) => phaseBuilt(x.phase) && x.key.startsWith('see.'))) {
      for (const level of f.levels) {
        it(`${preset}, ${f.key} = ${String(level)}`, () => {
          const a = closeDependents(withField(presetAgreement(preset), f, level));
          for (const food of [true, false]) {
            const c = joinCopy('Sam', a, { built: BUILT_PHASE, foodModule: food });
            const seeKeys = c.sees.filter((l) => l.key !== null).map((l) => l.key);
            const built = AGREEMENT_FIELDS.filter((x) => phaseBuilt(x.phase) && x.key.startsWith('see.')).map((x) => x.key);
            expect(seeKeys.sort()).toEqual([...built].sort());
            const text = all(c);
            expect(text).not.toMatch(/\beverything\b|full access/i);
            // P4 features never appear before P4 is built; his assistant reading her space is never offered (not built).
            if (!phaseBuilt('P4')) expect(text).not.toMatch(/caf[eé]|shared list/i);
            expect(c.sees.map((l) => l.key)).not.toContain('assistant');
            // P3: the chat disclosure is on the page, from the same words her chat shows.
            expect(text).toMatch(/Your assistant runs on Sam's Claude account, on Sam's Mac\./);
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

  it('names what he sees and gets at each level, so the copy can only grow (spec 2.5)', () => {
    const offer = closeDependents(presetAgreement('everything'));
    const text = all(joinCopy('Sam', offer, { built: BUILT_PHASE, foodModule: false }));
    for (const re of [
      /Your day plan: when you open it \("Seen"\), each step you finish and when, the notes you write, your check-ins \(mood, energy, a line and what you need\), your status \(Okay, Low or Need space, and its line\) and a rough day/,
      /Your evening review: each item done, moved, missed or gone, what you write in it and your mood/,
      /When you tap "Going to sleep" or "Woke up", Sam sees it as it happens\./,
      /When you open an alert from Sam, and your reply/,
      /Mark an item "no snooze", or ask to be told if it isn't done by a set time\./,
      /Your quiet hours apply, except Urgent: it rings through them unless you switch that off/,
      /Add to and edit the lists you share/,
      /Activity lists every change Sam makes in your space, and each time Sam looks, including reading your journal or your chats\./,
      /"See what Sam sees" opens each area/,
      /The only times Sam sees are the "Seen" marks, finish times, sleep taps and when you open an alert listed above\./,
      /security log on Sam's Mac notes the time of each change your devices make and each time your assistant runs/,
    ]) {
      expect(text).toMatch(re);
    }
    // Each lower level says what it still shows, or that it is off.
    const at = (key: string, level: string | boolean) => {
      const f = AGREEMENT_FIELDS.find((x) => x.key === key);
      if (!f) throw new Error(key);
      return joinCopy('Sam', closeDependents(withField(offer, f, level)), { built: BUILT_PHASE, foodModule: false }).sees.find((l) => l.key === key)?.text;
    };
    expect(at('see.review', 'counts')).toBe('Your evening review: only the counts, like "5 done · 1 moved"');
    expect(at('see.review', 'off')).toBe('Your evening review: off');
    expect(at('see.plan', false)).toBe('Your day plan: off, and with it your status and check-ins');
    expect(at('see.sleep', false)).toBe('Your sleep: off');
    // To-dos off: the review says they stay out of it (the daemon leaves them out, M5).
    expect(at('see.todos', false)).toBe('Your to-dos and reminders: off');
    const todosOff = closeDependents(withField(offer, AGREEMENT_FIELDS.find((x) => x.key === 'see.todos') as (typeof AGREEMENT_FIELDS)[number], false));
    expect(joinCopy('Sam', todosOff, { built: BUILT_PHASE, foodModule: false }).sees.find((l) => l.key === 'see.review')?.text).toMatch(/Your to-dos stay out of it while they are off/);
    // With nothing to assign, no follow-up line.
    const noAssign = { ...offer, assign: { todos: false, meds: false, plan: false } };
    expect(all(joinCopy('Sam', noAssign, { built: BUILT_PHASE, foodModule: false }))).not.toMatch(/no snooze/);
  });

  it('every level has its own plain label, and switches are named in plain words', () => {
    for (const f of AGREEMENT_FIELDS.filter((x) => x.key.startsWith('see.'))) {
      const labels = f.levels.map(levelLabel);
      expect(new Set(labels).size, f.key).toBe(labels.length);
      expect(switchLabel('Sam', f.key)).toMatch(/^What Sam sees of your /);
    }
    expect(levelLabel('counts')).toBe('Only counts');
  });

  it('a P2 build names no chat', () => {
    const c = joinCopy('Sam', presetAgreement('everything', 'P2'), { built: 'P2', foodModule: false });
    expect(all(c)).not.toMatch(/\bchat\b|assistant/i);
  });

  it('a P1 build names no P2 feature', () => {
    const c = joinCopy('Sam', presetAgreement('everything', 'P2'), { built: 'P1', foodModule: false });
    expect(all(c)).not.toMatch(/journal|sleep|day plan|evening review|assistant/i);
  });

  it("food off: the line says it isn't part of the space", () => {
    const c = joinCopy('Sam', presetAgreement('everything'), { built: 'P1', foodModule: false });
    expect(c.sees.find((l) => l.key === 'see.food')?.text).toMatch(/not part of your space/);
  });
});
