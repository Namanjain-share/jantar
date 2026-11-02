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
/** v0.10: Start when I join, on a page that shows no join screen, waiting room or call. */
export const JOIN_SCREEN_FIRST = "Open the call's join screen first.";
/** v0.10: why notes did not start by themselves with no key stored. */
export const PAIR_FIRST = 'pair the extension first: click the Jantar icon.';
/** Something in the extension itself went wrong (never expected). */
export const TRY_AGAIN = 'Something went wrong. Try again.';

/** A screenshot's answers, flashed next to the camera button. */
export const SHOT = Object.freeze({
  saved: 'Saved',
  joinFirst: 'Not saved: join the call first.',
  openTabFirst: 'Not saved: open the meeting tab first.',
  tooLarge: 'Not saved: the screenshot is too large.',
  /** No activeTab grant here and no `<all_urls>` (D1): the toolbar icon or the shortcut grants it. A failure, so it says "Not saved" too (v0.5.3). */
  allowHere: 'Not saved: click the Jantar icon once in this tab, then try again.',
  chromeFailed: 'Not saved: Chrome could not take it.',
  notRunning: 'Not saved: Jantar is not running on this Mac.',
  pairAgain: 'Not saved: pair again: jantar pair --extension',
  tryAgain: 'Not saved: try again.',
});

/** "Not saved: <the daemon's sentence>". */
export const notSaved = (sentence: string): string => `Not saved: ${sentence}`;

/** v0.8: Read saved links, in the popup's words. */
export const READS = Object.freeze({
  title: 'Read saved links',
  why: 'Opens posts you save to Intel (Instagram, YouTube, TikTok, X, Reddit, LinkedIn) in a muted background tab, as you, reads the post and closes the tab. Post links only, never other pages.',
  denied: "Chrome didn't allow the post sites, so Read saved links stays off.",
});

/** v0.10: Start when I join, in the popup's words. */
export const ARM = Object.freeze({
  button: 'Start when I join',
  leadPrejoin: 'Not in the call yet.',
  leadLobby: 'Waiting to be let in.',
  leadLeft: 'You left the call.',
  hint: 'Notes start by themselves once you are in the call, only in this tab.',
  armedPrejoin: 'Armed: starts when you join',
  armedLobby: "Armed: starts when you're let in",
  armedLeft: 'Armed: starts when you rejoin',
  nameFromPage: 'Name from the page',
  noProject: 'No project',
  byAlways: 'Always start when I join a call is on (Settings).',
  change: 'Change',
  cancel: 'Cancel',
  notThisCall: 'Not this call',
  where: "Start when I join shows on the call's join screen or in its waiting room.",
  startedAt: (clock: string) => `Started when you joined, ${clock}`,
  failed: (why: string) => `Notes did not start when you joined: ${why}`,
});

/** v0.10: Settings › Always start when I join a call, and the page's bubble when it arms a call. */
export const ALWAYS = Object.freeze({
  title: 'Always start when I join a call',
  why: 'Notes start by themselves in every Meet or Teams call you join in this Chrome, once you are in the call, never before. Skip one with Not this call. Let people know you keep notes.',
  armedBubble: 'Jantar starts notes when you join. Not this call: the Jantar icon.',
});

/** v0.10: why notes did not start by themselves in a call another tab already keeps notes for. */
export const OTHER_TAB = 'they are already on for this call in another tab.';

/** v0.10: what the page says when notes start by themselves, or do not. */
export const AUTO = Object.freeze({
  started: 'Jantar started notes. Let people know you keep notes.',
  notStarted: (why: string) => `Notes did not start: ${why}`,
  retrying: 'Notes did not start: Jantar is not running on this Mac. Trying again for 2 minutes.',
  otherTab: `Notes did not start: ${OTHER_TAB}`,
  lost: "Notes will not start by themselves: Jantar can't see this call's join screen or the call.",
});

/** v0.10: Settings › Call check: what the page shows, in words, and the hook id that decided it. */
export const CALL_CHECK = Object.freeze({
  none: 'no join screen or call',
  prejoin: 'join screen',
  lobby: 'waiting to be let in',
  in: 'in the call',
  left: 'left the call',
  line: (stage: string, hook: string) => `Call check: ${stage}${hook ? ` · ${hook}` : ''}`,
});
