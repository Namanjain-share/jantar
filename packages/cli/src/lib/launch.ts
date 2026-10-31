/**
 * The start sheet's flag picks on the command line (decision U7): four
 * pickers from fixed lists, never free-text claude flags. The daemon turns
 * picks into argv with `launchFlagArgs` and nothing else, so the CLI only
 * ever sends `{ permission, chrome, effort, model }`.
 */
import { realpath } from 'node:fs/promises';
import {
  LaunchEffortSchema,
  LaunchModelSchema,
  LaunchPermissionSchema,
  launchFlagArgs,
  type FileRoot,
  type LaunchFlags,
} from '@jantar/protocol';
import { UsageError } from '../args.js';
import { expandPath } from './roots.js';
import { clip } from './text.js';

/** Flag definitions for parseArgs, shared by `launch defaults` and `new`. */
export const FLAG_PICKS = {
  permission: { type: 'string', help: `${LaunchPermissionSchema.options.join(' | ')}` },
  chrome: { type: 'boolean', help: 'start with --chrome (--no-chrome: without)' },
  effort: { type: 'string', help: `${LaunchEffortSchema.options.join(' | ')}` },
  model: { type: 'string', help: `${LaunchModelSchema.options.join(' | ')}` },
} as const;

export interface PickFlags {
  permission?: string;
  chrome?: boolean;
  effort?: string;
  model?: string;
}

function pick<T extends string>(schema: { safeParse(v: unknown): { success: boolean; data?: T }; options: readonly T[] }, value: string, name: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new UsageError(`--${name} must be one of ${schema.options.join(', ')} (got "${clip(value, 20)}")`);
  return r.data as T;
}

/** The picks given on the command line, checked against the allowlists. */
export function picksFrom(flags: PickFlags): Partial<LaunchFlags> {
  const out: Partial<LaunchFlags> = {};
  if (flags.permission !== undefined) out.permission = pick(LaunchPermissionSchema, flags.permission, 'permission');
  if (flags.chrome !== undefined) out.chrome = flags.chrome;
  if (flags.effort !== undefined) out.effort = pick(LaunchEffortSchema, flags.effort, 'effort');
  if (flags.model !== undefined) out.model = pick(LaunchModelSchema, flags.model, 'model');
  return out;
}

const PERMISSION_WORDS: Readonly<Record<LaunchFlags['permission'], string>> = {
  skip: 'skip all checks',
  auto: 'auto',
  acceptEdits: 'accept edits',
  plan: 'plan',
  manual: 'ask me (manual)',
};

/** "permissions skip all checks · Chrome on · effort ultracode · model default" */
export function flagsText(f: LaunchFlags): string {
  return `permissions ${PERMISSION_WORDS[f.permission]} · Chrome ${f.chrome ? 'on' : 'off'} · effort ${f.effort} · model ${f.model}`;
}

/** The claude flags the picks give, as the start sheet shows them (every permission pick names its mode). */
export function flagArgsText(f: LaunchFlags): string {
  return launchFlagArgs(f).join(' ');
}

/** U7's sentence for skip and auto. */
export const DANGEROUS_SENTENCE = "Claude won't ask before running commands in this session.";

export interface Located {
  root: FileRoot;
  rel: string;
  real: string;
}

/**
 * Which root a folder on this Mac lies under, and its path there: a root
 * configured on the Mac before a live session's folder, then the deepest.
 * `roots` is GET /v1/folders/roots over ctl.sock, which carries absolute paths.
 */
export function locateIn(roots: readonly FileRoot[], real: string): Located | null {
  let best: Located | null = null;
  for (const root of roots) {
    const base = root.path;
    if (!base) continue;
    if (real !== base && !real.startsWith(base.endsWith('/') ? base : `${base}/`)) continue;
    const rel = real === base ? '' : real.slice(base.replace(/\/+$/, '').length + 1);
    const better =
      best === null ||
      (root.kind === 'configured' && best.root.kind !== 'configured') ||
      (root.kind === best.root.kind && base.length > (best.root.path ?? '').length);
    if (better) best = { root, rel, real };
  }
  return best;
}

/** The realpath of a folder as typed (~ and relative paths too), or null when it does not exist. */
export async function realFolder(input: string, userHome: string): Promise<string | null> {
  try {
    return await realpath(expandPath(input, userHome));
  } catch {
    return null;
  }
}
