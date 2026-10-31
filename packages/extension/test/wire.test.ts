/**
 * The extension's mirrors of the protocol (it imports only types from
 * @jantar/protocol): the header, the pairing line, the ID and the limits
 * equal the protocol's; the pairing line parses as the popup reads it; the
 * timings are the spec's (3.2); the four hosts and siteOf.
 */
import { describe, expect, it } from 'vitest';
import {
  EXTENSION_ID as P_ID,
  EXTENSION_KEY_HEADER as P_HEADER,
  EXTENSION_PAIR_PREFIX as P_PREFIX,
  MEETING_LIMITS,
  MEETING_SHOT_MAX_BYTES as P_SHOT_MAX,
} from '@jantar/protocol';
import { MEETING_HOSTS, siteOf } from '../src/shared/sites.js';
import { DAEMON_HOST, DAEMON_ORIGIN, EXTENSION_ID, EXTENSION_KEY_HEADER, EXTENSION_PAIR_PREFIX, MEETING_SHOT_MAX_BYTES, PAIR_LINE, TIMING, WIRE_LIMITS } from '../src/shared/wire.js';

describe('wire', () => {
  it("mirrors the protocol's constants", () => {
    expect(EXTENSION_KEY_HEADER).toBe(P_HEADER);
    expect(EXTENSION_PAIR_PREFIX).toBe(P_PREFIX);
    expect(EXTENSION_ID).toBe(P_ID);
    expect(MEETING_SHOT_MAX_BYTES).toBe(P_SHOT_MAX);
    for (const [k, v] of Object.entries(WIRE_LIMITS)) expect(v, k).toBe(MEETING_LIMITS[k as keyof typeof MEETING_LIMITS]);
    expect(DAEMON_HOST).toBe('127.0.0.1');
    expect(DAEMON_ORIGIN).toBe(`http://${DAEMON_HOST}`);
    expect(new URL(`${DAEMON_ORIGIN}:7420/v1/ext/info`).host).toBe(`${DAEMON_HOST}:7420`);
  });

  it('reads the pairing line the CLI prints, and nothing else', () => {
    const code = 'C0DEc0de_C0DE-c0deC0';
    expect(PAIR_LINE.exec(`${P_PREFIX}:7420:${code}`)?.slice(1)).toEqual(['7420', code]);
    for (const bad of [`${P_PREFIX}:7420:short`, `jantar:7420:${code}`, `${P_PREFIX}:7:${code}`, `${P_PREFIX}:742000:${code}`, `${P_PREFIX}:7420:${code} x`, `http://127.0.0.1:7420/pair#c=${code}`]) {
      expect(PAIR_LINE.test(bad), bad).toBe(false);
    }
  });

  it("keeps the spec's timings", () => {
    expect({ ...TIMING }).toEqual({
      callPollMs: 1_000,
      leaveGraceMs: 60_000,
      keepAliveMs: 60_000,
      linesEveryMs: 1_500,
      linesRetryMs: 2_000,
      debounceMs: 250,
      noCaptionsMs: 10_000,
      notFoundMs: 60_000,
      shotGapMs: 550,
    });
    expect(Object.isFrozen(TIMING)).toBe(true);
  });

  it('knows the four meeting hosts, and no other', () => {
    expect(MEETING_HOSTS.map(siteOf)).toEqual(['meet', 'teams', 'teams', 'teams']);
    for (const h of ['meet.google.com.example.com', 'google.com', 'teams.microsoft.com.mcas.ms', 'evil.example', '']) expect(siteOf(h), h).toBeNull();
    expect(siteOf('MEET.GOOGLE.COM')).toBe('meet');
  });
});
