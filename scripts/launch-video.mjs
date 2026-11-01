#!/usr/bin/env node
// The launch film and the README's GIF, from synthetic data only:
//
//   docs/brand/launch.mp4                1920 x 1080, 30 fps, 53 s, H.264 (High, yuv420p, bt709, faststart), no sound
//   docs/brand/launch.webm               the same in VP9
//   docs/brand/launch-poster.jpg         the film's frame at POSTER_AT, 1920 x 1080
//   docs/brand/launch-narrow.mp4         the phone cut: 1080 x 1920, the same scenes and words, one panel at a time
//   docs/brand/launch-narrow.webm        the same in VP9
//   docs/brand/launch-narrow-poster.jpg  its frame at POSTER_AT, 1080 x 1920
//   docs/brand/demo.gif                  1280 x 720, 15 fps, 14 s, a loop of the same story for the README
//   docs/brand/demo-narrow.gif           720 x 900, the same loop for the README on a phone
//
// The site plays the wide film on a wide screen and the phone cut on a
// narrow one (each viewer loads one); the README picks its GIF the same way.
// On a phone the wide film is a 358 px box with 9 px captions; the narrow
// cut's captions are 64 px of 1080, about 21 px there.
//
// Every product screen is a capture of the BUILT web app (packages/web/dist)
// served the synthetic film fixture (test/integration/web-fixture-film.ts),
// the way scripts/screenshots.mjs takes the README's pictures: the daemon's
// headers, a frozen clock, no daemon, no home folder, an ephemeral
// 127.0.0.1 port. Only the Terminal window, the push and the end card are
// drawn, by the stage (scripts/launch-video/), from the same fixture's text
// and the daemon's own notification code (notify/format.ts).
//
// The stage is one page rendered by playwright-core's own Chromium in a
// context that refuses every request but its own files. Each frame is a
// seek (window.seek(t) sets every transform and opacity for time t) and a
// screenshot, piped losslessly to ffmpeg; the files are encoded from that
// master. No network, no dependency beyond playwright-core and ffmpeg.
//
// Usage (after `pnpm build`):
//   node scripts/launch-video.mjs [--only film,gif,film-narrow,gif-narrow] [--out DIR] [--work DIR] [--reuse]
//                                 [--from S3 --to S4] [--frames DIR] [--check]
//
// --only    which of the four to render (a comma list; default all)
// --out     where the files go (default docs/brand)
// --work    the folder for captures and masters (default: a new temp folder)
// --reuse   take the captures already in --work (stage changes only)
// --from/--to  render only those scenes, to --work/preview.mp4 (the phone cut with --only film-narrow)
// --frames  also write key frames of what was encoded, and a contact sheet, as PNGs there
// --check   validate the script (scenes, captions, captures) and render nothing
//
// ffmpeg comes from $FFMPEG, then /opt/homebrew/bin, /usr/local/bin and PATH.
// Review every frame by eye before committing the files: example data only,
// nothing from v0.6, the words true of this version.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MARK_RECTS, WORDS, fontFaces, tokens } from './brand.mjs';
import { sidOf } from './screenshots.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const CHILD_ENV = 'JANTAR_LAUNCH_VIDEO_CHILD';
const STAGE_DIR = join(here, 'launch-video');

export const FILM = { width: 1920, height: 1080, fps: 30, seconds: 53 };
/** The phone cut: the same scenes and seconds, portrait, a phone's full screen when it plays full screen. */
export const FILM_NARROW = { width: 1080, height: 1920, fps: 30, seconds: FILM.seconds };
/** The GIF's layout is 960 x 540 CSS px, drawn at `scale` (1280 x 720 pixels: sharp when GitHub shows it on a retina screen). */
export const GIF = { width: 960, height: 540, scale: 4 / 3, fps: 15, seconds: 14 };
/** The README's GIF on a phone: a 1080 x 1350 layout drawn at 2/3 (720 x 900 pixels), the same cut and seconds. */
export const GIF_NARROW = { width: 1080, height: 1350, scale: 2 / 3, fps: GIF.fps, seconds: GIF.seconds };

/** What each layout draws (stage.js reads `layout`), at which size, into which files. */
export const LAYOUTS = {
  film: { size: FILM, files: ['mp4', 'webm', 'poster'] },
  'film-narrow': { size: FILM_NARROW, files: ['mp4Narrow', 'webmNarrow', 'posterNarrow'] },
  gif: { size: GIF, files: ['gif'] },
  'gif-narrow': { size: GIF_NARROW, files: ['gifNarrow'] },
};

/** The files this script writes, relative to the repository. */
export const OUT = {
  mp4: 'docs/brand/launch.mp4',
  webm: 'docs/brand/launch.webm',
  poster: 'docs/brand/launch-poster.jpg',
  mp4Narrow: 'docs/brand/launch-narrow.mp4',
  webmNarrow: 'docs/brand/launch-narrow.webm',
  posterNarrow: 'docs/brand/launch-narrow-poster.jpg',
  gif: 'docs/brand/demo.gif',
  gifNarrow: 'docs/brand/demo-narrow.gif',
};

/** Size limits: each cut of the site's film (its MP4, WebM and poster together), and each of the README's GIFs. */
export const LIMITS = { site: 6 * 1024 * 1024, gif: 8 * 1024 * 1024, captionChars: 44, captionLines: 2 };

