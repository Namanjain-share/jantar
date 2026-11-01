/**
 * Synthetic data for the launch film and the README's GIF
 * (scripts/launch-video.mjs): the v0.5.1 fixture (web-fixture-v051.ts) told
 * in three stages, around one Bash permission. Every name, line, path and
 * picture is made up.
 *
 * Stages (`stage`):
 * - 'before': the v0.5.1 board as it is. 15 sessions, 3 need you; card 3 is
 *   the Bash permission `pnpm prisma migrate reset --force` in api-server
 *   ("migrate billing tables", account 05, waiting 1m), a session in
 *   Claude's default mode (it asks before each command).
 * - 'answered': Yes was tapped on card 3. The card is gone from the state,
 *   session 3 is working on that command (status since now), its transcript
 *   ends with the tool call, and the board says 2 need you.
 * - 'migrating', 'testing': the same, session 3 on the run's second and
 *   third command (FILM_RUN), so the board can follow the Terminal.
 * - 'done': session 3 ran the reset, the migration and the tests, then
 *   stopped with FILM_REPLY: your turn. Still 2 need you.
 *
 * Session 3's transcript starts with an earlier exchange (FILM_HISTORY), so
 * its page has no empty band at the top once the card is gone.
 *
 * FILM_TERMINAL is what the drawn Terminal window shows: the twelve tabs and
 * a few lines per tab. api-server's dialog is BASH_SCREEN, the same text the
 * v0.5.1 fixture's 'phone-control' variant serves and the daemon's own
 * dialogOfScreen reads as a Bash permission. The lines after the answer are
 * the transcript's tool calls, drawn the way Claude Code prints them.
 */
import type { PendingRequest, Session, TranscriptItem } from '@jantar/protocol';
import { sidOf } from './web-fixture.js';
import { BASH_SCREEN, webFixtureV051, type WebFixtureV051, type WebFixtureV051Options } from './web-fixture-v051.js';
import type { V05Reply } from './web-fixture-v05.js';

/** The pictures the capture script draws first (a meeting's slides, the composer's photo). */
export { SCREENSHOT_ART } from './web-fixture-v051.js';

const MIN = 60_000;

export type FilmStage = 'before' | 'answered' | 'migrating' | 'testing' | 'done';
export const FILM_STAGES: readonly FilmStage[] = ['before', 'answered', 'migrating', 'testing', 'done'];
/** Which of FILM_RUN's commands session 3 is on, at the stages where it works. */
export const FILM_RUNNING: Readonly<Partial<Record<FilmStage, number>>> = { answered: 0, migrating: 1, testing: 2 };

/** The session the film follows: api-server, "migrate billing tables", with the Bash card. */
export const FILM_SID = sidOf(3);
export const FILM_COMMAND = 'pnpm prisma migrate reset --force';
/** What Claude says when it stops (the board's YOUR TURN line). */
export const FILM_REPLY = 'Done. The billing tables are on the new schema and the tests pass (48 passed).';

/** The tool calls Claude makes after the answer, oldest first: [tool, input, the output lines the Terminal shows]. */
export const FILM_RUN: ReadonlyArray<readonly [tool: string, input: string, out: readonly string[]]> = [
  ['Bash', FILM_COMMAND, ['Billing database reset', 'Applied 14 migrations']],
  ['Bash', 'pnpm prisma migrate dev --name billing-v2', ['Applied 1 migration: billing-v2']],
  ['Bash', 'pnpm vitest run src/billing', ['48 passed (6 files)']],
];

/** Session 3's exchange before the migration prompt, oldest first: [minutes ago, role, kind, text, tool]. */
export const FILM_HISTORY: ReadonlyArray<readonly [minutesAgo: number, role: 'user' | 'assistant', kind: 'text' | 'tool_use', text: string, tool?: string]> = [
  [12, 'user', 'text', 'Which tables does the new billing schema change?'],
  [11, 'assistant', 'tool_use', 'invoices src/billing', 'Grep'],
  [10, 'assistant', 'text', 'Two. `invoices` loses two columns and `invoice_lines` is new. Only src/billing reads them.'],
];

export interface WebFixtureFilmOptions extends WebFixtureV051Options {
  stage?: FilmStage;
}

export interface WebFixtureFilm extends WebFixtureV051 {
  stage: FilmStage;
}

/** One tab of the drawn Terminal: its folder and the lines it shows, oldest first. */
export interface FilmTab {
  folder: string;
  lines: string[];
}

const TABS = ['jantar', 'web-app', 'docs-site', 'mobile', 'landing', 'infra', 'design-system', 'payments', 'search', 'crm-sync', 'api-server', 'analytics'];

/** What a tool call looks like in Claude Code's scrollback: "● Bash(cmd)" and its output under "⎿". */
function toolLines(tool: string, input: string, out: readonly string[]): string[] {
  return [`● ${tool}(${input})`, ...out.map((l, i) => `${i === 0 ? '  ⎿  ' : '     '}${l}`), ''];
}

/**
 * The drawn Terminal window. `tabs` in strip order; `screens` the lines of
 * the four tabs the film shows (landing, search and payments at work, and
 * api-server waiting on the Bash prompt); `after` api-server's lines once
 * the card is answered (oldest first, the dialog gone); `reply` its last.
 */
