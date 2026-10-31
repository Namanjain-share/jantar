/**
 * "Ask about this" (v0.3 Files viewer): put a mention such as
 * "@src/auth/session.ts:12-20 " into a session's composer. Never sends: the
 * user still taps Send.
 *
 * The text is handed over in memory, never through the URL, so a link
 * cannot pre-type a prompt. Inside the session screen the Files tab calls
 * its `onAsk` prop; from the Files place, call `askAbout(sid, text)` and
 * then navigate to the session, which takes the text once on open.
 */
let pending: { sid: string; text: string } | null = null;

/** Queue `text` for the session's composer (replaces anything queued before). */
export function askAbout(sid: string, text: string): void {
  pending = { sid, text };
}

/** The text queued for `sid`, once; null when there is none. */
export function takeAsk(sid: string): string | null {
  if (!pending || pending.sid !== sid) return null;
  const { text } = pending;
  pending = null;
  return text;
}
