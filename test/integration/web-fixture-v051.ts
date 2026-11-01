/**
 * Synthetic v0.5.1 data for the README's pictures (scripts/screenshots.mjs,
 * its default fixture): the v0.5 fixture (web-fixture-v05.ts) plus what the
 * v0.4.2 screens need. Every name, line, path and picture is made up.
 *
 * - Terminal screens per session, answered on GET /v1/sessions/:sid/screen
 *   the way the daemon answers it (api/routes.ts getScreen): the dialog is
 *   read from the text by the daemon's own `dialogOfScreen`, so the dock
 *   shows exactly what a real read would send. A screen that should parse
 *   and doesn't throws here, before any picture is taken.
 * - A transcript per session (2, 3 and 4; 1 keeps the cookie transcript of
 *   web-fixture.ts), on GET /v1/sessions/:sid/transcript.
 * - Uploads: POST /v1/sessions/:sid/uploads answers 201 with a fresh id,
 *   DELETE answers ok. Nothing is stored.
 * - Meetings: the screenshots are slides drawn in Chromium by the script
 *   (`art`, from SCREENSHOT_ART), not flat colour frames.
 * - No legacy ccw tool (unless `ccw: true`): with cswap, what anyone else
 *   sees. /v1/plan says source "none" with the default ceilings, and nothing
 *   ccw computes is left: no `next →`, burn, "full in" or red dashes, no
 *   moves and no hold list (an account kept at the Mac is still marked
 *   held on the start sheet).
 *
 * Variants (`variant`):
 * - 'default': the board as it is (three hook cards: a question, a plan, a
 *   Bash command), no terminal screens.
 * - 'phone-control': sessions 1 to 3 wait in the terminal with no hook card
 *   (the question, the plan and the Bash prompt as Claude Code draws them).
 *   The board still says "3 need you".
 * - 'keypad': session 2 waits on a model list Jantar can't turn into
 *   buttons, so its dock shows the screen and the keypad.
 * - 'ask': Ask on (v0.5.3), with this phone's history on GET /v1/ask: a
 *   reminder added, "calories left?" (its card filled from Today) and a
 *   meal of two foods still to add.
 *
 * The screens copy the layouts of test/fixtures/src/dialogs.ts (rules, the
 * pointer, numbering, the hints) with the board's own words, and none of
 * its planted marker or /tmp paths.
 */
import { createHash } from 'node:crypto';
import {
  AskListSchema,
  DIALOG_NOTES,
  MeetingDetailSchema,
  type Account,
  type AskList,
  type PendingRequest,
  type PlanResponse,
  type Session,
  type TranscriptItem,
} from '@jantar/protocol';
import { dialogOfScreen, screenKey } from '@jantar/daemon/terminal/dialog';
import { readScreenState } from '@jantar/daemon/terminal/screen';
import { makePng } from '../fixtures/runtime/images.mjs';
import { sidOf, transcriptFixture } from './web-fixture.js';
import { syntheticPdf } from './web-fixture-v03.js';
import { lid, type WebFixtureV04Options } from './web-fixture-v04.js';
import { webFixtureV05, type V05Reply, type WebFixtureV05 } from './web-fixture-v05.js';

const MIN = 60_000;

export type V051Variant = 'default' | 'phone-control' | 'keypad' | 'ask';

/** The pictures the script draws in Chromium before it builds the fixture (see SCREENSHOT_ART). */
export type V051ArtName = 'slide' | 'slide2' | 'photo';

export interface WebFixtureV051Options extends WebFixtureV04Options {
  variant?: V051Variant;
  /** Keep what the legacy ccw tool adds (its plan, burn, moves and hold list). Off: the pictures show Jantar alone. */
  ccw?: boolean;
  /** The bytes of each picture in SCREENSHOT_ART, drawn by the caller; a flat tile stands in for any left out. */
  art?: Partial<Record<V051ArtName, Buffer>>;
}

export interface WebFixtureV051 extends WebFixtureV05 {
  variant: V051Variant;
  /** The pictures this fixture serves or attaches (a meeting's slides, the composer's photo). */
  art: Record<V051ArtName, { bytes: Buffer; type: string; name: string }>;
  /** A one-page PDF for the composer's second chip. */
  pdf: Buffer;
  /** The screen each session's terminal shows in this variant. */
  screens: Record<string, string>;
}

