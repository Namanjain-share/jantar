/**
 * v0.4 primer: when an account's 5-hour window has not started, one tiny
 * headless Claude run on it starts its clock early, so the window resets
 * sooner once the account is really used. Opt-in at the Mac
 * (`settings.accounts.prime`, `jantar accounts prime on`), with cswap's
 * accounts only. The daemon reports who primes in `state.primer` (event
 * `primer.status`); the Accounts screen shows it in one line. No push.
 */
import { z } from 'zod';
import { AccountIdSchema, IsoDateSchema } from './models.js';

export const PrimerStatusSchema = z.object({
  /**
   * Who primes free windows on this Mac:
   * - "jantar": accounts.prime is on and the accounts are cswap's;
   * - "ccw": the legacy ccw tool does (its switch.json does not say
   *   "prime": false, and its autoswitch is on, not a dry run), so Jantar
   *   leaves it to ccw;
   * - "off": nobody (the setting is off, one Claude login, or --read-only).
   */
  by: z.enum(['jantar', 'ccw', 'off']),
  /** The account a prime is running on now. */
  running: AccountIdSchema.nullable(),
  /** Jantar's last prime, kept across restarts: which account, when, and whether it worked. */
  last: z
    .object({
      account: AccountIdSchema,
      at: IsoDateSchema,
      ok: z.boolean(),
    })
    .nullable(),
});
export type PrimerStatus = z.infer<typeof PrimerStatusSchema>;
