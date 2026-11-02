/**
 * jantar place (v0.10, spec 0.10 A5): read your cafés over ctl.sock, so a
 * script or a Claude session on this Mac can see them: `list` with the
 * phone's sorts and filters, and `show` one café with its sub-ratings,
 * dishes and newest 10 visits. Read only: adding, rating, logging a visit
 * and deleting are the phone's (and Chat's); ctl.sock has no café write.
 *
 * Every text from life.db goes through clean()/clip() before it is printed
 * (no escape sequence reaches the terminal). `--json` prints the reply as
 * it came, for scripts. Prices show in the Life currency's symbol (the
 * words Cheap, Mid, Pricey and Splurge when none is set).
 */
import {
  PLACE_PRICE_WORDS,
  PLACE_RATING_KEYS,
  PLACE_RATING_LABELS,
  PlacesSortSchema,
  ROUTES,
  buildPath,
  placeScore,
  placeTagLabel,
  type LifeStatus,
  type Place,
  type PlaceDetail,
  type PlaceVisit,
  type PlacesResponse,
  type PlacesSort,
} from '@jantar/protocol';
import { UsageError, parseArgs, type ParsedArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { callDaemon } from '../ctl.js';
import { clean, clip } from '../lib/text.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** Visits `show` prints, newest first. */
export const SHOW_VISITS = 10;
const NAME_SHOWN = 28;
const SORT_WORDS: Record<PlacesSort, string> = {
  best: 'best first',
  recent: 'last visited first',
  visits: 'most visited first',
  name: 'by name',
  price: 'cheapest first',
  work: 'best to work from first',
};

const FLAGS = {
  tried: { type: 'boolean', help: 'list: only cafés you have tried' },
  want: { type: 'boolean', help: 'list: only cafés you want to try' },
  sort: { type: 'string', help: `list: ${PlacesSortSchema.options.join(', ')} (default best)` },
  tag: { type: 'string', multiple: true, help: 'list: only cafés with this tag (again for more; all must match)' },
  area: { type: 'string', help: 'list: only this area' },
  q: { type: 'string', help: 'list: search names, areas, dishes, tags and notes' },
  json: { type: 'boolean', help: 'the reply as JSON' },
} as const;

type Flags = ParsedArgs<typeof FLAGS>['flags'];
type FlagName = keyof typeof FLAGS;

function only(flags: Flags, action: string, allowed: readonly FlagName[]): void {
  for (const name of Object.keys(FLAGS) as FlagName[]) {
    if (flags[name] !== undefined && !allowed.includes(name)) throw new UsageError(`--${name} is not for "place ${action}"`);
  }
}

/** "12 Oct" from a day key. */
function shortDay(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ''}`;
}

/** Five characters: "★★★★☆", "★★★★½" for a half, "-----" with no score. */
export function starsText(score: number | null | undefined): string {
  if (score === null || score === undefined) return '-----';
  const full = Math.floor(score);
  const half = score - full >= 0.5 ? 1 : 0;
  return `${'★'.repeat(full)}${half ? '½' : ''}${'☆'.repeat(Math.max(0, 5 - full - half))}`;
}

/** The currency's symbol ("₹"), or null with none (or one this runtime does not know). */
function symbolOf(currency: string | null): string | null {
  if (!currency) return null;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency;
  } catch {
    return null;
  }
}

/** A price level as the currency symbol repeated ("₹₹"), or a word with no currency ("Mid"); '' for none. */
export function priceText(level: number | undefined, currency: string | null): string {
  if (level === undefined) return '';
  const symbol = symbolOf(currency);
  return symbol ? symbol.repeat(level) : (PLACE_PRICE_WORDS[level - 1] ?? '');
}

/** Hundredths for reading: "₹450", "₹123.45", or "450.00" with no currency. */
export function moneyText(hundredths: number, currency: string | null): string {
  if (currency) {
    const digits = hundredths % 100 === 0 ? 0 : 2;
    try {
      return new Intl.NumberFormat('en', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(hundredths / 100);
    } catch {
      /* an unknown code: plain below */
    }
  }
  return (hundredths / 100).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** The Life currency, or null when the daemon does not say. */
async function lifeCurrency(ctx: CliContext): Promise<string | null> {
  try {
    return (await callDaemon<LifeStatus>(ctx.ctl, 'GET', ROUTES.lifeStatus.path)).currency;
  } catch {
    return null;
  }
}

const tagsText = (tags: readonly string[] | undefined, max = 60): string => clip((tags ?? []).map(placeTagLabel).join(', '), max);

/** One list line: name, stars, price, then area, last visit and tags, and the id. Never notes. */
export function placeLine(p: Place, currency: string | null): string {
  const name = clip(p.name, NAME_SHOWN).padEnd(NAME_SHOWN);
  const price = priceText(p.price, currency).padEnd(currency ? 4 : 7);
  const detail = [
    p.area ? clip(p.area, 30) : '',
    p.visits?.last ? `last ${shortDay(p.visits.last)}` : '',
    tagsText(p.tags),
    p.tried ? '' : 'want to try',
    p.again === 'no' ? 'not again' : '',
  ].filter((s) => s !== '');
  return `${name}  ${starsText(placeScore(p))}  ${price}  ${detail.join(' · ')}${detail.length ? '  ' : ''}${p.id}`;
}

function visitLine(v: PlaceVisit, currency: string | null): string {
  const parts = [v.day, v.spend !== undefined ? moneyText(v.spend, currency) : '', v.stars !== undefined ? starsText(v.stars) : ''].filter((s) => s !== '');
  const had = v.had?.length ? `had ${clip(v.had.join(', '), 60)}` : '';
  const notes = v.notes ? clip(v.notes, 80) : '';
  return `  ${[parts.join('  '), had, notes].filter((s) => s !== '').join(' · ')}`;
}

/** `show`: the café, its ratings, tags, dishes, the newest visits and its notes. */
export function placeDetail(d: PlaceDetail, currency: string | null): string {
  const p = d.place;
  const lines: string[] = [];
  const head = [starsText(placeScore(p)), priceText(p.price, currency), p.again === 'yes' ? 'would go again' : p.again === 'maybe' ? 'maybe again' : p.again === 'no' ? 'not again' : '']
    .filter((s) => s !== '')
    .join('  ');
  lines.push(`${clean(p.name)}  ${head}`);
  const where = [p.area ? clean(p.area) : '', p.link ? clean(p.link) : '', p.tried ? 'tried' : 'want to try'].filter((s) => s !== '');
  lines.push(where.join(' · '));
  const rated = PLACE_RATING_KEYS.filter((k) => p.ratings?.[k] !== undefined);
  if (rated.length) lines.push(`Ratings: ${rated.map((k) => `${PLACE_RATING_LABELS[k]} ${starsText(p.ratings?.[k])}`).join(' · ')}`);
  if (p.tags?.length) lines.push(`Tags: ${tagsText(p.tags, 200)}`);
  if (p.dishes.length) {
    lines.push('Dishes:');
    for (const dish of p.dishes) {
      const extra = [dish.price !== undefined ? moneyText(dish.price, currency) : '', dish.again ? 'order again' : dish.again === false ? 'not again' : '', dish.notes ? clip(dish.notes, 60) : ''].filter((s) => s !== '');
      lines.push(`  ${clip(dish.name, 40).padEnd(40)}  ${dish.rating !== undefined ? starsText(dish.rating) : 'not tried yet'}${extra.length ? `  ${extra.join(' · ')}` : ''}`);
    }
  }
  const count = p.visits?.count ?? d.visits.length;
  if (count > 0) {
    const avg = p.visits?.avgSpend;
    lines.push(`Visits: ${count}${avg !== null && avg !== undefined ? ` · about ${moneyText(avg, currency)} a visit` : ''}`);
    for (const v of d.visits.slice(0, SHOW_VISITS)) lines.push(visitLine(v, currency));
    if (count > SHOW_VISITS) lines.push(`  and ${count - SHOW_VISITS} older (jantar place show ${p.id} --json for a page of them)`);
  } else {
    lines.push('No visits yet.');
  }
  if (p.notes) lines.push(`Notes: ${clip(p.notes, 400)}`);
  return `${lines.join('\n')}\n`;
}

async function list(ctx: CliContext, flags: Flags): Promise<number> {
  if (flags.tried && flags.want) throw new UsageError('give --tried or --want, not both');
  const query = new URLSearchParams();
  if (flags.tried) query.set('filter', 'tried');
  if (flags.want) query.set('filter', 'want');
  let sort: PlacesSort = 'best';
  if (flags.sort !== undefined) {
    const parsed = PlacesSortSchema.safeParse(flags.sort.trim().toLowerCase());
    if (!parsed.success) throw new UsageError(`unknown --sort "${clip(flags.sort, 20)}" (${PlacesSortSchema.options.join(', ')})`);
    sort = parsed.data;
    query.set('sort', sort);
  }
  const tags = (flags.tag ?? []).map((t) => t.trim()).filter((t) => t !== '');
  if (tags.some((t) => t.includes(','))) throw new UsageError('a --tag has no comma; give --tag again for each');
  if (tags.length) query.set('tags', tags.join(','));
  const area = flags.area?.trim();
  if (area) query.set('area', area);
  const q = flags.q?.trim();
  if (q) query.set('q', q);
  const qs = query.toString();
  const r = await callDaemon<PlacesResponse>(ctx.ctl, 'GET', `${ROUTES.placesList.path}${qs ? `?${qs}` : ''}`);
  if (flags.json) {
    ctx.io.out(`${JSON.stringify(r, null, 2)}\n`);
    return EXIT.ok;
  }
  const narrowed = tags.length > 0 || area || q || flags.tried || flags.want;
  if (r.places.length === 0) {
    ctx.io.out(narrowed ? 'No café matches.\n' : 'No cafés yet. Add them on the phone (Cafés).\n');
    return EXIT.ok;
  }
  const currency = await lifeCurrency(ctx);
  ctx.io.out(`${r.places.length === 1 ? '1 café' : `${r.places.length.toLocaleString('en')} cafés`}, ${SORT_WORDS[sort]}\n`);
  for (const p of r.places) ctx.io.out(`${placeLine(p, currency)}\n`);
  return EXIT.ok;
}

async function show(ctx: CliContext, flags: Flags, id: string | undefined): Promise<number> {
  if (id === undefined || id.trim() === '') throw new UsageError('show needs a café id (jantar place list prints them)');
  const r = await callDaemon<PlaceDetail>(ctx.ctl, 'GET', buildPath(ROUTES.placeGet, { id: id.trim() }));
  if (flags.json) {
    ctx.io.out(`${JSON.stringify(r, null, 2)}\n`);
    return EXIT.ok;
  }
  ctx.io.out(placeDetail(r, await lifeCurrency(ctx)));
  return EXIT.ok;
}

export default defineCommand(
  {
    name: 'place',
    summary: 'List your cafés and show one, with its ratings, dishes and visits. Read only: cafés are added and changed on the phone.',
    usage: 'jantar place <list [options]|show <id>> [--json]',
    owner: 'WP-FF',
    help:
      `  place list [--tried|--want] [--sort ${PlacesSortSchema.options.join('|')}] [--tag <t>]... [--area <a>] [--q <text>] [--json]\n` +
      '                                 one line a café: name, stars, price, area, last visit, tags and its id\n' +
      '  place show <id> [--json]       one café: sub-ratings, tags, dishes, the newest 10 visits and notes\n' +
      'Adding, rating, logging a visit and deleting are on the phone. Turn Cafés on: jantar life on places',
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(argv, FLAGS, { min: 1, max: 2 });
    const [action, word] = positionals;
    switch (action) {
      case 'list':
        if (word !== undefined) throw new UsageError('"place list" takes no other word');
        only(flags, 'list', ['tried', 'want', 'sort', 'tag', 'area', 'q', 'json']);
        return list(ctx, flags);
      case 'show':
        only(flags, 'show', ['json']);
        return show(ctx, flags, word);
      default:
        throw new UsageError(`unknown action "${clip(action ?? '', 20)}" (list or show)`);
    }
  },
);
