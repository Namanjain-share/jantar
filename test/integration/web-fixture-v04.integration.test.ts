/**
 * The synthetic v0.4 fixture (web-fixture-v04.ts) that the README's
 * screenshots and the browser checks are built from:
 *
 * - every v0.4 route answers with a body its own response schema accepts
 *   (reads from the data, writes `{ id }` or `{ ok: true }`), and any other
 *   path is left to the server;
 * - the day the screenshots tell holds: two doses due at 13:00 and none
 *   overdue, 1,240 of 1,500 kcal, weight changes that agree with the
 *   weights listed, Food over its budget, two bills on Today;
 * - Resume's Last is the newest conversation not running, and the preview
 *   types `--resume <id>` in place of `--session-id`;
 * - one Claude login: account 0 only, every session on it, `claude` typed;
 * - nothing in it points at a real home, address or account.
 */
import { describe, expect, it } from 'vitest';
import { ROUTES, StateSchema, buildPath, type RouteDef } from '@jantar/protocol';
import { V04_NOW, V04_TZ, RESUME_FOLDER, lid, webFixtureV04, webFixtureV04Single } from './web-fixture-v04.js';

const BASE = 'http://127.0.0.1:1';
const V04 = (Object.entries(ROUTES) as Array<[string, RouteDef]>).filter(([, r]) => r.phase === 'v0.4');

