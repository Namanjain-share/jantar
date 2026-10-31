/**
 * "New folder" at the foot of the browser (spec 5.3.2): a row that expands
 * into an inline 16 px field with live validation and Create. The name rule
 * is the daemon's own (FolderNameSchema: no leading dot, no "/", no trailing
 * space or dot); the daemon makes one folder, never a path, and answers 409
 * when it exists. Creating needs the `launch` scope, which a 403 reveals.
 */
import { FolderPlusIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useId, useRef, useState, type FormEvent } from 'react';
import { FolderNameSchema } from '@jantar/protocol';
import { errorText, isApiError } from '../../../lib/api.js';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Spinner } from '../../kit/Spinner.js';
import { isNoScope } from './data.js';
import { NoScopeNote, OfflineNote } from './parts.js';

export const folderNameOk = (n: string) => FolderNameSchema.safeParse(n).success;

export function NewFolder({ root, parent, offline, phone, onCreated }: { root: string; parent: string; offline: boolean; phone: boolean; onCreated: (path: string) => void }) {
  const { api } = useDeps();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ok = folderNameOk(name);

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
          phone ? 'min-h-52' : 'min-h-40',
        )}
      >
        <FolderPlusIcon size={16} aria-hidden="true" className="flex-none" />
        New folder
      </button>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || busy || offline) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.foldersCreate({ root, parent, name });
      onCreated(r.path);
    } catch (err) {
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
          maxLength={60}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={name !== '' && !ok}
          aria-describedby={name !== '' && !ok ? `${id}-hint` : undefined}
          className="h-40 min-w-0 flex-1 rounded-btn border border-line-strong bg-bg px-12 type-input text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink coarse:h-44"
        />
        <Button type="submit" variant="primary" disabled={!ok || busy || offline}>
          {busy ? <Spinner label="Creating" /> : null}
          Create
        </Button>
        <Button
          variant="text"
          onClick={() => {
            setOpen(false);
            setName('');
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
      {name !== '' && !ok ? (
        <p id={`${id}-hint`} className="mt-6 type-small text-ink-2">
          Start with a letter or digit; letters, digits, spaces, dots, dashes and underscores after that. It can't end in a space or a dot.
        </p>
      ) : null}
      {offline ? <OfflineNote what="make folders" className="mt-8" /> : null}
      {error ? (
        isNoScope(error) ? (
          <NoScopeNote className="mt-8" />
        ) : (
          <p role="alert" className="mt-8 type-small text-ink-2">
            {isApiError(error, 'conflict') ? `There is already a folder called ${name} here.` : errorText(error)}
          </p>
        )
      ) : null}
    </form>
  );
}
