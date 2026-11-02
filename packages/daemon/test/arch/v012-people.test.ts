/**
 * v0.12 People (spec 9.7.1), by reading the route tables and the source:
 *
 * - T1: her routes are exactly the reviewed list, every one under
 *   PERSON_PREFIX, never on ctl.sock; only the three join routes take no
 *   credential; the exit set is exactly the six. His People routes are
 *   pinned too, each with its scope, ctl, localOnly and area. Adding or
 *   widening one is a visible edit here.
 * - M9: every People route is phase v0.12; every `:pid` data route and
 *   every person data route declares an area; every localOnly route is also
 *   ctl.
 * - T2: her cookie is read at exactly one place in api/, guarded by her
 *   prefix and her host; his device cookie is never read under her prefix;
 *   hers is set only with the `__Host-` attributes.
 * - T7: her stream imports no State, replay, store or his event stream.
 * - The ledger (M19) is append-only: no UPDATE or DELETE on
 *   person_consents anywhere in src/.
 * - Her route files import nothing from his route files, and his nothing
 *   from hers.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROUTES, type RouteDef } from '@jantar/protocol';
import { AREAS, PEOPLE_ROUTES, PERSON_PREFIX, PERSON_ROUTES } from '@jantar/protocol/people';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(SRC, p).split(sep).join('/');
const code = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const src = files(SRC).map((p) => ({ rel: rel(p), text: code(p) }));
const imports = (text: string) => [...text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((m) => m[1] as string);

/** T1: her routes, reviewed. Edit this list in the same commit as a route. */
const REVIEWED_PERSON_ROUTES = [
  'personActivity',
  'personAgreementAccept',
  'personAgreementDecline',
  'personAgreementNarrow',
  'personDeviceLinkClaim',
  'personDeviceLinkCode',
  'personDeviceRevoke',
  'personDevices',
  'personEvents',
  'personExport',
  'personJoin',
  'personJoinPreview',
  'personLeave',
  'personMe',
  'personPause',
  'personPrefs',
  'personPushKey',
  'personPushSubscribe',
  'personPushTest',
  'personPushUnsubscribe',
  'personResume',
  // Her Today, to-dos, projects, weights and mirror.
  'personMirror',
  'personProjectCreate',
  'personProjectDelete',
  'personProjectUpdate',
  'personProjects',
  'personToday',
  'personTodoAck',
  'personTodoAsk',
  'personTodoCreate',
  'personTodoDelete',
  'personTodoDone',
  'personTodoSkip',
  'personTodoSnooze',
  'personTodoUpdate',
  'personTodos',
  'personWeightDelete',
  'personWeightSet',
  'personWeights',
];

/** T1: his People routes, reviewed: scope, ctl, localOnly, area. */
const REVIEWED_PEOPLE_OWNER_ROUTES: Record<string, { scope: string; ctl: boolean; localOnly: boolean; area: string | null }> = {
  peopleDoctor: { scope: 'admin', ctl: true, localOnly: true, area: null },
  peopleList: { scope: 'control', ctl: true, localOnly: false, area: null },
  peopleSwitch: { scope: 'admin', ctl: true, localOnly: true, area: null },
  personAdd: { scope: 'admin', ctl: true, localOnly: true, area: null },
  personColor: { scope: 'control', ctl: false, localOnly: false, area: null },
  personGet: { scope: 'control', ctl: false, localOnly: false, area: null },
  personInvite: { scope: 'admin', ctl: true, localOnly: true, area: null },
  personInviteLink: { scope: 'admin', ctl: false, localOnly: false, area: null },
  personInviteRevoke: { scope: 'admin', ctl: true, localOnly: true, area: null },
  personModules: { scope: 'admin', ctl: true, localOnly: true, area: null },
  personOffer: { scope: 'admin', ctl: true, localOnly: true, area: null },
  personOwnerActivity: { scope: 'control', ctl: false, localOnly: false, area: null },
  personOwnerDeviceRevoke: { scope: 'admin', ctl: true, localOnly: false, area: null },
  personOwnerDevices: { scope: 'control', ctl: true, localOnly: false, area: null },
  personPropose: { scope: 'admin', ctl: false, localOnly: false, area: null },
  personRemove: { scope: 'admin', ctl: true, localOnly: true, area: null },
  // His reads and writes in her space, each with its area.
  personAssign: { scope: 'control', ctl: false, localOnly: false, area: 'todos' },
  personOwnerToday: { scope: 'control', ctl: false, localOnly: false, area: 'today' },
  personOwnerTodoDelete: { scope: 'control', ctl: false, localOnly: false, area: 'todos' },
  personOwnerTodoUpdate: { scope: 'control', ctl: false, localOnly: false, area: 'todos' },
  personOwnerTodos: { scope: 'control', ctl: true, localOnly: false, area: 'todos' },
  personOwnerWeightDelete: { scope: 'control', ctl: false, localOnly: false, area: 'weight' },
  personOwnerWeightUpdate: { scope: 'control', ctl: false, localOnly: false, area: 'weight' },
  personOwnerWeights: { scope: 'control', ctl: false, localOnly: false, area: 'weight' },
};

