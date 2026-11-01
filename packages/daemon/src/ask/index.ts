/**
 * Ask (v0.5.3): a chat page on the phone that suggests Life items. Plain
 * words in, one isolated headless Claude run, strict JSON of proposed
 * actions and a short reply; the phone shows a card per action and nothing
 * is added until the user taps Add.
 *
 * `createAskService` is the part daemon.ts wires (Factories['ask'], plus
 * `{ readOnly }`: under --read-only the list says so and nothing runs).
 * service.ts holds the turns (memory only), the queue, the run and the
 * taps; input.ts writes the run's stdin; answer.ts reads Claude's answer
 * and checks every action against a fixed list. There is no history file.
 */
import type { CcwLegacySource, DaemonContext, Factories, LifeService, UsageSource } from '../contracts.js';
import { buildAskService, type AskOptions } from './service.js';

export { ASK_SENTENCES, asksReminder, checkWrite, matchCategory, matchProject, parseAnswer, readAction, replyOf, settleDue, type AskScope, type ParsedAnswer } from './answer.js';
export { ASK_TAGS, askInput, dayWithWeekday, type AskInput } from './input.js';
export {
  ASK_EFFORT,
  ASK_MODULE_OF,
  ASK_MODULE_OFF,
  ASK_PROMPT_ASSET,
  ASK_PROMPT_VERSION,
  ASK_TIMEOUT_MS,
  buildAskService,
  type AskDeps,
  type AskOptions,
} from './service.js';

/** The Ask part (Factories['ask'] plus the daemon's mode). */
export function createAskService(ctx: DaemonContext, deps: { life: LifeService; usage: UsageSource; ccwLegacy: CcwLegacySource }, opts: AskOptions = {}): ReturnType<Factories['ask']> {
  return buildAskService(ctx, deps, opts);
}
