/**
 * Work's own settings (W44): data in life.db's `meta`, which the phone may
 * change, unlike the Mac's switches. Each key is JSON checked with zod on
 * every read; one that no longer parses reads as the default (logged by
 * key, never by value).
 *
 * - `work_businesses`: `[{id, name}]`, at most 5 (AMG-style trading names;
 *   none is built in).
 * - `work_prefs`: `{dialCode?, quietDays}`.
 * - `work_imports`: the newest imports (`{batch, at, added, filled}`), for
 *   their Undo.
 * - `work_stages` (P3): the deal stages in order (3 to 12, exactly one Won
 *   and one Lost); the six defaults until he changes them.
 */
import { z } from 'zod';
import { IsoDateSchema } from '@jantar/protocol';
import { stageInvariantError } from '@jantar/life-core';
import { DEFAULT_WORK_STAGES, WORK_LIMITS, WorkBusinessSchema, WorkDialCodeSchema, WorkStageSchema, type WorkBusiness, type WorkStage } from '@jantar/protocol/work';
import type { LifeDb, Logger } from '../../contracts.js';

const PrefsSchema = z.object({ dialCode: WorkDialCodeSchema.optional(), quietDays: z.number().int().min(1).max(90).default(WORK_LIMITS.quietDays) });
export type WorkPrefs = z.infer<typeof PrefsSchema>;
const BusinessesSchema = z.array(WorkBusinessSchema).max(WORK_LIMITS.businesses);
export const ImportEntrySchema = z.object({ batch: z.string(), at: IsoDateSchema, added: z.number().int(), filled: z.number().int() });
export type ImportEntry = z.infer<typeof ImportEntrySchema>;
const ImportsSchema = z.array(ImportEntrySchema).max(WORK_LIMITS.importsKept);
const StagesSchema = z
  .array(WorkStageSchema)
  .min(WORK_LIMITS.stagesMin)
  .max(WORK_LIMITS.stages)
  .refine((list) => stageInvariantError(list) === null, { message: 'one Won and one Lost stage, unique ids' });

function read<T>(db: LifeDb, key: string, schema: z.ZodType<T>, fallback: T, log: Logger): T {
  const raw = db.meta(key);
  if (raw === undefined) return fallback;
  try {
    const p = schema.safeParse(JSON.parse(raw));
    if (p.success) return p.data;
  } catch {
    // falls through
  }
  log.warn('work setting left at its default: it no longer parses', { key });
  return fallback;
}

export function readPrefs(db: LifeDb, log: Logger): WorkPrefs {
  return read(db, 'work_prefs', PrefsSchema, { quietDays: WORK_LIMITS.quietDays }, log);
}

export function writePrefs(db: LifeDb, prefs: WorkPrefs): void {
  db.setMeta('work_prefs', JSON.stringify(PrefsSchema.parse(prefs)));
}

export function readBusinesses(db: LifeDb, log: Logger): WorkBusiness[] {
  return read(db, 'work_businesses', BusinessesSchema, [], log);
}

export function writeBusinesses(db: LifeDb, list: readonly WorkBusiness[]): void {
  if (list.length === 0) db.deleteMeta('work_businesses');
  else db.setMeta('work_businesses', JSON.stringify(BusinessesSchema.parse(list)));
}

export function readImports(db: LifeDb, log: Logger): ImportEntry[] {
  return read(db, 'work_imports', ImportsSchema, [], log);
}

export function writeImports(db: LifeDb, list: readonly ImportEntry[]): void {
  if (list.length === 0) db.deleteMeta('work_imports');
  else db.setMeta('work_imports', JSON.stringify(ImportsSchema.parse(list.slice(0, WORK_LIMITS.importsKept))));
}

/** The deal stages in order (the six defaults until he changes them). */
export function readStages(db: LifeDb, log: Logger): WorkStage[] {
  return read(db, 'work_stages', StagesSchema, DEFAULT_WORK_STAGES.map((st) => ({ ...st })), log);
}

export function writeStages(db: LifeDb, list: readonly WorkStage[]): void {
  db.setMeta('work_stages', JSON.stringify(StagesSchema.parse(list)));
}
