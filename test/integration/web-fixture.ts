/**
 * Synthetic data for the browser checks of the built web app
 * (web.integration.test.ts). Every name, folder and address is made up.
 *
 * The board the design was reviewed with (direction.md 5.1, rule 18): 15
 * sessions (3 need you: a question, a plan and a Bash permission; all six
 * glyph states appear), 11 accounts and 3 alerts. Times are relative to the
 * `now` passed in, so the screens never look months old.
 */
import type { Account, Alert, PendingRequest, PlanResponse, SendJob, Session, StateResponse } from '@jantar/protocol';

const MIN = 60_000;

export function sidOf(n: number): string {
  return `a1b2c3d4-${String(n).padStart(4, '0')}-4000-8000-00000000${String(n).padStart(4, '0')}`;
}

export interface WebFixture {
  state: StateResponse;
  plan: PlanResponse;
  /** The session with the open Bash permission card. */
  permissionSid: string;
}

export function webFixture(now: number = Date.now()): WebFixture {
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();
  const fut = (minutes: number) => iso(-minutes);

  const sess = (
    n: number,
    folder: string,
    name: string,
    account: number,
    status: Session['status'],
    sinceMin: number,
    over: Partial<Session> & { atMin?: number } = {},
  ): Session => {
    const { atMin, ...rest } = over;
    return {
      sid: sidOf(n),
      pid: 40000 + n,
      procStart: 'Thu Oct 29 09:00:00 2026',
      account,
      configDir: '/synthetic/.claude',
      cwd: `/Users/you/Desktop/work/${folder}`,
      folder,
      name,
      entrypoint: 'cli',
      status,
      statusSource: 'hook',
      statusSince: iso(sinceMin),
      statusAt: iso(atMin ?? sinceMin),
      subagentsRunning: 0,
      ...rest,
    } as Session;
  };
  const tool = (name: string, text: string) => ({ kind: 'tool', tool: name, text }) as unknown as Session['now'];

  const move = { sid: sidOf(9), from: 4, to: 8, step: 'restarting', why: '5-hour window at 92%', since: iso(1) } as unknown as NonNullable<Session['move']>;

  const sessions: Session[] = [
    // needs you
    sess(1, 'web-app', 'fix login redirect', 3, 'working', 12, {
      lastReply: { text: 'I found two places that set the session cookie. Which one should own it?', at: iso(12) },
    } as Partial<Session>),
    sess(2, 'infra', 'terraform plan', 3, 'working', 4),
    sess(3, 'api-server', 'migrate billing tables', 5, 'working', 1),
    // your turn
    sess(4, 'jantar', 'board redesign', 1, 'idle', 2, {
      lastReply: { text: 'Done. The board now groups sessions by state, and the tests pass (125 passed).', at: iso(2) },
    } as Partial<Session>),
    sess(5, 'docs-site', 'changelog for 0.4', 7, 'idle', 9, {
      lastReply: { text: 'Drafted the 0.4 changelog: 6 fixes, 2 new commands, 1 breaking change.', at: iso(9) },
    } as Partial<Session>),
    sess(6, 'mobile', 'push permissions', 10, 'idle', 31, {
      lastReply: { text: 'iOS now asks for notifications after pairing, not at launch.', at: iso(31) },
    } as Partial<Session>),
    // working, compacting and one with no update for 8 minutes
    sess(7, 'api-server', 'rate limiter', 5, 'working', 0.67, { now: tool('Bash', 'pnpm vitest run src/limiter') }),
    sess(8, 'landing', 'hero copy pass', 7, 'working', 0.08, { now: tool('Edit', 'components/Hero.tsx') }),
    sess(9, 'search', 'index rebuild', 4, 'working', 1, { now: tool('Bash', 'cargo build --release'), move }),
    sess(10, 'payments', 'stripe webhooks', 10, 'working', 0.2, { now: tool('WebFetch', 'docs.example.com/webhooks') }),
    sess(11, 'web-app', 'session tests', 3, 'working', 0.05, { now: tool('Grep', '"useSession" src/') }),
    sess(12, 'analytics', 'weekly report', 9, 'compacting', 0.33),
    sess(13, 'design-system', 'tokens audit', 11, 'working', 0.13, { now: tool('Read', 'src/styles/tokens.css'), subagentsRunning: 2 }),
    sess(14, 'crm-sync', 'contacts import', 9, 'working', 8, { atMin: 8, now: tool('Bash', 'node scripts/import.mjs --dry-run') }),
    // ended
    sess(15, 'scratch', 'try bun 2', 1, 'ended', 60),
  ];

  const card = (n: number, kind: PendingRequest['kind'], toolName: string, input: Record<string, unknown>, minutes: number, over: Partial<PendingRequest> = {}): PendingRequest =>
    ({
      id: `01JPENDING${String(n).padStart(20, '0')}abcdefghijklmnop`,
      sid: sidOf(n),
      kind,
      tool: toolName,
      input,
      suggestions: [],
      correlationKey: `${sidOf(n)}|${toolName}|{}`,
      createdAt: iso(minutes),
      settleUntil: iso(minutes),
      state: 'open',
      ...over,
    }) as PendingRequest;

  const pending: PendingRequest[] = [
    card(1, 'question', 'AskUserQuestion', {}, 12, {
      questions: [
        {
          question: 'Which module should own the session cookie?',
          header: 'Cookie',
          options: [
            { label: 'auth/session.ts', description: 'Keep it next to the login flow' },
            { label: 'middleware/cookies.ts', description: 'One place for every cookie' },
          ],
        },
      ],
    } as Partial<PendingRequest>),
    card(2, 'plan', 'ExitPlanMode', { plan: '3 to add, 1 to change, 0 to destroy.\n1. Add a bucket for build artifacts\n2. Add a lifecycle rule (30 days)\n3. Add a role for CI\n4. Point the CDN origin at the new bucket' }, 4),
    card(3, 'permission', 'Bash', { command: 'pnpm prisma migrate reset --force', description: 'Reset the billing database' }, 1, {
      suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'pnpm prisma migrate:*' }] }],
    } as Partial<PendingRequest>),
  ];

  // id, alias, 5h %, minutes to the 5h reset (null: no window), 7d %, burn %/min, full-in min, extra.
  // The aliases are star names and the held pair is arbitrary: neither copies anyone's real cswap setup.
  const rows: Array<[number, string, number, number | null, number, number, number | null, Partial<Account>]> = [
    [1, 'vega', 22, 142, 31, 0.1, null, { isDefaultLogin: true }],
    [2, 'lyra', 3, null, 12, 0, null, {}],
    [3, 'rigel', 81, 12, 63, 0.5, 18, {}],
    [4, 'deneb', 92, 122, 70, 0.6, 8, {}],
    [5, 'altair', 34, 192, 40, 0.3, null, { held: true }],
    [6, 'sirius', 0, null, 4, 0, null, {}],
    [7, 'castor', 12, 182, 36, 0.15, null, {}],
    [8, 'pollux', 0, null, 8, 0, null, {}],
    [9, 'capella', 47, 272, 52, 0.2, null, {}],
    [10, 'mira', 58, 352, 44, 0.18, null, { held: true }],
    [11, 'antares', 5, 351, 21, 0.07, null, { usageStatus: 'token_expired' } as Partial<Account>],
  ];
  const accounts: Account[] = rows.map(([id, alias, h5, reset, d7, burn, full, extra]) => {
    const windows: Account['windows'] = [{ kind: 'seven_day', pct: d7, resetsAt: fut(60 * 24 * 3 + id * 90) }];
    if (reset !== null) {
      windows.unshift({
        kind: 'five_hour',
        pct: h5,
        resetsAt: fut(reset),
        willLastToReset: full === null,
        ...(full !== null ? { projectedExhaustionAt: fut(full) } : {}),
      } as Account['windows'][number]);
    }
    return {
      id,
      alias,
      emailMasked: 'u***@e***.com',
      isDefaultLogin: false,
      disabled: false,
      held: false,
      usageStatus: 'ok',
      fetchedAt: iso(0.2),
      ageS: 12,
      windows,
      projection: { burnPctPerMin: burn, ridesReset: full === null, usable: h5 < 97, ...(full !== null ? { fullInMin: full } : {}) },
      ...extra,
    } as Account;
  });

  const alerts: Alert[] = [
    { id: 'al1', ts: iso(6), kind: 'error', sid: sidOf(7), label: 'Working · api-server · rate limiter', what: 'Hit an API error: 529 overloaded.', why: 'Retried twice, then stopped.' },
    { id: 'al2', ts: iso(20), kind: 'blocked', sid: sidOf(8), label: 'Working · landing · hero copy pass', what: 'Blocked: a hook refused rm -rf public.', full: 'PreToolUse hook refused the command' },
    { id: 'al3', ts: iso(168), kind: 'limit', account: 3, label: 'acct 03', what: 'Hit its 5-hour limit.', why: 'Resets 14:20.' },
  ] as Alert[];

  const sends: Record<string, SendJob> = {
    job1: { id: 'job1', sid: sidOf(4), textHash: 'sha256:x', textLength: 38, stage: 'proven', attempts: 1, createdAt: iso(6), updatedAt: iso(6) } as SendJob,
  };

  const state = {
    seq: 42,
    sessions: Object.fromEntries(sessions.map((s) => [s.sid, s])),
    pending: Object.fromEntries(pending.map((p) => [p.id, p])),
    accounts: Object.fromEntries(accounts.map((a) => [String(a.id), a])),
    activeAccount: 1,
    usage: { fetchedAt: iso(0.2), source: 'cache' },
    moves: { [sidOf(9)]: move },
    sends,
    rewrites: {},
    launches: {},
    fileTicks: {},
    alerts,
    daemon: { protocol: 1, daemonVersion: '0.1.0', webHash: null },
  } as unknown as StateResponse['state'];

  const plan = {
    source: 'ccw-legacy',
    next: 8,
    updatedAt: iso(2),
    ceiling: 97,
    weeklyCeiling: 95,
    accounts: accounts.map((a) => ({
      id: a.id,
      burnPctPerMin: a.projection?.burnPctPerMin ?? 0,
      ...(a.projection?.fullInMin !== undefined ? { fullInMin: a.projection.fullInMin } : {}),
      ridesReset: a.projection?.ridesReset ?? true,
      usable: a.projection?.usable ?? true,
    })),
  } as unknown as PlanResponse;

  return { state: { seq: 42, epoch: 'web-fixture', state }, plan, permissionSid: sidOf(3) };
}

/** A transcript page for any session: a prompt, one tool call and a reply. */
export function transcriptFixture(now: number = Date.now()) {
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();
  return {
    items: [
      { id: 't3', at: iso(12), role: 'assistant', kind: 'text', text: 'I found two places that set the session cookie: **auth/session.ts** and **middleware/cookies.ts**.' },
      { id: 't2', at: iso(13), role: 'assistant', kind: 'tool_use', tool: 'Grep', text: 'Set-Cookie in src/' },
      { id: 't1', at: iso(14), role: 'user', kind: 'text', text: 'Fix the login redirect after sign-in. It loops back to /login.' },
    ],
    nextBefore: null,
  };
}
