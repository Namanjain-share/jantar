/**
 * Today as a page of cards (0.11, build plan 2.3): from a pane 640 wide
 * Today's sections are cards, dealt into columns (kit/Columns.tsx); below
 * that they are 0.10's list. One card per section that has data
 * (`GET /v1/life/today`, D4): Medicines, Claude, Due, Food, Bills, Posts;
 * and (0.12) Accountability partner, first, while someone shares with him.
 *
 * - A card: a 44 header (the rail label, a status in its colour, and the
 *   module's link at the right), then at most five rows ("2 more" links to
 *   the module); it never scrolls inside itself.
 * - The order and which cards show are this device's (localStorage
 *   `jantar:today-cards`), changed in Edit cards: a 44 handle per card to
 *   drag it (or the arrow keys on the handle), and a switch to show or hide
 *   it.
 * - The Life strip (Todos 6, Medicines 2, Food, Cafés, Finance, Posts) sits
 *   on top: the Mac's rail doesn't list the Life places, so this is the way
 *   to them. It takes the place of 0.10's LIFE list.
 */
import { CaretRightIcon, DotsSixVerticalIcon, type Icon } from '@phosphor-icons/react';
import { PEOPLE_LABEL } from '@jantar/protocol/people-core';
import clsx from 'clsx';
import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { readLocal, writeLocal } from '../../../../lib/storage.js';
import { Button } from '../../../kit/Button.js';
import { RailLabel } from '../../../kit/RailLabel.js';
import { Switch } from '../../devices/parts.js';
import { Link } from '../../../shell/Link.js';

export type CardId = 'people' | 'meds' | 'claude' | 'due' | 'food' | 'bills' | 'posts';

/**
 * The cards, in the default order (open question 6, without the cards Today's call has no data for). 0.12:
 * Accountability partner (v0.11 People) is first, as its rows are on top of the phone's Today; it shows
 * only while someone shares with him, and Edit cards lists it only while People is on.
 */
export const CARDS: readonly { id: CardId; label: string }[] = [
  { id: 'people', label: PEOPLE_LABEL },
  { id: 'meds', label: 'Medicines' },
  { id: 'claude', label: 'Claude' },
  { id: 'due', label: 'Due' },
  { id: 'food', label: 'Food' },
  { id: 'bills', label: 'Bills' },
  { id: 'posts', label: 'Posts' },
];

const IDS = CARDS.map((c) => c.id);
const isId = (v: unknown): v is CardId => typeof v === 'string' && (IDS as string[]).includes(v);

/** localStorage key (with lib/storage's `jantar:` prefix). */
export const CARDS_KEY = 'today-cards';

/** At most this many rows in a card; the rest are "n more". */
export const CARD_ROWS = 5;

export interface CardPrefs {
  /** Every card, in this device's order. */
  order: CardId[];
  /** The cards switched off. */
  hidden: CardId[];
}

export const DEFAULT_PREFS: CardPrefs = { order: [...IDS], hidden: [] };

/** What is stored, made whole: unknown ids dropped, every card once, a card added in a later version at its default place. */
export function cardPrefs(raw: unknown): CardPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { order?: unknown; hidden?: unknown };
  const stored = Array.isArray(r.order) ? r.order.filter(isId) : [];
  const order = [...new Set(stored)];
  // A card not in the stored order goes right after the card before it in the default order (first, with none).
  IDS.forEach((id, i) => {
    if (!order.includes(id)) order.splice(i === 0 ? 0 : order.indexOf(IDS[i - 1]!) + 1, 0, id);
  });
  const hidden = Array.isArray(r.hidden) ? [...new Set(r.hidden.filter(isId))] : [];
  return { order, hidden };
}

export function readCardPrefs(): CardPrefs {
  return cardPrefs(readLocal<unknown>(CARDS_KEY, null));
}

/** The cards to show, in order: `has` says which have something to show today. */
export function shownCards(prefs: CardPrefs, has: (id: CardId) => boolean): CardId[] {
  return prefs.order.filter((id) => has(id) && !prefs.hidden.includes(id));
}

