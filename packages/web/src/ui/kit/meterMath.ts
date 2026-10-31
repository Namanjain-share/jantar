/** Pixel geometry for the usage Meter, kept pure so it can be tested. */

export interface MeterGeometry {
  /** Track width in px. */
  width: number;
  /** Filled px for the value (0..width). */
  fill: number;
  /** x of the 1 px ceiling tick, or null when there is no ceiling. */
  tick: number | null;
  /** The --ink-2 part: up to the tick. */
  base: number;
  /** The --signal part past the tick: [overX, overX + overW). */
  overX: number;
  overW: number;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));

export function meterGeometry(value: number, width: number, ceiling?: number | null): MeterGeometry {
  const w = Math.max(1, Math.round(width));
  const fill = Math.round((clamp(value) / 100) * w);
  if (ceiling === null || ceiling === undefined || !Number.isFinite(ceiling)) {
    return { width: w, fill, tick: null, base: fill, overX: fill, overW: 0 };
  }
  const tick = Math.min(w - 1, Math.round((clamp(ceiling) / 100) * w));
  const base = Math.min(fill, tick);
  const overX = tick + 1;
  const overW = Math.max(0, fill - tick - 1);
  return { width: w, fill, tick, base, overX, overW };
}

/** True when a usage value is at or past the autoswitch ceiling (drawn ember). */
export function pastCeiling(value: number | null | undefined, ceiling: number | null | undefined): boolean {
  return value !== null && value !== undefined && ceiling !== null && ceiling !== undefined && value >= ceiling;
}
