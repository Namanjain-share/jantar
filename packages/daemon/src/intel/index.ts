/**
 * The Intel shelf (v0.4): a read-only shelf over JSONL files plus captures.
 *
 * `createIntelService` is the Factories['intel'] entry wired in daemon.ts.
 * WP0 owns this file; WP-IN owns the rest of intel/ (service.ts must export
 * `buildIntelService`).
 */
import type { Factories } from '../contracts.js';
import { buildIntelService } from './service.js';

export const createIntelService: Factories['intel'] = (ctx, deps) => buildIntelService(ctx, deps);
