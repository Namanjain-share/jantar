/**
 * Rewrite (v0.3, decisions U5 and U6): typed or dictated text turned into a
 * proper prompt by one throwaway headless Claude run, reviewed on the phone,
 * then sent through the writer with `rewriteJobId`.
 *
 * `createRewriteService` is the Factories['rewrite'] entry wired in
 * daemon.ts. WP0 owns this file; work package R owns `service.ts` (which
 * must export `buildRewriteService`) and the rest of rewrite/.
 */
import type { Factories } from '../contracts.js';
import { buildRewriteService } from './service.js';

export const createRewriteService: Factories['rewrite'] = (ctx, deps) => buildRewriteService(ctx, deps);
