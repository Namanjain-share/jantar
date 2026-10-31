/**
 * Class strings the control bar's parts share, so the chip looks the same
 * before its menu has loaded (the Suspense fallback) and after.
 */

/** The mode chip: a 3 px chip with a --line-strong outline. Sans, since it is a button and not data. */
export const CHIP =
  'inline-flex h-32 max-w-full flex-none items-center gap-6 rounded-chip border border-line-strong px-8 text-small font-medium text-ink ' +
  'transition-colors duration-120 ease-hover hover:not-disabled:bg-hover disabled:cursor-default disabled:border-line disabled:text-ink-3 coarse:h-44';

/** A desktop popover menu: --raised with the one shadow (as the Alerts mute menu). */
export const MENU_POPUP = 'min-w-224 max-w-320 rounded-btn bg-raised py-4 text-ink shadow-float outline-none animate-pop';

/** A row in a menu; 44 px under a coarse pointer. */
export const MENU_ITEM =
  'flex min-h-32 cursor-pointer select-none items-center gap-8 px-12 py-6 text-small text-ink outline-none transition-colors duration-120 ease-hover ' +
  'data-highlighted:bg-select data-disabled:cursor-default data-disabled:text-ink-3 coarse:min-h-44';
