/**
 * v0.10 Chat (replaces v0.5.3's Ask): one thread per Mac, a headless Claude
 * run with Jantar's own tools over one strict MCP server, direct writes with
 * Undo, deletes and irreversible actions as Confirm cards, photos, and the
 * Siri door's voice turns. Sessions are read only.
 *
 * `createChatService` is the part daemon.ts wires (Factories['chat'], plus
 * `{ readOnly }`: under --read-only the list says so and nothing runs).
 * service.ts holds the queue and the run; dispatcher.ts the per-run MCP
 * server behind assets/chat/bridge.mjs; tools.ts, actions.ts and taps.ts
 * the tools, the journal and the taps; store.ts, db.ts and photos.ts what
 * is kept on disk; input.ts and text.ts the run's input and the reply.
 */
import type { DaemonContext, Factories } from '../contracts.js';
import { buildChatService, type ChatOptions } from './service.js';
import type { ChatDeps } from './types.js';

export { CHAT_BROKEN_REASON, openChatDb } from './db.js';
export { CHAT_PROMPT_ASSET, CHAT_PROMPT_VERSION, CHAT_SENTENCES, buildChatService, type ChatOptions } from './service.js';
export { CHAT_TOOLS, toolsFor } from './tools.js';
export type { ChatDeps } from './types.js';

/** The Chat part (Factories['chat'] plus the daemon's mode). */
export function createChatService(ctx: DaemonContext, deps: ChatDeps, opts: ChatOptions = {}): ReturnType<Factories['chat']> {
  return buildChatService(ctx, deps, opts);
}