// ---------------------------------------------------------------------------
// The pictures, as HTML the script renders (fonts: the app's own, added by the script)

const SLIDE_CSS = `
  body { margin: 0; width: 1280px; height: 800px; background: #f7f5ef; color: #16203a; font-family: 'Archivo Variable', sans-serif; }
  .s { box-sizing: border-box; width: 1280px; height: 800px; padding: 84px 96px; display: flex; flex-direction: column; }
  .k { font-family: 'JetBrains Mono Variable', monospace; font-size: 22px; letter-spacing: 0.08em; text-transform: uppercase; color: #596079; }
  h1 { margin: 18px 0 0; font-size: 76px; line-height: 1; font-weight: 600; font-stretch: 125%; letter-spacing: -0.02em; }
  .rows { margin-top: 64px; display: grid; grid-template-columns: 220px 1fr; row-gap: 26px; font-size: 34px; }
  .rows b { font-family: 'JetBrains Mono Variable', monospace; font-weight: 500; font-size: 28px; color: #7f5d00; padding-top: 4px; }
  .bar { margin-top: auto; height: 10px; background: #e2ded3; position: relative; }
  .bar i { position: absolute; left: 0; top: 0; bottom: 0; width: 62%; background: #16203a; }
  .bar u { position: absolute; left: 62%; top: -14px; width: 4px; height: 38px; background: #a67a0c; }
  .foot { margin-top: 18px; display: flex; justify-content: space-between; font-family: 'JetBrains Mono Variable', monospace; font-size: 20px; color: #596079; }
  .cols { margin-top: 56px; display: grid; grid-template-columns: 1fr 1fr; gap: 40px; }
  .card { border: 2px solid #e2ded3; background: #fff; padding: 36px 40px; font-size: 30px; line-height: 1.4; }
  .card h2 { margin: 0 0 18px; font-size: 40px; font-weight: 600; font-stretch: 112%; }
  .card.on { border-color: #16203a; }
`;

const PHOTO_CSS = `
  body { margin: 0; width: 1200px; height: 900px; background: #3a3f4f; font-family: 'Archivo Variable', sans-serif; }
  .desk { position: absolute; inset: 0; background: #2b3040; }
  .screen { position: absolute; left: 70px; top: 60px; width: 1060px; height: 740px; background: #fcfbf7; transform: rotate(-1.6deg); box-shadow: 0 30px 60px rgb(0 0 0 / 0.45); overflow: hidden; }
  nav { height: 74px; display: flex; align-items: center; gap: 34px; padding: 0 48px; border-bottom: 2px solid #e2ded3; font-size: 22px; color: #3d4660; }
  nav .logo { width: 30px; height: 30px; background: #16203a; margin-right: auto; }
  .hero { padding: 76px 48px 0; display: grid; grid-template-columns: 1.2fr 1fr; gap: 40px; }
  .hero h1 { margin: 0; font-size: 64px; line-height: 1.02; font-weight: 600; font-stretch: 118%; color: #16203a; letter-spacing: -0.02em; }
  .hero p { margin: 24px 0 0; font-size: 24px; line-height: 1.45; color: #3d4660; }
  .btn { display: inline-block; margin-top: 32px; padding: 18px 30px; background: #16203a; color: #f7f5ef; font-size: 22px; font-weight: 600; }
  .shot { height: 420px; background: #ebe8df; border: 2px solid #e2ded3; padding: 26px; display: grid; gap: 16px; align-content: start; }
  .shot i { display: block; height: 30px; background: #fff; border: 2px solid #e2ded3; }
  .shot i:first-child { background: #c63d2c; width: 40%; border: 0; }
  .glare { position: absolute; inset: 0; background: linear-gradient(115deg, rgb(255 255 255 / 0) 40%, rgb(255 255 255 / 0.10) 52%, rgb(255 255 255 / 0) 64%); }
`;

/**
 * What the script draws before it builds the fixture: two slides shown in
 * the "Launch review" transcript and a photo of a landing page header for
 * the composer. Each is a page of plain HTML and CSS in the app's colours.
 */
