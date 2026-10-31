/**
 * Files (v0.3): the one path policy, the read-only file routes' service
 * (work package FP: `service.ts` exports `buildFilesService`) and the index
 * of files sessions created or changed (work package FC: `changes.ts`
 * exports `buildChangesService`). No git and no diffs (decision U9).
 *
 * `createFilesService` and `createChangesService` are the Factories['files']
 * and Factories['changes'] entries wired in daemon.ts. WP0 owns this file.
 */
import type { Factories } from '../contracts.js';
import { buildChangesService } from './changes.js';
import { buildFilesService } from './service.js';

export const createFilesService: Factories['files'] = (ctx, deps) => buildFilesService(ctx, deps);
export const createChangesService: Factories['changes'] = (ctx, deps) => buildChangesService(ctx, deps);
