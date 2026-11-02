/**
 * Add post (v0.8 spec 8), while the Mac reads links: one box for a link or
 * any text (the first http(s) link in it is the item's, the rest its note;
 * no link makes a note), the depth (Standard picked), and Save. The Mac
 * saves it on the shelf at once and reads it in the background
 * (`POST /v1/intel/reads`); the sheet closes and says so. A link already on
 * the shelf saves nothing: "Already saved." with Open and Read again at the
 * depth picked here. A failed save keeps the sheet and its text, and a retry
 * of the same thing sends the same Idempotency-Key, so a reply lost on the
 * way back is never a second item. "Add by hand" is the 0.7 form (title,
 * link, type, tags, note), which saves without reading.
 */
import { useId, useState, type FormEvent } from 'react';
import { INTEL_DEPTH_DEFAULT, INTEL_READ_LIMITS, type IntelDepth, type IntelReadReply } from '@jantar/protocol';
import { useDeps } from '../../context.js';
import { Button, buttonClass } from '../../kit/Button.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { Link } from '../../shell/Link.js';
import { NotSaved, OFFLINE_WRITE } from '../life/shared/states.js';
import { useWrite } from '../life/today/parts.js';
import { DepthPick } from './Depth.js';
import { DEPTH_LABEL, READ_COPY, shelfPath } from './model.js';

const TEXTAREA =
  'block min-h-88 w-full resize-none rounded-btn border border-line-strong bg-bg px-12 py-8 type-input text-ink outline-none ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';
/** A quiet text button (Ask's "What's sent"): 44 px tall under a coarse pointer. */
const LINK = 'rounded-chip type-small font-medium text-ink-2 transition-colors duration-120 ease-hover hover:text-ink coarse:min-h-44 coarse:px-8';
/** Open, after "Already saved.": a text button like Read again beside it (44 px under a coarse pointer), not a 19 px inline link. */
export const OPEN = buttonClass('text', 'sm');

export function AddPostSheet({
  open,
  onOpenChange,
  offline,
  onSaved,
  onByHand,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offline: boolean;
  /** Saved (and queued, unless the Mac says otherwise in `reply.message`), or read again: the sheet closes itself. */
  onSaved: (sentence: string) => void;
  /** "Add by hand": the 0.7 form instead. */
  onByHand: () => void;
}) {
  const { api } = useDeps();
  const id = useId();
  const [text, setText] = useState('');
  const [depth, setDepth] = useState<IntelDepth>(INTEL_DEPTH_DEFAULT);
  const [already, setAlready] = useState<IntelReadReply | null>(null);
  const [whatOpen, setWhatOpen] = useState(false);
  const save = useWrite();
  const again = useWrite();
  const trimmed = text.trim();

  const forget = () => {
    setAlready(null);
    save.clear();
    again.clear();
  };
  const change = (next: boolean) => {
    if (!next) forget();
    onOpenChange(next);
  };
  const close = () => change(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || save.busy || offline) return;
    const body = { text: trimmed, depth };
    const r = await save.run(JSON.stringify(body), (key) => api.intelRead(body, key));
    if (!r.ok) return;
    if (r.value.duplicate) {
      setAlready(r.value);
      return;
    }
    setText('');
    setDepth(INTEL_DEPTH_DEFAULT);
    onSaved(r.value.queued ? READ_COPY.saved : r.value.message);
    close();
  };

  const readAgain = async () => {
    if (!already || again.busy || offline) return;
    const itemId = already.id;
    const r = await again.run(`read:${itemId}:${depth}`, (key) => api.intelReread(itemId, depth, key));
    if (!r.ok) return;
    setText('');
    setDepth(INTEL_DEPTH_DEFAULT);
    onSaved(READ_COPY.again);
    close();
  };

  return (
    <Sheet open={open} onOpenChange={change} title={READ_COPY.sheet}>
      <form onSubmit={(e) => void submit(e)} aria-label={READ_COPY.sheet} className="pb-16">
        <p className="type-small text-ink-2">{READ_COPY.lead}</p>
        <div className="py-6">
          <label htmlFor={`${id}-text`} className="mb-6 mt-6 block type-small text-ink-3">
            {READ_COPY.box}
          </label>
          <textarea
            id={`${id}-text`}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              forget();
            }}
            maxLength={INTEL_READ_LIMITS.textMax}
            rows={3}
            autoFocus
            autoCapitalize="off"
            spellCheck={false}
            placeholder="https://"
            className={TEXTAREA}
          />
        </div>
        <div className="py-6">
          <DepthPick
            value={depth}
            onChange={(d) => {
              setDepth(d);
              again.clear();
            }}
          />
        </div>
        <p className="mt-6 flex flex-wrap items-center gap-x-8 type-small text-ink-3">
          <span>{READ_COPY.sent[depth]}</span>
          <button type="button" className={LINK} aria-expanded={whatOpen} aria-controls={whatOpen ? `${id}-sent` : undefined} onClick={() => setWhatOpen(!whatOpen)}>
            What's sent
          </button>
        </p>
        {whatOpen ? (
          <p id={`${id}-sent`} className="mt-4 type-small text-pretty text-ink-3">
            {READ_COPY.sentAll}
          </p>
        ) : null}
        {already ? (
          <div role="status" className="mt-12 flex flex-wrap items-center gap-x-8 gap-y-4 type-small text-ink">
            <span>{READ_COPY.already}</span>
            <Link href={shelfPath({}, already.id)} onClick={close} className={OPEN}>
              Open
            </Link>
            <Button variant="text" size="sm" disabled={again.busy || offline} onClick={() => void readAgain()}>
              {again.busy ? <Spinner label="Starting" /> : null}
              Read again as {DEPTH_LABEL[depth]}
            </Button>
          </div>
        ) : null}
        {save.error ? <NotSaved error={save.error} /> : null}
        {again.error ? <NotSaved error={again.error} /> : null}
        <div className="mt-16 flex flex-wrap items-center gap-8">
          <Button type="submit" variant="primary" size="lg" disabled={!trimmed || save.busy || offline}>
            {save.busy ? <Spinner label="Saving" /> : null}
            Save
          </Button>
          <Button variant="text" size="lg" onClick={close}>
            Cancel
          </Button>
          <button
            type="button"
            className={`${LINK} ml-auto`}
            onClick={() => {
              forget();
              onByHand();
            }}
          >
            {READ_COPY.byHand}
          </button>
        </div>
        {offline ? <p className="mt-8 type-mono text-ink-3">{OFFLINE_WRITE}</p> : null}
      </form>
    </Sheet>
  );
}
