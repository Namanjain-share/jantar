/**
 * Log a comment (v0.9 spec 4.2): a comment the user already made, saved as
 * posted now with its link, so Today and the week count it and Done lists
 * it with Open.
 *
 *   Log a comment
 *   Paste the link to your comment. On Reddit: Share, then Copy link.
 *   Link to your comment  [https://…]
 *                         Reddit · r/exampletools     read from the link as it is typed
 *   Where                 [r/exampletools]            filled from the link until edited
 *   What you wrote        [ optional ]
 *   [ Log comment ]  Cancel
 *
 * The platform and where come from the link alone (postPlaceOf): Jantar
 * never fetches, opens or checks it. A retry of the same body keeps its
 * Idempotency-Key, so a double tap logs once; a failure (the same link
 * twice included) keeps the sheet open with Not saved.
 */
import { useId, useState, type FormEvent } from 'react';
import { POST_LINK_MAX, POST_TEXT_MAX, POST_WHERE_MAX, PostBodySchema, PostWhereSchema, postPlaceOf, type PostBody } from '@jantar/protocol';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Sheet } from '../../../kit/Sheet.js';
import { Spinner } from '../../../kit/Spinner.js';
import { NotSaved } from '../shared/states.js';
import { Field, INPUT, OfflineLine, SheetActions, TEXTAREA, useOffline, useWrite } from '../today/parts.js';
import { postLabel } from './model.js';

const ONE_LINE = 'Use one line, with no special characters.';
const HTTPS = 'Use a link that starts with https://';

export interface LogCommentSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A fresh number per opening (the form starts over). */
  sheetKey: number;
  /** Saved: its id and label ("Reddit · r/exampletools"), for the Undo bar. */
  onLogged: (id: string, label: string) => void;
}

export function LogCommentSheet({ open, onOpenChange, sheetKey, onLogged }: LogCommentSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Log a comment">
      <LogForm
        key={sheetKey}
        onDone={() => onOpenChange(false)}
        onLogged={(id, label) => {
          onOpenChange(false);
          onLogged(id, label);
        }}
      />
    </Sheet>
  );
}

function LogForm({ onDone, onLogged }: { onDone: () => void; onLogged: (id: string, label: string) => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const id = useId();
  const [link, setLink] = useState('');
  const [typed, setTyped] = useState('');
  const [touched, setTouched] = useState(false);
  const [text, setText] = useState('');

  const place = link.trim() ? postPlaceOf(link) : null;
  // Filled from the link until the user types in it; then it is theirs.
  const where = touched ? typed : (place?.where ?? '');
  const badWhere = where.trim() !== '' && !PostWhereSchema.safeParse(where).success;
  const at = where.trim() ? { where: where.trim() } : {};
  // "Reddit · r/exampletools", "Reddit · Comment", "Comment · example.com": the preview and the Undo bar.
  const label = place ? postLabel({ platform: place.platform, kind: 'comment', ...at }) : '';
  const body: PostBody | null = place ? { platform: place.platform, kind: 'comment', status: 'posted', postedUrl: link.trim(), ...at, ...(text.trim() ? { text } : {}) } : null;
  const ok = body !== null && PostBodySchema.safeParse(body).success;
  const busy = w.busy || offline;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!body || !ok || busy) return;
    const r = await w.run(JSON.stringify(body), (key) => api.postCreate(body, key));
    if (r.ok) onLogged(r.value.id, label);
  };

  return (
    <form onSubmit={(e) => void save(e)} aria-label="Log a comment">
      <p className="type-small text-ink-2">Paste the link to your comment. On Reddit: Share, then Copy link.</p>
      <Field label="Link to your comment" htmlFor={`${id}-link`}>
        <input
          id={`${id}-link`}
          className={INPUT}
          type="url"
          inputMode="url"
          autoFocus
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          placeholder="https://"
          value={link}
          maxLength={POST_LINK_MAX}
          aria-invalid={link.trim() !== '' && !place}
          aria-describedby={`${id}-place`}
          onChange={(e) => setLink(e.target.value)}
        />
      </Field>
      <p id={`${id}-place`} aria-live="polite" className={place ? 'type-mono text-ink-2' : 'type-small text-ink-2'}>
        {link.trim() === '' ? null : place ? label : HTTPS}
      </p>
      <Field label="Where" htmlFor={`${id}-where`}>
        <input
          id={`${id}-where`}
          className={INPUT}
          value={where}
          maxLength={POST_WHERE_MAX}
          autoComplete="off"
          autoCapitalize="off"
          placeholder="r/sub or @account"
          aria-invalid={badWhere}
          onChange={(e) => {
            setTouched(true);
            setTyped(e.target.value);
          }}
        />
      </Field>
      {badWhere ? <p className="type-small text-ink-2">{ONE_LINE}</p> : null}
      <Field label="What you wrote" htmlFor={`${id}-text`}>
        <textarea id={`${id}-text`} className={TEXTAREA} value={text} maxLength={POST_TEXT_MAX} rows={4} placeholder="Optional" onChange={(e) => setText(e.target.value)} />
      </Field>
      {w.error ? <NotSaved error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || busy}>
          {w.busy ? <Spinner label="Saving" /> : null}
          Log comment
        </Button>
        <Button variant="text" size="lg" onClick={onDone}>
          Cancel
        </Button>
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
