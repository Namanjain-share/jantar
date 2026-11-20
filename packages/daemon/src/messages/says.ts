/**
 * What Messages says (0.15): fixed sentences, never a name, a number or a
 * message. The phone, the CLI and `jantar mcp` show them as they are.
 *
 * A reader failure the owner can fix is 503 messages_unavailable with one of
 * these (readerSays); `not_found` and `bad_request` are the caller's 404 and
 * 400 (api/routes/messages.ts says noChat, noFile, tooBig or badAsk).
 * `no_access` is told apart by the reader's fixed detail, which names the
 * file macOS refused (or that isn't there): WhatsApp's files don't need Full
 * Disk Access, so that sentence is only for what none of the others fit. An
 * answer the client couldn't check (READER_MISMATCH) is a reader of another
 * build: updateNeeded, never WhatsApp's `unsupported`.
 *
 * Also how someone else's name that reads as the owner's own mark shows
 * (NOT_OWNER), wherever Messages shows a sender.
 */
import { MESSAGES_LIMITS } from '@jantar/protocol';
import { CONTROL, LINE_END } from '../rewrite/guards.js';
import type { ReaderError } from './reader-protocol.js';

const MB = 1024 * 1024;

/** The reader client's detail for an answer that doesn't check: a reader of another build, so its sentence is updateNeeded. */
export const READER_MISMATCH = "the reader's answer doesn't check";

/** "Messages can't read WhatsApp right now: {reason}. At the Mac: jantar messages status" (Review Focus 5). */
export function cantRead(reason: string): string {
  return `Messages can't read WhatsApp right now: ${reason}. At the Mac: jantar messages status`;
}

export const MESSAGES_SAYS = {
  down: cantRead("the reader isn't running"),
  noAccess: "Messages can't read WhatsApp right now: Full Disk Access is missing for jantar-messages-reader. At the Mac: jantar messages setup",
  unsupported: 'This WhatsApp version stores chats differently; Messages needs an update.',
  updateNeeded: 'The reader changed in this release. At the Mac: jantar messages setup, then re-grant Full Disk Access.',
  skipRemoveMacOnly: 'Removing a chat from the skip list is done at the Mac: jantar messages skip remove <chat>',
  off: 'Messages is off. At the Mac: jantar messages on',
  // Status details.
  readerDown: "The reader isn't running. At the Mac: jantar messages setup (it restarts it); its errors are in ~/.jantar/logs/messages-reader.err.log",
  notInstalled: "The reader isn't set up on this Mac. At the Mac: jantar messages setup",
  noWhatsApp: "WhatsApp for Mac isn't on this Mac, or isn't linked to a phone yet.",
  contacts:
    "Messages can't read WhatsApp right now: WhatsApp's contact files (ContactsV2.sqlite, LID.sqlite) are missing or macOS refused them to the reader, and the skip list needs them. At the Mac: jantar messages setup",
  closed: 'WhatsApp is closed, and Messages reads nothing while it is. Open WhatsApp on the Mac.',
  skipBroken: "The skip list file won't read, so Messages reads nothing until it is written again (turn Messages off and on at the Mac).",
  skipLocked:
    "The skip list file (skip.json, in ~/.jantar/messages) won't open or isn't one Messages wrote, so Messages reads nothing and won't write over it. At the Mac: make it readable again, or move it aside and check jantar messages skip list.",
  skipUnsaved: "Messages couldn't save the skip list file's chats in messages.db (is the Mac's disk full?), so it reads nothing until it can. It tries again on each read.",
  saltLost:
    "The reader's salt (~/.jantar/messages/salt) is gone, so the skip list matches no chat and the reader won't start. At the Mac: jantar messages skip reset",
  skipResetLeft:
    "Chats skipped before the reader's salt was lost aren't all skipped again yet, so Messages reads nothing. At the Mac: jantar messages skip reset",
  skipResetNotNeeded: "The reader's salt is there, so the skip list still matches its chats: there is nothing to reset.",
  skipResetMacOnly: 'Resetting the skip list is done at the Mac: jantar messages skip reset',
  skipForgetFirst:
    "First run jantar messages skip reset: --forget lets go only of chats a reset looked for, with the reader running, and couldn't find.",
  // Answers.
  busy: cantRead('WhatsApp is busy or closed'),
  timeout: cantRead('WhatsApp took too long to answer'),
  noImage: cantRead("jantar-media couldn't shrink the image (it needs Command Line Tools)"),
  skipWrite: "The skip list couldn't be saved; nothing changed. At the Mac: jantar messages status",
  noMirror: cantRead("the skip list couldn't be written for the reader"),
  skipUnreadable: cantRead("the skip list file won't open or isn't one Messages wrote, and Messages won't write over it"),
  // no_access, by what the reader's detail names.
  noWhatsAppHere: cantRead("WhatsApp for Mac isn't on this Mac, or isn't signed in"),
  phoneLog:
    "Messages can't read the iPhone call log: Full Disk Access isn't granted to jantar-messages-reader, or this Mac has no iPhone call log. At the Mac: jantar messages setup",
  // media.ts's own failures.
  imageJob: cantRead("the image couldn't be made ready to show on this Mac"),
  notInSpool: cantRead('the reader handed over a file from outside its spool, so it was left alone'),
  notAChat: 'No chat with that id (it may be skipped already, or gone).',
  // A skip done while life.db was closed (the skip's own answer, MessagesSkipAddReply `note`). life.db stays open once it
  // opened (every Life module turned off since included), so closed is: never opened since the daemon started, or
  // broken. "Any": while Life is closed nobody can tell whether one is still open, or all are done.
  skipTodosLater:
    "Life isn't open right now (every Life module and People have been off since Jantar started, or Life needs attention), so any open todos and call-backs the morning made from this chat leave Life once it opens.",
  notSkipped: "That chat isn't on the skip list.",
  // Calls to return: a call list left out (as the morning run's report says).
  waCallsUnread: "WhatsApp's calls weren't read, so missed WhatsApp calls aren't listed.",
  phoneCallsUnread: "The iPhone call log wasn't read (it needs Full Disk Access on the reader), so missed phone calls aren't listed.",
  // The routes' 404 and 400 (a skipped chat or sender is told as one that isn't there).
  noChat: 'No chat with that name or id.',
  noFile: 'No file for that message on this Mac.',
  tooBig: `That file is over ${MESSAGES_LIMITS.mediaMaxBytes / MB} MB, too large to show.`,
  badAsk: "The reader couldn't take that request.",
  // The morning run.
  noRun: 'No such morning run.',
  noDraft: 'No such reply draft.',
  badPrefs: 'A time is HH:MM, or none to turn it off.',
  morningBusy: 'A morning run is going. Wait for it to finish.',
  morningReadOnly: 'The morning run is off while Jantar is read-only.',
  morningNoClaude: 'The morning run needs Claude Code on this Mac.',
  morningNoAccount: 'No Claude account has room for the morning run right now. Try again later.',
  morningUnreadable: "Claude's answer couldn't be used, so nothing was made. Try again.",
  morningNotIsolated: 'The morning run stopped: Claude could not run in its safe mode on this Mac. Check it at the Mac: jantar doctor',
  morningStopped: 'The morning run was stopped before it finished.',
  morningTooLong: 'Claude took too long to answer. Try again.',
  morningRestarted: 'The morning run stopped before it finished: Jantar restarted, or Messages was turned off.',
  morningFailed: "The morning run didn't work. Try again.",
  morningSkipped: 'A chat was skipped while the morning run was going, so it stopped and made nothing. Run it again.',
} as const;

