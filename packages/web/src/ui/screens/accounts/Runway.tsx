/**
 * The runway (direction.md 5.3, dir-k.html): one account's 5-hour window on a
 * time axis shared by every row, from now (left edge) to now + 6 h.
 *
 *   mustard 1x12 tick   now (mustard marks time)
 *   2 px --ink line     the time the account can still run
 *   ink triangle        when it reaches the ceiling at this pace
 *   --signal dashes     dead time: from full to the reset
 *   1x8 --ink-2 tick    the reset
 *
 * Faint 1 px hour lines run through every row so the resets line up by eye.
 * Pixel-snapped rects (crispEdges); the words live in the row, so the SVG is
 * aria-hidden.
 */
import { nextHour } from './time.js';
import { SPAN_MIN } from './model.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

const xAt = (ms: number, now: number, k: number) => Math.round(((ms - now) / MIN) * k);

function hourLines(now: number, width: number, k: number): number[] {
  const out: number[] = [];
  for (let t = nextHour(now); t < now + SPAN_MIN * MIN; t += HOUR) {
    const x = xAt(t, now, k);
    if (x > 0 && x < width) out.push(x);
  }
  return out;
}

export function Runway({
  now,
  resetAt,
  fullAt,
  width,
  height,
  empty = 'no window open',
  grid = true,
  resetLabel,
}: {
  now: number;
  resetAt: number | null;
  fullAt: number | null;
  width: number;
  height: number;
  /** Shown when no window is open. */
  empty?: string;
  grid?: boolean;
  /**
   * The reset clock right of the reset tick, where no RESETS column says it.
   * It draws past `width` (the SVG overflows), so leave about 40 px free.
   */
  resetLabel?: string;
}) {
  const k = width / SPAN_MIN;
  const mid = Math.floor(height / 2) - 1;
  const lines = grid ? hourLines(now, width, k) : [];
  const gridRects = (from: number) =>
    lines.filter((x) => x > from).map((x) => <rect key={x} className="fill-line" x={x} y="0" width="1" height={height} />);

  if (resetAt === null) {
    return (
      <svg className="glyph block flex-none overflow-visible" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
        {/* No hour line runs through the words. */}
        <g shapeRendering="crispEdges">{gridRects(empty.length * 7 + 8)}</g>
        <text className="fill-ink-3 font-mono text-rail font-data tabular-nums" x="0" y={mid + 5}>
          {empty}
        </text>
      </svg>
    );
  }

  const xr = Math.max(2, Math.min(width - 1, xAt(resetAt, now, k)));
  const xf = fullAt !== null ? Math.max(2, Math.min(xr - 1, xAt(fullAt, now, k))) : null;
  const dashes: number[] = [];
  if (xf !== null) for (let x = xf + 2; x < xr; x += 5) dashes.push(x);

  return (
    <svg className="glyph block flex-none overflow-visible" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
      <g shapeRendering="crispEdges">
        {gridRects(0)}
        <rect className="fill-jup" x="0" y={mid - 5} width="1" height="12" />
        <rect className="fill-ink" x="1" y={mid} width={Math.max(1, (xf ?? xr) - 1)} height="2" />
        {dashes.map((x) => (
          <rect key={x} className="fill-signal" x={x} y={mid} width={Math.min(3, xr - x)} height="2" />
        ))}
        <rect className="fill-ink-2" x={xr} y={mid - 3} width="1" height="8" />
      </g>
      {xf !== null ? <path className="fill-ink" d={`M${xf + 0.5} ${mid + 3}l3.5 4.5h-7z`} /> : null}
      {resetLabel ? (
        <text className="fill-ink-3 font-mono text-rail font-data tabular-nums" x={xr + 8} y={mid + 5}>
          {resetLabel}
        </text>
      ) : null}
    </svg>
  );
}

/** The axis above the runway column: "now" in mustard, then each whole hour. */
export function RunwayAxis({ now, width, clock }: { now: number; width: number; clock: (ms: number) => string }) {
  const k = width / SPAN_MIN;
  const hours: { x: number; t: number }[] = [];
  for (let t = nextHour(now); t < now + SPAN_MIN * MIN; t += HOUR) {
    const x = xAt(t, now, k);
    if (x > 0 && x < width) hours.push({ x, t });
  }
  return (
    <svg className="block flex-none overflow-visible" width={width} height={20} viewBox={`0 0 ${width} 20`} aria-hidden="true" focusable="false">
      <text className="fill-jup-text font-mono text-rail font-data" x="0" y="12">
        now
      </text>
      <g shapeRendering="crispEdges">
        <rect className="fill-jup" x="0" y="15" width="1" height="5" />
        {hours.map(({ x }) => (
          <rect key={x} className="fill-line" x={x} y="15" width="1" height="5" />
        ))}
      </g>
      {hours
        .filter(({ x }) => x >= 40 && x <= width - 18)
        .map(({ x, t }) => (
          <text key={x} className="fill-ink-3 font-mono text-rail font-data tabular-nums" x={x} y="12" textAnchor="middle">
            {clock(t)}
          </text>
        ))}
    </svg>
  );
}
