/**
 * The 10 s ask-again for what caption lines change without a tick (v0.5
 * spec 5.0): an open meeting's page and the list while it shows a running
 * meeting. Only while `on`, the page is visible and the Mac can be reached;
 * a hidden page asks nothing, and coming back is useLifeLoad's own reload.
 */
import { useEffect, useRef, useState } from 'react';
import { useOffline } from '../life/today/parts.js';
import { POLL_MS } from './model.js';

const isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export function usePoll(on: boolean, fn: () => void, ms = POLL_MS): void {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  const [visible, setVisible] = useState(isVisible);
  const offline = useOffline();
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const changed = () => setVisible(isVisible());
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => {
    if (!on || !visible || offline) return;
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [on, visible, offline, ms]);
}