/**
 * Words of the reader's fixed `no_access` details (jantar-messages-reader.swift:
 * "<file> isn't there: is WhatsApp for Mac installed and signed in?",
 * "macOS refused <file> to the reader", "the iPhone call log isn't on this
 * Mac", "<contact file> isn't there, and the skip list needs it"), matched
 * only to pick a sentence; a detail is never shown.
 */
const NOT_THERE = "isn't there";
const CONTACT_FILES = ['ContactsV2.sqlite', 'LID.sqlite'] as const;
const PHONE_LOG = 'iPhone call log';

function noAccessSays(detail: string | undefined): string {
  if (detail?.includes(PHONE_LOG)) return MESSAGES_SAYS.phoneLog;
  if (detail && CONTACT_FILES.some((f) => detail.includes(f))) return MESSAGES_SAYS.contacts;
  if (detail?.includes(NOT_THERE)) return MESSAGES_SAYS.noWhatsAppHere;
  return MESSAGES_SAYS.noAccess;
}

/** The sentence for a reader failure the owner can fix (503), or null for the caller's own 404 or 400. `detail`: the reader's, for `no_access`; READER_MISMATCH for `unsupported`. */
export function readerSays(code: ReaderError | 'down', detail?: string): string | null {
  switch (code) {
    case 'down':
      return MESSAGES_SAYS.down;
    case 'no_access':
      return noAccessSays(detail);
    case 'unsupported':
      // An answer the client couldn't check is a reader of another build, not WhatsApp's layout.
      return detail === READER_MISMATCH ? MESSAGES_SAYS.updateNeeded : MESSAGES_SAYS.unsupported;
    case 'busy':
      return MESSAGES_SAYS.busy;
    case 'timeout':
      return MESSAGES_SAYS.timeout;
    case 'not_found':
    case 'bad_request':
    case 'skipped':
      return null;
  }
}

/** How the owner's own lines are signed where a name would be (the morning input, beside its by_user mark). */
export const OWNER_NAME = 'me';
/** Anyone else's name that reads as OWNER_NAME, as Messages shows it everywhere (the morning input, `jantar mcp`, the CLI). */
export const NOT_OWNER = `${OWNER_NAME} (another person)`;
/** Characters that show as nothing: a name with them still reads as what is left. */
const UNSEEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Whether someone else's name reads as OWNER_NAME: any case or width, hidden
 * characters or spaces around it. Line ends and control characters go first,
 * as every place that shows a name takes them out (chat/text.ts line(), the
 * morning input's dataName, the CLI's cleanData): "M\u0001e" shows as "Me".
 */
export function readsAsOwner(name: string): boolean {
  const shown = name.replace(LINE_END, ' ').replace(CONTROL, '');
  return shown.normalize('NFKC').replace(UNSEEN, '').trim().toLowerCase() === OWNER_NAME;
}
