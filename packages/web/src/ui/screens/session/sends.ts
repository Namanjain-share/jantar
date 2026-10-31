/**
 * Prompts sent from this device (v0.1 SendBox logic, kept). The daemon types
 * the text into the terminal and only reports success once Claude's
 * transcript proves it arrived; every stage comes in as `send.progress`. A
 * network failure can be retried with the SAME idempotency key; a refusal or
 * a failed job puts the text back for editing.
 *
 * The composer owns the draft; the transcript shows each send as a user turn
 * with its receipt (sending…, typed, delivered 14:02). `post` sends any text
 * (v0.3: the Rewrite sheet's prompt, with its `rewriteJobId`) and returns the
 * send's key; `submit` sends the draft. `forget` drops a send this device
 * made from the transcript: the Rewrite sheet's "Send again" replaces a send
 * that never arrived, which would otherwise stay as a second "Not delivered".
 *
 * v0.4.2 (spec 6.1, 6.8): the composer's attachments live here too
 * (`attachments`, one chip per file, added from the + sheet, a paste or a
 * drop). Each file is prepared on the phone (attach/convert.ts, loaded with
 * `import()` the first time a file is attached) and uploaded
 * to the Mac two at a time (UPLOADS_IN_FLIGHT, the daemon's own cap), with
 * progress; photos are prepared one at a time (each decodes to tens of MB).
 * × aborts an upload or deletes the file from the Mac, and a network failure
 * or a 429 can be retried; going offline fails the uploads on their way, with
 * Retry. `post` takes every chip with the text unless `{ attachments: false }`,
 * and only once each one is on the Mac (a send never leaves a chip the user
 * can see behind); with chips the text may be blank. The chips stay,
 * unremovable, until the daemon answers. Accepted (202), or no answer at all
 * (the Mac may have it, so like the words they wait on the receipt's Retry
 * or Edit and resend), they leave the composer; refused, they stay, ready.
 * Put back brings a send's files back (as ready chips: they are still on the
 * Mac). Chips live while the session screen is open: leaving it aborts the
 * uploads in flight and revokes the thumbnails, and what is on the Mac stays
 * until removed or swept.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  SEND_FINAL_STAGES,
  UPLOADS_IN_FLIGHT,
  UPLOADS_PER_PROMPT,
  type AttachmentRef,
  type SendJob,
  type SendStage,
  type UploadInfo,
  type UploadKind,
} from '@jantar/protocol';
import { ApiError, errorText, isApiError, type ApiErrorCode } from '../../../lib/api.js';
import { newIdempotencyKey } from '../../../lib/ids.js';
import { useApp, useDeps } from '../../context.js';
import type { PreparedFile } from './attach/convert.js';
import { isImage, ownName } from './attach/names.js';

export interface LocalSend {
  key: string;
  text: string;
  /** v0.3: the rewrite job the text came from (Rewrite sheet). */
  rewriteJobId?: string;
  /** v0.4.2: the files sent with it (Put back restores them as chips). */
  attachments?: AttachmentRef[];
  /** v0.4.2: what the Mac said of each of them, in the same order (the restored chips' glyphs). */
  uploads?: UploadInfo[];
  jobId?: string;
  /** The job as the POST returned it (events take over from there). */
  initial?: SendJob;
  /** The request itself failed. */
  error?: string;
  /** Why it failed, as the API said (a 404 with a `rewriteJobId` can mean the job expired). */
  errorCode?: ApiErrorCode;
  /** Network failure: may retry with the same key. */
  retryable?: boolean;
  posting: boolean;
  at: number;
}

/** A send as the transcript shows it. */
export interface SendView {
  key: string;
  /** Null for sends from other clients (the text is never stored). */
  text: string | null;
  textLength: number;
  job?: SendJob;
  error?: string;
  errorCode?: ApiErrorCode;
  retryable?: boolean;
  posting: boolean;
  /** Who sent it when it was not this device: "cli", "device:...". */
  actor?: string;
  local?: LocalSend;
}

/**
 * v0.4.2: one file in the composer (a chip), from picking it to its upload
 * on the Mac. Only `ready` ones go with a send.
 */
