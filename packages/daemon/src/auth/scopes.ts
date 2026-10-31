import type { Scope } from '@jantar/protocol';

/** Every scope, in chain order: admin ⊃ launch ⊃ control ⊃ read. */
export const ALL_SCOPES: readonly Scope[] = ['read', 'control', 'launch', 'admin'];

/** What a paired phone or browser gets unless the Mac grants more (never `launch`). */
export const DEFAULT_DEVICE_SCOPES: readonly Scope[] = ['read', 'control'];

/**
 * Scopes only the Mac hands out: a pairing code made over TCP (a browser on
 * the Mac, or an admin phone through the tunnel) carries read and control
 * only, and deviceScopes is `localOnly`. Only ctl.sock gives a device
 * launch or admin (`jantar pair --admin`, `jantar devices grant <device> launch`).
 */
export const GRANTED_ON_THE_MAC = ['launch', 'admin'] as const satisfies readonly Scope[];

/**
 * Scopes nest: admin implies launch, launch implies control, control
 * implies read. Stored scopes are always normalized, so checks are plain
 * membership tests.
 */
export function normalizeScopes(scopes: readonly Scope[]): Scope[] {
  const set = new Set<Scope>(scopes);
  if (set.has('admin')) set.add('launch');
  if (set.has('launch')) set.add('control');
  if (set.has('control')) set.add('read');
  return ALL_SCOPES.filter((s) => set.has(s));
}

export function hasScope(scopes: readonly Scope[], needed: Scope): boolean {
  return normalizeScopes(scopes).includes(needed);
}

/**
 * A device's scopes after adding and removing some (POST /v1/devices/:id/scopes).
 * Removing a scope also removes the ones above it (removing control from an
 * admin leaves read), and read always stays.
 */
export function editScopes(current: readonly Scope[], add: readonly Scope[] = [], remove: readonly Scope[] = []): Scope[] {
  const have = new Set<Scope>(normalizeScopes([...current, ...add]));
  for (const r of remove) {
    const at = ALL_SCOPES.indexOf(r);
    for (const s of ALL_SCOPES.slice(Math.max(1, at))) have.delete(s);
  }
  have.add('read');
  return normalizeScopes([...have]);
}
