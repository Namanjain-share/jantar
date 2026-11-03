/**
 * "New folder" at the foot of the browser (spec 5.3.2): a row that expands
 * into an inline 16 px field with live validation and Create. The name rule
 * is the daemon's own (FolderNameSchema: no leading dot, no "/", no trailing
 * space or dot); the daemon makes one folder, never a path, and answers 409
 * when it exists. Creating needs the `launch` scope, which a 403 reveals.
 *
 * 0.10.1: the name is trimmed (iOS predictive text adds a trailing space),
 * every try sends an Idempotency-Key (one per name, reused on a retry after
 * a network failure only, so a lost 201 is replayed instead of answering
 * "already exists", while a refusal is asked afresh), and a 409 shows the
 * daemon's sentence, which names what is there in its own case. A 429
 * shows the daemon's sentence too, which says how long to wait, and a
 * missing launch scope keeps Create off while the field is open (another
 * name meets the same 403). Nothing typed or pasted is cut: a name over 60
 * characters shows the hint, which says the limit.
 * Files' New folder (files/NewFolderSheet) is the same route.
 */
import { FolderPlusIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useId, useRef, useState, type FormEvent } from 'react';
import { FOLDER_NAME_HINT, createSig, dropAnsweredKey, folderErrorText, folderNameOk, keepKey } from '../../../lib/folder-name.js';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Spinner } from '../../kit/Spinner.js';
import { FOLDERS_NO_SCOPE, isNoScope } from './scope.js';
import { NoScopeNote, OfflineNote } from './parts.js';

export function NewFolder({ root, parent, offline, phone, onCreated }: { root: string; parent: string; offline: boolean; phone: boolean; onCreated: (path: string) => void }) {
  const { api } = useDeps();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // No launch scope: every name meets the same 403, so Create stays off until the field is opened again.
  const [noScope, setNoScope] = useState(false);
  const kept = useRef<{ sig: string; key: string } | null>(null);
  const trimmed = name.trim();
  const ok = folderNameOk(trimmed);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => input.current?.focus());
        }}
        className={clsx(
          'flex w-full items-center gap-12 border-b border-line px-16 text-left type-row text-ink-2 transition-colors duration-120 ease-hover hover:bg-hover hover:text-ink',
          phone ? 'min-h-52' : 'min-h-40 coarse:min-h-52',
        )}
      >
        <FolderPlusIcon size={16} aria-hidden="true" className="flex-none" />
        New folder
      </button>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || busy || offline || noScope) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.foldersCreate({ root, parent, name: trimmed }, keepKey(kept, createSig(root, parent, trimmed)));
      kept.current = null;
      onCreated(r.path);
    } catch (err) {
      dropAnsweredKey(kept, err);
      if (isNoScope(err)) setNoScope(true);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="border-b border-line px-16 py-12" aria-label="New folder">
      <label htmlFor={id} className="type-small text-ink-3">
        New folder
      </label>
      <div className="mt-8 flex items-center gap-8">
        <input
          ref={input}
          id={id}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={trimmed !== '' && !ok}
          aria-describedby={trimmed !== '' && !ok ? `${id}-hint` : undefined}
          className="h-40 min-w-0 flex-1 rounded-btn border border-line-strong bg-bg px-12 type-input text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink coarse:h-44"
        />
        <Button type="submit" variant="primary" disabled={!ok || busy || offline || noScope}>
          {busy ? <Spinner label="Creating" /> : null}
          Create
        </Button>
        <Button
          variant="text"
          onClick={() => {
            setOpen(false);
            setName('');
            setError(null);
            setNoScope(false);
          }}
        >
          Cancel
        </Button>
      </div>
      {trimmed !== '' && !ok ? (
        <p id={`${id}-hint`} className="mt-6 type-small text-ink-2">
          {FOLDER_NAME_HINT}
        </p>
      ) : null}
      {offline ? <OfflineNote what="make folders" className="mt-8" /> : null}
      {noScope ? (
        <NoScopeNote what={FOLDERS_NO_SCOPE} className="mt-8" />
      ) : error ? (
        <p role="alert" className="mt-8 type-small text-ink-2">
          {folderErrorText(error)}
        </p>
      ) : null}
    </form>
  );
}
