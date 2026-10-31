/**
 * Fallback for closing a card from the transcript: pressing Esc at the
 * terminal dialog can write a `tool_result` for the call without firing any
 * completion hook. While a main-conversation card is open, its transcript is
 * read forward (bounded) and the card is closed when a `tool_result` shows up
 * for its tool call.
 *
 * The call is found by tool_use_id (cached at PreToolUse) or, failing that,
 * by a `tool_use` block whose name + input give the card's correlation key.
 * Results that were already in the file when the card opened belong to an
 * earlier identical call and are ignored.
 */
import type { Clock, Logger, TimerId, TranscriptEntry, TranscriptReader } from '../contracts.js';
import { cardKey, isPlainObject } from './keys.js';

/** How far back to look for the card's tool_use block when its id is not known. */
export const TOOL_RESULT_BACKSCAN_BYTES = 256 * 1024;
const READ_MAX_BYTES = 1024 * 1024;

interface Watch {
  cardId: string;
  sid: string;
  key: string;
  path: string;
  ready: boolean;
  /** File size when the card opened: results before this offset are older. */
  openSize: number;
  cursor: number;
  ids: Set<string>;
  preResolved: Set<string>;
}

export interface ToolResultWatcherOptions {
  clock: Clock;
  transcripts: TranscriptReader;
  log: Logger;
  pollMs: number;
  onToolResult(cardId: string): void;
}

export class ToolResultWatcher {
  private readonly watches = new Map<string, Watch>();
  private timer: TimerId | undefined;
  private polling = false;
  private stopped = false;

  constructor(private readonly opts: ToolResultWatcherOptions) {}

  get size(): number {
    return this.watches.size;
  }

  /** Start watching for `cardId`. Resolves once the open-time offset is known. */
  async watch(cardId: string, sid: string, key: string, path: string, toolUseId?: string): Promise<void> {
    if (this.stopped || this.opts.pollMs <= 0) return;
    const w: Watch = { cardId, sid, key, path, ready: false, openSize: 0, cursor: 0, ids: new Set(), preResolved: new Set() };
    if (toolUseId) w.ids.add(toolUseId);
    this.watches.set(cardId, w);
    let size: number;
    try {
      size = await this.opts.transcripts.size(path);
    } catch (e) {
      this.opts.log.debug('hooks: transcript size failed; tool_result fallback off for this card', { error: String(e) });
      this.unwatch(cardId);
      return;
    }
    if (this.watches.get(cardId) !== w) return;
    w.openSize = size;
    w.cursor = Math.max(0, size - TOOL_RESULT_BACKSCAN_BYTES);
    w.ready = true;
    this.ensureTimer();
  }

  addToolUseId(cardId: string, id: string): void {
    const w = this.watches.get(cardId);
    if (w && !w.preResolved.has(id)) w.ids.add(id);
  }

  unwatch(cardId: string): void {
    this.watches.delete(cardId);
    if (this.watches.size === 0 && this.timer !== undefined) {
      this.opts.clock.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Allow watching again after stop() (the bridge was restarted). */
  resume(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    this.watches.clear();
    this.opts.clock.clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass over every watched card (exposed for tests). */
  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      for (const w of [...this.watches.values()]) {
        if (!w.ready || this.watches.get(w.cardId) !== w) continue;
        let res: { entries: TranscriptEntry[]; next: number };
        try {
          res = await this.opts.transcripts.readFrom(w.path, w.cursor, { maxBytes: READ_MAX_BYTES });
        } catch (e) {
          this.opts.log.debug('hooks: transcript read failed', { error: String(e) });
          continue;
        }
        if (this.stopped || this.watches.get(w.cardId) !== w) continue;
        if (res.next >= w.cursor) w.cursor = res.next;
        let hit = false;
        for (const e of res.entries) {
          if (scanEntry(w, e)) {
            hit = true;
            break;
          }
        }
        if (hit) {
          this.unwatch(w.cardId);
          try {
            this.opts.onToolResult(w.cardId);
          } catch (e) {
            this.opts.log.error('hooks: tool_result handler threw', { error: String(e) });
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private ensureTimer(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.timer = this.opts.clock.setInterval(() => {
      void this.poll();
    }, this.opts.pollMs);
  }
}

function contentBlocks(e: TranscriptEntry): unknown[] {
  const msg = e.raw.message;
  if (!isPlainObject(msg)) return [];
  return Array.isArray(msg.content) ? msg.content : [];
}

/** True when `e` carries the tool_result of the watched call. */
function scanEntry(w: Watch, e: TranscriptEntry): boolean {
  if (e.isSidechain) return false;
  if (e.type === 'assistant') {
    for (const b of contentBlocks(e)) {
      if (!isPlainObject(b) || b.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue;
      if (w.preResolved.has(b.id)) continue;
      if (cardKey(w.sid, b.name, b.input) === w.key) w.ids.add(b.id);
    }
    return false;
  }
  if (e.type === 'user') {
    for (const b of contentBlocks(e)) {
      if (!isPlainObject(b) || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      if (e.offset < w.openSize) {
        w.preResolved.add(b.tool_use_id);
        w.ids.delete(b.tool_use_id);
      } else if (w.ids.has(b.tool_use_id)) {
        return true;
      }
    }
  }
  return false;
}
