/**
 * The sentences the worker answers with and the popup shows (spec 3.8 to
 * 3.10), in one place. The page shows a ShotAnswer's `text` as its flash
 * and a stop `text` in its bubble; the popup shows a Done's `error` and a
 * PopupState's `sentence`. A sentence the daemon wrote (Meetings off, a cap,
 * the day's budget) is passed on as it came. No em dash, no exclamation
 * mark.
 */

export const NOT_RUNNING = 'Jantar is not running on this Mac.';
/** A 400 from a capture route: the extension and the daemon disagree on a body shape (spec 3.2). */
export const MISMATCH = "Jantar and this extension don't match. Build the extension again and press reload in chrome://extensions.";
export const PAIR_AGAIN = 'Pair again: jantar pair --extension';
export const BAD_CODE = 'That code is not right or has expired. Run the command again.';
/** The daemon's 404 on every capture route, for when it gave none. */
export const NOT_OPEN = 'This meeting is not open in Jantar any more. Start notes again from the Jantar icon.';
/** A meeting tab open before the extension was loaded or reloaded has no page script yet: Chrome adds it only on a load. */
export const NO_MEETING_TAB = 'Open a Google Meet or Teams call in this tab (reload it if the call is already open).';
export const JOIN_FIRST = 'Join the call first.';
/** Something in the extension itself went wrong (never expected). */
export const TRY_AGAIN = 'Something went wrong. Try again.';

/** A screenshot's answers, flashed next to the camera button. */
export const SHOT = Object.freeze({
  saved: 'Saved',
  joinFirst: 'Not saved: join the call first.',
  openTabFirst: 'Not saved: open the meeting tab first.',
  tooLarge: 'Not saved: the screenshot is too large.',
  /** No activeTab grant here and no `<all_urls>` (D1): the toolbar icon or the shortcut grants it. */
  allowHere: 'Click the Jantar icon once to allow screenshots here.',
  chromeFailed: 'Not saved: Chrome could not take it.',
  notRunning: 'Not saved: Jantar is not running on this Mac.',
  pairAgain: 'Not saved: pair again: jantar pair --extension',
  tryAgain: 'Not saved: try again.',
});

/** "Not saved: <the daemon's sentence>". */
export const notSaved = (sentence: string): string => `Not saved: ${sentence}`;
