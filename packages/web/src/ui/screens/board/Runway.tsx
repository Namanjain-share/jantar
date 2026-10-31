/**
 * The Desk's runway: one account's 5-hour window on a time axis from now to
 * now + 6 h, drawn at integer pixels (so it is measured, not scaled).
 *
 *   hour lines      1 px --line, full height
 *   now             1 x 12 px mustard tick at the left edge (Jupiter marks time)
 *   runway          2 px --ink from now to the reset, or to the projected full
 *   dead time       2 px --signal dashes from full to the reset
 *   full marker     a small --ink triangle under the line
 *   reset           1 x 8 px --ink-2 tick
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { RUNWAY_SPAN_MIN, runwaySpan, type ResetModel } from './model.js';

const H = 14;
const MID = Math.floor(H / 2) - 1;

/** The element's content width in px, kept current with ResizeObserver. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW(Math.floor(el.clientWidth));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function Runway({ r, now, label }: { r: ResetModel; now: number; label: string }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const k = W / RUNWAY_SPAN_MIN;
  const xr = Math.min(W - 1, Math.max(2, Math.round(r.inMin * k)));
  const hours: number[] = [];
  if (W > 0) {
    const minuteOfHour = new Date(now).getMinutes() + new Date(now).getSeconds() / 60;
    for (let t = 60 - minuteOfHour; t < RUNWAY_SPAN_MIN; t += 60) hours.push(Math.round(t * k));
  }
  const fullMin = r.fullAt === null ? null : (r.fullAt - now) / 60_000;
  const xf = fullMin === null ? null : Math.min(xr - 1, Math.max(2, Math.round(fullMin * k)));
  const dashes: number[] = [];
  if (xf !== null) for (let x = xf + 2; x < xr; x += 5) dashes.push(x);

  return (
    <div ref={ref} className="h-14 w-full">
      {W > 0 ? (
        <svg
          className="glyph block"
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={label}
          focusable="false"
        >
          <g shapeRendering="crispEdges">
            {hours.map((x) => (
              <rect key={x} className="fill-line" x={x} y="0" width="1" height={H} />
            ))}
            {xf !== null ? (
              <>
                <rect className="fill-ink" x="1" y={MID} width={Math.max(1, xf - 1)} height="2" />
                {dashes.map((x) => (
                  <rect key={x} className="fill-signal" x={x} y={MID} width={Math.min(3, xr - x)} height="2" />
                ))}
              </>
            ) : (
              <rect className="fill-ink" x="1" y={MID} width={Math.max(1, xr - 1)} height="2" />
            )}
            <rect className="fill-ink-2" x={xr} y={MID - 3} width="1" height="8" />
            <rect className="fill-jup" x="0" y={MID - 5} width="1" height="12" />
          </g>
          {xf !== null ? <path className="fill-ink" d={`M${xf + 0.5} ${MID + 3}l3.5 4.5h-7z`} /> : null}
        </svg>
      ) : null}
    </div>
  );
}

/** "03 team resets in 12m at 14:20; lasts to the reset." for the runway's accessible name. */
export function runwayLabel(r: ResetModel, resetClock: string, fullClock: string | null): string {
  const who = r.alias ? `${r.id} ${r.alias}` : r.id;
  const tail = fullClock ? `full about ${fullClock}, ${runwaySpan(r.deadMin)} before the reset` : 'lasts to the reset';
  return `${who} resets in ${runwaySpan(r.inMin)} at ${resetClock}; ${tail}`;
}
