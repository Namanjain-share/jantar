/**
 * Share and Download for a PDF or an image in the viewer (0.14.1). The
 * bytes are the ones GET /v1/files/raw serves the viewer: the newest ones
 * it has for this version of the file (its root, path, mtime and size),
 * whether the image or PDF view fetched them to show it or a tap here did,
 * else fetched on the tap. When Claude writes the file again, the bytes
 * held for the old version are dropped. Nothing is kept past the viewer,
 * as with the bytes it shows (blob.ts).
 *
 * Share hands a File to the share sheet (navigator.share), and Download
 * clicks an <a download> on an object URL, revoked a moment later
 * (lib/share-file.ts). An iPhone allows either only straight from a tap.
 * With the bytes at hand the tap hands them over at once; when they had to
 * be fetched first, that tap is spent, so the viewer says "Ready to share"
 * (Share now) or "Ready to save" (Save now), and the second tap does it. A
 * browser that can't share this file (navigator.canShare false, or no Web
 * Share) saves it instead. Closing the share sheet is no error; any other
 * failure is one plain toast. Over the raw caps (20 MB for an image, 50 MB
 * for a PDF) both are off, with the reason on screen.
 */
import { XIcon } from '@phosphor-icons/react';
import { FILES_RAW_IMAGE_MAX, FILES_RAW_PDF_MAX } from '@jantar/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { browserExportEnv, type ExportEnv } from '../../../lib/share-file.js';
import { useDeps, useToast } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { IconButton } from '../../kit/IconButton.js';
import { TextRun } from './CodeView.js';
import { sizeText } from './model.js';
import { fileErrorText } from './states.js';

/** The kinds GET /v1/files/raw serves, so the only ones Share and Download offer. */
export type HandOverKind = 'image' | 'pdf';

export function handOverMax(kind: HandOverKind): number {
  return kind === 'pdf' ? FILES_RAW_PDF_MAX : FILES_RAW_IMAGE_MAX;
}

/** Why Share and Download are off for this file, or null when they are on. */
export function handOverRefusal(kind: HandOverKind, size: number): string | null {
  if (size <= handOverMax(kind)) return null;
  return `Too large to share or download from here: ${kind === 'pdf' ? 'PDFs' : 'images'} up to ${sizeText(handOverMax(kind))}.`;
}

const TYPE_BY_EXT: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
};

/** The bytes as a File named like the file on the Mac, typed as the daemon served them (else by its extension). */
export function handOverFile(blob: Blob, name: string, kind: HandOverKind): File {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const type = blob.type || TYPE_BY_EXT[ext] || (kind === 'pdf' ? 'application/pdf' : 'application/octet-stream');
  return new File([blob], name, { type });
}

/** Whether this browser's share sheet takes this file. */
export function sharesFile(file: File, env: ExportEnv): boolean {
  if (!env.share || !env.canShare) return false;
  try {
    return env.canShare({ files: [file] });
  } catch {
    return false;
  }
}

type Action = 'share' | 'download';
type Phase = { name: 'idle' } | { name: 'fetching'; action: Action } | { name: 'ready'; mode: 'share' | 'save' };

export interface HandOver {
  /** Over the cap: Share and Download are off, and this says why. */
  refusal: string | null;
  /** Bytes are on their way for this action. */
  busy: Action | null;
  /** Bytes fetched after the tap: the next tap shares (`share`) or saves (`save`). */
  ready: 'share' | 'save' | null;
  share(): void;
  download(): void;
  dismiss(): void;
  /** The bytes the image or PDF view fetched to show the file (its `onBytes`). Stable across renders. */
  keep(blob: Blob): void;
}

/**
 * Share and Download for one version of one file. The share sheet and the
 * download are the browser's own (browserExportEnv), read at each tap.
 */
