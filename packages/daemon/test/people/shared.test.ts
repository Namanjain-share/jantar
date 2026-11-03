/**
 * v0.12 People (P4, spec 5): shared cafés and shared lists, through the
 * real routes, with synthetic people (the owner Sam, Asha, Bea).
 *
 * - Cafés: his list holds his own and the shared ones (a `space` and `by`
 *   on shared ones, the 0.10 shape on his own), with `?space=` filters; she
 *   sees only the shared ones; "Edited by" on shared edits; each person
 *   changes only their own visits (C39); he shares his own café and moves
 *   one he added back, never hers; a delete by either tells the other (one
 *   push and an Activity row).
 * - Lists: kinds, items, `doneBy` on tick, rename and delete by either,
 *   and "Assign to Asha" making an unlinked to-do of hers (C6).
 * - M3 / M16: Bea never sees Asha's shared rows, and Asha's ids under Bea's
 *   routes (and the reverse) are 404.
 * - Forget moves the shared rows to his space with her authorship 'gone'.
 * - C19 in chat: the other person's café text is framed as data and taints
 *   the turn, in his thread and in hers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Place, PlaceDetail, PlacesResponse } from '@jantar/protocol';
import { type PersonActivityResponse, type PersonTodosResponse, type PersonView, type SharedItemsResponse, type SharedListsResponse } from '@jantar/protocol/people';
import { openChatDb } from '../../src/chat/db.js';
import { personChatDeps } from '../../src/chat/person-deps.js';
import { ChatStore } from '../../src/chat/store.js';
import { CHAT_TOOLS, PERSON_TOOLS, TurnTools } from '../../src/chat/tools.js';
import type { ChatDeps } from '../../src/chat/types.js';
import { V04_LIMITS } from '../../src/api/services.js';
import { SlidingWindowLimiter } from '../../src/auth/rate-limit.js';
import { makeFixture, type Fixture } from './isolation-fixture.js';
import { EP, kit } from './p2-kit.js';

let f: Fixture;
const k = kit(() => f);
let sid = '';
let beaSid = '';

beforeAll(async () => {
  f = await makeFixture();
  // His Cafés switch (the fixture has it off); hers need no switch: shared lists are both people's.
  await f.api.ctx.settings.patch({ life: { places: true } });
  await k.subscribeAll();
  sid = ((await k.him('GET', `/v1/people/${f.asha.id}`)).json() as { person: PersonView }).person.sharedSpace ?? '';
  beaSid = ((await k.him('GET', `/v1/people/${f.bea.id}`)).json() as { person: PersonView }).person.sharedSpace ?? '';
}, 90_000);
afterAll(async () => {
  await f?.close();
});

const his = async (q = '') => (await k.him('GET', `/v1/places${q}`)).json() as PlacesResponse;
const hers = async (who = f.asha.full) => (await k.her('GET', '/v1/p/places', undefined, who)).json() as PlacesResponse;
const named = (r: PlacesResponse, name: string) => r.places.find((p) => p.name === name) as Place | undefined;

describe('shared cafés (spec 5.2)', () => {
  it('his list holds his own and the shared; hers only the shared; the filters split them', async () => {
    expect(sid).toMatch(/^s:[0-9A-Z]{26}$/);
    // His routes answer 200 on a create (0.10's), hers 201.
    expect((await k.him('POST', '/v1/places', { name: 'Just Mine Cafe' })).statusCode).toBe(200);
    expect((await k.him('POST', '/v1/places', { name: 'Blue Door', space: sid })).statusCode).toBe(200);
    expect((await k.her('POST', '/v1/p/places', { name: 'Corner Bakery', stars: 4 })).statusCode).toBe(201);
    const all = await his();
    expect(all.places.map((p) => p.name).sort()).toEqual(['Blue Door', 'Corner Bakery', 'Just Mine Cafe']);
    // His own café keeps its 0.10 shape: no space or by.
    expect(named(all, 'Just Mine Cafe')).not.toHaveProperty('space');
    expect(named(all, 'Just Mine Cafe')).not.toHaveProperty('by');
    expect(named(all, 'Blue Door')).toMatchObject({ space: sid, by: '' });
    expect(named(all, 'Corner Bakery')).toMatchObject({ space: sid, by: f.asha.id });
    expect((await his('?space=mine')).places.map((p) => p.name)).toEqual(['Just Mine Cafe']);
    expect((await his('?space=shared')).places.map((p) => p.name).sort()).toEqual(['Blue Door', 'Corner Bakery']);
    expect((await hers()).places.map((p) => p.name).sort()).toEqual(['Blue Door', 'Corner Bakery']);
    // A space that isn't his: refused.
    expect((await k.him('POST', '/v1/places', { name: 'Elsewhere', space: 's:01JZZZZZZZZZZZZZZZZZZZZZZZ' })).statusCode).toBe(400);
  });

  it('either edits a shared café ("Edited by"); each changes only their own visits (C39)', async () => {
    const blue = named(await hers(), 'Blue Door') as Place;
    expect((await k.her('PATCH', `/v1/p/places/${blue.id}`, { stars: 5, notes: 'Great window seats' })).statusCode).toBe(200);
    const after = named(await his(), 'Blue Door') as Place;
    expect(after).toMatchObject({ stars: 5, editedBy: f.asha.id, by: '' });
    expect(after.editedAt).toBeTruthy();
    const mine = await k.her('POST', `/v1/p/places/${blue.id}/visits`, { spend: 30000, notes: 'with a friend' });
    expect(mine.statusCode).toBe(201);
    const herVisit = (mine.json() as { id: string }).id;
    const hisVisit = ((await k.him('POST', `/v1/places/${blue.id}/visits`, { stars: 4 })).json() as { id: string }).id;
    const detail = (await k.him('GET', `/v1/places/${blue.id}`)).json() as PlaceDetail;
    expect(detail.place.visits.count).toBe(2);
    expect(Object.fromEntries(detail.visits.map((v) => [v.id, v.by]))).toEqual({ [herVisit]: f.asha.id, [hisVisit]: '' });
    expect((await k.him('PATCH', `/v1/places/${blue.id}/visits/${herVisit}`, { stars: 1 })).statusCode).toBe(409);
    expect((await k.him('DELETE', `/v1/places/${blue.id}/visits/${herVisit}`)).statusCode).toBe(409);
    expect((await k.her('PATCH', `/v1/p/places/${blue.id}/visits/${hisVisit}`, { stars: 1 })).statusCode).toBe(409);
    expect((await k.her('PATCH', `/v1/p/places/${blue.id}/visits/${herVisit}`, { stars: 5 })).statusCode).toBe(200);
  });

  it('he shares his own café and takes back one he added; one she added stays shared', async () => {
    const own = named(await his(), 'Just Mine Cafe') as Place;
    expect((await k.him('PATCH', `/v1/places/${own.id}`, { space: sid })).statusCode).toBe(200);
    expect(named(await hers(), 'Just Mine Cafe')).toBeTruthy();
    expect((await k.him('PATCH', `/v1/places/${own.id}`, { space: '' })).statusCode).toBe(200);
    expect(named(await hers(), 'Just Mine Cafe')).toBeUndefined();
    const corner = named(await his(), 'Corner Bakery') as Place;
    expect((await k.him('PATCH', `/v1/places/${corner.id}`, { space: '' })).statusCode).toBe(409);
    // She can't move a café out of the shared list at all.
    expect((await k.her('PATCH', `/v1/p/places/${corner.id}`, { space: '' })).statusCode).toBe(400);
  });

  it('a delete by either tells the other: one push and an Activity row', async () => {
    k.clearPushes();
    const corner = named(await hers(), 'Corner Bakery') as Place;
    expect((await k.him('DELETE', `/v1/places/${corner.id}`)).statusCode).toBe(200);
    expect(k.to(EP.asha).map((p) => p.title)).toEqual(['Sam deleted a café']);
    const act = (await k.her('GET', '/v1/p/activity')).json() as PersonActivityResponse;
    expect(act.activity[0]).toMatchObject({ actor: 'owner', action: 'place.deleted', title: 'Corner Bakery' });
    k.clearPushes();
    const blue = named(await hers(), 'Blue Door') as Place;
    expect((await k.her('DELETE', `/v1/p/places/${blue.id}`)).statusCode).toBe(200);
    expect(k.to(EP.sam).map((p) => p.title)).toEqual(['Asha deleted a café']);
    expect(k.to(EP.asha)).toEqual([]);
    expect(named(await his(), 'Blue Door')).toBeUndefined();
  });

  it('M3 / M16: Bea never sees Asha\'s shared cafés; ids across spaces are 404', async () => {
    const r = await k.her('POST', '/v1/p/places', { name: 'Asha Only' });
    const id = (r.json() as { id: string }).id;
    const b = await k.her('POST', '/v1/p/places', { name: 'Bea Only' }, f.bea.full);
    const bid = (b.json() as { id: string }).id;
    expect((await hers(f.bea.full)).places.map((p) => p.name)).toEqual(['Bea Only']);
    expect((await hers()).places.map((p) => p.name)).not.toContain('Bea Only');
    for (const [method, url] of [
      ['GET', `/v1/p/places/${id}`],
      ['PATCH', `/v1/p/places/${id}`],
      ['DELETE', `/v1/p/places/${id}`],
      ['POST', `/v1/p/places/${id}/visits`],
    ] as const) {
      expect((await k.her(method, url, method === 'GET' || method === 'DELETE' ? undefined : {}, f.bea.full)).statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await k.her('GET', `/v1/p/places/${bid}`)).statusCode).toBe(404);
    // His list holds both (he shares a space with each).
    expect((await his('?space=shared')).places.map((p) => p.name).sort()).toEqual(['Asha Only', 'Bea Only']);
    expect(beaSid).not.toBe(sid);
  });
});

describe('shared lists (spec 5.3)', () => {
  it('both add, edit and tick; a tick records who; rename and delete by either; the other is told', async () => {
    const made = await k.her('POST', '/v1/p/lists', { name: 'Weekly shop', kind: 'shopping' });
    expect(made.statusCode).toBe(201);
    const list = (made.json() as { id: string }).id;
    const hisLists = (await k.him('GET', `/v1/people/${f.asha.id}/lists`)).json() as SharedListsResponse;
    expect(hisLists.lists).toEqual([expect.objectContaining({ id: list, name: 'Weekly shop', kind: 'shopping', open: 0, done: 0 })]);
    const milk = ((await k.him('POST', `/v1/people/${f.asha.id}/lists/${list}/items`, { title: 'Oat milk' })).json() as { id: string }).id;
    const eggs = ((await k.her('POST', `/v1/p/lists/${list}/items`, { title: 'Eggs', note: 'a dozen' })).json() as { id: string }).id;
    expect((await k.her('POST', `/v1/p/lists/${list}/items/${milk}/tick`, { done: true })).statusCode).toBe(200);
    expect((await k.her('PATCH', `/v1/p/lists/${list}/items/${milk}`, { title: 'Oat milk (2)' })).statusCode).toBe(200);
    const items = (await k.him('GET', `/v1/people/${f.asha.id}/lists/${list}/items`)).json() as SharedItemsResponse;
    expect(items.items.map((i) => [i.title, i.by, i.doneBy ?? null, i.editedBy ?? null])).toEqual([
      ['Eggs', f.asha.id, null, null],
      ['Oat milk (2)', '', f.asha.id, f.asha.id],
    ]);
    expect((await k.him('PATCH', `/v1/people/${f.asha.id}/lists/${list}`, { name: 'Shop' })).statusCode).toBe(200);
    expect(((await k.her('GET', '/v1/p/lists')).json() as SharedListsResponse).lists[0]?.name).toBe('Shop');
    expect((await k.her('DELETE', `/v1/p/lists/${list}/items/${eggs}`)).statusCode).toBe(200);
    k.clearPushes();
    expect((await k.him('DELETE', `/v1/people/${f.asha.id}/lists/${list}`)).statusCode).toBe(200);
    expect(k.to(EP.asha).map((p) => p.title)).toEqual(['Sam deleted a list']);
    expect(((await k.her('GET', '/v1/p/lists')).json() as SharedListsResponse).lists).toEqual([]);
    expect((await k.her('GET', `/v1/p/lists/${list}/items`)).statusCode).toBe(404);
  });

  it('Assign to Asha: an unlinked to-do of hers from him, the item ticked as handed (C6)', async () => {
    const list = ((await k.him('POST', `/v1/people/${f.asha.id}/lists`, { name: 'Errands', kind: 'plain' })).json() as { id: string }).id;
    const item = ((await k.him('POST', `/v1/people/${f.asha.id}/lists/${list}/items`, { title: 'Return the library book' })).json() as { id: string }).id;
    const r = await k.him('POST', `/v1/people/${f.asha.id}/lists/${list}/items/${item}/assign`, {});
    expect(r.statusCode, r.body).toBe(201);
    const todos = (await k.her('GET', '/v1/p/todos')).json() as PersonTodosResponse;
    const t = todos.todos.find((x) => x.title === 'Return the library book');
    expect(t).toMatchObject({ by: '' });
    expect(t?.projectId).toBeUndefined();
    const items = (await k.her('GET', `/v1/p/lists/${list}/items`)).json() as SharedItemsResponse;
    expect(items.items[0]).toMatchObject({ handed: { to: f.asha.id }, doneBy: '' });
    expect(items.items[0]?.doneAt).toBeTruthy();
  });

  it("M3: Bea can't reach Asha's lists, and his routes for Bea don't see Asha's", async () => {
    const list = ((await k.her('POST', '/v1/p/lists', { name: 'Films', kind: 'watch' })).json() as { id: string }).id;
    expect(((await k.her('GET', '/v1/p/lists', undefined, f.bea.full)).json() as SharedListsResponse).lists).toEqual([]);
    expect((await k.her('GET', `/v1/p/lists/${list}/items`, undefined, f.bea.full)).statusCode).toBe(404);
    expect((await k.her('POST', `/v1/p/lists/${list}/items`, { title: 'x' }, f.bea.full)).statusCode).toBe(404);
    expect((await k.him('GET', `/v1/people/${f.bea.id}/lists/${list}/items`)).statusCode).toBe(404);
  });
});

describe('C19 in chat: the other person\'s café words are data', () => {
  it("his thread frames her café as partner data; hers frames his as owner data; both taint", async () => {
    const opened = openChatDb(':memory:');
    if (!opened.ok) throw new Error(opened.reason);
    const store = new ChatStore(opened.db);
    const base = { life: f.life, notifiers: [] } as unknown as ChatDeps;
    const run = async (deps: ChatDeps, thread: string, tools: typeof CHAT_TOOLS) => {
      const id = `01JTURN${String(Math.floor(Math.random() * 1e15)).padStart(19, '0')}`;
      const st = store.inThread(thread);
      st.insertTurn({ id, at: f.api.ctx.clock.iso(), via: 'phone', text: '', photos: [], state: 'running', tainted: false, refused: 0, by: 'x' });
      const place = tools.find((t) => t.name === 'places_find');
      if (!place) throw new Error('no places_find');
      const tt = new TurnTools({ ctx: f.api.ctx, deps, store: st, turnId: id, actor: { kind: 'cli' }, actorName: 'cli', message: '', tools: [place], lifeWrites: new SlidingWindowLimiter({ ...V04_LIMITS.lifeWrite, clock: f.api.ctx.clock }), live: () => true });
      const a = await tt.call('places_find', {});
      return { text: a.text, tainted: tt.counts.tainted };
    };
    await k.him('POST', '/v1/places', { name: 'His Shared Spot', space: sid, notes: 'from him' });
    const mine = await run(base, '', CHAT_TOOLS);
    expect(mine.text).toMatch(/<data source="partner" id="[0-9A-Z]{26}">\nAsha Only/);
    expect(mine.tainted).toBe(true);
    const herDeps = personChatDeps(base, { pid: f.asha.id, people: f.life.people });
    const her = await run(herDeps, `p:${f.asha.id}`, PERSON_TOOLS);
    expect(her.text).toMatch(/<data source="owner" id="[0-9A-Z]{26}">\nHis Shared Spot/);
    expect(her.text).not.toMatch(/Bea Only|Just Mine Cafe/);
    expect(her.tainted).toBe(true);
    store.close();
  });
});

describe('forget (spec 5.1)', () => {
  it("Bea's shared café stays, moved to his space with her authorship gone", async () => {
    expect((await k.her('POST', '/v1/p/leave', { data: 'delete', confirm: 'LEAVE' }, f.bea.full)).statusCode).toBe(200);
    const all = await his();
    const kept = named(all, 'Bea Only');
    expect(kept).toBeTruthy();
    expect(kept).not.toHaveProperty('space');
    expect((await his('?space=shared')).places.map((p) => p.name)).not.toContain('Bea Only');
    const row = f.life.people.openCore()?.db.prepare("SELECT space, by_person FROM places WHERE space = '' AND json_extract(json, '$.name') = ?").get('Bea Only') as { space: string; by_person: string } | undefined;
    expect(row).toEqual({ space: '', by_person: 'gone' });
  });
});
