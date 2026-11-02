/**
 * jantar place (v0.10) against an in-memory daemon: `list` turns its flags
 * into the list query (tried or want, sort, every --tag, area, a search)
 * and prints one line per café (name, stars, price in the Life currency or
 * words, area, last visit, tags, the id), never notes; `show` prints one
 * café's sub-ratings, tags, dishes, newest 10 visits and notes. `--json`
 * prints the reply as it came. Escape sequences in café text never reach
 * the terminal. The daemon's sentences reach the user as they are, and
 * with the daemon down it exits 3. Read only: it sends no write. Synthetic
 * cafés only.
 */
import { describe, expect, it } from 'vitest';
import type { LifeStatus, Place, PlaceDetail, PlacesResponse } from '@jantar/protocol';
import place, { moneyText, priceText, starsText } from '../src/commands/place.js';
import { EXIT } from '../src/command.js';
import { COMMANDS, main, memoryIo } from '../src/index.js';
import { contextFor, fail, fakeCtl, ok, type CtlCall, type Handler } from './helpers.js';

const ENV = { HOME: '/synthetic/home', JANTAR_HOME: '/synthetic/state' };
const AT = '2026-11-01T10:00:00.000Z';
const ID1 = '01JSYNTHCAFE0000000000000A';
const ID2 = '01JSYNTHCAFE0000000000000B';
const ID3 = '01JSYNTHCAFE0000000000000C';
const NO_VISITS = { count: 0, last: null, avgSpend: null };

const base = { tried: true, dishes: [], best: null, tags: [], visits: NO_VISITS, createdAt: AT, updatedAt: AT };
const PLACES: Place[] = [
  {
    ...base,
    id: ID1,
    name: 'Sample Dosa House',
    area: 'Market Street',
    notes: 'NOTES-MARKER-5a1e',
    stars: 5,
    price: 2,
    tags: ['wifi', 'sockets', 'Board games'],
    dishes: [{ name: 'Ghee roast dosa', rating: 5 }],
    best: 5,
    visits: { count: 3, last: '2026-10-12', avgSpend: 45000 },
  },
  { ...base, id: ID2, name: 'Example Café', area: 'Old Town', ratings: { food: 5, drinks: 4 }, again: 'no' },
  { ...base, id: ID3, name: 'Fixture Bakery\u001b[31m', tried: false },
];

function status(currency: string | null): LifeStatus {
  return {
    open: true,
    timezone: 'UTC',
    today: '2026-11-02',
    currency,
    lockScreenDetails: false,
    modules: { todos: false, medicines: false, food: false, places: true, finance: false, posts: false },
    estimate: { available: false },
    backups: { last: null, count: 0 },
    push: { devices: 0, webpush: true },
  };
}

function daemon(routes: Record<string, Handler | ReturnType<typeof ok>> = {}, currency: string | null = 'INR') {
  const list: PlacesResponse = { places: PLACES, tags: [{ tag: 'wifi', n: 1 }], areas: [] };
  return fakeCtl({ 'GET /v1/places': () => ok(list), 'GET /v1/life/status': () => ok(status(currency)), ...routes });
}

async function run(args: string[], ctl = daemon()) {
  const c = contextFor({ env: ENV }, { ctl });
  const code = await place.run(args, c.ctx);
  return { code, out: c.io.stdout, err: c.io.stderr, calls: ctl.calls as CtlCall[] };
}

