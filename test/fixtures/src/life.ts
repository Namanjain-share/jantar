/**
 * Life fixtures (v0.4): request bodies for every Life write, with names that
 * are obviously made up (Testamol, Placebin, Example Café, Sample Dosa,
 * Example Stream; v0.7: r/exampletools and www.example.com for a post), and a marker to plant in every text field for the
 * privacy sweep (LP1): `projectBody({}, { marked: true })` puts LIFE_MARKER
 * in the name and the notes. MARKER_KG is the marked weight and goal.
 *
 *   await post('/v1/medicines', medBody());                 // Testamol 500 mg at 08:00 and 21:00
 *   await post('/v1/todos', todoBody({}, { timed: { day, time: '11:00' } }));   // a reminder
 *   await post('/v1/posts', postBody({}, { timed: { day, time: '19:30' } }));   // a post that rings
 */
import type {
  BillBody,
  DoseBody,
  FoodBody,
  MedicineBody,
  MoneyBody,
  PlaceBody,
  PostBody,
  ProjectBody,
  TodoBody,
  WeightBody,
} from '@jantar/protocol';

/** Planted in every Life text field by `{ marked: true }`; must never reach an event, audit row, log line or write reply. */
export const LIFE_MARKER = 'LIFE-MARKER-4f1c';
/** A weight (and goal) no real log has: it must never reach an event, audit row or log line. */
export const MARKER_KG = 187.3;
/** The day the bodies default to. */
export const LIFE_DAY = '2026-10-30';

export interface MarkOptions {
  /** Put LIFE_MARKER into every text field. */
  marked?: boolean;
}

const mark = (text: string, opts: MarkOptions): string => (opts.marked ? `${text} ${LIFE_MARKER}` : text);

export function projectBody(over: Partial<ProjectBody> = {}, opts: MarkOptions = {}): ProjectBody {
  return { name: mark('Example project', opts), notes: mark('Synthetic project notes', opts), ...over };
}

/** A todo; `timed` gives it a due day and time, which makes it a reminder. */
export function todoBody(over: Partial<TodoBody> = {}, opts: MarkOptions & { timed?: { day?: string; time: string } } = {}): TodoBody {
  const body: TodoBody = { title: mark('Example todo', opts), notes: mark('Synthetic todo notes', opts) };
  if (opts.timed) body.due = { day: opts.timed.day ?? LIFE_DAY, time: opts.timed.time };
  return { ...body, ...over };
}

/** Testamol 500 mg at 08:00 and 21:00, every day, 10 pills, one a dose. */
export function medBody(over: Partial<MedicineBody> = {}, opts: MarkOptions = {}): MedicineBody {
  return {
    name: mark('Testamol', opts),
    dose: mark('500 mg', opts),
    times: ['08:00', '21:00'],
    schedule: { freq: 'daily' },
    pills: { left: 10, perDose: 1 },
    notes: mark('Synthetic medicine notes', opts),
    ...over,
  };
}

/** The other two made-up medicines, for groups and lists. */
export const PLACEBIN: MedicineBody = { name: 'Placebin', dose: '10 mg', times: ['08:00'], schedule: { freq: 'daily' } };
export const EXAMPLEX: MedicineBody = { name: 'Examplex', dose: '1000 IU', times: ['08:00'], schedule: { freq: 'weekly', byWeekday: [1] } };

export function doseBody(over: Partial<DoseBody> = {}): DoseBody {
  return { day: LIFE_DAY, slot: '08:00', status: 'taken', ...over };
}

export function foodBody(over: Partial<Extract<FoodBody, { name: string }>> = {}, opts: MarkOptions = {}): FoodBody {
  return { day: LIFE_DAY, name: mark('Roti', opts), kcal: 120, ...over };
}

/** What Ask Claude is asked to estimate. */
export function estimateText(opts: MarkOptions = {}): string {
  return mark('2 rotis and dal', opts);
}

export function weightBody(over: Partial<WeightBody> = {}, opts: MarkOptions = {}): WeightBody {
  return { kg: opts.marked ? MARKER_KG : 72.4, ...over };
}

export function placeBody(over: Partial<PlaceBody> = {}, opts: MarkOptions = {}): PlaceBody {
  return {
    name: mark('Example Café', opts),
    area: mark('Example Area', opts),
    link: 'https://maps.example.com/example-cafe',
    notes: mark('Synthetic café notes', opts),
    tried: true,
    dishes: [
      { name: mark('Sample Dosa', opts), rating: 5 },
      { name: mark('Sample Coffee', opts), rating: 3 },
    ],
    ...over,
  };
}

export function moneyBody(over: Partial<MoneyBody> = {}, opts: MarkOptions = {}): MoneyBody {
  return {
    kind: 'expense',
    amount: 124000,
    category: opts.marked ? `C ${LIFE_MARKER}` : 'Groceries',
    note: mark('milk, eggs', opts),
    day: LIFE_DAY,
    ...over,
  };
}

/** Example Stream, ₹649.00 a month, due on the 3rd. */
export function billBody(over: Partial<BillBody> = {}, opts: MarkOptions = {}): BillBody {
  return { name: mark('Example Stream', opts), amount: 64900, category: opts.marked ? `C ${LIFE_MARKER}` : 'Bills', repeat: 'monthly', nextDue: '2026-11-03', ...over };
}

/**
 * v0.7: a Reddit post to make in r/exampletools, an idea; `timed` gives it a
 * day and a time, which makes it ring. Marked: LIFE_MARKER in where, title,
 * text, notes and the link.
 */
export function postBody(over: Partial<PostBody> = {}, opts: MarkOptions & { timed?: { day?: string; time: string } } = {}): PostBody {
  const body: PostBody = {
    platform: 'reddit',
    kind: 'post',
    where: mark('r/exampletools', opts),
    title: mark('Typing into Terminal from a phone', opts),
    text: mark('Synthetic post text.\n\nA second paragraph.', opts),
    notes: mark('Synthetic notes: flair Example, attach one screenshot', opts),
    link: opts.marked ? `https://www.example.com/submit?m=${LIFE_MARKER}` : 'https://www.example.com/submit',
    status: 'idea',
  };
  if (opts.timed) body.due = { day: opts.timed.day ?? LIFE_DAY, time: opts.timed.time };
  return { ...body, ...over };
}