/** `order` with `id` moved to index `to` (clamped). */
export function moveCard(order: readonly CardId[], id: CardId, to: number): CardId[] {
  const rest = order.filter((x) => x !== id);
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, id);
  return rest;
}

/** `listed` (the cards Edit cards shows, in their new order) back into the whole `order`: the cards not listed keep their places. */
export function withListed(order: readonly CardId[], listed: readonly CardId[]): CardId[] {
  const next = [...listed];
  return order.map((id) => (listed.includes(id) ? next.shift()! : id));
}

/** This device's card order and switches, kept in localStorage. */
export function useCardPrefs() {
  const [prefs, setPrefs] = useState<CardPrefs>(readCardPrefs);
  const update = useCallback((next: CardPrefs) => {
    setPrefs(next);
    writeLocal(CARDS_KEY, next);
  }, []);
  return [prefs, update] as const;
}

const labelOf = (id: CardId) => CARDS.find((c) => c.id === id)?.label ?? id;

export type Tone = 'plain' | 'due' | 'needs';

const TONE: Record<Tone, string> = { plain: 'text-ink-2', due: 'text-jup-text', needs: 'text-signal-text' };

/**
 * A section of Today: 0.10's rail and rows below a pane of 640 (`card`
 * false), or a card. `count` is the rail's number; `status` the card's word
 * in its colour ("2 due", "3 need you"); `open` the module's link.
 */
export function Card({
  id,
  card,
  count,
  status,
  open,
  children,
}: {
  id: CardId;
  card: boolean;
  count?: number | undefined;
  status?: { text: string; tone: Tone } | null | undefined;
  open?: { href: string; label: string; name: string } | undefined;
  children: ReactNode;
}) {
  const label = labelOf(id);
  if (!card)
    return (
      <section aria-label={label}>
        <RailLabel ground="bg" {...(count !== undefined ? { count } : {})}>
          {label}
        </RailLabel>
        {children}
      </section>
    );
  return (
    <section aria-label={label} data-card={id} className="overflow-hidden rounded-dock border border-line bg-raised">
      <header className="flex h-44 items-center gap-8 border-b border-line pl-16 pr-4">
        <h2 className="flex min-w-0 flex-1 items-center gap-8 type-rail text-ink-3">
          <span>{label}</span>
          {count !== undefined ? <span className="text-ink-2">{count}</span> : null}
          {status ? <span className={TONE[status.tone]}>{status.text}</span> : null}
        </h2>
        {open ? (
          <Link
            href={open.href}
            aria-label={open.name}
            className="flex h-32 flex-none items-center gap-4 rounded-btn px-8 type-small text-ink-2 transition-colors duration-120 ease-hover hover:bg-hover hover:text-ink coarse:h-44"
          >
            {open.label}
            <CaretRightIcon size={14} aria-hidden="true" />
          </Link>
        ) : null}
      </header>
      {/* The last row's hairline tucks under the card's border. */}
      <div className="-mb-px">{children}</div>
    </section>
  );
}

/** "2 more" under a card's five rows: the module has them. `inline` sits in a row of its own (Due's add row). */
export function MoreLink({ n, href, what, inline = false }: { n: number; href: string; what: string; inline?: boolean }) {
  if (n <= 0) return null;
  return (
    <Link
      href={href}
      aria-label={`${n} more ${what}`}
      className={clsx(
        'flex h-40 items-center justify-end gap-4 px-16 type-mono text-ink-3 transition-colors duration-120 ease-hover hover:bg-hover coarse:h-44',
        inline ? 'flex-none rounded-btn px-8' : 'border-b border-line',
      )}
    >
      {n} more
      <CaretRightIcon size={12} aria-hidden="true" />
    </Link>
  );
}

export interface StripItem {
  href: string;
  label: string;
  icon: Icon;
  count?: number | undefined;
}