export interface Attachment {
  /** This chip's own key (not the upload's id). */
  key: string;
  /** What the chip and the prompt call it: the file's name without its folders ("image 1" for a pasted one). */
  name: string;
  state: 'preparing' | 'uploading' | 'ready' | 'failed';
  /** Upload progress, 0 to 1. */
  progress: number;
  /** A `blob:` URL of the prepared image, revoked when the chip goes. */
  thumb?: string;
  /** What it is, once prepared (the chip's glyph). */
  kind?: UploadKind;
  /** The upload on the Mac, once it is there. */
  upload?: UploadInfo;
  /** Why it failed (the daemon's sentence, or the phone's). */
  error?: string;
  /** A network failure or a 429: Retry is offered. */
  retryable?: boolean;
  /** Taken by a send the Mac has not accepted yet: it can't be removed or sent again meanwhile. */
  sending?: boolean;
}

/** The refs of the chips ready to go with a send. */
export function readyRefs(list: readonly Attachment[]): AttachmentRef[] {
  return list.flatMap((a) => (a.state === 'ready' && a.upload && !a.sending ? [{ upload: a.upload.id, label: a.name }] : []));
}

/** Chips that keep Send off: still preparing or uploading, failed, or with a send in flight. */
export function chipsWaiting(list: readonly Attachment[]): boolean {
  return list.some((a) => a.state !== 'ready' || a.sending === true);
}

/** The sentences the composer shows about its attachments (spec 6.1, 6.8). */
export const ATTACH_COPY = {
  offline: "Offline: can't add files right now",
  tooMany: `Up to ${UPLOADS_PER_PROMPT} files per prompt`,
  unreadable: "The phone couldn't read this file",
  failed: "Couldn't upload this file",
  /** v0.5.1: attach/convert.ts didn't load. No Retry: a browser may keep the failed import until the page loads again. */
  noPrepare: 'Nothing was sent. Reload the page and attach it again',
  /** The daemon's own sentence (api/routes.ts ATTACHMENTS_WITH_SLASH). */
  slash: "Attachments can't go with a slash command",
  /** A paste that held a file and text too (cells from a spreadsheet carry a picture of them): the file was added. */
  pasted: 'Pasted as a file.',
  pasteText: 'Paste the text instead',
} as const;

/** A slash command as the daemon reads one (writer/text.ts parseSlashCommand), on the trimmed text. */
const SLASH_COMMAND = /^\/[A-Za-z][\w:.-]*(?:\s|$)/;

/** Why the text can't go with these chips, or null: the daemon refuses files with a slash command. */
export function filesProblem(text: string, list: readonly Attachment[]): string | null {
  return list.length > 0 && SLASH_COMMAND.test(text.trim()) ? ATTACH_COPY.slash : null;
}

/** The Rewrite sheet's line about the chips its send carries (spec 6.7); null with none. */
export function attachmentsLine(list: readonly Attachment[]): string | null {
  const n = list.length;
  if (!n) return null;
  const failed = list.filter((a) => a.state === 'failed').length;
  if (failed) {
    // The Rewrite sheet covers the composer, so its FilesLine offers Retry and Remove right under this.
    const which = failed < n ? `${failed} of ${n} files` : n === 1 ? 'The file' : 'The files';
    return `${which} didn't upload. Retry or remove ${failed === 1 ? 'it' : 'them'} to send.`;
  }
  if (list.some((a) => a.state !== 'ready')) return n === 1 ? '1 file goes with it once it is uploaded' : `${n} files go with it once they are uploaded`;
  return n === 1 ? '1 file goes with it' : `${n} files go with it`;
}

/** What the daemon puts before a prompt's file list (daemon uploads/compose.ts). */
const FILES_HEADING = 'Attached files:';
const FILES_ONLY_HEADING = 'Please look at these files:';

/**
 * Whether a user turn of the transcript is this send: its text exactly, or,
 * for a send with files, the prompt the daemon composed from it (the words,
 * a blank line and "Attached files:", or "Please look at these files:" for
 * files alone, then one line per file). For the Transcript's matching of
 * proven sends, which otherwise never finds a send with files.
 */
