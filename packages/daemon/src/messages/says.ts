/**
 * What Messages says (0.15): fixed sentences, never a name, a number or a
 * message. The phone, the CLI and `jantar mcp` show them as they are.
 *
 * A reader failure the owner can fix is 503 messages_unavailable with one of
 * these (readerSays); `not_found` and `bad_request` are the caller's 404 and
 * 400 (api/routes/messages.ts says noChat, noFile, tooBig or badAsk).
 * `no_access` is told apart by the reader's fixed detail, which names the
 * file macOS refused (or that isn't there): WhatsApp's files don't need Full
 * Disk Access, so that sentence is only for what none of the others fit.
 */
import { MESSAGES_LIMITS } from '@jantar/protocol';
import type { ReaderError } from './reader-protocol.js';

const MB = 1024 * 1024;

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
  notInstalled: "The reader isn't set up on this Mac. At the Mac: jantar messages setup",
  noWhatsApp: "WhatsApp for Mac isn't on this Mac, or isn't linked to a phone yet.",
  contacts: "Messages can't read WhatsApp right now: macOS refused WhatsApp's contact files (ContactsV2.sqlite, LID.sqlite) to the reader. At the Mac: jantar messages setup",
  closed: 'WhatsApp is closed: open it on the Mac so Messages can read the newest messages.',
  skipBroken: "The skip list file won't read, so Messages reads nothing until it is written again (turn Messages off and on at the Mac).",
  skipLocked: "The skip list file (skip.json, in ~/.jantar/messages) won't open, so Messages reads nothing and won't write over it: make it readable again at the Mac.",
  // Answers.
  busy: cantRead('WhatsApp is busy or closed'),
  timeout: cantRead('WhatsApp took too long to answer'),
  noImage: cantRead("jantar-media couldn't shrink the image (it needs Command Line Tools)"),
  skipWrite: "The skip list couldn't be saved; nothing changed. At the Mac: jantar messages status",
  noMirror: cantRead("the skip list couldn't be written for the reader"),
  skipUnreadable: cantRead("the skip list file won't open, and Messages won't write over it"),
  // no_access, by what the reader's detail names.
  noWhatsAppHere: cantRead("WhatsApp for Mac isn't on this Mac, or isn't signed in"),
  phoneLog:
    "Messages can't read the iPhone call log: Full Disk Access isn't granted to jantar-messages-reader, or this Mac has no iPhone call log. At the Mac: jantar messages setup",
  // media.ts's own failures.
  imageJob: cantRead("the image couldn't be made ready to show on this Mac"),
  notInSpool: cantRead('the reader handed over a file from outside its spool, so it was left alone'),
  notAChat: 'No chat with that id (it may be skipped already, or gone).',
  notSkipped: "That chat isn't on the skip list.",
  // The routes' 404 and 400 (a skipped chat or sender is told as one that isn't there).
  noChat: 'No chat with that name or id.',
  noFile: 'No file for that message on this Mac.',
  tooBig: `That file is over ${MESSAGES_LIMITS.mediaMaxBytes / MB} MB, too large to show.`,
  badAsk: "The reader couldn't take that request.",
} as const;

/**
 * Words of the reader's fixed `no_access` details (jantar-messages-reader.swift:
 * "<file> isn't there: is WhatsApp for Mac installed and signed in?",
 * "macOS refused <file> to the reader", "the iPhone call log isn't on this
 * Mac"), matched only to pick a sentence; a detail is never shown.
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

/** The sentence for a reader failure the owner can fix (503), or null for the caller's own 404 or 400. `detail`: the reader's, for `no_access`. */
export function readerSays(code: ReaderError | 'down', detail?: string): string | null {
  switch (code) {
    case 'down':
      return MESSAGES_SAYS.down;
    case 'no_access':
      return noAccessSays(detail);
    case 'unsupported':
      return MESSAGES_SAYS.unsupported;
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
