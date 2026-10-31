/**
 * Factories for protocol objects with synthetic defaults, for unit tests that
 * don't need a whole fake home. Pass overrides for the fields a test cares about.
 */
import type { Account, Alert, Move, PendingRequest, SendJob, Session } from '@jantar/protocol';

export const MODEL_T0 = '2026-01-15T10:00:00.000Z';

export function makeSession(over: Partial<Session> = {}): Session {
  return {
    sid: '11111111-1111-4111-8111-111111111111',
    pid: 41001,
    procStart: 'Thu Jan 15 09:00:00 2026',
    version: '2.1.300',
    account: 1,
    configDir: '/synthetic/home/.claude',
    cwd: '/synthetic/home/work/alpha-app',
    folder: 'alpha-app',
    name: 'add login form',
    entrypoint: 'cli',
    status: 'working',
    statusSource: 'session-file',
    statusSince: MODEL_T0,
    statusAt: MODEL_T0,
    subagentsRunning: 0,
    ...over,
  };
}

export function makePending(over: Partial<PendingRequest> = {}): PendingRequest {
  return {
    id: '01JSYNTHETICPENDING00000000AAAAAAAAAAAAAAAA',
    sid: '11111111-1111-4111-8111-111111111111',
    kind: 'permission',
    tool: 'Bash',
    input: { command: 'npm test' },
    suggestions: [],
    correlationKey: '11111111-1111-4111-8111-111111111111|Bash|{"command":"npm test"}',
    createdAt: MODEL_T0,
    settleUntil: '2026-01-15T10:00:03.000Z',
    state: 'open',
    ...over,
  };
}

export function makeAccount(over: Partial<Account> = {}): Account {
  return {
    id: 2,
    alias: 'team-b',
    emailMasked: 'b***@e***.com',
    isDefaultLogin: false,
    disabled: false,
    held: false,
    usageStatus: 'ok',
    fetchedAt: MODEL_T0,
    ageS: 30,
    windows: [
      { kind: 'five_hour', pct: 42, resetsAt: '2026-01-15T12:00:00.000Z' },
      { kind: 'seven_day', pct: 18, resetsAt: '2026-01-18T10:00:00.000Z', willLastToReset: true },
    ],
    ...over,
  };
}

export function makeMove(over: Partial<Move> = {}): Move {
  return {
    sid: '11111111-1111-4111-8111-111111111111',
    from: 2,
    to: 1,
    step: 'saving',
    why: 'five_hour window nearly full',
    since: MODEL_T0,
    ...over,
  };
}

export function makeSendJob(over: Partial<SendJob> = {}): SendJob {
  return {
    id: 'job-synthetic-1',
    sid: '11111111-1111-4111-8111-111111111111',
    paneId: 'terminal-app:1:1',
    textHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    textLength: 0,
    stage: 'queued',
    attempts: 0,
    createdAt: MODEL_T0,
    updatedAt: MODEL_T0,
    ...over,
  };
}

export function makeAlert(over: Partial<Alert> = {}): Alert {
  return {
    id: 'alert-synthetic-1',
    ts: MODEL_T0,
    kind: 'limit',
    sid: '11111111-1111-4111-8111-111111111111',
    account: 2,
    label: 'Done · alpha-app · add login form',
    what: 'usage limit reached',
    ...over,
  };
}
