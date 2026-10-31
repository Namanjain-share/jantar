/**
 * The primer (v0.4): starts free 5-hour windows early, opt-in at the Mac
 * (docs/primer.md). daemon.ts builds it after usage and ccwLegacy and
 * starts it after them: `createPrimer(ctx, { usage, ccwLegacy }, { readOnly })`.
 */
import type { DaemonContext } from '../contracts.js';
import { PrimerService, type PrimerDeps, type PrimerOptions } from './service.js';

export { PrimerService, type PrimerDeps, type PrimerOptions } from './service.js';
export * from './rules.js';

export function createPrimer(ctx: DaemonContext, deps: PrimerDeps, opts?: PrimerOptions): PrimerService {
  return new PrimerService(ctx, deps, opts);
}
