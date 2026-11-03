// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// Noblot's computeMedEscalation cases (health-report.test.ts), and (ours) the words naming no medicine.
import { describe, expect, it } from 'vitest';
import { MED_ESCALATE_DAYS, computeMedEscalation } from '../src/med-escalation.js';

describe('computeMedEscalation', () => {
  const days = (missed: number[]) => missed.map((m, i) => ({ day: `2026-01-0${i + 1}`, taken: m === 0 ? 2 : 1, missed: m }));

  it('stays silent when nothing is missed', () => {
    const e = computeMedEscalation(days([0, 0, 0]), '2026-01-03');
    expect(e.level).toBe('none');
    expect(e.consecutiveMissedDays).toBe(0);
  });

  it('nudges on a single missed day', () => {
    const e = computeMedEscalation(days([0, 0, 1]), '2026-01-03');
    expect(e.level).toBe('nudge');
    expect(e.missedToday).toBe(1);
    expect(e.consecutiveMissedDays).toBe(1);
  });

  it('escalates once doses are missed on consecutive days', () => {
    const e = computeMedEscalation(days([0, 1, 2]), '2026-01-03');
    expect(e.level).toBe('escalate');
    expect(e.consecutiveMissedDays).toBe(2);
    expect(e.message).toContain('2 days running');
  });

  it('never counts days AFTER `asOfDay` (a future slot is not a missed one)', () => {
    const e = computeMedEscalation(days([0, 0, 3]), '2026-01-02');
    expect(e.level).toBe('none');
  });

  // Jantar's own cases.
  it('the concern needs two days running, and says "not logged", never a name', () => {
    expect(MED_ESCALATE_DAYS).toBe(2);
    const yesterdayOnly = computeMedEscalation(days([0, 1, 0]), '2026-01-03');
    expect(yesterdayOnly.level).toBe('none');
    const e = computeMedEscalation(days([1, 1, 1]), '2026-01-03');
    expect(e).toEqual({ level: 'escalate', missedToday: 1, consecutiveMissedDays: 3, message: 'Doses not logged 3 days running. Worth checking in.' });
    expect(computeMedEscalation([], '2026-01-03').level).toBe('none');
  });

  it('an unsorted window reads the same', () => {
    const d = days([0, 1, 2]).reverse();
    expect(computeMedEscalation(d, '2026-01-03').consecutiveMissedDays).toBe(2);
  });
});