describe('place list', () => {
  it('one line a café, best first: name, stars, price, area, last visit, tags, the id; never notes', async () => {
    const r = await run(['list']);
    expect(r.err).toBe('');
    expect(r.code).toBe(EXIT.ok);
    const lines = r.out.split('\n');
    expect(lines[0]).toBe('3 cafés, best first');
    expect(lines[1]).toBe(`${'Sample Dosa House'.padEnd(28)}  ★★★★★  ₹₹    Market Street · last 12 Oct · Wi-Fi, Sockets, Board games  ${ID1}`);
    expect(lines[2]).toBe(`${'Example Café'.padEnd(28)}  ★★★★½        Old Town · not again  ${ID2}`);
    // An escape sequence in a name never reaches the terminal.
    expect(lines[3]).toBe(`${'Fixture Bakery'.padEnd(28)}  -----        want to try  ${ID3}`);
    expect(r.out).not.toContain('\u001b');
    expect(r.out).not.toContain('NOTES-MARKER-5a1e');
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/places', 'GET /v1/life/status']);
  });

  it('turns the flags into the query, every --tag kept', async () => {
    const r = await run(['list', '--tried', '--sort', 'Work', '--tag', 'wifi', '--tag', 'Quiet', '--area', 'Old Town', '--q', 'dosa']);
    expect(r.code).toBe(EXIT.ok);
    expect(r.calls[0]?.path).toBe('/v1/places?filter=tried&sort=work&tags=wifi%2CQuiet&area=Old+Town&q=dosa');
    expect(r.out.split('\n')[0]).toBe('3 cafés, best to work from first');
    const want = await run(['list', '--want']);
    expect(want.calls[0]?.path).toBe('/v1/places?filter=want');
  });

  it('refuses --tried with --want, an unknown sort, a tag with a comma, and flags of show', async () => {
    for (const [args, says] of [
      [['list', '--tried', '--want'], 'give --tried or --want, not both'],
      [['list', '--sort', 'rating'], 'unknown --sort "rating" (best, recent, visits, name, price, work)'],
      [['list', '--tag', 'wifi,quiet'], 'a --tag has no comma'],
      [['show', ID1, '--tag', 'wifi'], '--tag is not for "place show"'],
      [['list', 'extra'], '"place list" takes no other word'],
      [['add'], 'unknown action "add" (list or show)'],
    ] as const) {
      const r = await run([...args]);
      expect(r.code, args.join(' ')).toBe(EXIT.usage);
      expect(r.err, args.join(' ')).toContain(says);
      expect(r.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    }
  });

  it('with no Life currency the price is a word; --json prints the reply as it came', async () => {
    const r = await run(['list'], daemon({}, null));
    expect(r.out.split('\n')[1]).toContain('★★★★★  Mid      Market Street');
    const json = await run(['list', '--json']);
    expect(JSON.parse(json.out)).toEqual({ places: PLACES, tags: [{ tag: 'wifi', n: 1 }], areas: [] });
  });

  it('says when there is no café, or none matches', async () => {
    const empty = fakeCtl({ 'GET /v1/places': () => ok({ places: [], tags: [], areas: [] }) });
    expect((await run(['list'], empty)).out).toBe('No cafés yet. Add them on the phone (Cafés).\n');
    expect((await run(['list', '--q', 'nothing'], empty)).out).toBe('No café matches.\n');
  });

  it("a 0.9 daemon's reply (no tags, no visits) still prints", async () => {
    const old = { id: ID1, name: 'Sample Dosa House', tried: true, dishes: [{ name: 'Dosa', rating: 4 }], best: 4, createdAt: AT, updatedAt: AT };
    const r = await run(['list'], daemon({ 'GET /v1/places': () => ok({ places: [old] }) }));
    expect(r.code).toBe(EXIT.ok);
    expect(r.out.split('\n')[1]).toBe(`${'Sample Dosa House'.padEnd(28)}  ★★★★☆        ${ID1}`);
  });

  it("the daemon's sentences reach the user as they are; with the daemon down it exits 3", async () => {
    const off = await run(['list'], daemon({ 'GET /v1/places': fail('forbidden', 'Cafés are off. Turn them on at your Mac: jantar life on places', 403) }));
    expect(off.code).toBe(EXIT.failed);
    expect(off.err).toBe('jantar place: Cafés are off. Turn them on at your Mac: jantar life on places\n');
    const down = contextFor({ env: ENV }, { ctl: fakeCtl({}, { down: true }) });
    expect(await place.run(['list'], down.ctx)).toBe(EXIT.daemonDown);
  });
});

describe('place show', () => {
  const detail: PlaceDetail = {
    place: {
      ...base,
      id: ID1,
      name: 'Example Café',
      area: 'Old Town',
      link: 'https://maps.example.com/?q=example-cafe',
      notes: 'Go before noon.',
      stars: 4,
      price: 2,
      again: 'yes',
      ratings: { food: 5, drinks: 4, work: 3 },
      tags: ['wifi', 'quiet'],
      dishes: [
        { name: 'Cardamom bun', rating: 5, price: 18000, again: true },
        { name: 'Must try toast', notes: 'Saturdays only' },
      ],
      best: 5,
      visits: { count: 12, last: '2026-10-30', avgSpend: 45050 },
    },
    visits: Array.from({ length: 12 }, (_, i) => ({
      id: `01JSYNTHVISIT00000000000${String(i).padStart(2, '0')}`,
      placeId: ID1,
      day: `2026-10-${String(30 - i).padStart(2, '0')}`,
      ...(i === 0 ? { spend: 45000, stars: 4, had: ['Cardamom bun', 'Flat white'], notes: 'Quiet before 11' } : {}),
      createdAt: AT,
      updatedAt: AT,
    })),
    more: false,
  };

  it('prints the café, its ratings, tags, dishes, the newest 10 visits and its notes', async () => {
    const r = await run(['show', ID1], daemon({ [`GET /v1/places/${ID1}`]: () => ok(detail) }));
    expect(r.err).toBe('');
    expect(r.code).toBe(EXIT.ok);
    const lines = r.out.split('\n');
    expect(lines.slice(0, 9)).toEqual([
      'Example Café  ★★★★☆  ₹₹  would go again',
      'Old Town · https://maps.example.com/?q=example-cafe · tried',
      'Ratings: Food ★★★★★ · Coffee & drinks ★★★★☆ · Work ★★★☆☆',
      'Tags: Wi-Fi, Quiet',
      'Dishes:',
      `  ${'Cardamom bun'.padEnd(40)}  ★★★★★  ₹180 · order again`,
      `  ${'Must try toast'.padEnd(40)}  not tried yet  Saturdays only`,
      'Visits: 12 · about ₹450.50 a visit',
      '  2026-10-30  ₹450  ★★★★☆ · had Cardamom bun, Flat white · Quiet before 11',
    ]);
    expect(lines.filter((l) => l.startsWith('  2026-10-'))).toHaveLength(10);
    expect(r.out).toContain(`  and 2 older (jantar place show ${ID1} --json for a page of them)`);
    expect(r.out.endsWith('Notes: Go before noon.\n')).toBe(true);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /v1/places/${ID1}`, 'GET /v1/life/status']);
  });

  it('a café with nothing but a name; --json; a café that is gone; no id', async () => {
    const bare: PlaceDetail = { place: { ...base, id: ID2, name: 'Plain Place', tried: false }, visits: [], more: false };
    const r = await run(['show', ID2], daemon({ [`GET /v1/places/${ID2}`]: () => ok(bare) }));
    expect(r.out).toBe('Plain Place  -----\nwant to try\nNo visits yet.\n');
    const json = await run(['show', ID2, '--json'], daemon({ [`GET /v1/places/${ID2}`]: () => ok(bare) }));
    expect(JSON.parse(json.out)).toEqual(bare);
    const gone = await run(['show', ID3], daemon({ [`GET /v1/places/${ID3}`]: fail('not_found', 'That café is gone.', 404) }));
    expect(gone.code).toBe(EXIT.failed);
    expect(gone.err).toBe('jantar place: That café is gone.\n');
    const none = await run(['show']);
    expect(none.code).toBe(EXIT.usage);
    expect(none.err).toContain('show needs a café id');
  });
});

describe('formatting', () => {
  it('stars with halves; prices in symbols or words; money in the currency or plain', () => {
    expect(starsText(4)).toBe('★★★★☆');
    expect(starsText(3.5)).toBe('★★★½☆');
    expect(starsText(5)).toBe('★★★★★');
    expect(starsText(null)).toBe('-----');
    expect(priceText(3, 'INR')).toBe('₹₹₹');
    expect(priceText(1, 'USD')).toBe('$');
    expect(priceText(4, null)).toBe('Splurge');
    expect(priceText(undefined, 'INR')).toBe('');
    expect(moneyText(45000, 'INR')).toBe('₹450');
    expect(moneyText(12345, 'INR')).toBe('₹123.45');
    expect(moneyText(45000, null)).toBe('450.00');
  });
});

describe('the command', () => {
  it('sits right after post, owned by WP-FF, with its help', async () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names.indexOf('place')).toBe(names.indexOf('post') + 1);
    expect(COMMANDS.find((c) => c.name === 'place')?.owner).toBe('WP-FF');
    const help = memoryIo({ HOME: '/nonexistent/jantar-test-home' });
    expect(await main(['place', '--help'], { io: help })).toBe(EXIT.ok);
    expect(help.stdout).toContain('usage: jantar place <list [options]|show <id>> [--json]');
    expect(help.stdout).toContain('place list [--tried|--want] [--sort best|recent|visits|name|price|work] [--tag <t>]... [--area <a>] [--q <text>] [--json]');
  });
});
