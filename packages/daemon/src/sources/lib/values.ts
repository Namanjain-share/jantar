/**
 * Small, defensive readers for JSON written by other programs (Claude Code,
 * cswap, ccw). Their formats are not ours and may change, so nothing here
 * trusts a field's type.
 */

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** A non-empty string, else undefined. */
export function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

export function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/** Earliest and latest instants we accept from other programs' files (sanity bounds). */
const MIN_MS = Date.UTC(2000, 0, 1);
const MAX_MS = Date.UTC(2200, 0, 1);

/** Epoch milliseconds from epoch ms, epoch seconds or an ISO string; undefined if implausible. */
export function toEpochMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v > 1e11 ? v : v * 1000; // < 1e11 can only be seconds (1e11 ms is 1973)
    return ms >= MIN_MS && ms <= MAX_MS ? ms : undefined;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const ms = Date.parse(v);
    return Number.isFinite(ms) && ms >= MIN_MS && ms <= MAX_MS ? ms : undefined;
  }
  return undefined;
}

/** Normalised ISO-8601 (UTC, milliseconds) or undefined. */
export function toIso(v: unknown): string | undefined {
  const ms = toEpochMs(v);
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** Cut `s` to at most `max` characters, marking the cut. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** First non-empty line, trimmed. */
export function firstLine(s: string | undefined): string {
  if (!s) return '';
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

/** Stable JSON for change detection (sorted keys, no whitespace). */
export function stableJson(v: unknown): string {
  return JSON.stringify(sortDeep(v)) ?? 'null';
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (isObj(v)) {
    const out: Obj = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}
