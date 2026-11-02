// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// The tier contract from Noblot's notifications tests (critical crosses quiet hours, important is held to the end of
// the window, standard is dropped; no window, no check), its `inQuietHours` cases, and (ours, M22) the spec 6.3
// table row by row: first match wins.
import { describe, expect, it } from 'vitest';
import {
  DELIVERY_TIERS,
  inQuietHours,
  inQuietWindow,
  minutesToQuietEnd,
  quietWindowOf,
  resolveDelivery,
  type DeliveryTier,
  type RecipientState,
} from '../src/delivery.js';

const QUIET = { startMin: 22 * 60, endMin: 8 * 60 }; // 22:00 → 08:00, wraps midnight

describe('inQuietHours (Noblot)', () => {
  it('a wrapping window covers both sides of midnight and ends exclusive', () => {
    expect(inQuietHours(23 * 60, QUIET)).toBe(true);
    expect(inQuietHours(3 * 60, QUIET)).toBe(true);
    expect(inQuietHours(8 * 60, QUIET)).toBe(false);
    expect(inQuietHours(12 * 60, QUIET)).toBe(false);
    expect(inQuietHours(22 * 60, QUIET)).toBe(true);
  });

  it('a same-day window, and an empty one that is never quiet', () => {
    expect(inQuietHours(13 * 60, { startMin: 12 * 60, endMin: 14 * 60 })).toBe(true);
    expect(inQuietHours(14 * 60, { startMin: 12 * 60, endMin: 14 * 60 })).toBe(false);
    expect(inQuietHours(600, { startMin: 600, endMin: 600 })).toBe(false);
  });
});

describe('the tiers behave differently (Noblot)', () => {
  const inQuiet: RecipientState = { quiet: QUIET, minute: 3 * 60, weekday: 2 };
  const outside: RecipientState = { quiet: QUIET, minute: 12 * 60, weekday: 2 };

  it('critical sends inside quiet hours (the only tier that can wake you)', () => {
    expect(resolveDelivery('critical', inQuiet)).toEqual({ action: 'push', reason: 'ok' });
  });

  it('important is held inside quiet hours, never dropped', () => {
    expect(resolveDelivery('important', inQuiet)).toEqual({ action: 'hold', reason: 'quiet' });
  });

  it('standard is dropped inside quiet hours (a stale nudge is noise)', () => {
    expect(resolveDelivery('standard', inQuiet)).toEqual({ action: 'drop', reason: 'quiet' });
  });

  it('outside quiet hours every tier sends', () => {
    for (const t of DELIVERY_TIERS) expect(resolveDelivery(t, outside).action, t).toBe('push');
  });

  it('no window (or no minute) means the check never fires', () => {
    expect(resolveDelivery('important', { minute: 3 * 60 }).action).toBe('push');
    expect(resolveDelivery('important', { quiet: QUIET }).action).toBe('push');
  });
});

describe('quiet windows with days', () => {
  it('a wrapping window belongs to the day it started on', () => {
    const fri = { ...QUIET, days: [5] };
    expect(inQuietWindow(fri, 23 * 60, 5)).toBe(true); // Friday 23:00
    expect(inQuietWindow(fri, 2 * 60, 6)).toBe(true); // Saturday 02:00, started Friday
    expect(inQuietWindow(fri, 23 * 60, 6)).toBe(false); // Saturday 23:00
    expect(inQuietWindow(fri, 2 * 60, 5)).toBe(false); // Friday 02:00, started Thursday
  });

  it('parses stored windows and counts down to the end', () => {
    expect(quietWindowOf({ from: '22:00', to: '07:30' })).toEqual({ startMin: 1320, endMin: 450 });
    expect(quietWindowOf({ from: 'x', to: '07:30' })).toBeNull();
    expect(quietWindowOf(null)).toBeNull();
    expect(minutesToQuietEnd(QUIET, 23 * 60)).toBe(9 * 60);
    expect(minutesToQuietEnd(QUIET, 12 * 60)).toBe(0);
  });
});

/** M22: spec 6.3's decision table, row by row. Each row's state alone, then precedence between rows. */
describe('M22: the spec 6.3 table', () => {
  const T: DeliveryTier[] = ['critical', 'urgent', 'important', 'standard'];
  const row = (s: RecipientState) => T.map((t) => {
    const d = resolveDelivery(t, s);
    return `${d.action}:${d.reason}`;
  });

  it('over the caps: urgent and important are saved, the others unaffected', () => {
    expect(row({ overCap: true })).toEqual(['push:ok', 'save:capped', 'save:capped', 'push:ok']);
  });
  it('paused: her own critical rings, his urgent and important are held, standard dropped', () => {
    expect(row({ paused: true })).toEqual(['push:ok', 'hold:paused', 'hold:paused', 'drop:paused']);
  });
  it('muted: urgent still pushes', () => {
    expect(row({ muted: true })).toEqual(['push:ok', 'push:ok', 'hold:muted', 'drop:muted']);
  });
  it('need space: urgent as quiet hours, important held, her own rings unaffected', () => {
    expect(row({ needSpace: true })).toEqual(['push:ok', 'push:ok', 'hold:space', 'push:ok']);
    expect(row({ needSpace: true, urgentBreaksQuiet: false })).toEqual(['push:ok', 'hold:space', 'hold:space', 'push:ok']);
    // Her quiet hours still drop her rings under need space.
    expect(resolveDelivery('standard', { needSpace: true, quiet: QUIET, minute: 60 }).action).toBe('drop');
  });
  it('focus and an open night: urgent as quiet hours, important held, standard dropped', () => {
    expect(row({ focus: true })).toEqual(['push:ok', 'push:ok', 'hold:focus', 'drop:focus']);
    expect(row({ asleep: true })).toEqual(['push:ok', 'push:ok', 'hold:sleep', 'drop:sleep']);
    expect(row({ asleep: true, urgentBreaksQuiet: false })).toEqual(['push:ok', 'hold:sleep', 'hold:sleep', 'drop:sleep']);
  });
  it("quiet hours: urgent only when she allows it", () => {
    const q = { quiet: QUIET, minute: 60, weekday: 1 };
    expect(row(q)).toEqual(['push:ok', 'push:ok', 'hold:quiet', 'drop:quiet']);
    expect(row({ ...q, urgentBreaksQuiet: false })).toEqual(['push:ok', 'hold:quiet', 'hold:quiet', 'drop:quiet']);
  });
  it('otherwise everything pushes', () => {
    expect(row({})).toEqual(['push:ok', 'push:ok', 'push:ok', 'push:ok']);
  });
  it('first match wins: caps before pause, pause before mute, need space before focus and sleep, those before quiet', () => {
    expect(resolveDelivery('important', { overCap: true, paused: true }).action).toBe('save');
    expect(resolveDelivery('urgent', { paused: true, muted: true })).toEqual({ action: 'hold', reason: 'paused' });
    expect(resolveDelivery('important', { needSpace: true, focus: true, asleep: true }).reason).toBe('space');
    expect(resolveDelivery('important', { focus: true, asleep: true }).reason).toBe('focus');
    expect(resolveDelivery('important', { asleep: true, quiet: QUIET, minute: 60 }).reason).toBe('sleep');
  });
});
