/**
 * Life (v0.4): projects and todos, medicines, food and weight, cafés and
 * finance, in one daemon part with one database (life.db) and one scheduler.
 *
 * `createLifeService` is the Factories['life'] entry wired in daemon.ts.
 * This file and db.ts are the wiring and the database; service.ts
 * (`buildLifeService`) and the files beside it are the shell; each module has
 * its own folder and its `build<Module>Module`.
 */
import type { Factories, LifeModuleBuilders } from '../contracts.js';
import { buildFinanceModule } from './finance/module.js';
import { buildFoodModule } from './food/module.js';
import { buildMedicinesModule } from './medicines/module.js';
import { buildPlacesModule } from './places/module.js';
import { buildLifeService } from './service.js';
import { buildTodosModule } from './todos/module.js';

export { LIFE_BROKEN_REASON, LIFE_MIGRATIONS, LIFE_SCHEMA_VERSION, openLifeDb, type LifeOpenResult } from './db.js';

export const LIFE_MODULE_BUILDERS: LifeModuleBuilders = {
  todos: buildTodosModule,
  medicines: buildMedicinesModule,
  food: buildFoodModule,
  places: buildPlacesModule,
  finance: buildFinanceModule,
};

export const createLifeService: Factories['life'] = (ctx, deps) => buildLifeService(ctx, deps, LIFE_MODULE_BUILDERS);