export function turnOfSend(turn: string, s: Pick<SendView, 'text' | 'local'>): boolean {
  // Line ends as the daemon reads both (uploads/compose.ts).
  const text = (s.text ?? '').replace(/\r\n?/g, '\n').trim();
  const t = turn.replace(/\r\n?/g, '\n').trim();
  const files = s.local?.attachments?.length ?? 0;
  if (!files) return text !== '' && t === text;
  const head = text ? `${text}\n\n${FILES_HEADING}\n` : `${FILES_ONLY_HEADING}\n`;
  return t.startsWith(head) && t.slice(head.length).split('\n').length === files;
}

/** "2 files" for a send of this device that carried files, under its words in the transcript; null without. */
export function sendFilesWord(s: Pick<SendView, 'local'>): string | null {
  const n = s.local?.attachments?.length ?? 0;
  if (!n) return null;
  return n === 1 ? '1 file' : `${n} files`;
}

/** AttachmentRef labels are 200 characters at most (the daemon cuts them to 80 in the prompt). */
const LABEL_MAX = 200;

/** A name cut to at most `max` UTF-16 units (what the schema's max counts), whole code points only: an emoji is never split in half. */
export function cutName(name: string, max: number): string {
  if (name.length <= max) return name;
  let out = '';
  for (const ch of name) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** The chip's state for an upload that got no answer: the app's sentence, with Retry. */
const NO_ANSWER: Pick<Attachment, 'state' | 'error' | 'retryable'> = {
  state: 'failed',
  error: errorText(new ApiError('network', 'offline', 0)),
  retryable: true,
};

/**
 * After an aborted upload, the next one waits this long: the Mac frees the
 * aborted request's slot only once the abort reaches it (through the tunnel,
 * a moment later), and an upload sent before that gets a 429.
 */
export const ABORT_SETTLE_MS = 1000;

/** The chip's sentence for a failed upload: the daemon's own (411, 413, 415, 422, 429), or the app's for no answer. */
function uploadErrorText(e: unknown): string {
  if (isApiError(e, 'network') || isApiError(e, 'unauthorized')) return errorText(e);
  if (isApiError(e)) return e.message || errorText(e);
  return ATTACH_COPY.failed;
}

/** An object URL for a thumbnail, or none where the browser has no object URLs. */
function objectUrl(blob: Blob): string | undefined {
  try {
    return URL.createObjectURL(blob);
  } catch {
    return undefined;
  }
}

function revoke(url: string | undefined) {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // nothing to free
  }
}

/** What a chip holds besides its state: the prepared file (Retry sends it again) and the upload in flight. */
interface ChipFile {
  /** "image 3" for a file with no name of its own, given when it was added. */
  fallback: string;
  prepared?: PreparedFile;
  ctrl?: AbortController;
}

/** The v0.1 stage order; `proven-merged` counts as the last step. */
export const STEPS: readonly SendStage[] = ['queued', 'checking', 'typed', 'enter', 'proven'];

export function stepIndex(stage: SendStage): number {
  if (stage === 'proven-merged') return 4;
  const i = STEPS.indexOf(stage);
  return i < 0 ? 0 : i;
}

export const isFinal = (stage: SendStage) => SEND_FINAL_STAGES.includes(stage);
export const isBad = (stage: SendStage) => stage === 'failed' || stage === 'refused';
export const isProven = (stage: SendStage) => stage === 'proven' || stage === 'proven-merged';

/** C0 and C1 controls but tab and line feed: the daemon refuses a prompt holding one. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

/**
 * Prompts the daemon refuses on sight because they can never be proven sent,
 * or hold control characters (packages/daemon/src/writer/text.ts): say so
 * before sending, not after.
 */
export function promptProblem(raw: string): string | null {
  const text = raw.trim();
  // As the daemon reads it (writer/text.ts): line ends made \n, then no other control character.
  if (CONTROL.test(text.replace(/\r\n?/g, '\n'))) return 'This text holds control characters, which could press keys of their own in the terminal. Take them out and try again.';
  if (text.startsWith('!')) {
    return "A prompt that starts with ! runs as a shell command in Claude's bash mode, so it can't be proven sent from here. Run it at the Mac.";
  }
  const m = /^(\/[A-Za-z][\w:.-]*)(?:\s|$)/.exec(text);
  const name = m?.[1];
  if (name === '/clear' || name === '/reset' || name === '/new') {
    return `${name} starts a new transcript, so it can't be proven sent from here. Run it at the Mac.`;
  }
  return null;
}

