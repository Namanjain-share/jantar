/**
 * cswap's `sequence.json` (the account roster) and its profile directory
 * names. Read-only: cswap is the only writer of its files.
 *
 * Never read here: `configs/*` (full copies of ~/.claude.json with OAuth
 * identity), `credentials/*`, or anything in the Keychain.
 */
import { basename, dirname, resolve } from 'node:path';
import { readJsonFile } from './fsx.js';
import { int, isObj, nonEmpty, str, toEpochMs, type Obj } from './values.js';

export interface SequenceAccount {
  id: number;
  email: string;
  organizationUuid: string;
  alias?: string;
  disabled: boolean;
  /** "api_key" for API-key accounts; undefined = OAuth subscription. */
  kind?: string;
}

export interface SequenceInfo {
  /** cswap's active account: the plain `claude` login on ~/.claude. */
  active: number | null;
  /** Slot order as cswap lists them. */
  order: number[];
  accounts: Map<number, SequenceAccount>;
  lastUpdatedMs?: number;
}

/** Parse sequence.json; null if it isn't the shape cswap writes. */
export function parseSequence(raw: unknown): SequenceInfo | null {
  if (!isObj(raw) || !isObj(raw.accounts)) return null;
  const accounts = new Map<number, SequenceAccount>();
  for (const [key, value] of Object.entries(raw.accounts as Obj)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id < 0 || !isObj(value)) continue;
    const email = str(value.email) ?? '';
    const a: SequenceAccount = {
      id,
      email,
      organizationUuid: str(value.organizationUuid) ?? '',
      disabled: value.disabled === true,
    };
    const alias = nonEmpty(value.alias);
    if (alias) a.alias = alias;
    const kind = nonEmpty(value.kind);
    if (kind) a.kind = kind;
    accounts.set(id, a);
  }
  const order = Array.isArray(raw.sequence)
    ? raw.sequence.filter((n): n is number => Number.isInteger(n) && accounts.has(n as number))
    : [];
  for (const id of [...accounts.keys()].sort((a, b) => a - b)) if (!order.includes(id)) order.push(id);
  const active = int(raw.activeAccountNumber);
  const info: SequenceInfo = { active: active !== undefined && active >= 0 ? active : null, order, accounts };
  const lastUpdatedMs = toEpochMs(raw.lastUpdated);
  if (lastUpdatedMs !== undefined) info.lastUpdatedMs = lastUpdatedMs;
  return info;
}

/** sequence.json cached by file signature; keeps the last good copy across a half-written read. */
export class SequenceReader {
  private cached: { sig: string; info: SequenceInfo } | null = null;

  constructor(private readonly file: string) {}

  /** The last good parse (no I/O). */
  get last(): SequenceInfo | null {
    return this.cached?.info ?? null;
  }

  async read(): Promise<SequenceInfo | null> {
    const r = await readJsonFile(this.file);
    if (!r.ok) {
      if (r.reason === 'missing') this.cached = null;
      return this.cached?.info ?? null;
    }
    if (this.cached && this.cached.sig === r.sig.sig) return this.cached.info;
    const info = parseSequence(r.value);
    if (!info) return this.cached?.info ?? null;
    this.cached = { sig: r.sig.sig, info };
    return info;
  }
}

/** cswap's profile slug: NFC, then every char other than ASCII letters, digits and `._-` becomes `_`. */
export function slugifyEmail(email: string): string {
  return [...email.normalize('NFC')].map((ch) => (/^[A-Za-z0-9._-]$/.test(ch) ? ch : '_')).join('');
}

/**
 * The cswap slot a profile directory belongs to. cswap names profiles
 * `<slot>-<email slug>`; the slot prefix is what makes them unique.
 * - prefix and slug agree with sequence.json: that slot;
 * - the prefix slot now holds another address but exactly one other slot has
 *   this slug: that slot (the roster was renumbered);
 * - otherwise the prefix, if the slot exists (or the roster is unknown).
 */
export function accountForProfileDir(dirName: string, seq: SequenceInfo | null): number | null {
  const m = /^(\d+)-(.*)$/.exec(dirName);
  if (!m) return null;
  const n = Number(m[1]);
  const slug = m[2] ?? '';
  if (!seq || seq.accounts.size === 0) return n;
  const own = seq.accounts.get(n);
  if (own && slugifyEmail(own.email) === slug) return n;
  const bySlug = [...seq.accounts.values()].filter((a) => slugifyEmail(a.email) === slug);
  if (bySlug.length === 1 && bySlug[0]) return bySlug[0].id;
  return own ? n : null;
}

/** Which kind of config dir this is, lexically (no symlinks are resolved). */
export function classifyConfigDir(
  configDir: string,
  paths: { claudeHome: string; cswapProfiles: string },
): { kind: 'default-login' } | { kind: 'profile'; name: string } | { kind: 'other' } {
  const dir = resolve(configDir);
  if (dir === resolve(paths.claudeHome)) return { kind: 'default-login' };
  if (dirname(dir) === resolve(paths.cswapProfiles)) return { kind: 'profile', name: basename(dir) };
  return { kind: 'other' };
}