/** The film's frame the poster is: the card on the phone beside the same prompt on the Mac. */
export const POSTER_AT = 14.0;

/** The website's host, as the end card shows it. */
export const SITE_HOST = 'jantar.namanbuilt.com';

/** The browser that pairs: control scope, so the card's buttons show (as screenshots.mjs). */
const DEVICE = { id: 'dev2', name: 'iPhone', scopes: ['read', 'control', 'launch'] };

const PHONE = { width: 390, height: 844, scale: 2, phone: true };
const DESKTOP = { width: 1440, height: 900, scale: 2, phone: false };

/**
 * What is captured from the real app, night theme only. `stage`: the
 * fixture's stage (web-fixture-film.ts); `boxes`: elements whose place on
 * the screen the stage needs (a tap's target, a row to mark), in CSS px.
 */
export const SHOTS = [
  {
    name: 'card',
    path: `/s/${sidOf(3)}`,
    stage: 'before',
    size: PHONE,
    ready: (page) => page.getByText('pnpm prisma migrate reset --force').first().waitFor(),
    boxes: { yes: (page) => page.getByRole('button', { name: 'Yes', exact: true }) },
  },
  {
    name: 'session-answered',
    path: `/s/${sidOf(3)}`,
    stage: 'answered',
    size: PHONE,
    ready: (page) => page.getByText('pnpm prisma migrate reset --force').first().waitFor(),
    boxes: { back: (page) => page.getByRole('button', { name: 'Back to the board' }) },
  },
  // The board as api-server runs each command of the run, so it can follow the Terminal.
  { name: 'board-answered', path: '/', stage: 'answered', size: PHONE, ready: (page) => page.getByText('2 need you').first().waitFor() },
  { name: 'board-migrating', path: '/', stage: 'migrating', size: PHONE, ready: (page) => page.getByText('2 need you').first().waitFor() },
  { name: 'board-testing', path: '/', stage: 'testing', size: PHONE, ready: (page) => page.getByText('2 need you').first().waitFor() },
  { name: 'board-done', path: '/', stage: 'done', size: PHONE, ready: (page) => page.getByText('2 need you').first().waitFor() },
  { name: 'board-done-desktop', path: '/', stage: 'done', size: DESKTOP, ready: (page) => page.getByText('2 need you').first().waitFor() },
  {
    name: 'accounts',
    path: '/accounts',
    stage: 'before',
    size: PHONE,
    boxes: { rigelRow: 'row:rigel|deneb' },
  },
  // The summary, decisions and action items: never the transcript (its screenshots are not yet confirmed on a real call).
  { name: 'meeting', path: '/meetings?id=01JV0000000000000000000501', stage: 'before', size: PHONE },
  { name: 'today', path: '/today', stage: 'before', size: PHONE },
];

/**
 * The film, scene by scene (seconds). `product`: product screens are on it,
 * so the Example data rail shows. `kicker`: the command that turns the part
 * shown on, where one does. `captions`: at most two lines of at most 44
 * characters; `big` ones sit beside the phone alone. `shots`: the captures
 * it shows. stage.js draws each scene from this.
 */
export const SCENES = [
  {
    id: 'S1',
    start: 0,
    end: 7,
    product: true,
    what: 'Twelve Claude Code tabs in Terminal. The front tab moves along them to api-server, which waits on a Bash prompt to run pnpm prisma migrate reset --force.',
    kicker: 'Terminal.app · 12 tabs',
    captions: [
      { from: 0.6, to: 3.9, lines: ['Twelve Claude Code sessions.', 'Which one is waiting on you?'] },
      { from: 4.3, to: 6.8, lines: ['This one. It sat behind eleven other tabs.'] },
    ],
    shots: [],
  },
  {
    id: 'S2',
    start: 7,
    end: 12,
    product: true,
    what: "The phone gets a push in the daemon's own words, api-server needs you, with the command. A tap on it.",
    kicker: 'jantar hooks install --apply',
    captions: [{ from: 7.6, to: 11.8, lines: ['Your phone tells you which one,', 'and what it wants to run.'] }],
    shots: [],
  },
  {
    id: 'S3',
    start: 12,
    end: 19,
    product: true,
    what: "The same prompt on the phone, as a card with Claude's options as buttons. A tap on Yes, and in Terminal the prompt goes and the command runs.",
    captions: [
      { from: 12.4, to: 15.8, lines: ['The same prompt, on your phone.', 'Answer it there.'] },
      { from: 16.2, to: 18.8, lines: ['The answer goes back', 'through Claude Code itself.'] },
    ],
    shots: ['card', 'session-answered'],
  },
  {
    id: 'S4',
    start: 19,
    end: 26,
    product: true,
    what: "Terminal prints the run: the reset, a migration and the tests. The board follows it, then moves api-server to your turn with Claude's reply.",
    captions: [
      { from: 19.5, to: 22.6, lines: ['The session carries on.'] },
      { from: 23.2, to: 25.8, lines: ['When it finishes, the board says so.'] },
    ],
    shots: ['board-answered', 'board-migrating', 'board-testing', 'board-done'],
  },
  {
    id: 'S5',
    start: 26,
    end: 32,
    product: true,
    what: "Accounts on the phone: each account's 5-hour use against the ceiling and when it resets. One account's row is marked.",
    kicker: 'jantar accounts · cswap optional',
    captions: [{ from: 26.6, to: 31.6, big: true, lines: ['One Claude login, or many with cswap.', "Each one's use, and when it resets."] }],
    shots: ['accounts'],
  },
  {
    id: 'S6',
    start: 32,
    end: 38,
    product: true,
    what: 'The same board in a browser on the Mac and on the phone, the sessions that need you first.',
    kicker: 'jantar open',
    captions: [{ from: 32.6, to: 37.6, lines: ['Every session on one board, on the Mac too.', 'The ones that need you first.'] }],
    shots: ['board-done-desktop', 'board-done'],
  },
  {
    id: 'S7',
    start: 38,
    end: 43,
    product: true,
    what: "A meeting's summary, decisions and action items on the phone.",
    kicker: 'jantar meetings on',
    captions: [{ from: 38.5, to: 42.6, big: true, lines: ['Meet and Teams notes from live captions.', 'A summary after the call. No audio.'] }],
    shots: ['meeting'],
  },
  {
    id: 'S8',
    start: 43,
    end: 47,
    product: true,
    what: "Today on the phone: two medicines due at 13:00 and the day's todos.",
    kicker: 'jantar life on medicines todos',
    captions: [{ from: 43.4, to: 46.6, big: true, lines: ['A small life list beside the board.', 'Off until you switch it on.'] }],
    shots: ['today'],
  },
  {
    id: 'S9',
    start: 47,
    end: 53,
    product: false,
    what: "The end card: Jantar's mark and name, its line, the site's address, the license and version, and Example data throughout.",
    captions: [],
    shots: [],
  },
];

