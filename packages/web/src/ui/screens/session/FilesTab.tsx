/**
 * A session's Files tab, ?view=files (v0.3 spec 5.2, U9): the files this
 * session created or changed, newest first, each opening in the read-only
 * viewer at its current content; Browse shows the session's own folder.
 *
 * The component's root is the tab panel. What is inside it
 * (files/SessionFiles.tsx: the lists, the browser and the viewer) is its own
 * chunk, loaded the first time the tab opens, so the session screen does
 * not carry the Files code; while Files is off the panel says so and loads
 * nothing.
 */
import type { Session } from '@jantar/protocol';
import { lazy, Suspense } from 'react';
import type { FilesLocation } from '../../../lib/router.js';
import { useFeatures } from '../../shell/data.js';
import { FilesOff, Loading } from '../files/states.js';

const SessionFiles = lazy(() => import('../files/SessionFiles.js').then((m) => ({ default: m.SessionFiles })));

export interface FilesTabProps {
  sid: string;
  session: Session;
  phone: boolean;
  id: string;
  labelledBy: string;
  /** Where the viewer stands (?root=&path=&tab=), empty for the list. */
  location: FilesLocation;
  /**
   * Move the viewer (pass {} to go back to the list). The screen keeps the
   * place in its own state and replaces the URL, so it survives a reload;
   * the in-app back goes through here too.
   */
  onLocation: (next: FilesLocation) => void;
  /**
   * "Ask about this" (session roots only): puts `text`, e.g.
   * "@src/auth/session.ts:12-20 ", into this session's draft and shows the
   * transcript with the composer focused. Never sends.
   */
  onAsk: (text: string) => void;
}

export function FilesTab({ id, labelledBy, ...props }: FilesTabProps) {
  const features = useFeatures();
  return (
    <div id={id} role="tabpanel" aria-labelledby={labelledBy} className="flex min-h-0 flex-1 flex-col">
      {features.files ? (
        <Suspense fallback={<Loading caption="Opening Files…" />}>
          <SessionFiles {...props} />
        </Suspense>
      ) : (
        <FilesOff className="px-16 py-16" />
      )}
    </div>
  );
}
