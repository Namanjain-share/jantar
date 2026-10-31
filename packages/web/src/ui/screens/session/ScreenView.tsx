/**
 * The Screen tab (direction.md 5.2): the last 80 lines of the session's
 * terminal tab on the --term surface (dark in both themes: it is the real
 * thing), with "refreshed 3s ago · Refresh · Show on Mac" under it. It reads
 * again every few seconds while it is in view. No fake caret, no typing.
 *
 * v0.4.2: the session screen hands it its one read (`read`, session/
 * screen.ts), so the tab and the dock show the same screen; `onShown` tells
 * the session screen the text is in view (the read then takes 80 lines).
 * With `keys`, a Keys toggle under it opens the keypad (session/Keypad.tsx)
 * while the screen shows no dialog with buttons.
 */
import clsx from 'clsx';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ScreenResponse } from '@jantar/protocol';
import { errorText, isApiError } from '../../../lib/api.js';
import { agoLong, cleanScreen } from '../../../lib/format.js';
import { useDeps, useNow } from '../../context.js';
import { Spinner } from '../../kit/Spinner.js';
import { UNREADABLE, type SessionScreenRead } from './screen.js';

/** The keypad is its own chunk, shared with the dialog dock (Session.tsx): it loads when Keys first opens. */
const Keypad = lazy(() => import('./Keypad.js').then((m) => ({ default: m.Keypad })));

/**
 * Read the terminal: on mount, every `everyMs` while the page is visible, and on demand.
 * v0.4.2: with `enabled` false it reads nothing and holds no screen (the session screen's
 * one read, session/screen.ts, is off unless something needs it).
 */
export function useScreen(sid: string, lines: number, everyMs: number | null, enabled = true) {
  const { api } = useDeps();
  const [screen, setScreen] = useState<ScreenResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const on = useRef(enabled);
  on.current = enabled;
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const load = useCallback(async () => {
    if (!on.current) return;
    setBusy(true);
    try {
      const res = await api.getScreen(sid, lines);
      if (!alive.current || !on.current || !res) return;
      setScreen(res);
      setError(null);
    } catch (e) {
      if (!alive.current || !on.current) return;
      setError(isApiError(e, 'unavailable') ? UNREADABLE : errorText(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [api, sid, lines]);
  useEffect(() => {
    if (enabled) {
      void load();
      return;
    }
    setScreen(null);
    setError(null);
  }, [load, enabled]);
  useEffect(() => {
    if (!everyMs || !enabled) return;
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void load();
    }, everyMs);
    return () => clearInterval(id);
  }, [everyMs, load, enabled]);
  return { screen, busy, error, load };
}

/**
 * The terminal text as one <pre> (its text is exactly the cleaned screen), newest line at the bottom.
 * `top`: text that reads from its first line (a dialog's plan or diff) starts there instead.
 */
export function TermBox({
  text,
  className,
  label = 'Terminal text',
  fill = false,
  top = false,
}: {
  text: string;
  className?: string;
  label?: string;
  fill?: boolean;
  top?: boolean;
}) {
  const ref = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    if (ref.current && !top) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text, top]);
  return (
    <pre
      ref={ref}
      tabIndex={0}
      aria-label={label}
      className={clsx(
        'no-scrollbar flex flex-col overflow-auto whitespace-pre-wrap rounded-btn bg-term px-16 py-12 font-mono text-code font-data text-term-ink wrap-break-word md:px-20 md:py-16',
        fill && 'min-h-0 flex-1',
        className,
      )}
    >
      <span className={clsx('block', !top && 'mt-auto')}>{text || ' '}</span>
    </pre>
  );
}

const LINK = 'rounded-chip type-small font-medium text-ink-2 transition-colors duration-120 hover:text-ink disabled:text-ink-3 coarse:min-h-44 coarse:px-8';

export function ScreenView({
  sid,
  phone,
  onShowOnMac,
  labelledBy,
  id,
  read,
  onShown,
  keys = false,
  offline = false,
}: {
  sid: string;
  phone: boolean;
  onShowOnMac?: () => void;
  labelledBy?: string;
  id?: string;
  /** v0.4.2: the session screen's one read; without it the tab reads on its own. */
  read?: SessionScreenRead;
  /** v0.4.2: called with true while this text is in view, false when it goes. */
  onShown?: (shown: boolean) => void;
  /** v0.4.2: offer the keypad under the screen (it shows only while no dialog with buttons does). */
  keys?: boolean;
  offline?: boolean;
}) {
  const now = useNow(5_000);
  const own = useScreen(sid, 80, 5_000, read === undefined);
  const { screen, busy, error, load } = read ?? own;
  const [keypad, setKeypad] = useState(false);
  useEffect(() => {
    onShown?.(true);
    return () => onShown?.(false);
  }, [onShown]);
  const text = screen ? cleanScreen(screen.text) : '';
  const canKeys = keys && read !== undefined && screen !== null && !screen.dialog;
  return (
    // The panel itself, unless it sits inside another one (ShotView's Text side, v0.3).
    <div id={id} role={id ? 'tabpanel' : undefined} aria-labelledby={labelledBy} className={clsx('flex min-h-0 flex-1 flex-col', phone ? 'p-16' : 'py-24')}>
      {screen ? <TermBox text={text} fill /> : <div className="min-h-0 flex-1 rounded-btn bg-term" />}
      {error ? (
        <p role="alert" className="mt-8 type-small text-signal-text">
          {error}
        </p>
      ) : null}
      <div className="mt-8 flex h-32 flex-none items-center gap-8 type-mono text-ink-3">
        {screen ? <span>refreshed {agoLong(screen.at, now) || 'just now'}</span> : <Spinner active={busy} label="Reading the screen" />}
        {screen || busy ? <span aria-hidden="true">·</span> : null}
        <button type="button" className={LINK} onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
        {onShowOnMac && !phone ? (
          <>
            <span aria-hidden="true">·</span>
            <button type="button" className={LINK} onClick={onShowOnMac}>
              Show on Mac
            </button>
          </>
        ) : null}
        {canKeys ? (
          <>
            <span aria-hidden="true">·</span>
            <button type="button" className={LINK} aria-expanded={keypad} onClick={() => setKeypad(!keypad)}>
              Keys
            </button>
          </>
        ) : null}
      </div>
      {canKeys && keypad && read ? (
        <div className="flex-none">
          <Suspense fallback={<Spinner label="Loading the keys" />}>
            <Keypad sid={sid} screen={read} phone={phone} offline={offline} onSent={() => void read.load()} />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