/** The README's GIF: the same story in 14 seconds, cuts and slides only, ending on its first frame. */
export const GIF_CUT = [
  { id: 'G0', start: 0, end: 1.2, from: 'S9', product: false, captions: [] },
  { id: 'G1', start: 1.2, end: 3.8, from: 'S1', product: true, captions: [{ from: 1.4, to: 3.7, lines: ['One of twelve tabs is waiting on you.'] }] },
  { id: 'G2', start: 3.8, end: 6.2, from: 'S2', product: true, captions: [{ from: 4.0, to: 6.1, lines: ['Your phone tells you which one.'] }] },
  { id: 'G3', start: 6.2, end: 10.0, from: 'S3', product: true, captions: [{ from: 6.4, to: 9.9, lines: ['Answer it from the phone.'] }] },
  { id: 'G4', start: 10.0, end: 12.6, from: 'S4', product: true, captions: [{ from: 10.2, to: 12.5, lines: ['It carries on. The board shows it.'] }] },
  { id: 'G5', start: 12.6, end: 14.0, from: 'S9', product: false, captions: [] },
];

/** The end card's words; the version is package.json's at render time. */
export function endCard(version = readVersion()) {
  return {
    name: WORDS.name,
    tagline: WORDS.tagline,
    url: SITE_HOST,
    meta: `Free · source-available (FSL-1.1-MIT) · v${version} · macOS and Terminal.app`,
    foot: 'Example data throughout. Not affiliated with Anthropic.',
  };
}

export function readVersion() {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
}

// ---------------------------------------------------------------------------
// The checks the script and its test share

/** Words the site's copy keeps out, and marks it never uses. */
const HYPE = /\b(?:revolutionary|seamless(?:ly)?|effortless(?:ly)?|blazing|magic(?:al)?|supercharge\w*|game[- ]chang\w*|ultimate|powerful|unleash\w*|next[- ]level)\b/i;
const OPEN_SOURCE = /\bopen[- ]source\b/i;

