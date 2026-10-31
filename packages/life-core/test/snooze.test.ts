/** The snooze presets: Later (1 h), Tonight, Tomorrow, Next week. */
import { describe, expect, it } from 'vitest';
import { instantAt, snoozeTarget } from '../src/index.js';

const IST = 'Asia/Kolkata';

describe('snoozeTarget', () => {
  // 2026-10-30 is a Friday.
  const fri = (hhmm: string) => instantAt('2026-10-30', hhmm, IST);

  it('1h: an hour on, crossing midnight when it has to', () => {
    expect(snoozeTarget('1h', fri('10:17'), IST)).toEqual({ day: '2026-10-30', time: '11:17' });
    expect(snoozeTarget('1h', fri('23:30'), IST)).toEqual({ day: '2026-10-31', time: '00:30' });
  });

  it('tonight: 20:00 today, or tomorrow once 20:00 has passed', () => {
    expect(snoozeTarget('tonight', fri('10:00'), IST)).toEqual({ day: '2026-10-30', time: '20:00' });
    expect(snoozeTarget('tonight', fri('20:00'), IST)).toEqual({ day: '2026-10-31', time: '20:00' });
  });

  it('tomorrow: 09:00 the next day', () => {
    expect(snoozeTarget('tomorrow', fri('23:59'), IST)).toEqual({ day: '2026-10-31', time: '09:00' });
  });

  it('nextWeek: 09:00 on the next Monday, a whole week on from a Monday', () => {
    expect(snoozeTarget('nextWeek', fri('10:00'), IST)).toEqual({ day: '2026-11-02', time: '09:00' });
    expect(snoozeTarget('nextWeek', instantAt('2026-11-02', '08:00', IST), IST)).toEqual({ day: '2026-11-09', time: '09:00' });
    expect(snoozeTarget('nextWeek', instantAt('2026-11-01', '08:00', IST), IST)).toEqual({ day: '2026-11-02', time: '09:00' });
  });

  it('reads today in the zone, not in UTC', () => {
    // 20:00Z on the 30th is 01:30 on the 31st in Kolkata.
    expect(snoozeTarget('tomorrow', new Date('2026-10-30T20:00:00.000Z'), IST)).toEqual({ day: '2026-11-01', time: '09:00' });
  });
});
