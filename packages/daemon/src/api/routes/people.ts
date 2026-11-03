/**
 * v0.12 People: the owner's routes about the people on his Mac (spec
 * 9.3.4), over life/people/module.ts. His reads and writes in her space are
 * routes/people-life.ts.
 *
 * - Every `:pid` route answers one not_found sentence for a person he may
 *   not reach (unknown, ending, left, forgotten), the same as an unknown id:
 *   a refusal confirms nothing (M8).
 * - What lets a person in, shapes her offer or ends her space is
 *   `localOnly` (the Mac's CLI): add, offer, modules, invite and its revoke,
 *   remove, the switch and the doctor. "Copy link again" needs an admin
 *   device (C14).
 * - Nothing here returns her devices' last-seen, user agent or an address
 *   (C20).
 */
import { PERSON_COLORS, type PersonAddBody, type PersonOfferBody, type PersonProposeBody, type PersonRemoveBody } from '@jantar/protocol/people';
import { peopleSettingsProblem } from '@jantar/protocol';
import type { LifeResult } from '../../contracts.js';
import { findWebPush } from '../../notify/index.js';
import { ApiError } from '../errors.js';
import { actorName } from '../request.js';
import { lifeValue, type Call, type RouteTable } from '../route-kit.js';
import type { ApiServices } from '../services.js';

type Pid = { pid: string };
const OK = { ok: true as const };

/** What a People route answers for a person it may not reach (the unknown-pid answer). */
export const NO_PERSON = 'No such person.';

/** His base for her links: her host, which must be set before an invite can be made. */
export const PEOPLE_URL_NEEDED = 'Set the people hostname first: jantar remote people-url <https-url>';

function peopleUrl(s: ApiServices): string {
  const origin = s.origin.peopleOrigin();
  if (!origin) throw new ApiError('conflict', PEOPLE_URL_NEEDED);
  return origin;
}

/** A person he may reach for routes about the person (invited included), or 404. */
export function aboutPerson(s: ApiServices, pid: string): void {
  if (s.deps.life.people.ownerReach(pid) === null) throw new ApiError('not_found', NO_PERSON);
}

function value<T>(r: LifeResult<T>): T {
  return lifeValue(r);
}