/** Problems in the scenes, the GIF's cut and the captures they name; [] when there are none. */
export function checkScript({ scenes = SCENES, cut = GIF_CUT, shots = SHOTS, film = FILM, gif = GIF, commands = cliCommands() } = {}) {
  const out = [];
  const names = new Set(shots.map((s) => s.name));
  const line = (where, text) => {
    if ([...text].length > LIMITS.captionChars) out.push(`${where}: "${text}" is over ${LIMITS.captionChars} characters`);
    if (/[–—]/.test(text)) out.push(`${where}: "${text}" has an en or em dash`);
    if (text.includes('!')) out.push(`${where}: "${text}" has an exclamation mark`);
    if (HYPE.test(text)) out.push(`${where}: "${text}" has a hype word`);
    if (OPEN_SOURCE.test(text)) out.push(`${where}: "${text}" says open source (Jantar is source-available)`);
  };
  const timeline = (list, length, label) => {
    let at = 0;
    for (const s of list) {
      if (s.start !== at) out.push(`${label} ${s.id} starts at ${s.start}, not ${at}`);
      if (!(s.end > s.start)) out.push(`${label} ${s.id} ends before it starts`);
      at = s.end;
      for (const [i, c] of (s.captions ?? []).entries()) {
        const where = `${s.id} caption ${i + 1}`;
        if (!Array.isArray(c.lines) || c.lines.length < 1 || c.lines.length > LIMITS.captionLines) out.push(`${where}: 1 to ${LIMITS.captionLines} lines`);
        for (const l of c.lines ?? []) line(where, l);
        if (!(c.from >= s.start && c.to <= s.end && c.to > c.from)) out.push(`${where}: ${c.from} to ${c.to} is not inside ${s.start} to ${s.end}`);
      }
      if (s.captions?.length > 0 && !s.product && s.id !== 'S9') out.push(`${label} ${s.id}: captions on a scene with no product`);
    }
    if (Math.abs(at - length) > 1e-9) out.push(`${label}s end at ${at}, not ${length}`);
  };
  timeline(scenes, film.seconds, 'scene');
  timeline(cut, gif.seconds, 'gif part');
  if (film.seconds < 40 || film.seconds > 60) out.push(`the film is ${film.seconds} s, not 40 to 60`);
  if (gif.seconds < 10 || gif.seconds > 15) out.push(`the GIF is ${gif.seconds} s, not 10 to 15`);
  for (const s of scenes) {
    if (s.kicker) {
      line(`${s.id} kicker`, s.kicker);
      const m = /^jantar ([a-z-]+)/.exec(s.kicker);
      if (m && !commands.includes(m[1])) out.push(`${s.id} kicker: jantar ${m[1]} is not a command in packages/cli/src/commands`);
    }
    for (const n of s.shots ?? []) if (!names.has(n)) out.push(`${s.id} shows ${n}, which is not captured`);
    if (!s.what) out.push(`${s.id} says nothing of what it shows`);
  }
  const ids = new Set(scenes.map((s) => s.id));
  for (const g of cut) if (!ids.has(g.from)) out.push(`gif part ${g.id} is cut from ${g.from}, which is no scene`);
  if (cut[0]?.from !== cut.at(-1)?.from) out.push('the GIF does not end where it starts, so its loop jumps');
  if (!(POSTER_AT >= 0 && POSTER_AT < film.seconds)) out.push(`the poster at ${POSTER_AT} s is not in the film`);
  for (const [k, v] of Object.entries(OUT)) if (!v.startsWith('docs/brand/')) out.push(`${k} is not in docs/brand`);
  return out;
}

/** The CLI's command names (packages/cli/src/commands/<name>.ts). */
export function cliCommands() {
  const dir = join(root, 'packages', 'cli', 'src', 'commands');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
    .map((f) => f.slice(0, -3));
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    out: join(root, 'docs', 'brand'),
    dist: join(root, 'packages', 'web', 'dist'),
    work: null,
    reuse: false,
    only: null,
    from: null,
    to: null,
    frames: null,
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    if (a === '--out') out.out = resolve(value());
    else if (a === '--dist') out.dist = resolve(value());
    else if (a === '--work') out.work = resolve(value());
    else if (a === '--reuse') out.reuse = true;
    else if (a === '--only') out.only = value();
    else if (a === '--from') out.from = value();
    else if (a === '--to') out.to = value();
    else if (a === '--frames') out.frames = resolve(value());
    else if (a === '--check') out.check = true;
    else fail(`unknown argument ${a}`);
  }
  const kinds = Object.keys(LAYOUTS);
  out.only = out.only ? out.only.split(',').map((x) => x.trim()) : null;
  for (const o of out.only ?? []) if (!kinds.includes(o)) fail(`--only takes ${kinds.join(', ')} (a comma list)`);
  if ((out.from || out.to) && out.only && (out.only.length !== 1 || !out.only[0].startsWith('film'))) fail('--from/--to take one film: --only film or --only film-narrow');
  if ((out.from || out.to) && !SCENES.some((s) => s.id === (out.from ?? out.to))) fail(`--from/--to take a scene id (${SCENES.map((s) => s.id).join(', ')})`);
  if (out.reuse && !out.work) fail('--reuse needs --work (the folder that holds the captures)');
  return out;
}

function fail(message, code = 2) {
  process.stderr.write(`launch-video: ${message}\n`);
  process.exit(code);
}

const shown = (file) => (file.startsWith(`${root}/`) ? relative(root, file) : file);
const log = (s) => process.stdout.write(`${s}\n`);
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

/** Run this file again under tsx, so it can import the TypeScript fixture and the daemon's notify code. */
function relaunch() {
  const tsx = join(root, 'packages', 'cli', 'node_modules', '.bin', 'tsx');
  if (!existsSync(tsx)) fail('tsx is missing: run pnpm install first');
  const r = spawnSync(tsx, ['--tsconfig', join(root, 'test', 'integration', 'tsconfig.json'), fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, [CHILD_ENV]: '1' },
  });
  process.exit(r.status ?? 1);
}