/** M9: the `:pid` routes about the person, not her data (no area). */
const ABOUT_THE_PERSON = new Set(['personGet', 'personOwnerActivity', 'personPropose', 'personOwnerDevices', 'personOwnerDeviceRevoke', 'personInviteLink', 'personColor', 'personOffer', 'personModules', 'personInvite', 'personInviteRevoke', 'personRemove']);

const person = Object.entries(PERSON_ROUTES) as [string, RouteDef][];
const people = Object.entries(PEOPLE_ROUTES) as [string, RouteDef][];

describe('T1: the allowlist is exactly the reviewed list', () => {
  it('her routes', () => {
    expect(person.map(([k]) => k).sort()).toEqual([...REVIEWED_PERSON_ROUTES].sort());
    for (const [k, def] of person) {
      expect(def.scope, k).toBe('person');
      expect(def.path.startsWith(PERSON_PREFIX), k).toBe(true);
      expect(def.ctl, k).toBe(false);
      expect(def.localOnly, k).toBeUndefined();
      expect(def.phase, k).toBe('v0.12');
    }
    expect(person.filter(([, d]) => d.join).map(([k]) => k).sort()).toEqual(['personDeviceLinkClaim', 'personJoin', 'personJoinPreview']);
    expect(person.filter(([, d]) => d.exit).map(([k]) => k).sort()).toEqual(['personActivity', 'personExport', 'personLeave', 'personMe', 'personPause', 'personResume']);
  });

  it('no other scope uses her prefix, and the owner table has no person route', () => {
    for (const [k, def] of [...Object.entries(ROUTES), ...people] as [string, RouteDef][]) {
      expect(def.scope, k).not.toBe('person');
      expect(def.path.startsWith(PERSON_PREFIX) || def.path === '/v1/p', k).toBe(false);
      expect(def.join, k).toBeUndefined();
      expect(def.exit, k).toBeUndefined();
    }
  });

  it("his People routes, each with its scope, ctl, localOnly and area", () => {
    const got = Object.fromEntries(people.map(([k, d]) => [k, { scope: d.scope, ctl: d.ctl, localOnly: d.localOnly === true, area: d.area ?? null }]));
    expect(got).toEqual(REVIEWED_PEOPLE_OWNER_ROUTES);
  });
});

describe('M9: route metadata', () => {
  it('every person data route and every :pid data route declares an area', () => {
    for (const [k, def] of person) {
      // Her account routes have none; the mirror's area is its `:area` parameter.
      const account = /^person(Join|Me|Agreement|Pause|Resume|Leave|Export|Activity|Prefs|Device|Push|Events|Mirror)/.test(k);
      if (!account) expect(def.area, k).toBeDefined();
    }
  });

  it('every People route is phase v0.12; areas come from AREAS; localOnly implies ctl', () => {
    for (const [k, def] of [...person, ...people]) {
      expect(def.phase, k).toBe('v0.12');
      if (def.area !== undefined) expect(Object.keys(AREAS), k).toContain(def.area);
      if (def.localOnly) expect(def.ctl, k).toBe(true);
    }
  });

  it('a :pid route without an area is one about the person', () => {
    for (const [k, def] of people) {
      if (def.path.includes(':pid') && def.area === undefined) expect(ABOUT_THE_PERSON.has(k), k).toBe(true);
    }
  });

  it('no People path collides with an owner route', () => {
    const owner = new Set((Object.values(ROUTES) as RouteDef[]).map((d) => `${d.method} ${d.path}`));
    for (const [k, def] of [...person, ...people]) expect(owner.has(`${def.method} ${def.path}`), k).toBe(false);
  });
});

