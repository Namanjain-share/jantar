/**
 * The full-screen viewer (v0.5 spec 5.4): a full-height sheet on --bg, the
 * image at full width in a scroll container (the browser's own pinch zoom),
 * its time in mono, and Close. No previous or next and no save button: a
 * long press saves on the phone. It shows the bytes the transcript already
 * has, or asks for them once; its own object URL is revoked when it closes.
 */
import { Dialog } from '@base-ui/react/dialog';
import { useState } from 'react';
import type { MeetingShot } from '@jantar/protocol';
import { Button } from '../../kit/Button.js';
import { Spinner } from '../../kit/Spinner.js';
import { useObjectUrl } from '../files/blob.js';
import { hhmm } from './model.js';
import { shotErrorText, useShotBlob } from './ShotImage.js';

export interface ShotView {
  shot: MeetingShot;
  /** The bytes the transcript loaded, when it has them. */
  blob: Blob | null;
}

function ViewerImage({ meetingId, view }: { meetingId: string; view: ShotView }) {
  const fetched = useShotBlob(meetingId, view.shot.id, view.blob === null);
  const url = useObjectUrl(view.blob ?? fetched.blob);
  const at = hhmm(view.shot.at);
  if (url) return <img src={url} alt={`Screenshot ${at}`} className="block h-auto w-full" />;
  if (fetched.error) {
    return (
      <div role="status" className="px-16 py-16">
        <p className="type-small text-ink-2">{shotErrorText(fetched.error)}</p>
        <Button size="sm" className="mt-12" onClick={fetched.retry}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div className="flex aspect-16/10 w-full items-center justify-center">
      <Spinner label="Loading the screenshot" />
    </div>
  );
}

export function ShotViewer({ meetingId, view, onClose }: { meetingId: string; view: ShotView | null; onClose: () => void }) {
  // The last one stays while the sheet animates away.
  const [last, setLast] = useState<ShotView | null>(view);
  if (view && view !== last) setLast(view);
  const shown = view ?? last;
  return (
    <Dialog.Root open={view !== null} onOpenChange={(o) => (o ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Popup className="fixed inset-0 z-40 flex flex-col bg-bg text-ink outline-none animate-rise">
          {shown ? (
            <>
              <div className="flex min-h-44 flex-none items-center gap-8 border-b border-line px-16 pt-safe">
                <Dialog.Title className="min-w-0 flex-1 truncate type-mono text-ink-3">Screenshot {hhmm(shown.shot.at)}</Dialog.Title>
                <Dialog.Close render={<Button variant="text" className="-mr-8" />}>Close</Dialog.Close>
              </div>
              <div className="min-h-0 flex-1 overflow-auto pb-safe">
                <ViewerImage key={shown.shot.id} meetingId={meetingId} view={shown} />
              </div>
            </>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
