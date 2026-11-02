/**
 * Files' New folder (0.10.1): a bottom sheet over the folder being browsed,
 * loaded lazily by Browse on its first opening (the session's Files tab and
 * the attach picker share Browse's chunk and never show it).
 *
 *   New folder
 *   in ~/Desktop/work               where it goes
 *   [ new-project            ]      a free name, selected; 16 px (no iOS zoom)
 *   hint / clash / refusal          inline; the sheet stays open
 *                [Cancel] [Create]
 *
 * The checks here only spare a request: the name rule is the daemon's own
 * FolderNameSchema, and a name that folds onto a listed entry's (any letter
 * case) is refused before sending, with "Open it" for a folder. The daemon
 * decides in the end (POST /v1/folders: launch scope, launching on, one
 * mkdir, a 409 naming what is there). Every try sends an Idempotency-Key,
 * one per folder (root, parent, name), kept by the caller across openings,
 * so a retry after a lost 201 is replayed instead of "already exists".
 */
import { useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import type { FileEntry } from '@jantar/protocol';
import { FOLDER_NAME_HINT, clashIn, createSig, folderErrorText, folderNameOk, freeFolderName, keepKey } from '../../../lib/folder-name.js';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Sheet, type SheetProps } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { isNoScope } from '../new/scope.js';
import { NoScopeNote, OfflineNote } from '../new/parts.js';

const INPUT =
  'h-40 w-full min-w-0 rounded-btn border border-line-strong bg-bg px-12 type-input text-ink outline-none ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink read-only:text-ink-3 coarse:h-44';

export interface NewFolderSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A new number at each opening: the form starts afresh (a free name, no old refusal). */
  formKey: number;
  root: string;
  /** The folder it goes in, relative to the root ("" for the root itself). */
  parent: string;
  /** Where that is, in words ("~/Desktop/work/auth"). */
  display: string;
  /** Every loaded page's entries: the suggested name and the clash check. */
  entries: readonly FileEntry[];
  phone: boolean;
  offline: boolean;
  /** The Idempotency-Key per folder, kept by the caller so a reopened sheet retries with it. */
  kept: RefObject<{ sig: string; key: string } | null>;
  /** Made (201), or "Open it" on a folder already there: its path relative to `root`. */
  onArrive: (path: string) => void;
  /** Where focus goes on close. */
  finalFocus: SheetProps['finalFocus'];
}

export function NewFolderSheet({ open, onOpenChange, formKey, finalFocus, ...form }: NewFolderSheetProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="New folder" initialFocus={input} finalFocus={finalFocus}>
      <NameForm key={formKey} {...form} input={input} onCancel={() => onOpenChange(false)} />
    </Sheet>
  );
}

function NameForm({
  root,
  parent,
  display,
  entries,
  phone,
  offline,
  kept,
  onArrive,
  input,
  onCancel,
}: Omit<NewFolderSheetProps, 'open' | 'onOpenChange' | 'formKey' | 'finalFocus'> & { input: RefObject<HTMLInputElement | null>; onCancel: () => void }) {
  const { api } = useDeps();
  const id = useId();
  const [name, setName] = useState(() => freeFolderName(entries.map((e) => e.name)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Select the suggested name once, on the first focus, so typing replaces it.
  const fresh = useRef(true);
  const trimmed = name.trim();
  const ok = folderNameOk(trimmed);
  const clash = ok ? clashIn(entries, trimmed) : null;
  const ready = ok && !clash && !busy && !offline;
  const hintId = `${id}-hint`;
  const noteId = `${id}-note`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.foldersCreate({ root, parent, name: trimmed }, keepKey(kept, createSig(root, parent, trimmed)));
      kept.current = null;
      onArrive(r.path);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const there = clash ? (clash.type === 'dir' ? 'a folder' : clash.type === 'file' ? 'a file' : 'something') : '';
  const describedBy = [!ok && trimmed ? hintId : null, clash || error ? noteId : null].filter(Boolean).join(' ') || undefined;
  return (
    <form onSubmit={(e) => void submit(e)} aria-label="New folder" className="pb-16">
      <p className="truncate type-mono text-ink-3">in {display}</p>
      <input
        ref={input}
        id={id}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onFocus={(e) => {
          if (!fresh.current) return;
          fresh.current = false;
          e.currentTarget.select();
        }}
        aria-label="Folder name"
        readOnly={busy}
        maxLength={60}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="done"
        aria-invalid={trimmed !== '' && !ok}
        aria-describedby={describedBy}
        className={`mt-8 ${INPUT}`}
      />
      {trimmed !== '' && !ok ? (
        <p id={hintId} className="mt-6 type-small text-ink-2">
          {FOLDER_NAME_HINT}
        </p>
      ) : null}
      {clash ? (
        <p id={noteId} role="status" className="mt-8 type-small text-ink">
          There is already {there} called {clash.name} here.
          {clash.type === 'dir' ? (
            <>
              {' '}
              <button
                type="button"
                className="rounded-chip font-medium text-ink underline underline-offset-2 coarse:min-h-44"
                onClick={() => onArrive(parent ? `${parent}/${clash.name}` : clash.name)}
              >
                Open it
              </button>
            </>
          ) : null}
        </p>
      ) : error ? (
        isNoScope(error) ? (
          <NoScopeNote className="mt-8" />
        ) : (
          <p id={noteId} role="alert" className="mt-8 type-small text-ink-2">
            {folderErrorText(error)}
          </p>
        )
      ) : null}
      {offline ? <OfflineNote what="make folders" className="mt-8" /> : null}
      <div className="mt-16 flex items-center justify-end gap-8">
        <Button variant="text" size={phone ? 'xl' : 'md'} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size={phone ? 'xl' : 'md'} disabled={!ready}>
          {busy ? <Spinner label="Creating" /> : null}
          Create
        </Button>
      </div>
    </form>
  );
}
