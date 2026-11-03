/**
 * Keyboard (direction.md 5.9; 0.12, build plan 3.1). The shell owns the
 * global keys; screens add their own (j/k, Enter, a, d, r, 1-9) with useKey,
 * which skips keys typed into fields and keys with modifiers.
 *
 * 0.12: keys work at every width once a hardware keyboard has been seen
 * (shell/layout.ts `keyboard`: a Mac from the start, an iPad once
 * lib/input.ts has seen one), not only from 768 px.
 *
 *   ⌘K           the palette (⌃K too, but only outside a field: on Apple
 *                platforms ⌃K deletes to the end of the line)
 *   ⌘1 … ⌘9      the places, fixed (nav.ts CMD_PLACES): Board, Today, Chat,
 *                Files, Accounts, Alerts, Devices, Intel, Meetings (a place
 *                that is off says so; matched on event.code, like every digit
 *                with a modifier: ⌥1 types ¡ on Apple layouts)
 *   ⌘.           Esc, for keyboards without one (the iPad's system Escape)
 *   ⌘\           the touch sidebar: fold it to the rail, or show it over
 *                the rail (c24)
 *   ⌘J           Chat beside this screen, its composer focused (c28; the
 *                phone opens the Chat tab)
 *   g then b t c l a d i m f   Board, Today, Chat, Alerts, Accounts,
 *                Devices, Intel, Meetings, Files (0.13.0: w, Work)
 *   ⌘Z           outside a field, the Undo on screen (c30): the newest
 *                Undo line, or in Chat the newest undoable change of the
 *                newest turn; never a change you can't see
 *   /            the place's search field (c30)
 *   c            the place's new item (c30): its [data-new] control
 *   ?            the shortcuts and the legend (shell/Shortcuts.tsx, c30)
 *
 * In a text field only ⌘K, ⌘J, ⌘1-⌘9, ⌘\, ⌘. and Esc reach the shell;
 * everything a field uses stays with the field:
 * ⌘A, ⌘C, ⌘V, ⌘X, ⌘Z, ⌘ or ⌥ with an arrow, ⌘⌫ and every ⌃ chord.
 */
import { useEffect, useRef } from 'react';

/** True when the key went to a text field, where single letters are typing. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

/**
 * The digit a key with a modifier means, from `event.code` (Digit1, Numpad1),
 * since `event.key` is whatever the layout types: ⌥1 is ¡ on a Mac.
 */
export function digitOf(e: Pick<KeyboardEvent, 'code' | 'key'>): number | null {
  const m = /^(?:Digit|Numpad)(\d)$/.exec(e.code ?? '');
  if (m) return Number(m[1]);
  return /^\d$/.test(e.key) ? Number(e.key) : null;
}

/** Call `fn` on a plain key press (no modifiers, not while typing). */
export function useKey(key: string | readonly string[], fn: (e: KeyboardEvent) => void, enabled = true): void {
  const cb = useRef(fn);
  cb.current = fn;
  const keys = typeof key === 'string' ? [key] : key;
  const sig = keys.join('\u0000');
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const list = sig.split('\u0000');
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (list.includes(e.key)) cb.current(e);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [sig, enabled]);
}

/** The g chords: g then a letter. */
export const G_ROUTES: Record<string, string> = {
  b: '/',
  t: '/today',
  c: '/chat',
  l: '/alerts',
  a: '/accounts',
  d: '/devices',
  i: '/intel',
  m: '/meetings',
  f: '/files',
  // 0.13.0: Work has no ⌘ number (CMD_PLACES keeps 0.12's nine).
  w: '/work',
};

/** A modal over the screen (a sheet, the palette, a menu): the page's own keys wait. */
export function dialogOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

const usable = (el: HTMLElement) => !(el as HTMLButtonElement).disabled && !el.closest('[hidden], [inert], [aria-hidden="true"]');

/**
 * What ⌘Z undoes (ipad-design.md 4.3): only a change shown on screen. Over a sheet, the sheet's own Undo
 * line. With the focus in Chat (the place or the panel), the newest undoable change of the newest turn.
 * Otherwise the newest Undo line on screen. Null when there is none: ⌘Z then does nothing.
 */