export const FILM_TERMINAL: {
  tabs: string[];
  screens: Record<'landing' | 'search' | 'payments' | 'api-server', FilmTab>;
  /** The lines above api-server's dialog: the prompt and the reads before it. */
  context: string[];
  after: string[];
  reply: string;
} = {
  tabs: TABS,
  screens: {
    landing: {
      folder: 'landing',
      lines: [
        '> Tighten the hero copy. Two lines at most.',
        '',
        '● I will read the hero first, then cut it down.',
        '',
        ...toolLines('Read', 'components/Hero.tsx', ['Read 84 lines']),
        '● Edit(components/Hero.tsx)',
        '',
        '✻ Working… (esc to interrupt)',
      ],
    },
    search: {
      folder: 'search',
      lines: [
        '> Rebuild the index with the new tokenizer.',
        '',
        '● Bash(cargo build --release)',
        '  ⎿  Compiling tokenizer v0.4.0',
        '     Compiling search-core v0.9.0',
        '     Compiling indexer v0.9.0',
        '',
        '✻ Working… (esc to interrupt)',
      ],
    },
    payments: {
      folder: 'payments',
      lines: [
        '> Check the webhook handler against the provider docs.',
        '',
        '● I will read the docs page, then compare the events.',
        '',
        '● WebFetch(docs.example.com/webhooks)',
        '',
        '✻ Working… (esc to interrupt)',
      ],
    },
    'api-server': {
      folder: 'api-server',
      lines: BASH_SCREEN.split('\n'),
    },
  },
  context: [
    '> Migrate the billing tables to the new schema. Reset the dev database if you have to.',
    '',
    '● I will compare the schema with the migrations first.',
    '',
    ...toolLines('Read', 'prisma/schema.prisma', ['Read 212 lines']),
    ...toolLines('Bash', 'pnpm prisma migrate diff', ['2 columns dropped from invoices']),
  ],
  after: FILM_RUN.flatMap(([tool, input, out]) => toolLines(tool, input, out)),
  reply: `● ${FILM_REPLY}`,
};

// ---------------------------------------------------------------------------

/** Session 3's transcript at `stage` (newest first, as the route pages them). */
function transcript(now: number, stage: FilmStage): { items: TranscriptItem[]; nextBefore: null } {
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();
  const item = (id: string, at: number, role: TranscriptItem['role'], kind: TranscriptItem['kind'], text: string, tool?: string): TranscriptItem => ({
    id,
    at: iso(at),
    role,
    kind,
    text,
    ...(tool ? { tool } : {}),
  });
  const history = FILM_HISTORY.map(([at, role, kind, text, tool], i) => item(`h${i + 1}`, at, role, kind, text, tool)).reverse();
  // The v0.5.1 fixture's five items for session 3 (web-fixture-v051.ts), unchanged.
  const before = [
    item('t5', 1, 'assistant', 'text', 'The migration drops two columns from `invoices`. I need to reset the billing database before I apply it.'),
    item('t4', 2, 'assistant', 'tool_use', 'pnpm prisma migrate diff', 'Bash'),
    item('t3', 3, 'assistant', 'tool_use', 'prisma/schema.prisma', 'Read'),
    item('t2', 4, 'assistant', 'text', 'I will compare the schema with the migrations first.'),
    item('t1', 5, 'user', 'text', 'Migrate the billing tables to the new schema. Reset the dev database if you have to.'),
  ];
  const run = stage === 'before' ? [] : stage === 'done' ? FILM_RUN : FILM_RUN.slice(0, (FILM_RUNNING[stage] ?? 0) + 1);
  const calls = run.map(([tool, input], i) => item(`t${6 + i}`, 0, 'assistant', 'tool_use', input, tool)).reverse();
  const reply = stage === 'done' ? [item(`t${6 + run.length}`, 0, 'assistant', 'text', FILM_REPLY)] : [];
  return { items: [...reply, ...calls, ...before, ...history], nextBefore: null };
}

export function webFixtureFilm(opts: WebFixtureFilmOptions = {}): WebFixtureFilm {
  const stage = opts.stage ?? 'before';
  if (!FILM_STAGES.includes(stage)) throw new Error(`webFixtureFilm: unknown stage ${stage}`);
  const base = webFixtureV051(opts);
  const st = base.state.state as unknown as { sessions: Record<string, Session>; pending: Record<string, PendingRequest> };
  const session = st.sessions[FILM_SID];
  if (!session) throw new Error('webFixtureFilm: no session 3');
  // A session that asks before a command runs in Claude's default mode (the phone says Manual).
  session.mode = 'default';

  const now = base.now;
  if (stage !== 'before') {
    const at = new Date(now).toISOString();
    const cards = Object.entries(st.pending).filter(([, p]) => p.sid === FILM_SID);
    if (cards.length !== 1 || cards[0]![1].tool !== 'Bash') throw new Error('webFixtureFilm: session 3 should hold one Bash card');
    for (const [id] of cards) delete st.pending[id];

    const running = FILM_RUNNING[stage];
    if (running !== undefined) {
      const [tool, input] = FILM_RUN[running]!;
      session.status = 'working';
      session.now = { kind: 'tool', tool, text: input };
    } else {
      session.status = 'idle';
      delete session.now;
      session.lastReply = { text: FILM_REPLY, at };
    }
    session.statusSince = at;
    session.statusAt = at;
    base.state.seq += 1;
  }

  const talk = transcript(now, stage);
  const path = `/v1/sessions/${encodeURIComponent(FILM_SID)}/transcript`;
  const v051Answer = base.v04.answer as (method: string, url: URL, body?: Buffer | null) => V05Reply | null;
  const answer = (method: string, url: URL, body?: Buffer | null): V05Reply | null => {
    if (method === 'GET' && url.pathname === path) return { status: 200, body: talk };
    return v051Answer(method, url, body);
  };
  return { ...base, v04: { ...base.v04, answer }, stage };
}
