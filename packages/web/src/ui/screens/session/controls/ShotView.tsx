/**
 * The Screen tab's Picture | Text switch (v0.3, the controls addendum; work
 * package C owns this file). The session screen uses it for the Screen tab
 * only while screenshots are switched on (features.screenshots), inside
 * its tab panel.
 *
 * - Picture: the terminal window as an image (useShot.ts), on the --term
 *   surface, with "captured 3s ago · Refresh · Show on Mac" under it. It is
 *   taken when shown and on Refresh, never on a timer.
 * - Text: the existing text peek (ScreenView), passed in as `text`.
 * - The daemon only captures a tab that is showing in its window. Otherwise
 *   (409 tab_not_visible) the text peek takes over with one line saying
 *   why; where the Mac allows it (features.screenshotSelect) and this device
 *   was paired with the control scope, the phone can ask to switch tabs for
 *   a moment and capture anyway. If that fails the text stays, with why.
 * - Every state renders: taking the first picture, the picture, a refusal
 *   (text instead), an error (with Refresh), offline (no new picture).
 * The choice of Picture or Text is this device's, kept in localStorage.
 *
 * v0.5.3: this file and useShot.ts are their own chunk (Session.tsx loads
 * them with import()), so the tab panel is Session.tsx's: it stays while
 * the chunk loads, and this view fills it.
 */
import clsx from 'clsx';
import { useState, type ReactNode } from 'react';
import { errorText, isApiError } from '../../../../lib/api.js';
import { agoLong } from '../../../../lib/format.js';
import { readLocal, writeLocal } from '../../../../lib/storage.js';
import { useApp, useNow } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Spinner } from '../../../kit/Spinner.js';
import { useFeatures } from '../../../shell/data.js';
import { Segmented, type Segment } from '../../accounts/Segmented.js';
import { readLocalDevice } from '../../devices/local.js';
import { useShot } from './useShot.js';

export interface ShotViewProps {
  sid: string;
  phone: boolean;
  onShowOnMac?: () => void;
  /**
   * The text peek (ScreenView). Called with the panel ids it should take
   * (pass both to make it the panel itself, none to nest it in yours).
   */
  text: (panel: { id?: string; labelledBy?: string }) => ReactNode;
}

type Face = 'picture' | 'text';

export const SHOT_FACE_KEY = 'screen-face';

const LINK = 'rounded-chip type-small font-medium text-ink-2 transition-colors duration-120 hover:text-ink disabled:text-ink-3 coarse:min-h-44 coarse:px-8';

/** Why the picture gave way to the text, in one line. */
function fallbackLine(code: string, message: string): string {
  if (code === 'screenshots_off') return message;
  return /minimi[sz]ed|hidden/u.test(message)
    ? 'That window is minimized or hidden on the Mac, showing text instead'
    : 'Another tab is showing in that window, showing text instead';
}

const FACES: Segment<Face>[] = [
  { key: 'picture', label: 'Picture' },
  { key: 'text', label: 'Text' },
];

/** Picture | Text: the app's segmented control, full width on a phone. */
function FaceSwitch({ face, onFace, phone }: { face: Face; onFace: (f: Face) => void; phone: boolean }) {
  return <Segmented label="Show the screen as" segments={FACES} value={face} onChange={onFace} fill={phone} />;
}

export function ShotView({ sid, phone, onShowOnMac, text }: ShotViewProps) {
  const features = useFeatures();
  const offline = useApp((s) => s.conn.status === 'offline');
  const now = useNow(5_000);
  const [face, setFaceState] = useState<Face>(() => (readLocal<Face>(SHOT_FACE_KEY, 'picture') === 'text' ? 'text' : 'picture'));
  const setFace = (f: Face) => {
    setFaceState(f);
    writeLocal(SHOT_FACE_KEY, f);
  };
  const picture = face === 'picture';
  const { shot, busy, error, selectError, load } = useShot(sid, picture && !offline);
  const fallback = error && (error.code === 'tab_not_visible' || error.code === 'screenshots_off') ? error : null;
  // The daemon gives select=1 to the control scope only. A browser with no pairing record (the Mac's own) may have it.
  const [controlScope] = useState(() => readLocalDevice()?.scopes.includes('control') !== false);
  const canSelect = features.screenshotSelect && controlScope && !offline && !isApiError(selectError, 'forbidden');

  const footer = (
    <div className="mt-8 flex min-h-32 flex-none flex-wrap items-center gap-x-8 type-mono text-ink-3">
      {shot?.at ? <span>captured {agoLong(shot.at, now) || 'just now'}</span> : null}
      {shot?.disturbed ? (
        <>
          <span aria-hidden="true">·</span>
          <span>switched tabs on the Mac for a moment</span>
        </>
      ) : null}
      <Spinner active={busy} label="Taking a screenshot" />
      {shot?.at ? <span aria-hidden="true">·</span> : null}
      <button type="button" className={LINK} onClick={() => void load()} disabled={busy || offline}>
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
    </div>
  );

  let body: ReactNode;
  if (!picture) {
    body = text({});
  } else if (fallback) {
    body = (
      <>
        <div className={clsx('flex flex-none flex-wrap items-center gap-x-8 gap-y-4', phone ? 'px-16 pt-12' : 'pt-16')}>
          <p role="status" className="type-small text-ink-2">
            {fallbackLine(fallback.code, fallback.message)}
          </p>
          {fallback.code === 'tab_not_visible' && canSelect ? (
            <Button variant="text" size="sm" className="-ml-8" onClick={() => void load({ select: true })} disabled={busy}>
              Switch tabs for a moment and capture
            </Button>
          ) : null}
          <Button variant="text" size="sm" className="-ml-8" onClick={() => void load()} disabled={busy || offline}>
            Try the picture again
          </Button>
          {selectError ? (
            <p role="alert" className="basis-full type-small text-ink-2">
              Couldn't switch tabs: {errorText(selectError)}
            </p>
          ) : null}
        </div>
        {text({})}
      </>
    );
  } else {
    body = (
      <div className={clsx('flex min-h-0 flex-1 flex-col', phone ? 'p-16' : 'py-24')}>
        {shot ? (
          <div className="no-scrollbar min-h-0 flex-1 overflow-auto rounded-btn bg-term">
            <img
              src={shot.url}
              alt="Screenshot of the session's terminal window"
              className="block h-auto w-full"
              {...(shot.width && shot.height ? { width: shot.width, height: shot.height } : {})}
            />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center rounded-btn bg-term">
            {offline ? <p className="type-small text-term-ink">Offline: can't take a screenshot right now</p> : null}
          </div>
        )}
        {error ? (
          <p role="alert" className="mt-8 type-small text-ink-2">
            The screenshot failed: {errorText(error)}
          </p>
        ) : null}
        {footer}
      </div>
    );
  }

  return (
    <>
      <div className={clsx('flex-none', phone ? 'px-16 pt-16' : 'pt-24')}>
        <FaceSwitch face={face} onFace={setFace} phone={phone} />
      </div>
      {body}
    </>
  );
}