const OTHERS_KEEP_MS = 15 * 60_000;

export function useSends(sid: string, now: number) {
  const { api } = useDeps();
  const jobs = useApp((s) => s.state.sends);
  const offline = useApp((s) => s.conn.status === 'offline');
  const [local, setLocal] = useState<LocalSend[]>([]);
  const [draft, setDraft] = useState('');
  const [sentCount, setSentCount] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  // v0.4.2: the chips, mirrored in a ref so an upload that ends between renders sees the latest list.
  const [attachments, setAttachmentList] = useState<Attachment[]>([]);
  const chips = useRef<Attachment[]>([]);
  const files = useRef(new Map<string, ChipFile>());
  const inFlight = useRef(new Set<string>());
  /** Upload slots still held on the Mac by aborted uploads (ABORT_SETTLE_MS each). */
  const settling = useRef(0);
  /** Photos wait here to be prepared one at a time. */
  const photos = useRef<Promise<unknown>>(Promise.resolve());
  const counts = useRef({ chip: 0, image: 0, file: 0 });
  const alive = useRef(true);
  // Read by uploads that end between renders.
  const offlineNow = useRef(offline);
  offlineNow.current = offline;
  /** "Up to 10 files per prompt", "Offline: …": the line under the chips, until the next add, remove or send. */
  const [attachNotice, setAttachNotice] = useState<string | null>(null);

  const patch = (key: string, p: Partial<LocalSend>) => setLocal((list) => list.map((l) => (l.key === key ? { ...l, ...p } : l)));

  function setChips(next: (list: Attachment[]) => Attachment[]) {
    chips.current = next(chips.current);
    setAttachmentList(chips.current);
  }
  const patchChip = (key: string, p: Partial<Attachment>) => setChips((list) => list.map((a) => (a.key === key ? { ...a, ...p } : a)));
  /** The chips holding these uploads. */
  const holding = (ids: ReadonlySet<string>) => (a: Attachment) => a.upload !== undefined && ids.has(a.upload.id);

  // Leaving the session screen: stop the uploads in flight and free the thumbnails.
  useEffect(() => {
    alive.current = true;
    const map = files.current;
    return () => {
      alive.current = false;
      for (const f of map.values()) f.ctrl?.abort();
      for (const a of chips.current) revoke(a.thumb);
    };
  }, []);

  // Offline (spec 6.8): the uploads on their way fail with Retry, and none starts (pump). Back online, the line saying so goes.
  useEffect(() => {
    if (!offline) {
      setAttachNotice((n) => (n === ATTACH_COPY.offline ? null : n));
      return;
    }
    const going = chips.current.filter((a) => a.state === 'uploading');
    if (!going.length) return;
    for (const a of going) files.current.get(a.key)?.ctrl?.abort();
    setChips((list) => list.map((a) => (a.state === 'uploading' ? { ...a, ...NO_ANSWER } : a)));
  }, [offline]);

  /** Send (or, after a network failure, send again with the same idempotency key). */
  async function retry(entry: LocalSend) {
    patch(entry.key, { posting: true, error: undefined, errorCode: undefined, retryable: false });
    const ids = new Set((entry.attachments ?? []).map((r) => r.upload));
    if (ids.size) setChips((list) => list.map((a) => (holding(ids)(a) ? { ...a, sending: true } : a)));
    try {
      const opts = {
        ...(entry.rewriteJobId ? { rewriteJobId: entry.rewriteJobId } : {}),
        ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
      };
      const res = Object.keys(opts).length > 0 ? await api.sendPrompt(sid, entry.text, entry.key, opts) : await api.sendPrompt(sid, entry.text, entry.key);
      patch(entry.key, { posting: false, jobId: res.jobId, initial: res.job });
      // The Mac took it: its files leave the composer (they stay on the Mac; Put back brings them back).
      if (ids.size) dropChips(holding(ids));
    } catch (e) {
      const network = isApiError(e, 'network');
      patch(entry.key, { posting: false, error: errorText(e), errorCode: isApiError(e) ? e.code : undefined, retryable: network });
      // No answer: the Mac may have typed it, so its files leave with its words (Retry sends them again, Edit
      // and resend brings them back). Left as ready chips, one tap would send them again without the words.
      if (!ids.size) return;
      if (network) dropChips(holding(ids));
      else setChips((list) => list.map((a) => (holding(ids)(a) ? { ...a, sending: undefined } : a)));
    }
  }

  /**
   * Send `text` as a new prompt. With `rewriteJobId` (the Rewrite sheet) the
   * daemon tells a written, edited or "as said" prompt apart by its hash.
   * v0.4.2: every chip goes with it unless `attachments: false`, and only
   * once each is on the Mac (null while one is preparing, uploading, failed
   * or with another send); with chips, the text may be blank. Returns the
   * send's key (its idempotency key, and its SendView's key), or null when
   * there was nothing to send. The draft is left alone.
   */
  function post(text: string, opts: { rewriteJobId?: string; attachments?: boolean } = {}): string | null {
    const t = text.trim();
    const withFiles = opts.attachments !== false;
    if (withFiles && chipsWaiting(chips.current)) return null;
    const taken = withFiles ? chips.current.filter((a) => a.upload) : [];
    const refs = readyRefs(taken);
    if ((!t && refs.length === 0) || promptProblem(t)) return null;
    const entry: LocalSend = { key: newIdempotencyKey(), text: t, posting: true, at: Date.now() };
    if (opts.rewriteJobId) entry.rewriteJobId = opts.rewriteJobId;
    if (refs.length > 0) {
      entry.attachments = refs;
      entry.uploads = taken.flatMap((a) => (a.upload ? [a.upload] : []));
    }
    setLocal((list) => [...list.slice(-4), entry]);
    setSentCount((n) => n + 1);
    setAttachNotice(null);
    void retry(entry);
    return entry.key;
  }

  /** Send the draft. Returns false when there was nothing to send. */
  function submit(): boolean {
    if (post(draft) === null) return false;
    setDraft('');
    return true;
  }

  /** Drop one of this device's sends from the transcript (one that never arrived, sent again). */
  function forget(key: string) {
    setLocal((list) => list.filter((l) => l.key !== key));
  }

  /**
   * Put a send's text back in the composer and focus it. v0.4.2: its files
   * come back as chips too: those of `from` (the send whose receipt was
   * tapped) when given, else of this device's newest send with that text that
   * did not arrive. A file already in the composer is not added twice.
   */
  function putBack(text: string, from?: LocalSend) {
    setDraft(text);
    const failed = (v: SendView) => v.local !== undefined && v.text === text && (v.error !== undefined || (v.job !== undefined && isBad(v.job.stage)));
    const entry = from ?? views.filter(failed).pop()?.local;
    if (entry?.attachments?.length) restoreChips(entry);
    requestAnimationFrame(() => area.current?.focus());
  }

  // ----- v0.4.2 attachments -----

  function restoreChips(entry: LocalSend) {
    const have = new Set(chips.current.flatMap((a) => (a.upload ? [a.upload.id] : [])));
    const back: Attachment[] = (entry.attachments ?? []).flatMap((ref) => {
      if (have.has(ref.upload)) return [];
      // The kind only picks the glyph; `uploads` is always kept beside `attachments`.
      const upload = entry.uploads?.find((u) => u.id === ref.upload) ?? { id: ref.upload, kind: 'text' as const, bytes: 0 };
      counts.current.chip += 1;
      return [{ key: `chip-${counts.current.chip}`, name: ref.label, state: 'ready' as const, progress: 1, kind: upload.kind, upload }];
    });
    const room = Math.max(0, UPLOADS_PER_PROMPT - chips.current.length);
    setAttachNotice(back.length > room ? ATTACH_COPY.tooMany : null);
    if (back.length) setChips((list) => [...list, ...back.slice(0, room)]);
  }

  /** Take chips out of the composer (sent, or removed): their files and thumbnails go, their uploads stay. */
  function dropChips(which: (a: Attachment) => boolean) {
    const gone = chips.current.filter(which);
    for (const a of gone) {
      files.current.get(a.key)?.ctrl?.abort();
      files.current.delete(a.key);
      revoke(a.thumb);
    }
    if (gone.length) setChips((list) => list.filter((a) => !which(a)));
  }

  /** Start uploads until UPLOADS_IN_FLIGHT are on their way, in the chips' order. Offline, those waiting fail with Retry instead. */
  function pump() {
    if (!alive.current) return;
    const waiting = (a: Attachment) => a.state === 'uploading' && !inFlight.current.has(a.key);
    if (offlineNow.current) {
      if (chips.current.some(waiting)) setChips((list) => list.map((a) => (waiting(a) ? { ...a, ...NO_ANSWER } : a)));
      return;
    }
    for (const a of chips.current) {
      if (inFlight.current.size + settling.current >= UPLOADS_IN_FLIGHT) return;
      if (waiting(a)) void upload(a.key);
    }
  }

  async function upload(key: string) {
    const f = files.current.get(key);
    const prepared = f?.prepared;
    if (!f || !prepared) return;
    const ctrl = new AbortController();
    f.ctrl = ctrl;
    inFlight.current.add(key);
    // A chip still there, and this very upload of it (not a removed one, nor one stopped by leaving).
    const current = () => files.current.get(key) === f && !ctrl.signal.aborted && alive.current;
    let shown = 0;
    try {
      const res = await api.uploadCreate(sid, prepared.blob, {
        ...(prepared.ext ? { ext: prepared.ext } : {}),
        signal: ctrl.signal,
        onProgress: (sent, total) => {
          // Whole percents only, below 100 until the Mac answers: a re-render per step, not per event.
          const pct = total > 0 ? Math.min(99, Math.floor((sent / total) * 100)) : 0;
          if (pct === shown || !current()) return;
          shown = pct;
          patchChip(key, { progress: pct / 100 });
        },
      });
      if (current()) {
        patchChip(key, { state: 'ready', progress: 1, upload: res.upload, kind: res.upload.kind, error: undefined, retryable: undefined });
      } else {
        // Removed (or the screen closed) while the Mac was answering: take the file off the Mac again.
        void api.uploadDelete(sid, res.upload.id).catch(() => undefined);
      }
    } catch (e) {
      if (current()) {
        const retryable = isApiError(e, 'network') || isApiError(e, 'rate_limited');
        patchChip(key, { state: 'failed', error: uploadErrorText(e), retryable });
      }
    } finally {
      inFlight.current.delete(key);
      if (f.ctrl === ctrl) delete f.ctrl;
      if (ctrl.signal.aborted) {
        settling.current += 1;
        setTimeout(() => {
          settling.current -= 1;
          pump();
        }, ABORT_SETTLE_MS);
      } else {
        pump();
      }
    }
  }

  async function prepare(key: string, file: File) {
    const run = async (): Promise<PreparedFile | { refused: string } | null> => {
      // Removed while it waited its turn, or the screen closed.
      if (!files.current.has(key) || !alive.current) return null;
      let convert: typeof import('./attach/convert.js');
      try {
        convert = await import('./attach/convert.js');
      } catch {
        // Its chunk didn't arrive (the connection dropped): nothing was read or sent.
        return { refused: ATTACH_COPY.noPrepare };
      }
      try {
        return await convert.prepareFile(file);
      } catch {
        return { refused: ATTACH_COPY.unreadable };
      }
    };
    let p: PreparedFile | { refused: string } | null;
    if (isImage(file)) {
      // One photo at a time: each decodes to tens of MB and draws a canvas, and iOS reloads a page that
      // takes too much (the draft and every chip would go with it).
      const turn = photos.current.then(run);
      photos.current = turn;
      p = await turn;
    } else {
      p = await run();
    }
    const f = files.current.get(key);
    // Removed while it was being prepared, or the screen closed.
    if (!p || !f || !alive.current) return;
    if ('refused' in p) {
      patchChip(key, { state: 'failed', error: p.refused, retryable: false });
      return;
    }
    f.prepared = p;
    const thumb = p.kind === 'image' ? objectUrl(p.blob) : undefined;
    patchChip(key, { name: cutName(p.name || f.fallback || 'file', LABEL_MAX), kind: p.kind, state: 'uploading', progress: 0, ...(thumb ? { thumb } : {}) });
    pump();
  }

  /**
   * Add files as chips (picked, pasted or dropped): each is prepared, then
   * uploaded. At most UPLOADS_PER_PROMPT. Returns the keys of the chips added.
   */
  function addFiles(list: Iterable<File>): string[] {
    const picked = [...list];
    if (!picked.length) return [];
    if (offline) {
      setAttachNotice(ATTACH_COPY.offline);
      return [];
    }
    const taken = picked.slice(0, Math.max(0, UPLOADS_PER_PROMPT - chips.current.length));
    setAttachNotice(taken.length < picked.length ? ATTACH_COPY.tooMany : null);
    const added = taken.map((file): Attachment => {
      const c = counts.current;
      c.chip += 1;
      const own = ownName(file);
      // Numbered when added, so two pasted images are "image 1" and "image 2" in the order they came.
      const fallback = own ? '' : isImage(file) ? `image ${(c.image += 1)}` : `file ${(c.file += 1)}`;
      const key = `chip-${c.chip}`;
      files.current.set(key, { fallback });
      return { key, name: cutName(own || fallback, LABEL_MAX), state: 'preparing', progress: 0 };
    });
    if (!added.length) return [];
    setChips((cur) => [...cur, ...added]);
    added.forEach((a, i) => void prepare(a.key, taken[i] as File));
    return added.map((a) => a.key);
  }

  /** Remove a chip: an upload in flight is aborted, one on the Mac is deleted there. Not while a send holds it. */
  function removeAttachment(key: string) {
    const a = chips.current.find((c) => c.key === key);
    if (!a || a.sending) return;
    if (a.upload) void api.uploadDelete(sid, a.upload.id).catch(() => undefined);
    setAttachNotice(null);
    dropChips((c) => c.key === key);
    pump();
  }

  /** Upload a failed chip again (after a network failure or a 429). */
  function retryAttachment(key: string) {
    const a = chips.current.find((c) => c.key === key);
    if (!a || a.state !== 'failed' || !a.retryable || !files.current.get(key)?.prepared) return;
    if (offline) {
      setAttachNotice(ATTACH_COPY.offline);
      return;
    }
    setAttachNotice(null);
    patchChip(key, { state: 'uploading', progress: 0, error: undefined, retryable: undefined });
    pump();
  }

  const views = useMemo<SendView[]>(() => {
    const mine = new Set(local.map((l) => l.jobId).filter(Boolean));
    const keys = new Set(local.map((l) => l.key));
    const byKey = new Map(Object.values(jobs).filter((j) => j.idempotencyKey && keys.has(j.idempotencyKey)).map((j) => [j.idempotencyKey, j]));
    // Sends to this session from elsewhere (CLI, another device) that are
    // still in flight or did not arrive. Proven ones show up in the
    // transcript itself.
    const others: SendView[] = Object.values(jobs)
      .filter((j) => j.sid === sid && !mine.has(j.id) && !(j.idempotencyKey && keys.has(j.idempotencyKey)) && !isProven(j.stage))
      .filter((j) => !isFinal(j.stage) || now - Date.parse(j.updatedAt) < OTHERS_KEEP_MS)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-2)
      .map((j) => ({ key: j.id, text: null, textLength: j.textLength, job: j, posting: false, actor: j.actor }));
    const own: SendView[] = local.map((l) => {
      const job = (l.jobId && jobs[l.jobId]) || byKey.get(l.key) || l.initial;
      return {
        key: l.key,
        text: l.text,
        textLength: l.text.length,
        job,
        error: l.error,
        errorCode: l.errorCode,
        retryable: l.retryable,
        posting: l.posting,
        local: l,
      };
    });
    return [...others, ...own];
  }, [jobs, local, sid, now]);

  return {
    views,
    draft,
    setDraft,
    submit,
    post,
    retry,
    forget,
    putBack,
    area,
    sentCount,
    attachments,
    attachNotice,
    addFiles,
    removeAttachment,
    retryAttachment,
  };
}

export type Sends = ReturnType<typeof useSends>;
