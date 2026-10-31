/**
 * One line under Moves (docs/primer.md), from state.primer: who primes free
 * 5-hour windows, and Jantar's last prime.
 *
 *   Jantar   "Jantar primes free 5-hour windows · last 04 at 14:05"
 *            ("· starting 04 now" while it runs, "· 04 failed at 14:05,
 *            again after 14:35" after a failure)
 *   ccw      "ccw primes free 5-hour windows" (its switch.json does not
 *            say "prime": false, so Jantar leaves them to it)
 *   nobody   nothing
 *
 * No button: the switch is the Mac's, like the kept accounts.
 */
import type { PrimerStatus } from '@jantar/protocol';
import { PRODUCT_NAME } from '../../../brand.js';
import { accountId } from '../../../lib/format.js';
import { LEGACY_TOOL } from './model.js';
import { dayClock } from './time.js';

/** After a failed prime that account is left alone this long (daemon primer/rules.ts PRIME_RETRY_MS). */
const RETRY_MS = 30 * 60_000;

export interface PrimerParts {
  /** "Jantar primes free 5-hour windows" */
  who: string;
  /** What follows " · ", around the account in mono: `${before}${account}${after}`; null when nothing does. */
  last: { before: string; account: string; after: string } | null;
}

/** The line's words, or null while nobody primes (or the daemon has not said). */
export function primerParts(p: PrimerStatus | undefined, now: number): PrimerParts | null {
  if (!p || p.by === 'off') return null;
  if (p.by === 'ccw') return { who: `${LEGACY_TOOL} primes free 5-hour windows`, last: null };
  const who = `${PRODUCT_NAME} primes free 5-hour windows`;
  if (p.running !== null) return { who, last: { before: 'starting ', account: accountId(p.running), after: ' now' } };
  if (!p.last) return { who, last: null };
  const at = Date.parse(p.last.at);
  const account = accountId(p.last.account);
  if (p.last.ok) return { who, last: { before: 'last ', account, after: ` at ${dayClock(at, now)}` } };
  return { who, last: { before: '', account, after: ` failed at ${dayClock(at, now)}, again after ${dayClock(at + RETRY_MS, now)}` } };
}

/** The line as plain text (tests, and anyone reading it aloud). */
export function primerText(p: PrimerStatus | undefined, now: number): string | null {
  const parts = primerParts(p, now);
  if (!parts) return null;
  return parts.last ? `${parts.who} · ${parts.last.before}${parts.last.account}${parts.last.after}` : parts.who;
}

export function PrimerLine({ primer, now }: { primer: PrimerStatus | undefined; now: number }) {
  const parts = primerParts(primer, now);
  if (!parts) return null;
  return (
    <p data-primer className="mt-12 type-small text-ink-3">
      {parts.who}
      {parts.last ? (
        <>
          {' · '}
          {parts.last.before}
          <b className="type-mono text-ink-2">{parts.last.account}</b>
          {parts.last.after}
        </>
      ) : null}
    </p>
  );
}
