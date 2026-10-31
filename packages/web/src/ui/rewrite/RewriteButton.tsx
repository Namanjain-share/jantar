/**
 * The composer's Rewrite button (v0.3, decisions U5 and U6). It sits next to
 * Send and is enabled when the box has text: a headless Claude run on the
 * Mac turns what the user typed or dictated (with the iPhone keyboard's own
 * dictation) into a prompt, the sheet shows "You said" and the editable
 * prompt, and Send goes through `sends.post(text, { rewriteJobId })`. Never
 * sends on its own.
 *
 * The composer mounts it only while Rewrite is switched on
 * (features.rewrite). An outline button with a word, not an icon, so it can
 * never be mistaken for Send; the same height as Send (44 phone, 40 desk).
 * Tapping it again with the same draft brings back the review it holds.
 */
import clsx from 'clsx';
import { BUTTON_BASE, BUTTON_VARIANT } from '../kit/Button.js';
import type { Sends } from '../screens/session/sends.js';
import { RewriteSheet } from './RewriteSheet.js';
import { useRewrite } from './useRewrite.js';

export interface RewriteButtonProps {
  sid: string;
  folder: string;
  /** The composer's draft and sends: read `sends.draft`, send with `sends.post`. */
  sends: Sends;
  phone: boolean;
  offline: boolean;
}

export function RewriteButton({ sid, folder, sends, phone, offline }: RewriteButtonProps) {
  const rw = useRewrite({ sid, sends });
  const input = sends.draft.trim();
  return (
    <>
      <button
        type="button"
        aria-label="Rewrite as a prompt"
        aria-haspopup="dialog"
        disabled={!input || offline}
        onClick={() => rw.openFor(input)}
        className={clsx(BUTTON_BASE, BUTTON_VARIANT.outline, 'flex-none px-12 text-small', phone ? 'h-44' : 'h-40')}
      >
        Rewrite
      </button>
      <RewriteSheet rw={rw} folder={folder} phone={phone} offline={offline} />
    </>
  );
}
