/**
 * Spinner timing: show only after `delayMs` of waiting (150 ms), and once
 * shown keep it at least `minMs` (300 ms) so it never flickers.
 */
import { useEffect, useRef, useState } from 'react';

export function useDelayedFlag(active: boolean, delayMs = 150, minMs = 300): boolean {
  const [shown, setShown] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    if (active && !shown) {
      t = setTimeout(() => {
        shownAt.current = Date.now();
        setShown(true);
      }, delayMs);
    } else if (!active && shown) {
      const left = Math.max(0, shownAt.current + minMs - Date.now());
      t = setTimeout(() => setShown(false), left);
    }
    return () => {
      if (t) clearTimeout(t);
    };
  }, [active, shown, delayMs, minMs]);
  return shown;
}
