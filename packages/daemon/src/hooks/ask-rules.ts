/**
 * 0.15 Messages: the "ask" rules for Jantar's WhatsApp tools in a GIVEN
 * Claude settings.json, so Claude Code asks before each one runs, in auto
 * and bypass modes too (the CLI's mcp command: its install turns them on,
 * and `ask on|off` switches them).
 *
 * - Only `permissions.ask` changes, and only by MESSAGES_ASK_RULES: every
 *   other key, rule and order is kept, and no allow rule is ever added. Off
 *   removes exactly ours, and drops `ask` (then `permissions`) only when
 *   that emptied it.
 * - Written the way the hooks are (installer.ts): the plan only reads; the
 *   write follows a symlinked settings.json to the real file, backs it up,
 *   writes atomically and refuses if the file changed since the plan.
 * - A speed bump against a session tricked into reading the chats, not a
 *   wall: a hijacked session could still reach the data by other routes.
 */
import {
  applyPlan,
  loadSettingsFile,
  makePlan,
  withKey,
  withoutKey,
  type EditResult,
  type HooksFailure,
  type HooksPlan,
  type HooksWritten,
  type PlanWriteOptions,
} from './installer.js';
import { isPlainObject } from './keys.js';

/** `mcp__<server>__<tool>` for the five WhatsApp tools of `jantar mcp` (server "jantar"). */
export const MESSAGES_ASK_RULES = [
  'mcp__jantar__messages_chats',
  'mcp__jantar__messages_read',
  'mcp__jantar__messages_search',
  'mcp__jantar__messages_media',
  'mcp__jantar__calls_to_return',
] as const;

const OURS: ReadonlySet<string> = new Set(MESSAGES_ASK_RULES);

/** Settings whose shape leaves no place for the rules; its message ends like the installer's refusals. */
export class AskRulesShapeError extends Error {}

/**
 * `permissions` and its `ask` list as they are, or a refusal for a shape
 * that isn't an object and a list (`where`: " in <file>", for the sentence).
 */
function parts(settings: unknown, where = ''): { root: Record<string, unknown>; permissions: Record<string, unknown>; ask: unknown[] } {
  if (!isPlainObject(settings)) throw new AskRulesShapeError(`the settings${where} are not a JSON object; nothing was changed`);
  const permissions = settings.permissions ?? {};
  if (!isPlainObject(permissions)) throw new AskRulesShapeError(`"permissions"${where} is not an object; nothing was changed`);
  const ask = permissions.ask ?? [];
  if (!Array.isArray(ask)) throw new AskRulesShapeError(`"permissions.ask"${where} is not a list; nothing was changed`);
  return { root: settings, permissions, ask };
}

/**
 * `settings` with MESSAGES_ASK_RULES added to (on: the missing ones, after
 * the others) or removed from (off) `permissions.ask`; the same object when
 * nothing changes. Never changes its input. Throws AskRulesShapeError.
 */
export function askRules(settings: unknown, on: boolean): unknown {
  const { root, permissions, ask } = parts(settings);
  if (on) {
    const missing = MESSAGES_ASK_RULES.filter((r) => !ask.includes(r));
    if (missing.length === 0) return settings;
    return withKey(root, 'permissions', withKey(permissions, 'ask', [...ask, ...missing]));
  }
  const kept = ask.filter((r) => !(typeof r === 'string' && OURS.has(r)));
  if (kept.length === ask.length) return settings;
  if (kept.length > 0) return withKey(root, 'permissions', withKey(permissions, 'ask', kept));
  const rest = withoutKey(permissions, 'ask');
  return Object.keys(rest).length > 0 ? withKey(root, 'permissions', rest) : withoutKey(root, 'permissions');
}

export type AskRulesState = 'on' | 'off' | 'partial';

/** All five rules in `permissions.ask`, none, or some. Throws AskRulesShapeError. */
export function askRulesState(settings: unknown): AskRulesState {
  const { ask } = parts(settings);
  const n = MESSAGES_ASK_RULES.filter((r) => ask.includes(r)).length;
  return n === MESSAGES_ASK_RULES.length ? 'on' : n === 0 ? 'off' : 'partial';
}

export interface AskRulesTarget {
  /** The settings file to edit (e.g. ~/.claude/settings.json). Symlinks are followed. */
  settingsPath: string;
  on: boolean;
}

/** The edit, its diff and the rules it adds or removes. Only reads. */
export async function planAskRules(opts: AskRulesTarget): Promise<HooksPlan | HooksFailure> {
  const loaded = await loadSettingsFile(opts.settingsPath);
  if (!('raw' in loaded)) return loaded;
  let edit: EditResult;
  try {
    const before = parts(loaded.data, ` in ${loaded.realPath}`).ask;
    const next = askRules(loaded.data, opts.on) as Record<string, unknown>;
    const after = parts(next).ask;
    edit = { ok: true, data: next, events: MESSAGES_ASK_RULES.filter((r) => before.includes(r) !== after.includes(r)) };
  } catch (e) {
    if (!(e instanceof AskRulesShapeError)) throw e;
    edit = { ok: false, message: e.message };
  }
  return makePlan(opts.on ? 'ask on' : 'ask off', loaded, edit);
}

/** Turn the rules on or off in the settings file (see the module comment). */
export async function setAskRules(opts: AskRulesTarget & PlanWriteOptions): Promise<HooksWritten | HooksFailure> {
  return applyPlan(await planAskRules(opts), opts);
}

/** The rules' state in a settings file (none there: off), or why it can't be read. Only reads. */
export async function readAskRules(settingsPath: string): Promise<AskRulesState | HooksFailure> {
  const loaded = await loadSettingsFile(settingsPath);
  if (!('raw' in loaded)) return loaded;
  try {
    parts(loaded.data, ` in ${loaded.realPath}`);
    return askRulesState(loaded.data);
  } catch (e) {
    if (!(e instanceof AskRulesShapeError)) throw e;
    return { ok: false, code: 'invalid_shape', message: e.message, settingsPath: loaded.settingsPath };
  }
}
