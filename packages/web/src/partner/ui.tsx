/**
 * v0.11 People: her app's small shared pieces: the 5-second Undo toast
 * (the one-thumb fix for a mis-tap, spec 3.1), one-tap reason chips
 * (typing is optional), a tick circle with a 44 px target, and the report
 * sheet for an item that asks for a short report.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../ui/kit/Button.js';

export interface UndoState {
  text: string;
  undo: () => void;
}

/** One toast at a time: a new one replaces the last; it closes itself after `ms`. */
export function useUndo(ms = 5000): { toast: UndoState | null; show: (text: string, undo: () => void) => void; close: () => void } {
  const [toast, setToast] = useState<UndoState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const close = useCallback(() => {
    clearTimeout(timer.current);
    setToast(null);
  }, []);
  const show = useCallback(
    (text: string, undo: () => void) => {
      clearTimeout(timer.current);
      setToast({ text, undo });
      timer.current = setTimeout(() => setToast(null), ms);
    },
    [ms],
  );
  useEffect(() => () => clearTimeout(timer.current), []);
  return { toast, show, close };
}

export function UndoToast({ toast, close }: { toast: UndoState | null; close: () => void }) {
  if (!toast) return null;
  return (
    <div role="status" className="fixed inset-x-16 bottom-144 z-20 mx-auto flex max-w-560 items-center justify-between gap-12 rounded-btn bg-ink px-16 py-8 text-bg">
      <span className="min-w-0 truncate">{toast.text}</span>
      <button
        type="button"
        className="min-h-44 px-8 font-medium underline"
        onClick={() => {
          toast.undo();
          close();
        }}
      >
        Undo
      </button>
    </div>
  );
}

export function ReasonChips({ reasons, value, onPick }: { reasons: readonly string[]; value: string; onPick: (r: string) => void }) {
  return (
    <div className="flex flex-wrap gap-8">
      {reasons.map((r) => (
        <button
          key={r}
          type="button"
          aria-pressed={value === r}
          onClick={() => onPick(value === r ? '' : r)}
          className={`min-h-44 rounded-chip border px-12 text-small ${value === r ? 'border-ink bg-hover' : 'border-line'}`}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

export function Tick({ done, label, onClick, disabled }: { done: boolean; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" aria-label={label} aria-pressed={done} disabled={disabled} className="flex size-44 shrink-0 items-center justify-center disabled:opacity-50" onClick={onClick}>
      <span className={`block size-20 rounded-full border-2 ${done ? 'border-ink bg-ink' : 'border-line-strong'}`} />
    </button>
  );
}

export function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section aria-label={label} className="mt-12 rounded-btn border border-line p-12">
      {children}
    </section>
  );
}

/** A plain text field for a sheet, with its label above it. */
export function Field({ label, value, onChange, max, multiline = false }: { label: string; value: string; onChange: (v: string) => void; max: number; multiline?: boolean }) {
  return (
    <label className="flex flex-col gap-4">
      <span className="text-small text-ink-2">{label}</span>
      {multiline ? (
        <textarea className="min-h-88 rounded-btn border border-line bg-bg px-8 py-8 type-input" maxLength={max} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="min-h-44 rounded-btn border border-line bg-bg px-8 type-input" maxLength={max} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

/**
 * "Done" on an item that asks for a short report (a plan step, or a to-do
 * he assigned with one): a note for {owner} and two equal buttons; Done
 * without a note sends none.
 */
export function ReportSheet({ open, title, owner, close, onDone }: { open: boolean; title: string; owner: string; close: () => void; onDone: (report?: string) => void }) {
  const [note, setNote] = useState('');
  useEffect(() => {
    if (open) setNote('');
  }, [open, title]);
  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()} title={`Done: ${title}`}>
      <div className="flex flex-col gap-12 pb-24">
        <Field label={`A short note for ${owner} (optional)`} value={note} onChange={setNote} max={500} multiline />
        <div className="flex gap-8">
          <Button variant="primary" size="xl" className="flex-1" disabled={!note.trim()} onClick={() => onDone(note.trim())}>
            Save note
          </Button>
          <Button variant="outline" size="xl" className="flex-1" onClick={() => onDone()}>
            Done without a note
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * Her bottom sheet: a light dialog (role dialog, aria-modal, Escape and the
 * backdrop close it, focus moves in on open and back on close). The owner
 * app's kit Sheet (Base UI's Drawer) would roughly add a third to her first
 * load, so her app keeps its own.
 */
export function Sheet({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  // The latest callback, so a parent re-render (each keystroke) never re-runs the focus move.
  const change = useRef(onOpenChange);
  change.current = onOpenChange;
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>('button, input, textarea, select, a[href]');
    (first ?? box.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') change.current(false);
    };
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('keydown', onKey);
      before?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center">
      <button type="button" aria-label="Close" tabIndex={-1} className="absolute inset-0 bg-scrim" onClick={() => onOpenChange(false)} />
      <div ref={box} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="relative max-h-[90dvh] w-full max-w-560 overflow-y-auto rounded-t-dock bg-raised px-16 pb-[env(safe-area-inset-bottom)] text-ink outline-none">
        <div className="flex h-20 items-center justify-center" aria-hidden="true">
          <span className="h-4 w-36 rounded-chip bg-ink-4" />
        </div>
        <h2 className="mb-8 mt-4 text-title font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}
