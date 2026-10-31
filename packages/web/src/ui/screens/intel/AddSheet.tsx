/**
 * Add to the shelf (v0.4 spec 5.8): Title, Link, Type, Tags (comma
 * separated) and Note, sent as one capture. A link already on the shelf
 * adds nothing and says so, with the way to open it. A failed save keeps
 * the sheet open with its values; a retry of the same thing sends the same
 * Idempotency-Key, so a reply lost on the way back is never a second item.
 * Closing keeps the values typed but forgets what the last try said.
 */
import clsx from 'clsx';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { IntelCaptureBody } from '@jantar/protocol';
import { newIdempotencyKey } from '../../../lib/ids.js';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { Link } from '../../shell/Link.js';
import { NotSaved, OFFLINE_WRITE } from '../life/shared/states.js';
import { ALREADY_THERE, LINK_HINT, httpHref, shelfPath, tagsFrom } from './model.js';

const INPUT =
  'h-40 w-full min-w-0 rounded-btn border border-line-strong bg-bg px-12 type-input text-ink outline-none ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:text-ink-3 coarse:h-44';
const TEXTAREA =
  'block min-h-88 w-full rounded-btn border border-line-strong bg-bg px-12 py-8 type-input text-ink outline-none ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

const TITLE_MAX = 300;
const TYPE_MAX = 40;
const TAG_MAX = 40;
const TAGS_MAX = 10;
const NOTE_MAX = 2000;

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="py-6">
      <label htmlFor={htmlFor} className="mb-6 block type-small text-ink-3">
        {label}
      </label>
      {children}
      {hint}
    </div>
  );
}

/** What the form would send, or why it cannot yet. */
function bodyOf(v: { title: string; link: string; type: string; tags: string; note: string }): { body: IntelCaptureBody } | { problem: 'title' | 'link' | 'tags' | null } {
  const title = v.title.trim();
  if (!title) return { problem: null };
  const body: IntelCaptureBody = { title };
  const link = v.link.trim();
  if (link) {
    const href = httpHref(link);
    if (!href) return { problem: 'link' };
    body.url = link;
  }
  const type = v.type.trim();
  if (type) body.type = type;
  const tags = tagsFrom(v.tags);
  if (tags.length > TAGS_MAX || tags.some((t) => t.length > TAG_MAX)) return { problem: 'tags' };
  if (tags.length) body.tags = tags;
  const note = v.note.trim();
  if (note) body.note = note;
  return { body };
}

export function AddSheet({
  open,
  onOpenChange,
  offline,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offline: boolean;
  /** A new item went on the shelf (the sheet closes itself). */
  onAdded: (id: string) => void;
}) {
  const { api } = useDeps();
  const id = useId();
  const [v, setV] = useState({ title: '', link: '', type: '', tags: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const kept = useRef<{ sig: string; key: string } | null>(null);
  const parsed = bodyOf(v);
  const ready = 'body' in parsed;

  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => {
    setV((cur) => ({ ...cur, [k]: e.target.value }));
    setDuplicate(null);
    setError(null);
  };

  const change = (next: boolean) => {
    if (!next) {
      setDuplicate(null);
      setError(null);
    }
    onOpenChange(next);
  };
  const close = () => change(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!('body' in parsed) || busy || offline) return;
    const sig = JSON.stringify(parsed.body);
    if (!kept.current || kept.current.sig !== sig) kept.current = { sig, key: newIdempotencyKey() };
    setBusy(true);
    setError(null);
    try {
      const r = await api.intelCapture(parsed.body, kept.current.key);
      kept.current = null;
      if (r.duplicate) {
        setDuplicate(r.id);
      } else {
        setV({ title: '', link: '', type: '', tags: '', note: '' });
        onAdded(r.id);
        close();
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const problem = 'problem' in parsed ? parsed.problem : null;
  return (
    <Sheet open={open} onOpenChange={change} title="Add to the shelf">
      <form onSubmit={(e) => void submit(e)} aria-label="Add to the shelf" className="pb-16">
        <Field label="Title" htmlFor={`${id}-title`}>
          <input id={`${id}-title`} value={v.title} onChange={set('title')} maxLength={TITLE_MAX} required autoComplete="off" className={INPUT} />
        </Field>
        <Field
          label="Link"
          htmlFor={`${id}-link`}
          hint={problem === 'link' ? <p className="mt-6 type-small text-ink-2">{LINK_HINT}</p> : null}
        >
          <input
            id={`${id}-link`}
            value={v.link}
            onChange={set('link')}
            type="url"
            inputMode="url"
            placeholder="https://"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={2000}
            aria-invalid={problem === 'link'}
            className={INPUT}
          />
        </Field>
        <div className="grid grid-cols-2 gap-x-12">
          <Field label="Type" htmlFor={`${id}-type`}>
            <input id={`${id}-type`} value={v.type} onChange={set('type')} maxLength={TYPE_MAX} placeholder="tool" autoCapitalize="off" autoComplete="off" className={INPUT} />
          </Field>
          <Field label="Tags" htmlFor={`${id}-tags`} hint={problem === 'tags' ? <p className="mt-6 type-small text-ink-2">At most 10 tags of up to 40 characters.</p> : null}>
            <input
              id={`${id}-tags`}
              value={v.tags}
              onChange={set('tags')}
              placeholder="comma, separated"
              autoCapitalize="off"
              autoComplete="off"
              aria-invalid={problem === 'tags'}
              className={INPUT}
            />
          </Field>
        </div>
        <Field label="Note" htmlFor={`${id}-note`}>
          <textarea id={`${id}-note`} value={v.note} onChange={set('note')} maxLength={NOTE_MAX} rows={3} className={clsx(TEXTAREA, 'resize-none')} />
        </Field>
        {duplicate ? (
          <p role="status" className="mt-8 type-small text-ink">
            {ALREADY_THERE}{' '}
            <Link href={shelfPath({}, duplicate)} onClick={close} className="text-ink underline underline-offset-2">
              Open it
            </Link>
          </p>
        ) : null}
        {error ? <NotSaved error={error} /> : null}
        <div className="mt-16 flex flex-wrap items-center gap-8">
          <Button type="submit" variant="primary" size="lg" disabled={!ready || busy || offline}>
            {busy ? <Spinner label="Adding" /> : null}
            Add
          </Button>
          <Button variant="text" size="lg" onClick={close}>
            Cancel
          </Button>
          {offline ? <p className="type-mono text-ink-3">{OFFLINE_WRITE}</p> : null}
        </div>
      </form>
    </Sheet>
  );
}
