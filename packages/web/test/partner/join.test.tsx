/**
 * v0.11 People, M20 (P1, P2): the join page and Sharing are generated from the
 * explicit fields. For every preset and every level of every built field:
 * each `see` field has exactly one line, no unbuilt feature appears, the
 * words "everything" and "full access" never do, "What … can't do" and
 * "Always yours" are always there, and a switch only lowers.
 */
import { describe, expect, it } from 'vitest';
import { AGREEMENT_FIELDS, BUILT_PHASE, applyAgreementPatch, closeDependents, phaseBuilt, presetAgreement, withField } from '@jantar/protocol/people-core';
import { joinCopy, levelLabel, lowerLevels, switchLabel } from '../../src/people-shared/join-copy.js';

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

  it('is titled "Accountability partner", names him as hers, and says it asks every two weeks', () => {
    const c = joinCopy('Sam', closeDependents(presetAgreement('standard')), { built: BUILT_PHASE, foodModule: false });
    expect(c.heading).toBe('Accountability partner');
    expect(c.intro).toMatch(/^Sam invited you to a shared space for your days, as your accountability partner\. This page lists exactly what Sam can see and do\./);
    expect(c.yours).toContain('Every two weeks the app asks whether this setup still works for you. Your answer stays with you unless you choose to tell Sam.');
    expect(all(c)).not.toMatch(/Join Sam's Jantar/);
  });

  it('names what he sees and gets at each level, so the copy can only grow (spec 2.5)', () => {
    const offer = closeDependents(presetAgreement('everything'));
    const text = all(joinCopy('Sam', offer, { built: BUILT_PHASE, foodModule: false }));
    for (const re of [
      /Your day plan: when you open it \("Seen"\), each step you finish or skip and when, the notes and skip reasons you write, your check-ins \(mood, energy, a line and what you need\), your status \(Okay, Low or Need space, and its line\) and a rough day/,
      /Your evening review: each item done, skipped, moved, missed or gone, with any skip reason, what you write in it and your mood/,
      /Your to-dos and reminders: all of them, including ones you add yourself, when you finish or skip each one, and the notes and skip reasons you write/,
      /When you tap "Going to sleep" or "Woke up", Sam sees it as it happens\./,
      /When you open an alert from Sam, and your reply/,
      /Mark an item "no snooze", or ask to be told if it isn't done by a set time\./,
      /Your quiet hours apply, except Urgent: it rings through them unless you switch that off/,
      /Add to and edit the lists you share/,
      /Activity lists every change Sam makes in your space, and each time Sam looks, including reading your journal or your chats\./,
      /Sam can read your Activity too: the names of the devices you link, and when you link or remove one, pause, resume or change what you share\./,
      /"See what Sam sees" opens each area/,
      /The only times Sam sees are those on what you share \(when you add, change, finish or skip a to-do or a step, when you write in your journal or your chats, "Seen" marks, sleep taps and when you open an alert\) and those in your Activity\./,
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

  it('food is not in this build: no line names it, whatever her food module says (nothing is promised that is not served)', () => {
    for (const foodModule of [true, false]) {
      const c = joinCopy('Sam', presetAgreement('everything'), { built: BUILT_PHASE, foodModule });
      expect(c.sees.map((l) => l.key)).not.toContain('see.food');
      expect(all(c)).not.toMatch(/\bfood\b/i);
    }
  });

  it('every area the page offers is one this build serves: medicines are on it, with Add and Change for him', () => {
    const c = joinCopy('Sam', applyAgreementPatch(presetAgreement('everything'), { see: { food: 'off' } }), { built: BUILT_PHASE, foodModule: false });
    expect(c.sees.find((l) => l.key === 'see.meds')?.text).toBe('Your medicines: names, doses, times, the notes on them, whether you took each dose, and how often in the last 30 days');
    expect(all(c)).toMatch(/Add a medicine for you, and change or stop the ones Sam added \(their notes too\)\./);
    expect(all(c)).toMatch(/Change or stop medicines you added yourself, their notes included\./);
  });

  // His `full` medicines view (daemon people/meds.ts ownerMedicine, pinned by people-medicines.test.ts "M20 for medicines")
  // carries names, doses, times, taken/skipped/not, and the notes only on medicines he may change: never a log time or pill count.
  it('M20 for medicines: the line names the notes exactly where he reads them, and his Add line says what he may change', () => {
    const base = presetAgreement('everything');
    const at = (assign: boolean, editHers: boolean) => {
      const a = { ...base, assign: { ...base.assign, meds: assign }, editHers: { ...base.editHers, meds: editHers } };
      const c = joinCopy('Sam', a, { built: BUILT_PHASE, foodModule: false });
      return { line: c.sees.find((l) => l.key === 'see.meds')?.text, does: c.does.map((l) => l.text).filter((t) => /medicine/.test(t)) };
    };
    expect(at(true, true)).toEqual({
      line: 'Your medicines: names, doses, times, the notes on them, whether you took each dose, and how often in the last 30 days',
      does: [
        'Add a medicine for you, and change or stop the ones Sam added (their notes too).',
        'Change or stop medicines you added yourself, their notes included. Each change shows "Edited by Sam" and is in your Activity.',
      ],
    });
    // The Standard preset: he adds and may change his own additions, never hers.
    expect(at(true, false)).toEqual({
      line: 'Your medicines: names, doses, times, the notes on the ones Sam added, whether you took each dose, and how often in the last 30 days',
      does: ['Add a medicine for you, and change or stop the ones Sam added (their notes too), never yours.'],
    });
    expect(at(false, true).line).toBe('Your medicines: names, doses, times, the notes on the ones you added, whether you took each dose, and how often in the last 30 days');
    expect(at(false, false)).toEqual({ line: 'Your medicines: names, doses, times, whether you took each dose, and how often in the last 30 days', does: [] });
    expect(joinCopy('Sam', closeDependents(presetAgreement('standard')), { built: BUILT_PHASE, foodModule: false }).sees.find((l) => l.key === 'see.meds')?.text).toBe(
      at(true, false).line,
    );
    // He never sees when she logged a dose: the only times stay the ones the can't-list names (to-dos and steps, not doses).
    const c = joinCopy('Sam', base, { built: BUILT_PHASE, foodModule: false });
    expect(c.cant.join('\n')).toMatch(/The only times Sam sees are those on what you share \(when you add, change, finish or skip a to-do or a step, /);
    expect(all(c)).not.toMatch(/pill|when you log|log time/i);
  });
});