describe('webFixtureV04', () => {
  const f = webFixtureV04();
  const get = (path: string) => f.v04.answer('GET', new URL(path, BASE));

  /** Params that name something the fixture holds, so a read finds it. */
  const params = (name: string): Record<string, string> => {
    if (name === 'intelGet') return { id: f.v04.intel[0]!.id };
    if (name === 'doseUndo') return { id: f.v04.medicines[0]!.id, doseId: lid(401) };
    if (name === 'weightSet' || name === 'weightDelete') return { day: f.v04.today.day };
    return { id: lid(101) };
  };

  it('answers every v0.4 route with a body its response schema accepts', () => {
    for (const [name, r] of V04) {
      const reply = f.v04.answer(r.method, new URL(buildPath(r, params(name)), BASE));
      expect(reply, name).not.toBeNull();
      if (r.localOnly) {
        // Only the Mac backs up and restores: a browser is refused, as the daemon refuses it.
        expect(reply!.status, name).toBe(403);
        continue;
      }
      expect(reply!.status, name).toBe(200);
      const parsed = r.response?.safeParse(reply!.body);
      expect(parsed?.success, `${name}: ${parsed?.success ? '' : JSON.stringify(parsed?.error.issues.slice(0, 3))}`).toBe(true);
    }
  });

  it('reads the queries the screens send', () => {
    const intel = get('/v1/intel?type=tool&limit=2')!.body as { items: Array<{ type: string }>; total: number; next: string | null };
    expect(intel.items).toHaveLength(2);
    expect(intel.items.every((i) => i.type === 'tool')).toBe(true);
    expect(intel.next).not.toBeNull();
    const want = get('/v1/places?filter=want')!.body as { places: Array<{ tried: boolean }> };
    expect(want.places.length).toBeGreaterThan(0);
    expect(want.places.every((p) => !p.tried)).toBe(true);
    const docs = get(`/v1/todos?project=${lid(101)}`)!.body as { todos: Array<{ projectId?: string }> };
    expect(docs.todos.length).toBeGreaterThan(0);
    expect(docs.todos.every((t) => t.projectId === lid(101))).toBe(true);
    const done = get('/v1/todos?done=1')!.body as { todos: Array<{ doneAt?: string }> };
    expect(done.todos.every((t) => t.doneAt)).toBe(true);
    expect(get('/v1/intel/items/intel%3Anone')!.status).toBe(404);
    expect((get(`/v1/launch/history?root=${RESUME_FOLDER.root}&path=elsewhere`)!.body as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it('leaves every other path to the server', () => {
    expect(get('/v1/state')).toBeNull();
    expect(get('/v1/launch/preview?root=r.work&path=jantar')).toBeNull();
    expect(f.v04.answer('POST', new URL('/v1/life/today', BASE))).toBeNull();
  });

  it('tells Friday 30 October 2026 at 13:25 in London', () => {
    expect(f.now).toBe(V04_NOW);
    expect(f.timezone).toBe(V04_TZ);
    expect(f.v04.status.today).toBe('2026-10-30');
    expect(f.v04.today.day).toBe('2026-10-30');
  });

  it('has two medicines due now, the morning ones taken, and nothing overdue', () => {
    const items = f.v04.meds.groups.flatMap((g) => g.items);
    const due = items.filter((i) => i.status === 'pending' && i.slot <= '13:25');
    expect(due.map((i) => `${i.name} ${i.slot}`)).toEqual(['Placebin 13:00', 'Testamol 13:00']);
    expect(items.filter((i) => i.slot < '12:00').every((i) => i.status === 'taken')).toBe(true);
    expect(items.some((i) => i.overdue)).toBe(false);
    expect(f.v04.doseKey).toBe(`${due[0]!.medId}@1300`);
  });

  it('adds up: food, weight, money and Today', () => {
    expect(f.v04.food.kcal).toBe(f.v04.food.entries.reduce((s, e) => s + e.kcal, 0));
    expect(f.v04.food.kcal).toBe(1240);
    const w = f.v04.food.weight;
    const back = (n: number) => w.recent.find((x) => x.day <= new Date(Date.parse(`${w.latest!.day}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10))!;
    expect(w.change7).toBeCloseTo(w.latest!.kg - back(7).kg, 5);
    expect(w.change30).toBeCloseTo(w.latest!.kg - back(30).kg, 5);
    const m = f.v04.money;
    expect(m.spent).toBe(m.entries.filter((e) => e.kind === 'expense').reduce((s, e) => s + e.amount, 0));
    const food = m.byCategory.find((c) => c.category === 'Food')!;
    expect(food.spent).toBeGreaterThan(food.budget!);
    expect(f.v04.today.bills?.map((b) => b.name)).toEqual(['Gym', 'Example Stream']);
    expect(f.v04.today.food).toEqual({ kcal: 1240, target: 1500, weight: w.latest });
    for (const p of f.v04.projects) expect(p.open).toBe(f.v04.todos.filter((t) => t.projectId === p.id).length);
  });

  it('keeps the board a valid state with Life and the shelf on', () => {
    const st = f.state.state;
    expect(StateSchema.safeParse(st).success).toBe(true);
    expect(st.daemon?.features).toMatchObject({ life: true, intel: true });
    expect(st.daemon?.accountsMode).toBe('cswap');
    expect(Object.keys(st.launches)).toEqual([]);
  });

  it("resumes Last: the newest conversation that is not running, typed as --resume", () => {
    const last = f.v04.past.find((p) => !p.live)!;
    expect(f.v04.past[0]!.live).toBe(true);
    const q = new URLSearchParams({ root: RESUME_FOLDER.root, path: RESUME_FOLDER.path, resume: last.id });
    const p = f.v03.preview(q);
    expect(p.command).toContain(`--resume ${last.id}`);
    expect(p.command).not.toContain('--session-id');
    expect(p.command).toMatch(/^cd -- \/Users\/you\/Desktop\/work\/jantar && \S+cswap run --share-history 7 -- /);
    const pinned = f.v04.past.find((x) => x.account !== null)!;
    const q2 = new URLSearchParams({ root: RESUME_FOLDER.root, path: RESUME_FOLDER.path, resume: pinned.id });
    expect(f.v03.preview(q2).account).toMatchObject({ pick: pinned.account, source: 'resume' });
    // Without a resume, a new session id as v0.3 had it.
    expect(f.v03.preview(new URLSearchParams({ root: 'r.work', path: 'jantar' })).command).toContain('--session-id <session id>');
  });

  it('holds nothing real: no home path but the docs\' placeholder /Users/you, no address outside example domains', () => {
    const text = JSON.stringify([f.state, f.plan, f.v04, f.v03.preview(new URLSearchParams({ path: 'jantar' }))]);
    expect(text).not.toMatch(/\/Users\/(?!you\/)/);
    // The start sheet's folder row and the command it types name the same folder.
    expect(f.v03.preview(new URLSearchParams({ root: 'r.work', path: 'jantar' })).command).toContain('cd -- /Users/you/Desktop/work/jantar &&');
    for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g)) expect(m[0]).toMatch(/example\.com$/);
    for (const m of text.matchAll(/https?:\/\/([^/"\s]+)/g)) expect(m[1]).toMatch(/(^|\.)example\.com$|^127\.0\.0\.1/);
  });
});

describe('webFixtureV04Single', () => {
  const f = webFixtureV04Single();
  const st = f.state.state;

  it('is one Claude login: account 0 only, every session on it, no moves or limit alerts', () => {
    expect(StateSchema.safeParse(st).success).toBe(true);
    expect(st.daemon?.accountsMode).toBe('single');
    expect(Object.keys(st.accounts)).toEqual(['0']);
    expect(Object.values(st.sessions).every((s) => s.account === 0 && !s.move)).toBe(true);
    expect(st.moves).toEqual({});
    expect(st.alerts.some((a) => a.kind === 'limit')).toBe(false);
  });

  it('types claude itself, with no account and no cswap', () => {
    const last = f.v04.past.find((p) => !p.live)!;
    const p = f.v03.preview(new URLSearchParams({ root: RESUME_FOLDER.root, path: RESUME_FOLDER.path, resume: last.id }));
    expect(p.command).toMatch(/^cd -- \/Users\/you\/Desktop\/work\/jantar && \S+\/claude --permission-mode manual --resume /);
    expect(p.command).not.toContain('cswap');
    expect(f.v04.past.every((x) => x.account === null)).toBe(true);
  });
});
