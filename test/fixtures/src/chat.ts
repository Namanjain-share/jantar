/**
 * Chat fixtures (v0.10): the fake claude's Chat modes
 * (runtime/fake-claude-chat.mjs, CHAT_MODES), what each run called, and a
 * marker to plant in what Chat reads (Life, Intel, meetings, transcripts):
 * it may come back in the owner's own thread, never in an event, an audit
 * row, a log line or a write reply.
 *
 *   await post('/v1/chat', { text: chatText('chat-write', 'rate my café') });
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FakeHome } from './home.js';
import { makePng } from '../runtime/images.mjs';

/** A generated PNG (runtime/images.mjs) for a chat photo: flat, or noise that won't compress. */
export { makePng };

/** Planted in Life, Intel, meetings and transcripts for the Chat privacy sweep. */
export const CHAT_MARKER = 'SYNTHETIC-CHAT-TEXT-DO-NOT-LOG';

export const CHAT_SCENARIOS = [
  'chat-read',
  'chat-write',
  'chat-delete',
  'chat-taint',
  'chat-link',
  'chat-bypass',
  'chat-flood',
  'chat-init-bash',
  'chat-init-nomcp',
  'chat-photos',
  'chat-slow',
  'chat-marker',
  'chat-refuse-option',
  'chat-person',
] as const;
export type ChatScenario = (typeof CHAT_SCENARIOS)[number];

/** A message that picks `scenario` (the fake reads the `FAKE_CHAT:<name>` marker), with `text` after it. */
export function chatText(scenario: ChatScenario, text = ''): string {
  return `FAKE_CHAT:${scenario} ${text}`.trim();
}

/** One tool call the fake made, as the run's server answered it. */
export interface ChatToolCall {
  /** The tool's short name (no mcp__jantar__ prefix). */
  name: string;
  input: Record<string, unknown>;
  isError: boolean;
  text: string;
}

/** One Chat run as the fake saw it. */
export interface ChatRun {
  scenario: ChatScenario;
  calls: ChatToolCall[];
  /** Tools it did not call because they were not in --allowedTools. */
  denials: Array<{ tool_name: string }>;
  images: number;
  /** The <message> block it read. */
  message: string;
  ts: number;
}

/** Every Chat run so far, oldest first (<root>/calls/claude-chat.jsonl). */
export async function chatRuns(home: Pick<FakeHome, 'root'>): Promise<ChatRun[]> {
  try {
    const raw = await readFile(join(home.root, 'calls', 'claude-chat.jsonl'), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ChatRun);
  } catch {
    return [];
  }
}
