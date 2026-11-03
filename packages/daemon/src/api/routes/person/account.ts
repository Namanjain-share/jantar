/**
 * v0.11 People: her account, consent and device routes (scope `person`,
 * spec 1.3.2), thin handlers over life/people/module.ts with her as the
 * caller. No file under api/routes/person/ imports a route file outside it,
 * and no owner route file imports from here (arch test).
 *
 * - The join routes take no credential (the gate counts them against the
 *   claim limiter); every bad code answers one sentence.
 * - Her cookie is set only with the `__Host-` attributes: Secure, Path=/,
 *   no Domain, HttpOnly, SameSite=Strict (C3).
 * - Her exits (Me, Pause, Resume, Leave, Export, Activity) work while People
 *   is off, in --read-only, while she is ending and, for Leave and Pause,
 *   while life.db is broken (C12).
 */
import { PERSON_COOKIE, type AgreementPatch, type JoinBody, type LeaveBody } from '@jantar/protocol/people';
import type { LifeResult, PersonDeviceRecord } from '../../../contracts.js';
import { ApiError } from '../../errors.js';
import { actorName, type RequestAuth } from '../../request.js';
import { lifeValue, type Call, type RouteTable } from '../../route-kit.js';
import type { ApiServices } from '../../services.js';
import { personExport } from './export.js';

const OK = { ok: true as const };

/** Her identity on a route the gate let through. */
export function her(auth: RequestAuth): { personId: string; deviceId: string } {
  if (!auth.person) throw new ApiError('unauthorized', 'Open your invite link again.');
  return { personId: auth.person.personId, deviceId: auth.person.deviceId };
}

/** Her cookie: `__Host-` (C3). */
export function personCookieOptions(s: ApiServices): { httpOnly: true; secure: true; sameSite: 'strict'; path: '/'; maxAge: number } {
  return { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: s.personDevices.cookieMaxAgeS() };
}

/** The one answer for a bad invite or link code (400, nothing spent). */
function codeValue<T>(r: LifeResult<T>): T {
  if (!r.ok && r.code === 'not_found') throw new ApiError('invalid_request', r.reason);
  return lifeValue(r);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function issued(c: Call<any, any, any>, s: ApiServices, r: { personId: string; device: PersonDeviceRecord; key: string; secret: string }) {
  c.reply.setCookie(PERSON_COOKIE, r.key, personCookieOptions(s));
  return { personId: r.personId, deviceId: r.device.id, deviceSecret: r.secret };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const header = (c: Call<any, any, any>, name: string): string | undefined => {
  const v = c.req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export const PERSON_ACCOUNT_ROUTE_IMPLS: RouteTable = {
  personJoinPreview: {
    handle: (c: Call<Record<string, string>, unknown, { code: string }>, s) => codeValue(s.deps.life.people.preview(c.body.code)),
  },
  personJoin: {
    // The audit shows a join happened (anonymous: no device yet), never the code or her email.
    handle: (c: Call<Record<string, string>, unknown, JoinBody>, s) => {
      const cloudflare = s.ctx.settings.get().remote.mode === 'cloudflare';
      const r = codeValue(
        s.deps.life.people.join(c.body, {
          cloudflare,
          accessEmail: cloudflare ? header(c, 'cf-access-authenticated-user-email') : undefined,
          userAgent: header(c, 'user-agent'),
        }),
      );
      return issued(c, s, r);
    },
    audit: (_c, out) => ({ target: (out.body as { personId?: string } | null)?.personId }),
  },
  personDeviceLinkClaim: {
    handle: (c: Call<Record<string, string>, unknown, { code: string; deviceName: string }>, s) => {
      const r = codeValue(s.deps.life.people.claimLink(c.body.code, c.body.deviceName, header(c, 'user-agent')));
      return issued(c, s, r);
    },
    audit: (_c, out) => ({ target: (out.body as { personId?: string } | null)?.personId }),
  },
  personMe: {
    handle: (c: Call, s) => lifeValue(s.deps.life.people.me(her(c.auth).personId, s.deps.life.broken() !== null)),
  },
  personAgreementAccept: {
    handle: (c: Call<Record<string, string>, unknown, { version: number }>, s) => {
      lifeValue(s.deps.life.people.accept(her(c.auth).personId, c.body.version, actorName(c.auth)));
      return OK;
    },
  },
  personAgreementDecline: {
    handle: (c: Call<Record<string, string>, unknown, { version: number; dontAsk?: boolean }>, s) => {
      lifeValue(s.deps.life.people.decline(her(c.auth).personId, c.body.version, c.body.dontAsk === true, actorName(c.auth)));
      return OK;
    },
  },
  personAgreementNarrow: {
    handle: (c: Call<Record<string, string>, unknown, AgreementPatch>, s) => {
      lifeValue(s.deps.life.people.narrow(her(c.auth).personId, c.body, actorName(c.auth)));
      return OK;
    },
  },
  personPause: {
    handle: (c: Call, s) => {
      lifeValue(s.deps.life.people.pause(her(c.auth).personId, actorName(c.auth)));
      return OK;
    },
  },
  personResume: {
    handle: (c: Call, s) => {
      lifeValue(s.deps.life.people.resume(her(c.auth).personId, actorName(c.auth)));
      return OK;
    },
  },
  personLeave: {
    handle: (c: Call<Record<string, string>, unknown, LeaveBody>, s) => {
      lifeValue(s.deps.life.people.leave(her(c.auth).personId, c.body.data, actorName(c.auth)));
      c.reply.clearCookie(PERSON_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'strict' });
      return OK;
    },
  },
  personExport: {
    handle: (c: Call<Record<string, string>, { format: 'html' | 'json' }>, s) => personExport(s, her(c.auth).personId, c.query.format),
  },
  personActivity: {
    handle: (c: Call<Record<string, string>, { before?: number }>, s) => lifeValue(s.deps.life.people.activity(her(c.auth).personId, c.query.before)),
  },
  personPrefs: {
    handle: (c: Call<Record<string, string>, unknown, Record<string, unknown>>, s) => {
      lifeValue(s.deps.life.people.setPrefs(her(c.auth).personId, c.body));
      return OK;
    },
  },
  personDevices: {
    handle: (c: Call, s) => {
      const me = her(c.auth);
      const devices = s.personDevices
        .list(me.personId)
        .filter((d) => !d.revokedAt)
        .map((d) => ({
          id: d.id,
          name: d.name,
          createdAt: d.createdAt,
          lastSeenAt: d.lastSeenAt,
          current: d.id === me.deviceId,
          ...(d.accessEmail ? { accessEmail: d.accessEmail } : {}),
        }));
      return { devices };
    },
  },
  personDeviceRevoke: {
    handle: (c: Call<{ id: string }>, s) => {
      const me = her(c.auth);
      lifeValue(s.deps.life.people.revokeOwn(me.personId, c.params.id));
      if (c.params.id === me.deviceId) c.reply.clearCookie(PERSON_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'strict' });
      return OK;
    },
  },
  personDeviceLinkCode: {
    handle: (c: Call, s) => {
      const me = her(c.auth);
      const r = lifeValue(s.deps.life.people.linkCode(me.personId, me.deviceId));
      const base = s.origin.peopleOrigin() ?? '';
      return { code: r.code, url: `${base}/p/link#c=${r.code}`, expiresAt: r.expiresAt };
    },
  },
};