describe('T2: her cookie is read in one place', () => {
  const api = src.filter((f) => f.rel.startsWith('api/'));
  it('PERSON_COOKIE is read once in api/, under her prefix on her host', () => {
    const reads = api.flatMap((f) => [...f.text.matchAll(/cookies\?\.\[PERSON_COOKIE\]/g)].map(() => f.rel));
    expect(reads).toEqual(['api/app.ts']);
    const app = api.find((f) => f.rel === 'api/app.ts')?.text ?? '';
    const at = app.indexOf('cookies?.[PERSON_COOKIE]');
    const guard = app.lastIndexOf('if (onPeopleHost && path.startsWith(PERSON_PREFIX))', at);
    expect(guard).toBeGreaterThan(-1);
    expect(at - guard).toBeLessThan(200);
  });

  it("his device cookie is read only off her prefix and her host", () => {
    const app = api.find((f) => f.rel === 'api/app.ts')?.text ?? '';
    const at = app.indexOf('req.cookies?.[DEVICE_COOKIE]');
    const block = app.slice(app.lastIndexOf('if (isApiPath(path)', at), at);
    expect(block).toContain('!path.startsWith(PERSON_PREFIX)');
    expect(block).toContain('!onPeopleHost');
  });

  it('her cookie is set only with the __Host- attributes', () => {
    const sets = src.filter((f) => f.text.includes('setCookie(PERSON_COOKIE'));
    expect(sets.map((f) => f.rel)).toEqual(['api/routes/person/account.ts']);
    const acct = sets[0]?.text ?? '';
    expect(acct).toMatch(/httpOnly: true, secure: true, sameSite: 'strict', path: '\/'/);
    expect(acct).not.toMatch(/domain/i);
  });
});

describe('T7: her stream reads nothing of his', () => {
  it('person-events.ts imports no State, replay, store or his event stream', () => {
    const f = src.find((x) => x.rel === 'api/person-events.ts');
    expect(f).toBeDefined();
    const text = f?.text ?? '';
    for (const spec of imports(text)) expect(spec, spec).not.toMatch(/events-ws|store|reducer|state/);
    expect(text).not.toMatch(/getState|\.replay\(|store\.subscribe|ctx\.store/);
  });
});

describe('M19: the ledger is append-only', () => {
  it('no UPDATE or DELETE on person_consents anywhere', () => {
    for (const f of src) expect(f.text, f.rel).not.toMatch(/(UPDATE|DELETE FROM)\s+person_consents/i);
  });
});

describe('her route files and his stay apart', () => {
  it('nothing under api/routes/person/ imports a route file outside it, and no other route file imports from it', () => {
    for (const f of src) {
      for (const spec of imports(f.text)) {
        if (f.rel.startsWith('api/routes/person/') && spec.startsWith('../') && !spec.startsWith('../../')) {
          throw new Error(`${f.rel} imports ${spec}`);
        }
        if (f.rel.startsWith('api/routes/') && !f.rel.startsWith('api/routes/person/')) expect(spec, f.rel).not.toMatch(/routes\/person\/|^\.\/person\//);
      }
    }
  });
});

/**
 * T6 (C5), the part this build pins: every SELECT, UPDATE and DELETE on a
 * table that already holds person spaces names `space` (her to-dos,
 * projects and weights; saved foods are keyed per space), and every query
 * on her Activity names `person`. Medicines, doses, food and cafés join
 * this list as their modules take a space.
 */
describe('T6: every query on a person-space table names its space', () => {
  const SPACE_TABLES = ['todos', 'projects', 'weights', 'foods_saved'];
  const statements = (text: string) => [...text.matchAll(/(['"`])((?:SELECT|UPDATE|DELETE)\b[\s\S]*?)\1/g)].map((m) => m[2] as string);
  it('names space (or person) in every statement on them', () => {
    const bad: string[] = [];
    for (const f of src) {
      for (const sql of statements(f.text)) {
        const tables = [...sql.matchAll(/\b(?:FROM|UPDATE|JOIN)\s+([a-z_]+)/gi)].map((m) => (m[1] as string).toLowerCase());
        if (tables.some((t) => SPACE_TABLES.includes(t)) && !/\bspace\b/.test(sql)) bad.push(`${f.rel}: ${sql.slice(0, 90)}`);
        if (tables.includes('person_activity') && !/\bperson\b/.test(sql)) bad.push(`${f.rel}: ${sql.slice(0, 90)}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