function findFfmpeg() {
  const candidates = [process.env.FFMPEG, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['-hide_banner', '-version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return fail('ffmpeg is missing: install it (Homebrew: brew install ffmpeg) or set FFMPEG', 1);
}

function ffmpegSync(ffmpeg, args, what) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg (${what}) failed: ${r.stderr || r.status}`);
}

// ---------------------------------------------------------------------------
// 1. Captures from the real app

/**
 * The box of a locator, or of a row: `row:<name>|<next>` is the largest
 * element round the text <name> that does not also hold <next> (the row
 * below it), so the box is the whole row, bars included.
 */
async function boxOf(page, spec) {
  if (typeof spec === 'string' && spec.startsWith('row:')) {
    const [text, next] = spec.slice(4).split('|');
    return page.evaluate(
      ([t, n]) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.textContent?.trim() !== t) continue;
          let el = node.parentElement;
          while (el?.parentElement && !el.parentElement.textContent?.includes(n)) el = el.parentElement;
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }
        return null;
      },
      [text, next],
    );
  }
  const loc = spec(page);
  await loc.waitFor({ timeout: 10_000 });
  return loc.boundingBox();
}

async function capture(opts, work) {
  const dist = opts.dist;
  if (!existsSync(join(dist, 'index.html'))) fail(`${shown(dist)} has no index.html: run pnpm build first`);
  const dir = join(work, 'captures');
  mkdirSync(dir, { recursive: true });
  const { serveWebApp } = await import(pathToFileURL(join(root, 'test', 'integration', 'web-server.ts')).href);
  const mod = await import(pathToFileURL(join(root, 'test', 'integration', 'web-fixture-film.ts')).href);
  const { chromium } = await import('playwright-core');
  const manifest = { shots: {}, terminal: mod.FILM_TERMINAL };
  let browser;
  let server;
  try {
    browser = await chromium.launch();
    const art = await drawArt(browser, mod.SCREENSHOT_ART);
    const fixtures = Object.fromEntries(mod.FILM_STAGES.map((stage) => [stage, mod.webFixtureFilm({ accounts: 'cswap', variant: 'default', art, stage })]));
    // The push, as the daemon writes it for the card (bodies: full, the default).
    const { cardNotification, hhmm } = await import(pathToFileURL(join(root, 'packages', 'daemon', 'src', 'notify', 'format.ts')).href);
    const before = fixtures.before;
    const card = Object.values(before.state.state.pending).find((p) => p.sid === mod.FILM_SID);
    const push = cardNotification(card, before.state.state.sessions[mod.FILM_SID], 'full', new Date(before.now).toISOString());
    manifest.push = { title: push.title, body: push.body, clock: hhmm(new Date(before.now).toISOString(), before.timezone) };
    let current = before;
    server = await serveWebApp(dist, () => current);
    for (const shot of SHOTS) {
      const fixture = fixtures[shot.stage];
      current = fixture;
      const size = shot.size;
      const ctx = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: size.scale,
        isMobile: size.phone,
        hasTouch: size.phone,
        colorScheme: 'dark',
        locale: 'en-GB',
        timezoneId: fixture.timezone,
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      try {
        await ctx.clock.setFixedTime(fixture.now);
        await ctx.addInitScript((device) => {
          try {
            localStorage.setItem('jantar:device', JSON.stringify(device));
          } catch {
            // no storage: Life then asks the Mac and gets the same answers
          }
        }, DEVICE);
        await ctx.routeWebSocket((url) => url.pathname === '/v1/events', () => undefined);
        await ctx.route(
          (url) => url.pathname.startsWith('/v1/'),
          async (route) => {
            const req = route.request();
            // Nothing is written: the captures only look (a stray write would be refused here).
            if (req.method() !== 'GET') return route.fulfill({ status: 409, contentType: 'application/json; charset=utf-8', body: '{"error":{"code":"conflict","message":"film"}}' });
            const reply = fixture.v04.answer(req.method(), new URL(req.url()), req.postDataBuffer());
            if (!reply) return route.continue();
            if (reply.bytes) return route.fulfill({ status: reply.status, contentType: reply.type, body: reply.bytes });
            return route.fulfill({ status: reply.status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(reply.body) });
          },
        );
        const page = await ctx.newPage();
        await page.goto(`${server.base}${shot.path}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(600);
        if (shot.ready) await shot.ready(page);
        await page.waitForTimeout(400);
        const boxes = {};
        for (const [k, spec] of Object.entries(shot.boxes ?? {})) {
          const b = await boxOf(page, spec);
          if (!b) throw new Error(`${shot.name}: no box for ${k}`);
          boxes[k] = b;
        }
        const file = join(dir, `${shot.name}.png`);
        await page.screenshot({ path: file });
        manifest.shots[shot.name] = { file: `${shot.name}.png`, width: size.width, height: size.height, boxes };
        log(`  captured ${shot.name}  ${size.width}x${size.height}@${size.scale}x  ${shot.stage}  ${shot.path}`);
      } finally {
        await ctx.close();
      }
    }
    if (server.misses.length) log(`  (the fixture had no answer for: ${[...new Set(server.misses)].join(', ')})`);
  } finally {
    await browser?.close().catch(() => undefined);
    await server?.close();
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** The fixture's pictures (SCREENSHOT_ART: a meeting's slides), drawn as screenshots.mjs draws them. */
async function drawArt(browser, specs) {
  const out = {};
  const faces = fontFaces();
  for (const [name, a] of Object.entries(specs ?? {})) {
    const ctx = await browser.newContext({ viewport: { width: a.width, height: a.height }, deviceScaleFactor: 1, serviceWorkers: 'block', reducedMotion: 'reduce' });
    try {
      await ctx.route('**/*', (route) => route.abort());
      const page = await ctx.newPage();
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${faces}\n${a.css}</style></head><body>${a.html}</body></html>`);
      await page.evaluate(() => document.fonts.ready);
      out[name] = await page.screenshot(a.type === 'jpeg' ? { type: 'jpeg', quality: 84 } : { type: 'png' });
    } finally {
      await ctx.close();
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. The stage, frame by frame

const ORIGIN = 'https://stage.invalid/';

/** The night tokens as --t-* custom properties. */
function tokenCss() {
  const t = tokens('dark');
  const vars = Object.entries(t)
    .filter(([k]) => k !== '--shadow-float-v')
    .map(([k, v]) => `  --t-${k.slice(2)}: ${v};`);
  return `:root {\n${vars.join('\n')}\n}\n`;
}

/** Every file the stage page may load, by path: name -> { type, bytes }. */
function stageFiles(work, manifest, layout, version) {
  const files = new Map();
  const add = (path, type, bytes) => files.set(path, { type, bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes) });
  add('stage.html', 'text/html; charset=utf-8', readFileSync(join(STAGE_DIR, 'stage.html')));
  add('stage.css', 'text/css; charset=utf-8', readFileSync(join(STAGE_DIR, 'stage.css')));
  add('stage.js', 'text/javascript; charset=utf-8', readFileSync(join(STAGE_DIR, 'stage.js')));
  add('fonts.css', 'text/css; charset=utf-8', fontFaces());
  add('tokens.css', 'text/css; charset=utf-8', tokenCss());
  const shots = {};
  for (const [name, s] of Object.entries(manifest.shots)) {
    add(`shot/${s.file}`, 'image/png', readFileSync(join(work, 'captures', s.file)));
    shots[name] = { src: `shot/${s.file}`, width: s.width, height: s.height, boxes: s.boxes };
  }
  const data = {
    layout,
    size: LAYOUTS[layout].size,
    scenes: SCENES,
    cut: GIF_CUT,
    shots,
    terminal: manifest.terminal,
    push: manifest.push,
    end: endCard(version),
    mark: MARK_RECTS,
  };
  add('data.js', 'text/javascript; charset=utf-8', `window.STAGE = ${JSON.stringify(data)};\n`);
  return files;
}

async function openStage(browser, files, size) {
  const ctx = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.scale ?? 1,
    colorScheme: 'dark',
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
  });
  // Sealed: the stage's own files from memory, every other request refused.
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    const f = url.startsWith(ORIGIN) ? files.get(url.slice(ORIGIN.length).split('?')[0]) : null;
    return f ? route.fulfill({ status: 200, contentType: f.type, body: f.bytes }) : route.abort();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${ORIGIN}stage.html`, { waitUntil: 'load' });
  await page.evaluate(() => window.stageReady);
  if (errors.length) throw new Error(`the stage failed: ${errors.join('; ')}`);
  return { ctx, page, errors };
}

/** Render frames [first, last) to a lossless master (FFV1 in Matroska). */
async function renderMaster(ffmpeg, page, { fps, first, last, file, label }) {
  const enc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-', '-c:v', 'ffv1', '-level', '3', file], {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  const done = new Promise((res, rej) => {
    enc.on('error', rej);
    enc.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg (${label} master) exited ${code}`))));
  });
  const write = (buf) => new Promise((res, rej) => (enc.stdin.write(buf, (e) => (e ? rej(e) : res())) ? undefined : enc.stdin.once('drain', res)));
  // A frame that looks like one already drawn (the same signature from window.seek) reuses its picture.
  const drawn = new Map();
  const t0 = Date.now();
  for (let f = first; f < last; f++) {
    const sig = await page.evaluate((t) => window.seek(t), f / fps);
    let buf = drawn.get(sig);
    if (!buf) {
      buf = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
      drawn.set(sig, buf);
    }
    await write(buf);
    if ((f - first) % (fps * 5) === 0) process.stdout.write(`  ${label} ${(f / fps).toFixed(1)} s\r`);
  }
  enc.stdin.end();
  await done;
  log(`  ${label}: ${last - first} frames (${drawn.size} drawn) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

// ---------------------------------------------------------------------------
// 3. Encoding

const BT709 = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
/** RGB to BT.709 limited-range 4:2:0, the frames tagged so players keep the needs-you red and the mustard. */
const YUV = 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';

function encodeMp4(ffmpeg, master, out, crf) {
  ffmpegSync(
    ffmpeg,
    ['-i', master, '-vf', YUV, '-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.1', '-preset', 'veryslow', '-tune', 'animation', '-crf', String(crf), '-g', '60', '-movflags', '+faststart', '-an', ...BT709, out],
    'mp4',
  );
}

function encodeWebm(ffmpeg, master, out, crf, work) {
  const common = ['-i', master, '-vf', YUV, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(crf), '-row-mt', '1', '-tile-columns', '2', '-g', '150', '-an', ...BT709];
  const passlog = join(work, 'vp9pass');
  ffmpegSync(ffmpeg, [...common, '-deadline', 'good', '-cpu-used', '4', '-pass', '1', '-passlogfile', passlog, '-f', 'webm', '/dev/null'], 'webm pass 1');
  ffmpegSync(ffmpeg, [...common, '-deadline', 'good', '-cpu-used', '1', '-pass', '2', '-passlogfile', passlog, out], 'webm pass 2');
}

function encodePoster(ffmpeg, master, out, frame) {
  ffmpegSync(ffmpeg, ['-i', master, '-vf', `select=eq(n\\,${frame})`, '-fps_mode', 'passthrough', '-frames:v', '1', '-q:v', '3', out], 'poster');
}

function encodeGif(ffmpeg, master, out, colors) {
  ffmpegSync(
    ffmpeg,
    [
      '-i',
      master,
      '-filter_complex',
      `split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=full:reserve_transparent=0[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
      '-loop',
      '0',
      out,
    ],
    'gif',
  );
}

const statSize = (f) => (existsSync(f) ? statSync(f).size : 0);

/** Key frames of what was encoded, and a contact sheet (one frame a second), as PNGs in `dir`. */
function writeFrames(ffmpeg, dir, { mp4, gif, film, cut }) {
  mkdirSync(dir, { recursive: true });
  const at = (file, t, name) => ffmpegSync(ffmpeg, ['-ss', t.toFixed(3), '-i', file, '-frames:v', '1', join(dir, name)], `frame ${name}`);
  if (mp4 && existsSync(mp4)) {
    const times = [];
    for (const s of film) {
      times.push(s.start + 0.2);
      for (const c of s.captions) times.push((c.from + c.to) / 2);
    }
    times.push(POSTER_AT, 15.45, 28.6, 47.6, 52.9);
    for (const t of [...new Set(times.map((x) => Math.round(x * 10) / 10))].sort((a, b) => a - b)) at(mp4, t, `film-${t.toFixed(1).padStart(4, '0')}.png`);
    ffmpegSync(ffmpeg, ['-i', mp4, '-vf', 'fps=1,scale=480:-1,tile=6x9', '-frames:v', '1', join(dir, 'contact-film.png')], 'contact sheet');
  }
  if (gif && existsSync(gif)) {
    const times = [0.1];
    for (const g of cut) for (const c of g.captions) times.push((c.from + c.to) / 2);
    times.push(7.95, 8.1, 13.3, 13.95);
    for (const t of times) at(gif, t, `gif-${t.toFixed(2).padStart(5, '0')}.png`);
    ffmpegSync(ffmpeg, ['-i', gif, '-vf', 'fps=2,scale=640:-1,tile=4x7', '-frames:v', '1', join(dir, 'contact-gif.png')], 'gif contact sheet');
  }
  log(`  frames in ${dir}`);
}

/** Key frames of a narrow render, named after its wide twin's (film-narrow-14.0.png). */
function writeNarrowFrames(ffmpeg, dir, { mp4, gif, film, cut }) {
  mkdirSync(dir, { recursive: true });
  const at = (file, t, name) => ffmpegSync(ffmpeg, ['-ss', t.toFixed(3), '-i', file, '-frames:v', '1', join(dir, name)], `frame ${name}`);
  if (mp4 && existsSync(mp4)) {
    const times = [];
    for (const s of film) {
      times.push(s.start + 0.2);
      for (const c of s.captions) times.push((c.from + c.to) / 2);
    }
    times.push(POSTER_AT, 11.6, 15.5, 16.4, 21.2, 23.6, 28.4, 35.8, 47.6, 52.9);
    for (const t of [...new Set(times.map((x) => Math.round(x * 10) / 10))].sort((a, b) => a - b)) at(mp4, t, `film-narrow-${t.toFixed(1).padStart(4, '0')}.png`);
    ffmpegSync(ffmpeg, ['-i', mp4, '-vf', 'fps=1,scale=270:-1,tile=9x6', '-frames:v', '1', join(dir, 'contact-film-narrow.png')], 'narrow contact sheet');
  }
  if (gif && existsSync(gif)) {
    const times = [0.1];
    for (const g of cut) for (const c of g.captions) times.push((c.from + c.to) / 2);
    times.push(7.6, 7.95, 8.1, 11.0, 11.6, 13.3, 13.95);
    for (const t of times) at(gif, t, `gif-narrow-${t.toFixed(2).padStart(5, '0')}.png`);
    ffmpegSync(ffmpeg, ['-i', gif, '-vf', 'fps=2,scale=240:-1,tile=7x4', '-frames:v', '1', join(dir, 'contact-gif-narrow.png')], 'narrow gif contact sheet');
  }
}

// ---------------------------------------------------------------------------

/**
 * The crf ladders: each file's crf raised until it fits its share of the
 * cut's 6 MB. The phone cut gets less, since a phone loads it over a mobile
 * connection (and only one of its MP4 and WebM).
 */
const MB = 1024 * 1024;
const BUDGET = {
  film: { mp4: { crfs: [24, 26, 28, 30], max: 3.2 * MB }, webm: { crfs: [34, 37, 40, 44], max: 2.4 * MB } },
  'film-narrow': { mp4: { crfs: [26, 28, 30, 32], max: 2.5 * MB }, webm: { crfs: [37, 40, 43, 46], max: 1.8 * MB } },
};

async function main(opts) {
  const problems = checkScript();
  if (problems.length) fail(`the script has problems:\n  ${problems.join('\n  ')}`, 1);
  if (opts.check) {
    log(`launch-video: ${SCENES.length} scenes (${FILM.seconds} s), ${GIF_CUT.length} GIF parts (${GIF.seconds} s), ${SHOTS.length} captures: ok`);
    return;
  }
  const ffmpeg = findFfmpeg();
  const work = opts.work ?? mkdtempSync(join(tmpdir(), 'jantar-launch-video-'));
  mkdirSync(work, { recursive: true });
  log(`launch-video: working in ${work}`);
  const version = readVersion();

  let manifest;
  if (opts.reuse) {
    const m = join(work, 'captures', 'manifest.json');
    if (!existsSync(m)) fail(`${m} is missing: run once without --reuse`);
    manifest = JSON.parse(readFileSync(m, 'utf8'));
  } else {
    log('1. captures');
    manifest = await capture(opts, work);
  }

  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch();
  const made = {};
  const wants = (layout) => !opts.only || opts.only.includes(layout);
  const file = (k) => join(opts.out, basename(OUT[k]));
  try {
    const preview = opts.from || opts.to;
    for (const layout of ['film', 'film-narrow']) {
      if (!wants(layout) || (preview && layout === 'film-narrow' && !opts.only)) continue;
      const size = LAYOUTS[layout].size;
      const [kMp4, kWebm, kPoster] = LAYOUTS[layout].files;
      log(preview ? `2. preview (${layout})` : `2. ${layout}`);
      const files = stageFiles(work, manifest, layout, version);
      const { ctx, page } = await openStage(browser, files, size);
      try {
        const first = opts.from ? Math.round(SCENES.find((s) => s.id === opts.from).start * size.fps) : 0;
        const last = opts.to ? Math.round(SCENES.find((s) => s.id === opts.to).end * size.fps) : size.seconds * size.fps;
        const master = join(work, preview ? 'preview.mkv' : `${layout}.mkv`);
        await renderMaster(ffmpeg, page, { fps: size.fps, first, last, file: master, label: layout });
        if (preview) {
          const out = join(work, 'preview.mp4');
          encodeMp4(ffmpeg, master, out, 20);
          log(`  ${out}  ${mb(statSize(out))}`);
          const shifted = SCENES.filter((s) => s.start * size.fps >= first && s.end * size.fps <= last).map((s) => ({
            ...s,
            start: s.start - first / size.fps,
            captions: s.captions.map((c) => ({ ...c, from: c.from - first / size.fps, to: c.to - first / size.fps })),
          }));
          if (opts.frames) (layout === 'film' ? writeFrames : writeNarrowFrames)(ffmpeg, opts.frames, { mp4: out, film: shifted, cut: [] });
          return;
        }
        mkdirSync(opts.out, { recursive: true });
        made[kMp4] = file(kMp4);
        made[kWebm] = file(kWebm);
        made[kPoster] = file(kPoster);
        encodePoster(ffmpeg, master, made[kPoster], Math.round(POSTER_AT * size.fps));
        const budget = BUDGET[layout];
        for (const crf of budget.mp4.crfs) {
          encodeMp4(ffmpeg, master, made[kMp4], crf);
          log(`  ${basename(made[kMp4])} crf ${crf}: ${kb(statSize(made[kMp4]))}`);
          if (statSize(made[kMp4]) <= budget.mp4.max) break;
        }
        for (const crf of budget.webm.crfs) {
          encodeWebm(ffmpeg, master, made[kWebm], crf, work);
          log(`  ${basename(made[kWebm])} crf ${crf}: ${kb(statSize(made[kWebm]))}`);
          if (statSize(made[kWebm]) <= budget.webm.max) break;
        }
      } finally {
        await ctx.close();
      }
    }
    for (const layout of ['gif', 'gif-narrow']) {
      if (!wants(layout) || preview) continue;
      const size = LAYOUTS[layout].size;
      const [kGif] = LAYOUTS[layout].files;
      log(`3. ${layout}`);
      const files = stageFiles(work, manifest, layout, version);
      const { ctx, page } = await openStage(browser, files, size);
      try {
        const master = join(work, `${layout}.mkv`);
        await renderMaster(ffmpeg, page, { fps: size.fps, first: 0, last: size.seconds * size.fps, file: master, label: layout });
        mkdirSync(opts.out, { recursive: true });
        made[kGif] = file(kGif);
        for (const colors of [128, 96, 64]) {
          encodeGif(ffmpeg, master, made[kGif], colors);
          if (statSize(made[kGif]) <= 1.5 * 1024 * 1024) break;
        }
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  // Gates: each cut of the film in 6 MB, each GIF in 8 MB.
  for (const f of Object.values(made)) log(`  ${shown(f)}  ${kb(statSize(f))}`);
  const over = [];
  for (const layout of ['film', 'film-narrow']) {
    const keys = LAYOUTS[layout].files;
    if (!keys.every((key) => made[key])) continue;
    const total = keys.reduce((n, key) => n + statSize(made[key]), 0);
    log(`  ${layout} total ${mb(total)} (limit ${mb(LIMITS.site)})`);
    if (total > LIMITS.site) over.push(`${layout}'s files are ${mb(total)}, over ${mb(LIMITS.site)}`);
  }
  for (const key of ['gif', 'gifNarrow']) if (made[key] && statSize(made[key]) > LIMITS.gif) over.push(`${shown(made[key])} is ${mb(statSize(made[key]))}, over ${mb(LIMITS.gif)}`);
  if (opts.frames) {
    writeFrames(ffmpeg, opts.frames, { mp4: made.mp4, gif: made.gif, film: SCENES, cut: GIF_CUT });
    writeNarrowFrames(ffmpeg, opts.frames, { mp4: made.mp4Narrow, gif: made.gifNarrow, film: SCENES, cut: GIF_CUT });
  }
  if (over.length) fail(over.join('; '), 1);
  log('Review every frame by eye before committing: example data only, and every word true of this version.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.check) {
    main(opts).catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e), 1));
  } else if (process.env[CHILD_ENV] !== '1') relaunch();
  else
    main(opts).catch((e) => {
      process.stderr.write(`launch-video: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exit(1);
    });
}