export const PEOPLE_ROUTE_IMPLS: RouteTable = {
  peopleList: {
    handle: (_c: Call, s) => ({ enabled: s.ctx.settings.get().people.enabled, people: value(s.deps.life.people.list()) }),
  },
  personGet: {
    handle: (c: Call<Pid>, s) => {
      aboutPerson(s, c.params.pid);
      return { person: value(s.deps.life.people.view(c.params.pid)) };
    },
  },
  personOwnerActivity: {
    handle: (c: Call<Pid, { before?: number }>, s) => {
      aboutPerson(s, c.params.pid);
      return value(s.deps.life.people.activity(c.params.pid, c.query.before));
    },
  },
  personPropose: {
    handle: (c: Call<Pid, unknown, PersonProposeBody>, s) => {
      aboutPerson(s, c.params.pid);
      value(s.deps.life.people.propose(c.params.pid, c.body, actorName(c.auth)));
      return OK;
    },
    audit: (c: Call<Pid>) => ({ target: c.params.pid }),
  },
  personOwnerDevices: {
    handle: (c: Call<Pid>, s) => ({ devices: value(s.deps.life.people.ownerDevices(c.params.pid)) }),
  },
  personOwnerDeviceRevoke: {
    handle: (c: Call<{ pid: string; did: string }>, s) => {
      value(s.deps.life.people.revokeByOwner(c.params.pid, c.params.did));
      return OK;
    },
    audit: (c: Call<{ pid: string; did: string }>) => ({ target: c.params.did }),
  },
  personInviteLink: {
    handle: (c: Call<Pid>, s) => {
      aboutPerson(s, c.params.pid);
      return value(s.deps.life.people.inviteLink(c.params.pid, peopleUrl(s)));
    },
    // A POST, so the write pipeline asks for the device secret and the Origin, and records it (C14), without the link.
    audit: (c: Call<Pid>) => ({ target: c.params.pid }),
  },
  personColor: {
    handle: (c: Call<Pid, unknown, { color?: (typeof PERSON_COLORS)[number]; chatPerDay?: number }>, s) => {
      aboutPerson(s, c.params.pid);
      if (c.body.color !== undefined) value(s.deps.life.people.setColor(c.params.pid, c.body.color));
      if (c.body.chatPerDay !== undefined) value(s.deps.life.people.setChatPerDay(c.params.pid, c.body.chatPerDay));
      return OK;
    },
    audit: (c: Call<Pid>) => ({ target: c.params.pid }),
  },
  personAdd: {
    handle: (c: Call<Record<string, string>, unknown, PersonAddBody>, s) => value(s.deps.life.people.add(c.body)),
    audit: (_c, out) => ({ target: (out.body as { id?: string } | null)?.id }),
  },
  personOffer: {
    handle: (c: Call<Pid, unknown, PersonOfferBody>, s) => {
      aboutPerson(s, c.params.pid);
      return value(s.deps.life.people.offer(c.params.pid, c.body, actorName(c.auth)));
    },
    audit: (c: Call<Pid>) => ({ target: c.params.pid }),
  },
  personModules: {
    handle: (c: Call<Pid, unknown, { food: boolean }>, s) => {
      aboutPerson(s, c.params.pid);
      value(s.deps.life.people.setModules(c.params.pid, c.body.food, actorName(c.auth)));
      return OK;
    },
    audit: (c: Call<Pid>) => ({ target: c.params.pid }),
  },
  personInvite: {
    handle: (c: Call<Pid>, s) => {
      aboutPerson(s, c.params.pid);
      return value(s.deps.life.people.invite(c.params.pid, peopleUrl(s), actorName(c.auth)));
    },
    audit: (c: Call<Pid>) => ({ target: c.params.pid }),
  },
  personInviteRevoke: {
    handle: (c: Call<Pid>, s) => {
      aboutPerson(s, c.params.pid);
      value(s.deps.life.people.revokeInvite(c.params.pid));
      return OK;
    },
    audit: (c: Call<Pid>) => ({ target: c.params.pid }),
  },
  personRemove: {
    handle: (c: Call<Pid, unknown, PersonRemoveBody>, s) => {
      const people = s.deps.life.people;
      // Remove reaches an ending or left person too (to cut the window short, or forget).
      if (people.person(c.params.pid) === null && people.ownerReach(c.params.pid) === null) throw new ApiError('not_found', NO_PERSON);
      value(people.remove(c.params.pid, c.body.mode, c.body.forget, actorName(c.auth)));
      return OK;
    },
    audit: (c: Call<Pid>) => ({ target: c.params.pid }),
  },
  peopleSwitch: {
    handle: async (c: Call<Record<string, string>, unknown, { on: boolean }>, s) => {
      const r = await s.ctx.settings.patch({ people: { enabled: c.body.on } });
      if (!r.ok) throw new ApiError('invalid_request', r.error);
      return OK;
    },
  },
  peopleDoctor: {
    handle: (_c: Call, s) => {
      const settings = s.ctx.settings.get();
      const problem = peopleSettingsProblem(settings);
      const mode = settings.remote.mode;
      const webpush = findWebPush(s.deps.notifiers);
      const checks = [
        { name: 'remote mode', ok: mode === 'cloudflare' || mode === 'tailscale', detail: `remote.mode is ${mode} (People needs cloudflare or tailscale)` },
        { name: 'people hostname', ok: s.origin.peopleOrigin() !== null, detail: s.origin.peopleOrigin() ?? 'not set: jantar remote people-url <https-url>' },
        { name: 'settings', ok: problem === null, detail: problem ? `${problem.path}: ${problem.message}` : 'ok' },
        { name: "owner's name", ok: settings.people.ownerName !== null, detail: settings.people.ownerName ? 'set' : 'not set: jantar people on --name <your name>' },
        { name: 'switch', ok: settings.people.enabled, detail: settings.people.enabled ? 'on' : 'off: jantar people on' },
        { name: 'life data', ok: s.deps.life.people.lifeOpen() && s.deps.life.broken() === null, detail: s.deps.life.broken() ?? (s.deps.life.people.lifeOpen() ? 'open' : 'closed') },
        { name: 'partner app', ok: s.peopleAssets.size > 0, detail: s.peopleAssets.size > 0 ? 'built' : 'not built: pnpm --filter @jantar/web build' },
        { name: 'web push', ok: webpush?.publicKey() !== null && webpush !== null, detail: webpush ? 'ready' : 'no Web Push notifier' },
      ];
      return { checks };
    },
  },
};
