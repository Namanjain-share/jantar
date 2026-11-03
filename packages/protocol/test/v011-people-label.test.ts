/**
 * v0.11 People: the space's name with one person (his label).
 *
 * - A label is trimmed, 1 to 40 characters, plain text on one line: no
 *   control characters, line separators or marks that reorder text. Markup
 *   is text (each screen renders it as text).
 * - spaceLabel is PEOPLE_LABEL while he set none; yourLabel reads "your
 *   cofounder" (an acronym keeps its capitals); shortLabel, her Home Screen
 *   title, is "Partner" for the default and at most 12 characters.
 */
import { describe, expect, it } from 'vitest';
import {
  PEOPLE_LABEL,
  PERSON_LABEL_PRESETS,
  PersonAddBodySchema,
  PersonColorBodySchema,
  PersonLabelSchema,
  personLabelProblem,
  shortLabel,
  spaceLabel,
  yourLabel,
} from '../src/people.js';

const ch = (n: number) => String.fromCharCode(n);

describe('the space’s name', () => {
  it('takes every preset and words of his own; trims; refuses empty, long and not-plain text', () => {
    for (const p of PERSON_LABEL_PRESETS) expect(PersonLabelSchema.parse(p)).toBe(p);
    expect(PERSON_LABEL_PRESETS[0]).toBe(PEOPLE_LABEL);
    expect(PersonLabelSchema.parse('  Study buddy  ')).toBe('Study buddy');
    expect(PersonLabelSchema.parse('<b>Coach</b> & "Friend"')).toBe('<b>Coach</b> & "Friend"');
    expect(PersonLabelSchema.parse('x'.repeat(40))).toHaveLength(40);
    for (const bad of ['', '  ', 'x'.repeat(41), `a\nb`, `a\tb`, `a${ch(0)}`, `a${ch(0x1b)}[2J`, `a${ch(0x85)}`, `a${ch(0x2028)}b`, `a${ch(0x202e)}b`, `a${ch(0x2066)}b`, `a${ch(0x200f)}`]) {
      expect(PersonLabelSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      expect(personLabelProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    expect(personLabelProblem('Cofounder')).toBeNull();
  });

  it('rides on add and on his edit (null is back to the default); the edit needs something to change', () => {
    expect(PersonAddBodySchema.parse({ name: 'Asha', label: 'Mentor' }).label).toBe('Mentor');
    expect(PersonColorBodySchema.parse({ label: null })).toEqual({ label: null });
    expect(PersonColorBodySchema.safeParse({}).success).toBe(false);
    expect(PersonColorBodySchema.safeParse({ label: 'x'.repeat(41) }).success).toBe(false);
  });

  it('reads as the default, after "your", and as a Home Screen title', () => {
    expect(spaceLabel(undefined)).toBe('Accountability partner');
    expect(spaceLabel('  ')).toBe('Accountability partner');
    expect(spaceLabel(' Coach ')).toBe('Coach');
    expect(yourLabel(undefined)).toBe('your accountability partner');
    expect(yourLabel('Cofounder')).toBe('your cofounder');
    expect(yourLabel('CEO')).toBe('your CEO');
    expect(yourLabel('<i>')).toBe('your <i>');
    expect(shortLabel(undefined)).toBe('Partner');
    expect(shortLabel('Accountability partner')).toBe('Partner');
    expect(shortLabel('Cofounder')).toBe('Cofounder');
    expect(shortLabel('Teammate')).toBe('Teammate');
    expect(shortLabel('My running coach')).toBe('Coach');
    expect(shortLabel('Accountabilitybuddyforever')).toBe('Accountabili');
    for (const l of [...PERSON_LABEL_PRESETS, 'My running coach', 'Accountabilitybuddyforever', 'Big brother 🙂', 'a b'.repeat(13)]) {
      expect(Array.from(shortLabel(l)).length, l).toBeLessThanOrEqual(12);
      expect(shortLabel(l).length, l).toBeGreaterThan(0);
    }
  });
});
