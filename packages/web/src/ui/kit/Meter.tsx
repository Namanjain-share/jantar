/**
 * The 5-hour (or 7-day) usage bar: a 6 px track in --line, fill in --ink-2,
 * a 1x10 px --ink tick at the autoswitch ceiling, and the part past the
 * ceiling in --signal. Square ends, pixel-snapped. `value: null` (no
 * reading) draws a dashed empty track. `stale` (a usageStatus that is not
 * ok, such as an expired token) draws the last value in --ink-3 over that
 * dashed track: the number beside it is the same old reading, not a live one.
 *
 * It is a real role="meter" with an accessible name such as
 * "03 5-hour usage", which the screen tests look up.
 */
import clsx from 'clsx';
import { meterGeometry } from './meterMath.js';

export interface MeterProps {
  value: number | null;
  /** Accessible name, e.g. "03 work 5-hour usage". */
  label: string;
  /** Width in px: 96 in the Accounts matrix, 64 for 7D, 200 on phone rows. */
  width?: number;
  /** Autoswitch ceiling in %; omit for no tick (7-day bars). */
  ceiling?: number | null;
  /** The value is the last reading, not a live one (token expired, usage error). */
  stale?: boolean;
  className?: string;
}

export function Meter({ value, label, width = 96, ceiling, stale = false, className }: MeterProps) {
  const unknown = value === null || !Number.isFinite(value);
  const g = meterGeometry(unknown ? 0 : value, width, ceiling);
  const now = unknown ? undefined : Math.round(Math.max(0, Math.min(100, value)));
  const dashes: number[] = [];
  if (unknown || stale) for (let x = Math.ceil(g.fill / 4) * 4; x < g.width; x += 4) dashes.push(x);
  const text = now === undefined ? 'no reading' : stale ? `${now}%, last reading` : `${now}%`;
  return (
    <svg
      className={clsx('glyph block flex-none', className)}
      width={g.width}
      height={10}
      viewBox={`0 0 ${g.width} 10`}
      shapeRendering="crispEdges"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={now}
      aria-valuetext={text}
      focusable="false"
    >
      {unknown || stale ? (
        <>
          {!unknown && g.fill > 0 ? <rect className="fill-ink-3" x="0" y="2" width={g.fill} height="6" /> : null}
          {dashes.map((x) => (
            <g key={x}>
              <rect className="fill-ink-4" x={x} y="2" width="2" height="1" />
              <rect className="fill-ink-4" x={x} y="7" width="2" height="1" />
            </g>
          ))}
        </>
      ) : (
        <>
          <rect className="fill-line" x="0" y="2" width={g.width} height="6" />
          {g.base > 0 ? <rect className="fill-ink-2" x="0" y="2" width={g.base} height="6" /> : null}
          {g.overW > 0 ? <rect className="fill-signal" x={g.overX} y="2" width={g.overW} height="6" /> : null}
        </>
      )}
      {g.tick !== null ? <rect className="fill-ink" x={g.tick} y="0" width="1" height="10" /> : null}
    </svg>
  );
}
