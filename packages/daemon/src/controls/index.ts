/**
 * Controls (v0.3, the controls addendum): control keys, permission-mode
 * switching, slash commands and terminal screenshots.
 *
 * `createControlsService` is the Factories['controls'] entry wired in
 * daemon.ts. WP0 owns this file; work package C owns `service.ts` (which
 * must export `buildControlsService`) and the rest of controls/.
 */
import type { Factories } from '../contracts.js';
import { buildControlsService } from './service.js';

export const createControlsService: Factories['controls'] = (ctx, deps) => buildControlsService(ctx, deps);
