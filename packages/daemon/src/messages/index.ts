/**
 * Messages (0.15): the owner's WhatsApp, WhatsApp calls and iPhone call log,
 * read on his Mac through jantar-messages-reader (the one program that opens
 * WhatsApp's files), for the phone, the CLI and `jantar mcp`.
 *
 * `createMessagesService` is the part daemon.ts wires (Factories['messages'],
 * plus `{ readOnly }`: under --read-only reads and the skip list work, the
 * morning run never runs). service.ts is the part; reader-client.ts the
 * reader's socket (reader-protocol.ts its protocol); db.ts messages.db;
 * skip.ts the skip list and its mirror; media.ts a message's file; says.ts
 * the sentences; morning/ the morning run (collect.ts its batch, budget.ts
 * what fits, input.ts what the model reads).
 */
import type { DaemonContext, Factories, MessagesService } from '../contracts.js';
import { buildMessagesService, type MessagesDeps, type MessagesOptions } from './service.js';

export { MESSAGES_BROKEN_REASON, MESSAGES_MIGRATIONS, MESSAGES_SCHEMA_VERSION, READS_KEEP, openMessagesDb, type MessagesDb } from './db.js';
export { mediaAnswer, type ImageShrinker } from './media.js';
export { READER_TIMEOUT_MS, ReaderFailure, createReaderClient, type ReaderClient } from './reader-client.js';
export { MESSAGES_SAYS, cantRead, readerSays } from './says.js';
export { buildMessagesService, type MessagesDeps, type MessagesOptions } from './service.js';
export { SKIP_FILE, SKIP_FILE_VERSION, createSkipStore, type SkipStore } from './skip.js';

export function createMessagesService(ctx: DaemonContext, deps: MessagesDeps, opts: MessagesOptions = {}): MessagesService {
  return buildMessagesService(ctx, deps, opts);
}

// The part fits its Factories entry (the third argument is optional).
const _factory: Factories['messages'] = createMessagesService;
void _factory;