export const SCREENSHOT_ART: Record<V051ArtName, { width: number; height: number; type: 'png' | 'jpeg'; name: string; css: string; html: string }> = {
  slide: {
    width: 1280,
    height: 800,
    type: 'png',
    name: 'slide-1.png',
    css: SLIDE_CSS,
    html: `<div class="s"><div class="k">Landing page · launch</div><h1>Launch plan</h1>
      <div class="rows"><b>WED 4</b><span>Docs ready: security notes and the extension guide</span>
      <b>THU 5</b><span>Review at 15:00, hero screenshot with the new board</span>
      <b>FRI 6</b><span>Launch, then revisit hosting</span></div>
      <div class="bar"><i></i><u></u></div><div class="foot"><span>Mon 2</span><span>Fri 6</span></div></div>`,
  },
  slide2: {
    width: 1280,
    height: 800,
    type: 'png',
    name: 'slide-2.png',
    css: SLIDE_CSS,
    html: `<div class="s"><div class="k">Landing page · hosting</div><h1>Hosting until launch</h1>
      <div class="cols"><div class="card on"><h2>Keep current</h2>No move before the 6th.<br>Same deploys, same costs.</div>
      <div class="card"><h2>Revisit after</h2>Revised quote this week.<br>Decide at the next sync.</div></div>
      <div class="foot" style="margin-top:auto"><span>Draft for discussion</span><span>2 / 6</span></div></div>`,
  },
  photo: {
    width: 1200,
    height: 900,
    type: 'jpeg',
    name: 'IMG_0412.jpg',
    css: PHOTO_CSS,
    html: `<div class="desk"></div><div class="screen"><nav><span class="logo"></span><span>Product</span><span>Pricing</span><span>Docs</span></nav>
      <div class="hero"><div><h1>Plan the week in one place</h1><p>Notes, tasks and the calendar on one page, on every device.</p><span class="btn">Start free</span></div>
      <div class="shot"><i></i><i></i><i></i><i></i><i></i></div></div></div><div class="glare"></div>`,
  },
};

/** A flat tile in the app's page colour, when the caller drew no picture (tests that never look at it). */
const FLAT: Buffer = makePng(16, 10, { rgb: [0xeb, 0xe8, 0xdf] });

// ---------------------------------------------------------------------------
// The terminal screens (Claude Code 2.1.314's layouts, 80 columns)

const R80 = '─'.repeat(80);
const D80 = '╌'.repeat(80);

