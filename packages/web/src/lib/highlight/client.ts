/**
 * The page's side of the highlighter: one lazily started worker, one
 * request per file, and a watchdog. Requests reach the worker one at a
 * time, and each gets HIGHLIGHT_WATCHDOG_MS from the moment the worker takes
 * it (a fresh worker's first one also gets HIGHLIGHT_START_MS to load its
 * grammars), so a notebook's many cells never share one second. A file that
 * is over the limits or has no grammar comes back as null and shows as
 * plain text; so does one that runs out of time, and then the worker is
 * terminated (a runaway regex dies with it) and the files still waiting go
 * to a fresh one. A request nobody waits for any more is dropped before it
 * reaches the worker.
 *
 * Where there is no Worker (tests, very old browsers) everything is plain.
 */
import { useEffect, useState } from 'react';
import { HIGHLIGHT_START_MS, HIGHLIGHT_WATCHDOG_MS, withinLimits, type HighlightReply, type HighlightRequest, type Line } from './types.js';

/** What the client needs of a Worker (tests pass a fake). */
export interface WorkerLike {
  postMessage(msg: HighlightRequest): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<HighlightReply>) => void) | null;
  onerror: ((e: Event) => void) | null;
}

export interface Highlighter {
  /** Lines with token classes, or null for plain text. Never rejects. An aborted `signal` drops it while it waits. */
  highlight(text: string, lang: string, signal?: AbortSignal): Promise<Line[] | null>;
  /** Terminate the worker; anything waiting resolves null. */
  dispose(): void;
}

/** The real worker: a Vite-bundled file, never blob: or data: (spec 5.2.4). */
function startWorker(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('../../workers/highlight.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

interface Job {
  id: number;
  text: string;
  lang: string;
  resolve: (lines: Line[] | null) => void;
}

export function createHighlighter(opts: { start?: () => WorkerLike | null; watchdogMs?: number; startMs?: number } = {}): Highlighter {
  const start = opts.start ?? startWorker;
  const watchdogMs = opts.watchdogMs ?? HIGHLIGHT_WATCHDOG_MS;
  const startMs = opts.startMs ?? HIGHLIGHT_START_MS;
  let worker: WorkerLike | null = null;
  // The worker has answered nothing yet: it may still be loading its grammars.
  let cold = false;
  let nextId = 1;
  const queue: Job[] = [];
  let running: { job: Job; timer: ReturnType<typeof setTimeout> } | null = null;

  const terminate = () => {
    const w = worker;
    worker = null;
    try {
      w?.terminate();
    } catch {
      // already gone
    }
  };
  // The file the worker has is done (null: plain); the next one goes in.
  const finish = (lines: Line[] | null) => {
    const r = running;
    if (!r) return;
    running = null;
    clearTimeout(r.timer);
    r.job.resolve(lines);
    pump();
  };
  const kill = () => {
    terminate();
    const r = running;
    running = null;
    if (r) {
      clearTimeout(r.timer);
      r.job.resolve(null);
    }
    for (const job of queue.splice(0)) job.resolve(null);
  };
  const ensure = (): WorkerLike | null => {
    if (worker) return worker;
    let w: WorkerLike | null;
    try {
      w = start();
    } catch {
      w = null;
    }
    if (!w) return null;
    worker = w;
    cold = true;
    w.onmessage = (e) => {
      const reply = e.data;
      // A late reply from a worker already terminated changes nothing.
      if (worker !== w || !running || !reply || reply.id !== running.job.id) return;
      cold = false;
      finish(Array.isArray(reply.lines) ? reply.lines : null);
    };
    // A worker that cannot run (a broken bundle, a CSP refusal) would fail the same way again.
    w.onerror = () => kill();
    return w;
  };
  const pump = () => {
    while (!running && queue.length) {
      const job = queue.shift()!;
      const w = ensure();
      if (!w) {
        job.resolve(null);
        continue;
      }
      // The watchdog: a stuck file is dropped with its worker, and shows plain.
      const timer = setTimeout(
        () => {
          terminate();
          finish(null);
        },
        cold ? watchdogMs + startMs : watchdogMs,
      );
      running = { job, timer };
      try {
        w.postMessage({ id: job.id, text: job.text, lang: job.lang });
      } catch {
        running = null;
        clearTimeout(timer);
        job.resolve(null);
      }
    }
  };

  return {
    highlight(text, lang, signal) {
      if (!withinLimits(text) || signal?.aborted) return Promise.resolve(null);
      return new Promise((resolve) => {
        const job: Job = { id: nextId++, text, lang, resolve };
        queue.push(job);
        signal?.addEventListener(
          'abort',
          () => {
            const i = queue.indexOf(job);
            if (i < 0) return;
            queue.splice(i, 1);
            resolve(null);
          },
          { once: true },
        );
        pump();
      });
    },
    dispose: kill,
  };
}

let shared: Highlighter | null = null;

/** The app's one highlighter (started on first use). */
export function sharedHighlighter(): Highlighter {
  shared ??= createHighlighter();
  return shared;
}

/** Swap the app's highlighter (tests); null goes back to the real one on next use. */
export function setSharedHighlighter(h: Highlighter | null): void {
  if (shared && shared !== h) shared.dispose();
  shared = h;
}

/**
 * Highlighted lines for `text`, or null while they are on the way and
 * whenever the file shows plain. `lang` null (no grammar) skips the worker.
 */
export function useHighlight(text: string, lang: string | null): Line[] | null {
  const [result, setResult] = useState<{ text: string; lang: string; lines: Line[] | null } | null>(null);
  useEffect(() => {
    if (!lang || !text) return;
    let live = true;
    // Gone before its turn (another file, the viewer closed): it never reaches the worker.
    const gone = new AbortController();
    void sharedHighlighter()
      .highlight(text, lang, gone.signal)
      .then((lines) => {
        if (live) setResult({ text, lang, lines });
      });
    return () => {
      live = false;
      gone.abort();
    };
  }, [text, lang]);
  // A reply for older text never paints over newer text.
  return result && lang && result.text === text && result.lang === lang ? result.lines : null;
}
