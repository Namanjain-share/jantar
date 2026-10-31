/**
 * A small, strict argument parser for Jantar commands.
 *
 * - `--name value`, `--name=value`, `-n value` for string and number flags.
 * - `--flag`, `--no-flag`, `--flag=true|false` for booleans.
 * - `--` ends option parsing: everything after it is positional.
 * - A lone `-` is a positional (commands use it for "read stdin").
 * - Unknown options, missing values and bad numbers are usage errors, so a
 *   typo never silently changes what a command does.
 */

export type FlagType = 'boolean' | 'string' | 'number';

export interface FlagDef {
  type: FlagType;
  /** One-letter alias, without the dash. */
  short?: string;
  /** String flags only: may be given more than once (value is an array). */
  multiple?: boolean;
  /** One line for the command's usage text. */
  help?: string;
}

export type FlagSpec = Record<string, FlagDef>;

type ValueOf<D extends FlagDef> = D['type'] extends 'boolean'
  ? boolean
  : D['type'] extends 'number'
    ? number
    : D['multiple'] extends true
      ? string[]
      : string;

export type FlagValues<S extends FlagSpec> = { -readonly [K in keyof S]?: ValueOf<S[K]> };

export interface ParsedArgs<S extends FlagSpec> {
  flags: FlagValues<S> & { help?: boolean };
  positionals: string[];
}

export interface ParseOptions {
  /** Fewest positionals accepted (default 0). */
  min?: number;
  /** Most positionals accepted (default unlimited). */
  max?: number;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const HELP: FlagDef = { type: 'boolean', short: 'h', help: 'show this help' };

export function parseArgs<S extends FlagSpec>(
  argv: readonly string[],
  spec: S,
  opts: ParseOptions = {},
): ParsedArgs<S> {
  const all: FlagSpec = { help: HELP, ...spec };
  const byShort = new Map<string, string>();
  for (const [name, def] of Object.entries(all)) {
    if (def.short) {
      if (def.short.length !== 1) throw new Error(`short alias for --${name} must be one letter`);
      byShort.set(def.short, name);
    }
  }
  const flags: Record<string, unknown> = {};
  const positionals: string[] = [];

  const setValue = (name: string, def: FlagDef, raw: string, shown: string) => {
    if (def.type === 'number') {
      const n = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(n)) throw new UsageError(`${shown} needs a number, got "${raw}"`);
      flags[name] = n;
    } else if (def.multiple) {
      flags[name] = [...((flags[name] as string[] | undefined) ?? []), raw];
    } else {
      flags[name] = raw;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-' || !arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }

    let name: string;
    let inline: string | undefined;
    let shown: string;
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      name = eq >= 0 ? body.slice(0, eq) : body;
      inline = eq >= 0 ? body.slice(eq + 1) : undefined;
      shown = `--${name}`;
    } else {
      const letter = arg.slice(1, 2);
      const mapped = byShort.get(letter);
      if (!mapped || arg.length > 2) throw new UsageError(`unknown option ${arg}`);
      name = mapped;
      inline = undefined;
      shown = `-${letter}`;
    }

    const def = all[name];
    if (!def && name.startsWith('no-') && inline === undefined) {
      const base = name.slice(3);
      const baseDef = all[base];
      if (baseDef?.type === 'boolean') {
        flags[base] = false;
        continue;
      }
    }
    if (!def) throw new UsageError(`unknown option ${shown}`);

    if (def.type === 'boolean') {
      if (inline === undefined) flags[name] = true;
      else if (inline === 'true') flags[name] = true;
      else if (inline === 'false') flags[name] = false;
      else throw new UsageError(`${shown} is a switch; use ${shown} or --no-${name}`);
      continue;
    }
    if (inline !== undefined) {
      setValue(name, def, inline, shown);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || (next.startsWith('-') && next !== '-' && next.length > 1)) {
      throw new UsageError(`${shown} needs a value`);
    }
    i += 1;
    setValue(name, def, next, shown);
  }

  if (!flags.help) {
    if (opts.min !== undefined && positionals.length < opts.min) {
      throw new UsageError(opts.min === 1 ? 'missing argument' : `expected at least ${opts.min} arguments`);
    }
    if (opts.max !== undefined && positionals.length > opts.max) {
      throw new UsageError(
        opts.max === 0 ? `unexpected argument "${positionals[0]}"` : `unexpected argument "${positionals[opts.max]}"`,
      );
    }
  }
  return { flags: flags as ParsedArgs<S>['flags'], positionals };
}

/** "  --name VALUE   help" lines for a usage text. */
export function describeFlags(spec: FlagSpec): string {
  const rows = Object.entries(spec).map(([name, def]) => {
    const left = `${def.short ? `-${def.short}, ` : '    '}--${name}${def.type === 'boolean' ? '' : def.type === 'number' ? ' N' : ' VALUE'}`;
    return [left, def.help ?? ''] as const;
  });
  const width = Math.max(0, ...rows.map(([l]) => l.length));
  return rows.map(([l, h]) => `  ${l.padEnd(width)}  ${h}`.trimEnd()).join('\n');
}