/** Session 1's question, as the board's card asks it. */
export const QUESTION_SCREEN = [
  '● I found two places that set the session cookie.',
  '',
  R80,
  ' ☐ Cookie',
  '',
  'Which module should own the session cookie?',
  '',
  '❯ 1. auth/session.ts',
  '     Keep it next to the login flow',
  '  2. middleware/cookies.ts',
  '     One place for every cookie',
  '  3. Type something.',
  R80,
  '  4. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

/** Session 2's plan, the board card's terraform plan. */
export const PLAN_SCREEN = [
  '● The plan is ready.',
  '',
  ` ${'─'.repeat(76)}`,
  '   Ready to code?',
  '',
  "   Here is Claude's plan:",
  `  ${'╌'.repeat(76)}`,
  '   3 to add, 1 to change, 0 to destroy.',
  '   1. Add a bucket for build artifacts',
  '   2. Add a lifecycle rule (30 days)',
  '   3. Add a role for CI',
  '   4. Point the CDN origin at the new bucket',
  `  ${'─'.repeat(76)}`,
  '   Claude has written up a plan and is ready to execute. Would you like to',
  '   proceed?',
  '',
  '   ❯ 1. Yes, and use auto mode',
  '     2. Yes, manually approve edits',
  '     3. Tell Claude what to change',
  '        shift+tab to approve with this feedback',
  '',
  '   ctrl+g to edit in VS Code · ~/Desktop/work/infra/plans/cdn-bucket.md',
].join('\n');

/** Session 3's Bash prompt, the board card's command. */
export const BASH_SCREEN = [
  '● I will reset the billing database before the migration.',
  '',
  R80,
  ' Bash command',
  ' Reset the billing database',
  D80,
  ' pnpm prisma migrate reset --force',
  D80,
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and don’t ask again for: pnpm prisma migrate *',
  '   3. Yes, and switch to auto mode',
  '   4. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');

/** /model opened in session 2: a list Jantar doesn't turn into buttons (Enter would save a default). */
export const MODEL_SCREEN = [
  '● Opening the model list.',
  '',
  R80,
  ' Select model',
  '',
  ' ❯ 1. Default (recommended)  ✔',
  '   2. Opus',
  '   3. Haiku',
  '',
  ' Enter to confirm · s for this session only · Esc to cancel',
].join('\n');

/** The screens per variant, by session number. */
const SCREENS: Record<V051Variant, Record<number, { text: string; kind: 'question' | 'plan' | 'permission' | 'keypad' }>> = {
  default: {},
  'phone-control': {
    1: { text: QUESTION_SCREEN, kind: 'question' },
    2: { text: PLAN_SCREEN, kind: 'plan' },
    3: { text: BASH_SCREEN, kind: 'permission' },
  },
  keypad: {
    2: { text: MODEL_SCREEN, kind: 'keypad' },
  },
  ask: {},
};

/** What GET /v1/sessions/:sid/screen answers for `text`, as the daemon builds it (api/routes.ts getScreen). */
function screenReply(text: string, lines: number, at: string) {
  const all = text.split('\n');
  const shown = all.slice(Math.max(0, all.length - lines)).join('\n');
  const read = dialogOfScreen(text);
  const state = read.dialog || read.note ? null : readScreenState(text);
  const note = read.note ?? (state?.inputBox && !state.dialog ? DIALOG_NOTES.promptBox : null);
  return {
    text: shown,
    lines: shown.split('\n').length,
    at,
    backend: 'terminal-app',
    ...(read.dialog ? { dialog: read.dialog } : {}),
    ...(note ? { dialogNote: note } : {}),
    screenKey: screenKey(text, lines),
  };
}

// ---------------------------------------------------------------------------
// Transcripts (newest first, as the route pages them)

function transcripts(now: number): Record<string, { items: TranscriptItem[]; nextBefore: null }> {
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();
  const t = (n: number, at: number, role: TranscriptItem['role'], kind: TranscriptItem['kind'], text: string, tool?: string): TranscriptItem => ({
    id: `t${n}`,
    at: iso(at),
    role,
    kind,
    text,
    ...(tool ? { tool } : {}),
  });
  return {
    [sidOf(2)]: {
      items: [
        t(5, 4, 'assistant', 'text', 'The plan adds a bucket for build artifacts with a 30-day lifecycle rule and a role for CI, and points the CDN origin at the new bucket. Nothing is destroyed.'),
        t(4, 5, 'assistant', 'tool_use', 'terraform plan -out tfplan', 'Bash'),
        t(3, 6, 'assistant', 'tool_use', 'modules/cdn/main.tf', 'Read'),
        t(2, 7, 'assistant', 'text', 'I will read the CDN module first, then make a plan.'),
        t(1, 8, 'user', 'text', 'Add a bucket for build artifacts and point the CDN at it. Plan first, change nothing yet.'),
      ],
      nextBefore: null,
    },
    [sidOf(3)]: {
      items: [
        t(5, 1, 'assistant', 'text', 'The migration drops two columns from `invoices`. I need to reset the billing database before I apply it.'),
        t(4, 2, 'assistant', 'tool_use', 'pnpm prisma migrate diff', 'Bash'),
        t(3, 3, 'assistant', 'tool_use', 'prisma/schema.prisma', 'Read'),
        t(2, 4, 'assistant', 'text', 'I will compare the schema with the migrations first.'),
        t(1, 5, 'user', 'text', 'Migrate the billing tables to the new schema. Reset the dev database if you have to.'),
      ],
      nextBefore: null,
    },
    [sidOf(4)]: {
      items: [
        t(8, 2, 'assistant', 'text', 'Done. The board now groups sessions by state, and the tests pass (125 passed).'),
        t(7, 3, 'assistant', 'tool_use', 'pnpm vitest run src/ui/screens/board', 'Bash'),
        t(6, 5, 'assistant', 'tool_use', 'src/ui/screens/board/Ledger.tsx', 'Edit'),
        t(5, 7, 'assistant', 'tool_use', 'src/ui/screens/Board.tsx', 'Edit'),
        t(4, 9, 'assistant', 'text', 'I will group the rows by state, then tighten the row height on phones.'),
        t(3, 10, 'user', 'text', 'Group the board by state and make the rows denser on phones.'),
        t(2, 24, 'assistant', 'text', 'Ended rows were sorted again on every update. They now keep their place until you leave the board.'),
        t(1, 26, 'user', 'text', 'Why do the rows jump when a session ends?'),
      ],
      nextBefore: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Ask (the 'ask' variant)

/**
 * This phone's Ask history, oldest first: a reminder added a quarter of an
 * hour ago (its Undo still shows), "calories left?" (the phone fills the
 * card from Today: 1,240 of 1,500 kcal) and a meal of two foods to add.
 */
function askHistory(now: number, today: string): AskList {
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();
  return AskListSchema.parse({
    ready: true,
    turns: [
      {
        id: lid(1101),
        at: iso(15),
        text: 'remind me at 6 to call the bank',
        state: 'done',
        reply: 'A reminder at 18:00 today.',
        cards: [{ action: { type: 'todo', title: 'Call the bank', due: { day: today, time: '18:00' } }, state: 'added', ref: lid(1151) }],
        dropped: 0,
      },
      {
        id: lid(1102),
        at: iso(6),
        text: 'calories left?',
        state: 'done',
        reply: 'Here is today so far.',
        cards: [{ action: { type: 'show', what: 'calories' }, state: 'proposed' }],
        dropped: 0,
      },
      {
        id: lid(1103),
        at: iso(1),
        text: 'had 2 rotis and dal',
        state: 'done',
        reply: 'Assumed 2 medium rotis and 1 bowl of dal.',
        cards: [
          { action: { type: 'food', day: today, name: 'Roti', kcal: 240 }, state: 'proposed' },
          { action: { type: 'food', day: today, name: 'Dal', kcal: 180 }, state: 'proposed' },
        ],
        dropped: 0,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Jantar without the legacy ccw tool

/**
 * Takes out everything only the legacy ccw tool supplies: its plan (`next →`,
 * burn and "full in"), the moves it makes and its hold list. What is left is
 * what a Mac with cswap and no ccw serves: each account's windows with their
 * resets, and the ceilings from Jantar's own settings.
 */
function withoutCcw(base: WebFixtureV05): void {
  const st = base.state.state as unknown as {
    sessions: Record<string, Session & { move?: unknown }>;
    accounts: Record<string, Account>;
    moves: Record<string, unknown>;
  };
  st.moves = {};
  for (const s of Object.values(st.sessions)) delete s.move;
  for (const a of Object.values(st.accounts)) {
    a.held = false;
    delete a.projection;
    a.windows = a.windows.map(({ willLastToReset: _w, projectedExhaustionAt: _p, ...w }) => w);
  }
  (base as { plan: PlanResponse }).plan = { source: 'none', next: null, accounts: [], updatedAt: null, ceiling: 97, weeklyCeiling: 95 };
}

// ---------------------------------------------------------------------------

export function webFixtureV051(opts: WebFixtureV051Options = {}): WebFixtureV051 {
  const variant = opts.variant ?? 'default';
  if (!(variant in SCREENS)) throw new Error(`webFixtureV051: unknown variant ${variant}`);
  const base = webFixtureV05(opts);
  const now = base.now;
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();
  const st = base.state.state as unknown as {
    sessions: Record<string, Session>;
    pending: Record<string, PendingRequest>;
  };

  // ----- No legacy ccw tool: cswap's usage and resets only -----
  if (base.accountsMode === 'cswap' && !opts.ccw) withoutCcw(base);

  // ----- Ask: on in its own variant only (it is off until the Mac turns it on) -----
  const ask = variant === 'ask' ? askHistory(now, base.v04.today.day) : null;
  if (ask) {
    const daemon = (base.state.state as unknown as { daemon: { features: Record<string, unknown> } }).daemon;
    daemon.features = { ...daemon.features, ask: true };
  }

  // ----- The variant: sessions waiting in the terminal, their hook cards gone -----
  const screens: Record<string, string> = {};
  const since: Record<number, number> = { 1: 12, 2: 4, 3: 1 };
  for (const [n, s] of Object.entries(SCREENS[variant])) {
    const sid = sidOf(Number(n));
    screens[sid] = s.text;
    const session = st.sessions[sid];
    if (!session) throw new Error(`webFixtureV051: no session ${n}`);
    session.status = 'waiting';
    session.statusSince = iso(since[Number(n)] ?? 3);
    session.statusAt = session.statusSince;
    for (const [id, p] of Object.entries(st.pending)) if (p.sid === sid) delete st.pending[id];
    // The screen must read as the dock is meant to show it: buttons, or the keypad with no note.
    const read = dialogOfScreen(s.text);
    if (s.kind === 'keypad') {
      if (read.dialog || read.note) throw new Error(`webFixtureV051: session ${n}'s screen should get the keypad, got ${read.dialog ? 'buttons' : read.note}`);
    } else if (!read.dialog || read.dialog.kind !== s.kind || read.note !== null) {
      throw new Error(`webFixtureV051: session ${n}'s screen does not parse as a ${s.kind} (${read.note ?? 'no dialog'})`);
    }
  }

  // ----- The pictures -----
  const artOf = (name: V051ArtName) => {
    const spec = SCREENSHOT_ART[name];
    const bytes = opts.art?.[name];
    return bytes ? { bytes, type: spec.type === 'jpeg' ? 'image/jpeg' : 'image/png', name: spec.name } : { bytes: FLAT, type: 'image/png', name: spec.name };
  };
  const art = { slide: artOf('slide'), slide2: artOf('slide2'), photo: artOf('photo') };
  const shotArt: Record<string, { bytes: Buffer; type: string }> = { [lid(601)]: art.slide, [lid(602)]: art.slide2 };
  // The slides' real sizes in the transcript's records (the picture's own bytes).
  const featured = base.v05.details[base.v05.featured];
  if (featured) {
    base.v05.details[base.v05.featured] = MeetingDetailSchema.parse({
      ...featured,
      shots: featured.shots.map((s) => (shotArt[s.id] ? { ...s, bytes: shotArt[s.id]!.bytes.length } : s)),
    });
  }

  // ----- Routes -----
  const talks = transcripts(now);
  let uploads = 0;
  const v05Answer = base.v04.answer as (method: string, url: URL) => V05Reply | null;
  /** `body`: the request's bytes, when it has any (an upload's kind is read from its first bytes, as the daemon sniffs it). */
  const answer = (method: string, url: URL, body?: Buffer | null): V05Reply | null => {
    const path = url.pathname;
    let m: RegExpExecArray | null;
    if (method === 'GET' && (m = /^\/v1\/sessions\/([^/]+)\/screen$/.exec(path))) {
      const text = screens[decodeURIComponent(m[1]!)];
      if (text === undefined) return null;
      const lines = Math.min(400, Math.max(1, Number(url.searchParams.get('lines') ?? 80) || 80));
      return { status: 200, body: screenReply(text, lines, new Date(now).toISOString()) };
    }
    if (method === 'GET' && (m = /^\/v1\/sessions\/([^/]+)\/transcript$/.exec(path))) {
      const sid = decodeURIComponent(m[1]!);
      return { status: 200, body: talks[sid] ?? transcriptFixture(now) };
    }
    if (method === 'POST' && /^\/v1\/sessions\/[^/]+\/uploads$/.test(path)) {
      uploads += 1;
      const ext = url.searchParams.get('ext');
      // A lowercase ULID's alphabet holds every hex digit.
      const id = createHash('sha256').update(`upload-${uploads}`).digest('hex').slice(0, 26);
      const head = body ? body.subarray(0, 4).toString('latin1') : '';
      const kind = ext && /^(docx?|xlsx?|pptx?)$/.test(ext) ? 'office' : ext ? 'text' : head === '%PDF' ? 'pdf' : 'image';
      return { status: 201, body: { upload: { id, kind, bytes: body?.length ?? 0 } } };
    }
    if (method === 'DELETE' && /^\/v1\/sessions\/[^/]+\/uploads\/[^/]+$/.test(path)) return { status: 200, body: { ok: true } };
    if (ask && method === 'GET' && path === '/v1/ask') return { status: 200, body: ask };
    if (method === 'GET' && (m = /^\/v1\/meetings\/([^/]+)\/shots\/([^/]+)$/.exec(path))) {
      const pic = shotArt[decodeURIComponent(m[2]!)];
      if (pic) return { status: 200, body: null, bytes: pic.bytes, type: pic.type };
    }
    return v05Answer(method, url);
  };

  return {
    ...base,
    v04: { ...base.v04, answer },
    variant,
    art,
    pdf: syntheticPdf(),
    screens,
  };
}
