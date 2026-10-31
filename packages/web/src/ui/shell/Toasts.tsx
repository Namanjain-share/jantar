/**
 * Toasts only for results with no on-screen home ("Usage refresh asked
 * for"): bottom centre, --raised, text only, 3.5 s (the toast store in
 * ui/context.tsx owns timing). Errors that belong to a control are shown
 * inline under it instead.
 */
import { useStore } from 'zustand';
import { useDeps } from '../context.js';

export function Toasts() {
  const { toasts } = useDeps();
  const list = useStore(toasts, (s) => s.toasts);
  const dismiss = useStore(toasts, (s) => s.dismiss);
  return (
    <div className="toasts pointer-events-none fixed inset-x-0 z-40 flex flex-col items-center gap-8 px-16" role="status" aria-live="polite">
      {list.map((t) => (
        <button
          type="button"
          key={t.id}
          className="pointer-events-auto max-w-480 rounded-btn border border-line bg-raised px-12 py-8 text-left type-small text-ink animate-fade"
          onClick={() => dismiss(t.id)}
          data-tone={t.tone}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}
