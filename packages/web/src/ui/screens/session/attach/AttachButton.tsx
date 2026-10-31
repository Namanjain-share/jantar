/**
 * The composer's + (v0.4.2, spec 6.1): a square left of the box, as tall as
 * it. With Files on and the session's folder listed, it opens a sheet with
 * "Photos, camera or files" (one `<input type="file" multiple>` with no
 * `accept`, so iOS offers Photo Library, Take Photo and Choose Files) and
 * "From this session's folder" (FolderPicker: a file's `@<path>` mention goes
 * into the draft; nothing is uploaded). Otherwise it is the file input's label
 * itself. Picked files go to `sends.addFiles`. Disabled offline.
 *
 * Each input is visually hidden but rendered (iOS opens no picker for a
 * `display: none` one) inside its label, so a tap anywhere on the label
 * opens the picker and the input carries the accessible name. Its value is
 * cleared after each pick, so the same file can be picked again. The +'s
 * own input stays mounted (hidden) once the + becomes the sheet's button: a
 * picker opened from it while the roots were still loading still delivers
 * its pick, which an unmounted input would drop.
 */
import { PlusIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useCallback, useState, type ChangeEvent } from 'react';
import { useDeps } from '../../../context.js';
import { Sheet } from '../../../kit/Sheet.js';
import { useFeatures } from '../../../shell/data.js';
import { useLoad } from '../../files/data.js';
import { ATTACH_COPY, type Sends } from '../sends.js';
import { FolderPicker } from './FolderPicker.js';
import { Glyph } from './glyph.js';

export interface AttachButtonProps {
  sid: string;
  sends: Sends;
  phone: boolean;
  offline: boolean;
}

export const ADD_FILES = 'Add files';
export const PICK_FILES = 'Photos, camera or files';
export const FROM_FOLDER = "From this session's folder";

/** The visually hidden input's focus ring, drawn on its label. */
const RING = 'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2';

/** The 48 px rows of the "Add to the prompt" sheet. */
const ROW =
  'flex h-48 w-full cursor-pointer items-center gap-12 rounded-btn px-12 text-left type-row text-ink transition-colors duration-120 ease-hover ' +
  'hover:bg-hover active:bg-hover';

export function AttachButton({ sid, sends, phone, offline }: AttachButtonProps) {
  const { api } = useDeps();
  const features = useFeatures();
  const [open, setOpen] = useState<'menu' | 'folder' | null>(null);
  // The session's folder, listed as a Files root (s.<sid>); the Files tab shares this load.
  const loadRoots = useCallback(() => api.filesRoots(), [api]);
  const roots = useLoad(features.files ? 'roots' : null, loadRoots);
  const folder = features.files && Boolean(roots.data?.roots.some((r) => r.sid === sid));

  const picked = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.currentTarget.files ?? []);
    e.currentTarget.value = '';
    setOpen(null);
    if (files.length) sends.addFiles(files);
  };
  // "Ask about this" text for the file, as the Files tab writes it (files/model.ts, loaded with the Files chunk).
  const mention = (path: string) => {
    setOpen(null);
    void import('../../files/model.js').then((m) => {
      const text = m.mention(path, null);
      sends.setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text));
      requestAnimationFrame(() => sends.area.current?.focus());
    });
  };

  const square = clsx(
    'relative flex flex-none items-center justify-center rounded-btn border transition duration-120 ease-hover',
    'active:not-disabled:scale-97 motion-reduce:active:not-disabled:scale-100',
    phone ? 'size-44' : 'size-40',
    offline ? 'border-line text-ink-3' : 'cursor-pointer border-line-strong text-ink hover:bg-hover',
  );
  const plus = <PlusIcon size={phone ? 20 : 16} weight="bold" aria-hidden="true" />;
  const title = offline ? ATTACH_COPY.offline : undefined;

  return (
    <>
      {/* The + itself, or (once the folder is listed) hidden: the same element either way, so it is never unmounted. */}
      <label className={folder ? 'sr-only' : clsx(square, RING)} title={folder ? undefined : title} aria-hidden={folder ? true : undefined}>
        <input type="file" multiple aria-label={folder ? undefined : ADD_FILES} tabIndex={folder ? -1 : undefined} disabled={offline} className="sr-only" onChange={picked} />
        {folder ? null : plus}
      </label>
      {folder ? (
        <>
          <button type="button" aria-label={ADD_FILES} title={title} disabled={offline} className={square} onClick={() => setOpen('menu')}>
            {plus}
          </button>
          <Sheet
            open={open === 'menu'}
            onOpenChange={(next) => {
              if (!next) setOpen(null);
            }}
            title="Add to the prompt"
          >
            <div className="flex flex-col gap-4 pb-8">
              <label className={clsx(ROW, RING)}>
                <input type="file" multiple aria-label={PICK_FILES} disabled={offline} className="sr-only" onChange={picked} />
                <Glyph name="image" size={20} className="flex-none text-ink-2" />
                <span aria-hidden="true">{PICK_FILES}</span>
              </label>
              <button type="button" className={ROW} onClick={() => setOpen('folder')}>
                <Glyph name="folder" size={20} className="flex-none text-ink-2" />
                <span>{FROM_FOLDER}</span>
              </button>
            </div>
            <p className="pb-16 type-small text-ink-3">Files from the phone are uploaded to the Mac. A file from the folder goes into the prompt by name.</p>
          </Sheet>
          <FolderPicker sid={sid} open={open === 'folder'} phone={phone} onClose={() => setOpen(null)} onPick={mention} />
        </>
      ) : null}
    </>
  );
}
