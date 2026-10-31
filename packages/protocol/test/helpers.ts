import type {
  Account,
  Alert,
  DaemonEvent,
  EventInput,
  Move,
  PendingRequest,
  SendJob,
  Session,
} from '../src/index.js';
import { parseEvent } from '../src/index.js';

export const T0 = '2026-01-15T10:00:00.000Z';

export function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

export function session(over: Partial<Session> = {}): Session {
  return {
    sid: 'sid-a',
    pid: 40001,
    procStart: 'Thu Jan 15 09:00:00 2026',
    account: 2,
    configDir: '/home/test/.claude-swap-backup/sessions/2-bravo_example.com',
    cwd: '/home/test/work/alpha-app',
    folder: 'alpha-app',
    name: 'fix login',
    entrypoint: 'cli',
    status: 'working',
    statusSource: 'session-file',
    statusSince: T0,
    subagentsRunning: 0,
    ...over,
  };
}

export function pending(over: Partial<PendingRequest> = {}): PendingRequest {
  return {
    id: '01JFAKEPENDING0000000000000AAAAAAAAAAAAAAAA',
    sid: 'sid-a',
    kind: 'permission',
    tool: 'Bash',
    input: { command: 'npm test' },
    suggestions: [],
    correlationKey: 'sid-a|Bash|{"command":"npm test"}',
    createdAt: T0,
    settleUntil: at(0.05),
    state: 'open',
    ...over,
  };
}

export function account(over: Partial<Account> = {}): Account {
  return {
    id: 2,
    emailMasked: 'b***@e***.com',
    isDefaultLogin: false,
    disabled: false,
    held: false,
    usageStatus: 'ok',
    windows: [{ kind: 'five_hour', pct: 42 }],
    ...over,
  };
}

export function move(over: Partial<Move> = {}): Move {
  return { sid: 'sid-a', from: 2, to: 3, step: 'saving', why: 'five_hour near full', since: T0, ...over };
}

export function job(over: Partial<SendJob> = {}): SendJob {
  return {
    id: 'job-1',
    sid: 'sid-a',
    paneId: 'pane-1',
    textHash: 'abc',
    textLength: 5,
    stage: 'queued',
    attempts: 0,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function alert(over: Partial<Alert> = {}): Alert {
  return { id: 'al-1', ts: T0, kind: 'limit', label: 'Done · alpha-app · fix login', what: 'rate limit', ...over };
}

let seq = 0;
export function resetSeq(n = 0): void {
  seq = n;
}

/** Build and validate an event with the next seq. */
export function ev(input: EventInput, s?: number): DaemonEvent {
  seq = s ?? seq + 1;
  return parseEvent({ ts: T0, ...input, seq });
}
