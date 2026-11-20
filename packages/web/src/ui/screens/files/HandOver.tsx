/**
 * Share and Download for a PDF or an image in the viewer (0.14.1). The
 * bytes are the ones GET /v1/files/raw serves the viewer: those already
 * fetched to show the file when there are any, else fetched on the tap.
 * Nothing is kept past the viewer, as with the bytes it shows (blob.ts).
 *
 * Share hands a File to the share sheet (navigator.share), which needs a
 * fresh tap on an iPhone. With the bytes at hand the tap shares at once;
 * when they had to be fetched first, that tap is spent, so the viewer says
 * "Ready to share" with a button of its own (and Share in the header works
 * again too), and the share starts from that second tap. A browser that
 * can't share this file (navigator.canShare false, or no Web Share) gets
 * the download instead. Closing the share sheet is no error; any other
 * failure is one plain toast.
 *
 * Download clicks an <a download> on an object URL, revoked a moment
 * later (lib/share-file.ts). Over the raw caps (20 MB for an image, 50 MB
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
type Phase = { name: 'idle' } | { name: 'fetching'; action: Action } | { name: 'ready' };

export interface HandOver {
  /** Over the cap: Share and Download are off, and this says why. */
  refusal: string | null;
  /** Bytes are on their way for this action. */
  busy: Action | null;
  /** Bytes fetched after a Share tap: the next tap shares. */
  ready: boolean;
  share(): void;
  download(): void;
  dismiss(): void;
}

/**
 * Share and Download for one file. `shown` gives the bytes the viewer
 * already fetched to show it (or null). The share sheet and the download
 * are the browser's own (browserExportEnv), read at each tap.
 */
export function useHandOver(opts: { root: string; path: string; name: string; kind: HandOverKind; size: number; shown: () => Blob | null }): HandOver {
  const { api } = useDeps();
  const toast = useToast();
  const { root, path, name, kind, size, shown } = opts;
  const refusal = handOverRefusal(kind, size);
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  // Bytes fetched here for this file; dropped with the viewer.
  const fetched = useRef<{ key: string; blob: Blob } | null>(null);
  const job = useRef<AbortController | null>(null);
  const key = `${root}\u0000${path}`;
  useEffect(
    () => () => {
      job.current?.abort();
      job.current = null;
    },
    [],
  );
  // Another file in the same viewer: nothing of the last one carries over.
  useEffect(() => {
    job.current?.abort();
    job.current = null;
    setPhase({ name: 'idle' });
  }, [key]);

  const known = (): Blob | null => (fetched.current?.key === key ? fetched.current.blob : shown());

  // One plain sentence: the browser's own error text is not written for people.
  const failed = useCallback(() => toast("Couldn't share this file. Try again, or use Download.", 'error'), [toast]);

  /** Hand the bytes over now, inside the tap that asked (navigator.share needs it). */
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
    setPhase({ name: 'fetching', action });
    api.filesRaw({ root, path }, { signal: abort.signal }).then(
      (blob) => {
        if (job.current !== abort) return;
        job.current = null;
        fetched.current = { key, blob };
        const env = browserExportEnv();
        // The tap that asked was spent waiting: a share starts from the next one.
        if (action === 'share' && sharesFile(handOverFile(blob, name, kind), env)) {
          setPhase({ name: 'ready' });
          return;
        }
        setPhase({ name: 'idle' });
        env.download(handOverFile(blob, name, kind));
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
    ready: phase.name === 'ready',
    share: () => start('share'),
    download: () => start('download'),
    dismiss: () => setPhase({ name: 'idle' }),
  };
}

/** The second tap target: the bytes came after the first tap, and this one opens the share sheet. */
export function ReadyToShare({ name, onShare, onDismiss, phone }: { name: string; onShare: () => void; onDismiss: () => void; phone: boolean }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => button.current?.focus({ preventScroll: true }), []);
  return (
    <section aria-label="Ready to share" className={phone ? 'flex flex-none items-center gap-8 border-t border-line bg-surface py-8 pl-16 pr-8' : 'flex flex-none items-center gap-8 border-t border-line bg-surface py-8 pl-24 pr-16'}>
      <p role="status" className="min-w-0 flex-1 truncate type-small text-ink-2">
        Ready to share <TextRun text={name} />
      </p>
      <Button ref={button} variant="primary" size="sm" className="flex-none" onClick={onShare}>
        Share now
      </Button>
      <IconButton aria-label="Not now" onClick={onDismiss}>
        <XIcon size={16} aria-hidden="true" />
      </IconButton>
    </section>
  );
}
