// v0.12 People: Quick plan (spec 4.3, C30). The patterns, the "then" sentence from the brief, 12 h and 24 h times,
// tags, limits, and junk always becoming plain steps without throwing.
import { describe, expect, it } from 'vitest';
import { QUICK_STEPS_MAX, parseQuickPlan } from '../src/quick-plan.js';

describe('Quick plan', () => {
  it('reads the brief\'s "then" sentence into the plan', () => {
    const p = parseQuickPlan(
      'Mock at 8, then analysis, then interview prep at 11, then interview at 2pm, then log practice questions, then daily file and VA, every 2h 10-18 check applications',
    );
    expect(p.steps).toEqual([
      { title: 'Mock', at: '08:00' },
      { title: 'Analysis' },
      { title: 'Interview prep', at: '11:00' },
      { title: 'Interview', at: '14:00' },
      { title: 'Log practice questions' },
      { title: 'Daily file and VA' },
    ]);
    expect(p.between).toEqual([{ title: 'Check applications', every: 120, from: '10:00', to: '18:00' }]);
    expect(p.dropped).toBe(0);
  });

  it('leading times, trailing lengths and tags, one per line', () => {
    const p = parseQuickPlan('8:00 Mock 90m\nAnalysis 45m !report\n2pm Interview 60 min !focus\n- 21:30 Night check-in !checkin\nInterview prep at 11 !ack');
    expect(p.steps).toEqual([
      { title: 'Mock', at: '08:00', minutes: 90 },
      { title: 'Analysis', minutes: 45, ask: 'report' },
      { title: 'Interview', at: '14:00', minutes: 60, focus: true },
      { title: 'Night check-in', at: '21:30', ask: 'checkin' },
      { title: 'Interview prep', at: '11:00', ask: 'ack' },
    ]);
  });

  it('12 h and 24 h times', () => {
    const at = (s: string) => parseQuickPlan(s).steps[0]?.at;
    expect(at('12am Wake')).toBe('00:00');
    expect(at('12pm Lunch')).toBe('12:00');
    expect(at('Call at 3')).toBe('15:00');
    expect(at('Call at 7')).toBe('07:00');
    expect(at('Call at 17:45')).toBe('17:45');
    expect(at('Call at 9.30am')).toBe('09:30');
    expect(at('3 eggs')).toBeUndefined();
    expect(parseQuickPlan('3 eggs').steps[0]?.title).toBe('3 eggs');
  });

  it('a check-between needs a sane interval and range', () => {
    expect(parseQuickPlan('every 30m 9-10 water').between).toEqual([{ title: 'Water', every: 30, from: '09:00', to: '10:00' }]);
    expect(parseQuickPlan('every 10m 9-10 water').between).toEqual([]);
    expect(parseQuickPlan('every 2h 18-10 water').between).toEqual([]);
    expect(parseQuickPlan('every 2h 18-10 water').steps[0]?.title).toBe('Every 2h 18-10 water');
  });

  it('limits: 30 steps and 4 check-betweens; the rest are counted, not kept', () => {
    const p = parseQuickPlan(Array.from({ length: 35 }, (_, i) => `Step ${i}`).join('\n'));
    expect(p.steps).toHaveLength(QUICK_STEPS_MAX);
    expect(p.dropped).toBe(5);
    const b = parseQuickPlan(Array.from({ length: 6 }, (_, i) => `every 1h 9-17 check ${i}`).join('\n'));
    expect(b.between).toHaveLength(4);
    expect(b.dropped).toBe(2);
  });

  it('junk becomes plain steps (or nothing) and never throws', () => {
    for (const s of ['', '   ', 'then then then', '!!!', '99:99 nope', 'at', '@ 5', '‮evil', 'x'.repeat(500), '0m', 'at 25pm thing']) {
      expect(() => parseQuickPlan(s)).not.toThrow();
      for (const step of parseQuickPlan(s).steps) {
        expect(step.title.length).toBeGreaterThan(0);
        expect(step.title.length).toBeLessThanOrEqual(120);
      }
    }
    expect(parseQuickPlan('99:99 nope').steps).toEqual([{ title: '99:99 nope' }]);
    expect(parseQuickPlan(undefined as unknown as string).steps).toEqual([]);
  });
});
