/**
 * Drafts (0.12, build plan 1.7): what was typed into a composer, kept by key
 * past a remount, so leaving a place and coming back, or a reload of the tab,
 * finds it as it was.
 *
 *   s:<sid>            a session's prompt (session/sends.ts) and its chips
 *   chat               Chat's box and its photo chips
 *   new:<root>:<path>  New session's first prompt, and aside its Name,
 *                      account and picks (the form is built again when it
 *                      moves between the pane and the sheet)
 *   post:<id>:comment  a post's comment (c21)
 *
 * The text is mirrored to sessionStorage, a per-viewer convenience: it can
 * be missing or throw (private mode, blocked site data), and then the
 * module's Map alone keeps it for the page's life. Anything else (the chips:
 * uploads already on the Mac, their thumbnails) is kept in memory only
 * (`aside`). A draft is cleared when the Mac accepts what it held.
 */
import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

const PREFIX = 'jantar:draft:';
const texts = new Map<string, string>();
const asides = new Map<string, unknown>();

function store(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

export function getDraft(key: string): string {
  const kept = texts.get(key);
  if (kept !== undefined) return kept;
  try {
    return store()?.getItem(PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

export function setDraft(key: string, text: string): void {
  texts.set(key, text);
  try {
    if (text) store()?.setItem(PREFIX + key, text);
    else store()?.removeItem(PREFIX + key);
  } catch {
    // The Map keeps it.
  }
}

/** The text and anything kept aside for `key`. */
export function clearDraft(key: string): void {
  setDraft(key, '');
  asides.delete(key);
}

/** What `key` keeps in memory beside its text (never stored). */
export function getAside<T>(key: string): T | undefined {
  return asides.get(key) as T | undefined;
}

export function setAside(key: string, value: unknown): void {
  if (value === undefined) asides.delete(key);
  else asides.set(key, value);
}

/** Forget every draft: the tests do after each one. */
export function forgetDrafts(): void {
  texts.clear();
  asides.clear();
  try {
    const s = store();
    if (!s) return;
    for (const k of Object.keys(s)) if (k.startsWith(PREFIX)) s.removeItem(k);
  } catch {
    // nothing kept there
  }
}

/**
 * A text field's value kept as `key`'s draft: starts from the draft (or
 * `initial` when there is none) and writes every change through.
 */
export function useDraft(key: string, initial = ''): [string, Dispatch<SetStateAction<string>>] {
  const [kept, setKept] = useState(() => ({ key, text: getDraft(key) || initial }));
  // Another key (another folder for New session): its own draft.
  const current = kept.key === key ? kept : { key, text: getDraft(key) || initial };
  if (current !== kept) setKept(current);
  // Stable, like useState's setter (effects list it).
  const set = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setKept((s) => {
      const text = typeof next === 'function' ? next(s.text) : next;
      setDraft(s.key, text);
      return { key: s.key, text };
    });
  }, []);
  return [current.text, set];
}
