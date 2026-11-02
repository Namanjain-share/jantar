/**
 * What Chat holds (spec 0.10 B7.4): Life, Intel's list, get, read, remove,
 * reread and jobs, Meetings' library, summaries, status and broken, a
 * read-only view of the board (its state and transcript pages), usage,
 * ccw's read-only view, the Web Push sender. Never the writer, the
 * terminal, the launcher, hooks' decide, controls, session uploads, Files,
 * the settings store's write side, devices or keys:
 * arch/v010-chat.test.ts pins it by reading the source.
 */
import type { State } from '@jantar/protocol';
import type { CcwLegacySource, IntelService, LifeService, MeetingsService, Notifier, TranscriptReader, UsageSource } from '../contracts.js';

/** The board, read only: the store's state and a session's transcript pages. Nothing here types or decides. */
export interface ChatBoard {
  state(): Readonly<State>;
  page: TranscriptReader['page'];
}

export interface ChatDeps {
  life: LifeService;
  intel: Pick<IntelService, 'list' | 'get' | 'read' | 'remove' | 'reread' | 'jobs'>;
  meetings: Pick<MeetingsService, 'library' | 'summaries' | 'status' | 'broken'>;
  board: ChatBoard;
  usage: UsageSource;
  ccwLegacy: CcwLegacySource;
  /** Only the Web Push one is used (life/push.ts sendLifePush): "Your answer is in Chat." */
  notifiers: Notifier[];
}

/** The parts Chat reaches, each behind its own switch; `sessions` (read only) is always there on the hub. */
export type ChatPart = 'life' | 'todos' | 'medicines' | 'food' | 'places' | 'finance' | 'posts' | 'intel' | 'meetings' | 'sessions';
