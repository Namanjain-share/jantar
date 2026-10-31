/**
 * "From this session's folder" (v0.4.2, spec 6.6): a sheet holding the Files
 * browser at the session's own root (`s.<sid>`). A file tap hands its path
 * in the folder to `onPick`, which puts the Files tab's "Ask about this"
 * mention (`@<path> `, files/model.ts `mention`) into the draft. Nothing is
 * uploaded and no chip appears. files/Browse.tsx is its own chunk: the
 * browser (attach/FolderBrowse.tsx) is loaded with `import()` the first time
 * the sheet opens (test/code-split.test.ts keeps it out of the main chunk).
 */
import { lazy, Suspense } from 'react';
import { Sheet } from '../../../kit/Sheet.js';
import { Loading } from '../../files/states.js';

const FolderBrowse = lazy(() => import('./FolderBrowse.js').then((m) => ({ default: m.FolderBrowse })));

export interface FolderPickerProps {
  sid: string;
  open: boolean;
  phone: boolean;
  onClose: () => void;
  /** A file's path in the session's folder (never ending in "/"). */
  onPick: (path: string) => void;
}

export function FolderPicker({ sid, open, phone, onClose, onPick }: FolderPickerProps) {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="From this session's folder"
    >
      {open ? (
        <div className="-mx-16 flex h-440 min-h-0 flex-col pb-8">
          <Suspense fallback={<Loading caption="Opening the folder…" />}>
            <FolderBrowse sid={sid} phone={phone} onPick={onPick} />
          </Suspense>
        </div>
      ) : null}
    </Sheet>
  );
}
