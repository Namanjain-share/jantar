/**
 * Today (GET /v1/life/today, spec 4.1): one day across the modules that are
 * on. Each module answers its own part (`LifeModule.today(day)`); no module
 * reads another's tables. A part that throws, or that does not match its
 * schema, is left out and logged by module name only, so one module's bug
 * never blanks the screen.
 */
import { LIFE_MODULES, TodaySchema, type Settings, type Today } from '@jantar/protocol';
import type { LifeModule, LifeModuleName, Logger } from '../contracts.js';

/** The keys of Today each module may fill. */
export const TODAY_PARTS: Readonly<Record<LifeModuleName, readonly Exclude<keyof Today, 'day'>[]>> = {
  todos: ['todos'],
  medicines: ['meds'],
  food: ['food'],
  places: [],
  finance: ['bills'],
};

export function buildToday(day: string, on: Settings['life'], modules: Readonly<Record<LifeModuleName, LifeModule>>, log: Logger): Today {
  const out: Today = { day };
  for (const name of LIFE_MODULES) {
    if (!on[name]) continue;
    let part: Partial<Today>;
    try {
      part = modules[name].today(day);
    } catch (e) {
      log.warn('life today part failed', { module: name, error: e instanceof Error ? e.name : 'unknown' });
      continue;
    }
    for (const key of TODAY_PARTS[name]) {
      const value = part[key];
      if (value === undefined) continue;
      const checked = TodaySchema.shape[key].safeParse(value);
      if (checked.success) Object.assign(out, { [key]: checked.data });
      else log.warn('life today part left out: it does not match its schema', { module: name, part: key });
    }
  }
  return out;
}
