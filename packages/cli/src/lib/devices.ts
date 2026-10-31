/**
 * Paired devices from the CLI: which device the user means, and how its
 * scopes read. Scopes are a chain (admin ⊃ launch ⊃ control ⊃ read): the
 * daemon's own normalizeScopes says what a stored list implies, so a device
 * paired as admin before v0.3 shows its implied launch too.
 */
import { normalizeScopes } from '@jantar/daemon/auth/scopes';
import { ScopeSchema, type DevicePublic, type Scope } from '@jantar/protocol';
import { UsageError } from '../args.js';
import { clip } from './text.js';

export type DeviceMatch =
  | { ok: true; device: DevicePublic }
  | { ok: false; reason: 'none' | 'ambiguous'; candidates: DevicePublic[] };

/**
 * A device id, a unique id prefix (4+ characters), or a unique name (as
 * written, then ignoring case). A revoked device matches by its full id only.
 */
export function resolveDevice(devices: readonly DevicePublic[], query: string): DeviceMatch {
  const q = query.trim();
  if (!q) return { ok: false, reason: 'none', candidates: [] };
  const exact = devices.find((d) => d.id === q);
  if (exact) return { ok: true, device: exact };
  const live = devices.filter((d) => !d.revokedAt);
  const lower = q.toLowerCase();
  const tests: Array<(d: DevicePublic) => boolean> = [
    (d) => q.length >= 4 && d.id.toLowerCase().startsWith(lower),
    (d) => d.name === q,
    (d) => d.name.toLowerCase() === lower,
  ];
  for (const test of tests) {
    const hits = live.filter(test);
    if (hits.length === 1) return { ok: true, device: hits[0] as DevicePublic };
    if (hits.length > 1) return { ok: false, reason: 'ambiguous', candidates: hits };
  }
  return { ok: false, reason: 'none', candidates: [] };
}

/** Every scope a stored list grants, in chain order: "read + control + launch". */
export function scopesText(scopes: readonly Scope[]): string {
  return normalizeScopes(scopes).join(' + ');
}

export function hasScopeNow(scopes: readonly Scope[], scope: Scope): boolean {
  return normalizeScopes(scopes).includes(scope);
}

/** Scope words from the command line ("launch", "admin"), deduplicated. */
export function parseScopes(words: readonly string[]): Scope[] {
  const out: Scope[] = [];
  for (const w of words) {
    const r = ScopeSchema.safeParse(w);
    if (!r.success) throw new UsageError(`"${clip(w, 20)}" is not a scope (${ScopeSchema.options.join(', ')})`);
    if (!out.includes(r.data)) out.push(r.data);
  }
  return out;
}

/** The device's name as one shell word, for a command to copy ("iPhone", 'Sam'\''s iPhone'). */
export function shellWord(s: string): string {
  return /^[A-Za-z0-9._@%+=:,/-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

/** One line per device for a "which one?" message. */
export function deviceLines(devices: readonly DevicePublic[]): string {
  return devices.map((d) => `  ${d.id}  ${clip(d.name, 40)}  ${scopesText(d.scopes)}`).join('\n');
}