export function undoOnScreen(active: Element | null): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
  const over = dialogs[dialogs.length - 1];
  if (over) return [...over.querySelectorAll<HTMLElement>('[data-undo="line"]')].filter(usable).pop() ?? null;
  const chat = active?.closest('[data-pane="chat"], [data-chat-dock]');
  if (chat) {
    const turns = chat.querySelectorAll('[data-turn]');
    const newest = turns[turns.length - 1];
    return newest ? ([...newest.querySelectorAll<HTMLElement>('[data-undo="change"]')].filter(usable).pop() ?? null) : null;
  }
  return [...document.querySelectorAll<HTMLElement>('[data-undo="line"]')].filter(usable).pop() ?? null;
}

/** The place's search field (Cafés, Intel, Meetings, Chat's history): `/` focuses it. */
function searchField(active: Element | null): HTMLInputElement | null {
  const inDock = active?.closest('[data-chat-dock]');
  const scope = inDock ?? document.getElementById('main');
  return [...(scope?.querySelectorAll<HTMLInputElement>('input[type="search"]') ?? [])].find(usable) ?? null;
}

/**
 * Esc for ⌘.: the same keydown a real Esc sends, to the same element, so
 * every sheet, menu, popover and pane that closes on Esc closes on ⌘. too.
 */
function escapeFrom(target: EventTarget | null): void {
  const el = target instanceof Element ? target : document.activeElement ?? document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
}

export function useGlobalKeys({
  enabled,
  onPalette,
  onLegend,
  navigate,
  onPlace,
  onSidebar,
  onChat,
}: {
  enabled: boolean;
  onPalette: () => void;
  onLegend: () => void;
  navigate: (to: string) => void;
  /** ⌘1 … ⌘9: the place with that number (shell/nav.ts CMD_PLACES). */
  onPlace?: (n: number) => void;
  /** ⌘\: the touch sidebar. */
  onSidebar?: (() => void) | undefined;
  /** ⌘J: Chat beside this screen (c28). */
  onChat?: (() => void) | undefined;
}): void {
  const h = useRef({ onPalette, onLegend, navigate, onPlace, onSidebar, onChat });
  h.current = { onPalette, onLegend, navigate, onPlace, onSidebar, onChat };
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    let gAt = 0;
    const on = (e: KeyboardEvent) => {
      const typing = isTyping(e.target);
      const k = e.key.toLowerCase();
      // ⌘K anywhere; ⌃K only outside a field (it deletes to the end of the line there).
      if (!e.altKey && k === 'k' && (e.metaKey || (e.ctrlKey && !typing))) {
        e.preventDefault();
        h.current.onPalette();
        return;
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === '.') {
          e.preventDefault();
          escapeFrom(e.target);
          return;
        }
        if ((e.key.toLowerCase() === 'j' || e.code === 'KeyJ') && !e.shiftKey && h.current.onChat) {
          e.preventDefault();
          h.current.onChat();
          return;
        }
        if ((e.key === '\\' || e.code === 'Backslash') && h.current.onSidebar) {
          e.preventDefault();
          h.current.onSidebar();
          return;
        }
        const n = digitOf(e);
        if (n !== null && n >= 1 && h.current.onPlace) {
          e.preventDefault();
          h.current.onPlace(n);
          return;
        }
      }
      // ⌘Z outside a field: the Undo on screen, if there is one (a field keeps its own ⌘Z).
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (k === 'z' || e.code === 'KeyZ') && !typing) {
        const undo = undoOnScreen(document.activeElement);
        if (undo) {
          e.preventDefault();
          undo.click();
        }
        return;
      }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing) return;
      if (e.key === '/' && !dialogOpen()) {
        const field = searchField(document.activeElement);
        if (field) {
          e.preventDefault();
          field.focus();
          field.select();
        }
        return;
      }
      if (e.key === 'c' && !(gAt && Date.now() - gAt < 900) && !dialogOpen()) {
        const add = [...(document.getElementById('main')?.querySelectorAll<HTMLElement>('[data-new]') ?? [])].find(usable);
        if (add) {
          e.preventDefault();
          add.click();
        }
        return;
      }
      if (gAt && Date.now() - gAt < 900) {
        gAt = 0;
        const to = G_ROUTES[e.key];
        if (to) {
          e.preventDefault();
          h.current.navigate(to);
        }
        return;
      }
      if (e.key === 'g') {
        gAt = Date.now();
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        h.current.onLegend();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [enabled]);
}