/** The Life places as 44 chips, on top of Today's cards. */
export function LifeStrip({ items }: { items: readonly StripItem[] }) {
  if (!items.length) return null;
  return (
    <nav aria-label="Life" className="px-16 pb-8">
      <ul className="flex flex-wrap gap-8">
        {items.map((m) => (
          <li key={m.href}>
            <Link
              href={m.href}
              className="flex h-40 items-center gap-8 rounded-btn border border-line-strong bg-raised px-12 type-row text-ink transition-colors duration-120 ease-hover hover:bg-hover coarse:h-44"
            >
              <m.icon size={18} aria-hidden="true" className="flex-none text-ink-2" />
              <span>{m.label}</span>
              {m.count ? <span className="type-mono text-ink-3">{m.count}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Edit cards: every card in this device's order, each with a 44 handle
 * (drag it, or press the arrow keys on it) and a switch to show or hide it.
 */
export function EditCards({
  prefs,
  onChange,
  onDone,
  skip = [],
}: {
  prefs: CardPrefs;
  onChange: (p: CardPrefs) => void;
  onDone: () => void;
  /** Cards that can't show on this Mac (Accountability partner while People is off): not listed, and kept where they are. */
  skip?: readonly CardId[];
}) {
  const list = useRef<HTMLOListElement>(null);
  const [dragging, setDragging] = useState<CardId | null>(null);
  const hint = useId();
  // A handle moved by the keys keeps the focus, whichever row React moved to reorder them.
  const refocus = useRef<CardId | null>(null);
  useLayoutEffect(() => {
    const id = refocus.current;
    refocus.current = null;
    if (id) list.current?.querySelector<HTMLButtonElement>(`[data-card="${id}"] button`)?.focus();
  });
  const listed = prefs.order.filter((id) => !skip.includes(id));
  const move = (id: CardId, to: number) => {
    const order = withListed(prefs.order, moveCard(listed, id, to));
    if (order.join() !== prefs.order.join()) onChange({ ...prefs, order });
  };
  const onKey = (e: KeyboardEvent, id: CardId) => {
    const at = listed.indexOf(id);
    if (e.key === 'ArrowUp' && at > 0) move(id, at - 1);
    else if (e.key === 'ArrowDown' && at < listed.length - 1) move(id, at + 1);
    else return;
    refocus.current = id;
    e.preventDefault();
  };
  const onDown = (e: PointerEvent<HTMLButtonElement>, id: CardId) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(id);
  };
  const onMove = (e: PointerEvent<HTMLButtonElement>, id: CardId) => {
    if (dragging !== id || !list.current) return;
    // Where the pointer is among the other rows: the number of their middles above it.
    const others = [...list.current.children].filter((li) => (li as HTMLElement).dataset.card !== id);
    const to = others.filter((li) => {
      const r = li.getBoundingClientRect();
      return r.top + r.height / 2 < e.clientY;
    }).length;
    move(id, to);
  };
  const onUp = () => setDragging(null);
  const toggle = (id: CardId, on: boolean) => onChange({ ...prefs, hidden: on ? prefs.hidden.filter((x) => x !== id) : [...prefs.hidden, id] });
  return (
    <section aria-label="Edit cards" className="px-16 pt-8">
      <p id={hint} className="pb-8 type-small text-ink-3">
        Drag a card by its handle, or press the arrow keys on it. The order is this device's.
      </p>
      <ol ref={list} className="max-w-540 overflow-hidden rounded-dock border border-line bg-raised">
        {listed.map((id) => {
          const label = labelOf(id);
          return (
            <li key={id} data-card={id} className={clsx('flex min-h-44 items-center gap-8 border-b border-line pr-16 last:border-b-0', dragging === id && 'bg-select')}>
              <button
                type="button"
                aria-label={`Move ${label}`}
                aria-describedby={hint}
                onKeyDown={(e) => onKey(e, id)}
                onPointerDown={(e) => onDown(e, id)}
                onPointerMove={(e) => onMove(e, id)}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                className="flex size-44 flex-none cursor-grab touch-none items-center justify-center text-ink-3 transition-colors duration-120 ease-hover hover:text-ink"
              >
                <DotsSixVerticalIcon size={18} weight="bold" aria-hidden="true" />
              </button>
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-12">
                <span className="min-w-0 flex-1 truncate type-row text-ink">{label}</span>
                <Switch checked={!prefs.hidden.includes(id)} onChange={(on) => toggle(id, on)} />
              </label>
            </li>
          );
        })}
      </ol>
      <div className="max-w-540 pt-12">
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </section>
  );
}
