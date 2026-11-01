/**
 * The v0.5 route table: 17 routes (three for pairing the extension, five
 * for its captures, nine for the phone and the CLI). The capture routes take
 * the extension's key only and live under /v1/ext/; every phone route needs
 * control, reads included; the Meetings switch closes everything but the
 * status and pairing. MA9: no capture route and no meeting write is on
 * ctl.sock; status, list, get and the screenshot bytes are (the CLI's
 * export). MP2: write replies carry ids or ok only, and the pairing claim's
 * key is the one secret, on a public route the idempotency cache never keeps.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ExtPairClaimReplySchema,
  ExtPairStartReplySchema,
  ExtUnpairReplySchema,
  IdReplySchema,
  MEETING_SHOT_BODY_MAX,
  OkReplySchema,
  ROUTES,
  type RouteDef,
  type RouteName,
} from '../src/index.js';

const routes = Object.entries(ROUTES) as [RouteName, RouteDef][];
const v05 = routes.filter(([, r]) => r.phase === 'v0.5');
const names = (list: [RouteName, RouteDef][]) => list.map(([n]) => n).sort();

describe('v0.5 routes', () => {
  it('are 17, under /v1 with a summary, GETs without a body', () => {
    expect(v05.length).toBe(17);
    for (const [name, r] of v05) {
      expect(r.path.startsWith('/v1/'), name).toBe(true);
      expect(r.summary.length, name).toBeGreaterThan(5);
      if (r.method === 'GET') expect(r.body, name).toBeUndefined();
      // Only GET and POST reach the extension's routes: an extension worker's PUT or DELETE was never checked for its Origin.
      if (r.path.startsWith('/v1/ext/')) expect(['GET', 'POST'], name).toContain(r.method);
    }
  });

  it('the extension scope is exactly the capture routes, all under /v1/ext/ and behind the switch', () => {
    const ext = v05.filter(([, r]) => r.scope === 'extension');
    expect(names(ext)).toEqual(['extInfo', 'extMeetingEnd', 'extMeetingLines', 'extMeetingOpen', 'extMeetingShot']);
    for (const [name, r] of ext) {
      expect(r.path.startsWith('/v1/ext/'), name).toBe(true);
      expect(r.feature, name).toBe('meetings');
    }
    // No route outside v0.5 takes the extension's key, but v0.8's two reads (v08-intel-read.test.ts).
    expect(names(routes.filter(([, r]) => r.scope === 'extension' && r.phase !== 'v0.5'))).toEqual(['extReadNext', 'extReadResult']);
  });

  it('pairing: start and unpair are admin and the Mac only; the claim is public; none has a switch', () => {
    expect(ROUTES.extPairStart).toMatchObject({ scope: 'admin', localOnly: true, ctl: true, method: 'POST' });
    expect(ROUTES.extUnpair).toMatchObject({ scope: 'admin', localOnly: true, ctl: true, method: 'POST' });
    expect(ROUTES.extPairClaim).toMatchObject({ scope: 'public', ctl: false, method: 'POST', path: '/v1/ext/pair' });
    for (const n of ['extPairStart', 'extUnpair', 'extPairClaim'] as const) expect((ROUTES[n] as RouteDef).feature, n).toBeUndefined();
    expect(names(v05.filter(([, r]) => r.localOnly))).toEqual(['extPairStart', 'extUnpair']);
  });

  it('every phone route needs control, reads included, and all but the status sit behind the switch', () => {
    const phone = v05.filter(([, r]) => r.path.startsWith('/v1/meetings'));
    expect(names(phone)).toEqual(
      ['meetingDelete', 'meetingGet', 'meetingItemTodo', 'meetingItemUntodo', 'meetingShot', 'meetingSummarize', 'meetingUpdate', 'meetingsList', 'meetingsStatus'].sort(),
    );
    for (const [name, r] of phone) {
      expect(r.scope, name).toBe('control');
      expect(r.feature, name).toBe(name === 'meetingsStatus' ? undefined : 'meetings');
    }
    expect(ROUTES.meetingShot.rawResponse).toBe(true);
  });

  it('MA9: no capture route and no meeting write is on ctl.sock; status, list, get and the screenshot are', () => {
    expect(names(v05.filter(([, r]) => r.ctl))).toEqual(['extPairStart', 'extUnpair', 'meetingGet', 'meetingShot', 'meetingsList', 'meetingsStatus']);
    for (const [name, r] of v05) {
      if (r.scope === 'extension' || name === 'extPairClaim') expect(r.ctl, name).toBe(false);
      if (r.path.startsWith('/v1/meetings') && r.method !== 'GET') expect(r.ctl, name).toBe(false);
    }
  });

  it('MP2: write replies are ids or ok; the claim alone carries a secret, and it is public', () => {
    // The start's one-time code (like pairStart's) goes only to the Mac: extPairStart is localOnly.
    const ALLOWED: z.ZodType[] = [IdReplySchema, OkReplySchema, ExtUnpairReplySchema, ExtPairClaimReplySchema, ExtPairStartReplySchema];
    for (const [name, r] of v05) {
      if (r.method === 'GET') continue;
      expect(ALLOWED.includes(r.response as z.ZodType), name).toBe(true);
    }
    const withKey = v05.filter(([, r]) => r.response === ExtPairClaimReplySchema);
    expect(names(withKey)).toEqual(['extPairClaim']);
    expect(names(v05.filter(([, r]) => r.response === ExtPairStartReplySchema))).toEqual(['extPairStart']);
    expect(ROUTES.extPairStart.localOnly).toBe(true);
    expect(ROUTES.extPairClaim.scope).toBe('public');
    expect(Object.keys(ExtPairClaimReplySchema.shape).sort()).toEqual(['id', 'key']);
    expect(Object.keys(ExtUnpairReplySchema.shape).sort()).toEqual(['ok', 'revoked']);
  });

  it('only the screenshot upload has its own body limit (and v0.8\'s door and read results)', () => {
    expect(routes.filter(([, r]) => r.bodyLimit !== undefined).map(([n]) => n)).toEqual(['extMeetingShot', 'captureSave', 'extReadResult']);
    expect(ROUTES.extMeetingShot.bodyLimit).toBe(MEETING_SHOT_BODY_MAX);
  });

  // v0.5.1: the daemon would let `rawBody` win silently, and run an extension route's gate (its request limiter) twice.
  it('no route has both its own body limit and raw bytes, and no extension route takes raw bytes', () => {
    expect(names(routes.filter(([, r]) => r.bodyLimit !== undefined && r.rawBody))).toEqual([]);
    expect(names(routes.filter(([, r]) => r.scope === 'extension' && r.rawBody))).toEqual([]);
  });
});
