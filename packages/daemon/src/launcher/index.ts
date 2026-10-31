/**
 * Folders and new sessions (v0.3, decisions U3, U7, U8): the folder browser,
 * the start sheet's preview, and launch jobs that open a new Terminal window.
 *
 * `createLauncher` is the Factories['launcher'] entry wired in daemon.ts.
 * WP0 owns this file; work package L owns `service.ts` (which must export
 * `buildLauncher`) and the rest of launcher/.
 */
import type { Factories } from '../contracts.js';
import { buildLauncher } from './service.js';

export const createLauncher: Factories['launcher'] = (ctx, deps) => buildLauncher(ctx, deps);