export function useHandOver(opts: { root: string; path: string; name: string; kind: HandOverKind; size: number; mtime: string }): HandOver {
  const { api } = useDeps();
  const toast = useToast();
  const { root, path, name, kind, size, mtime } = opts;
  const refusal = handOverRefusal(kind, size);
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  // The newest bytes for this version of the file, whoever fetched them; dropped with the viewer.
  const bytes = useRef<{ key: string; blob: Blob } | null>(null);
  const job = useRef<AbortController | null>(null);
  const key = `${root}\u0000${path}\u0000${mtime}\u0000${size}`;
  // Read by `keep`, which the views call from their own effects (they run before this hook's).
  const keyRef = useRef(key);
  keyRef.current = key;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  useEffect(
    () => () => {
      job.current?.abort();
      job.current = null;
    },
    [],
  );
  // Another file, or this one written again: nothing of the old version carries over.
  useEffect(() => {
    if (bytes.current && bytes.current.key !== key) bytes.current = null;
    job.current?.abort();
    job.current = null;
    setPhase({ name: 'idle' });
  }, [key]);

  const keep = useCallback((blob: Blob) => {
    // Bytes of another size are of another version (fetched before Claude wrote the file again): not this one's.
    if (blob.size !== sizeRef.current) return;
    bytes.current = { key: keyRef.current, blob };
  }, []);
  const known = (): Blob | null => (bytes.current?.key === key ? bytes.current.blob : null);

  // One plain sentence: the browser's own error text is not written for people.
  const failed = useCallback(() => toast("Couldn't share this file. Try again, or use Download.", 'error'), [toast]);

  /** Hand the bytes over now, inside the tap that asked (an iPhone allows it only there). */
  const handOver = (blob: Blob, action: Action) => {
    const env = browserExportEnv();
    const file = handOverFile(blob, name, kind);
    if (action === 'share' && sharesFile(file, env) && env.share) {
      let sharing: Promise<void>;
      try {
        sharing = env.share({ files: [file] });
      } catch {
        failed();
        return;
      }
      sharing.then(
        () => undefined,
        (e: unknown) => {
          // Closing the sheet is the person's answer, not a failure.
          if ((e as { name?: unknown } | null)?.name !== 'AbortError') failed();
        },
      );
      return;
    }
    env.download(file);
  };

  const fetchThen = (action: Action) => {
    job.current?.abort();
    const abort = new AbortController();
    job.current = abort;
    const at = key;
    setPhase({ name: 'fetching', action });
    api.filesRaw({ root, path }, { signal: abort.signal }).then(
      (blob) => {
        if (job.current !== abort) return;
        job.current = null;
        bytes.current = { key: at, blob };
        // The tap that asked was spent waiting: the share sheet or the save starts from the next one.
        const shares = action === 'share' && sharesFile(handOverFile(blob, name, kind), browserExportEnv());
        setPhase({ name: 'ready', mode: shares ? 'share' : 'save' });
      },
      (e: unknown) => {
        if (job.current !== abort) return;
        job.current = null;
        setPhase({ name: 'idle' });
        toast(fileErrorText(e), 'error');
      },
    );
  };

  const start = (action: Action) => {
    if (refusal || phase.name === 'fetching') return;
    const blob = known();
    if (blob) {
      setPhase({ name: 'idle' });
      handOver(blob, action);
    } else {
      fetchThen(action);
    }
  };

  return {
    refusal,
    busy: phase.name === 'fetching' ? phase.action : null,
    ready: phase.name === 'ready' ? phase.mode : null,
    share: () => start('share'),
    download: () => start('download'),
    dismiss: () => setPhase({ name: 'idle' }),
    keep,
  };
}

const READY = {
  share: { label: 'Ready to share', button: 'Share now' },
  save: { label: 'Ready to save', button: 'Save now' },
} as const;

/** The second tap target: the bytes came after the first tap, and this one opens the share sheet or saves the file. */
export function ReadyBar({ mode, name, onGo, onDismiss, phone }: { mode: 'share' | 'save'; name: string; onGo: () => void; onDismiss: () => void; phone: boolean }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => button.current?.focus({ preventScroll: true }), [mode]);
  const words = READY[mode];
  return (
    <section aria-label={words.label} className={phone ? 'flex flex-none items-center gap-8 border-t border-line bg-surface py-8 pl-16 pr-8' : 'flex flex-none items-center gap-8 border-t border-line bg-surface py-8 pl-24 pr-16'}>
      <p role="status" className="min-w-0 flex-1 truncate type-small text-ink-2">
        {words.label} <TextRun text={name} />
      </p>
      <Button ref={button} variant="primary" size="sm" className="flex-none" onClick={onGo}>
        {words.button}
      </Button>
      <IconButton aria-label="Not now" onClick={onDismiss}>
        <XIcon size={16} aria-hidden="true" />
      </IconButton>
    </section>
  );
}
