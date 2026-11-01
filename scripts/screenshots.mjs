#!/usr/bin/env node
// The README's and docs' pictures (spec O12), from synthetic data only:
// serves the BUILT web app (packages/web/dist) with the daemon's real headers
// and a synthetic fixture (test/integration/web-server.ts and, by default,
// test/integration/web-fixture-v051.ts: v0.5's data with the v0.4.2 screens),
// opens it in headless Chromium (playwright-core) and writes, for every
// screen in SHOTS and every size it asks for:
//
//   docs/img/<screen>-phone.png          390 x 844 at 2x, day theme
//   docs/img/<screen>-phone-dark.png     the same at night
//   docs/img/<screen>-desktop.png        1440 x 900 at 1x, day theme
//   docs/img/<screen>-desktop-dark.png   the same at night
//
// The browser's clock is frozen at the fixture's `now` in its time zone,
// this browser holds a control-scope device (so Life and the project chips
// load), the event stream is accepted (the status bar says live), and the
// v0.4, v0.4.2 and v0.5 routes are answered from the fixture's `v04.answer`
// before a request reaches the server (a picture's bytes as `{ bytes, type }`).
// A screen with `steps` is opened that far by hand (the dose sheet, Resume's
// Last, a typed answer, two keypad moves, two attachments).
//
// Each shot names its fixture: `accounts` (cswap, the default, or one Claude
// login) and `variant` (web-fixture-v051.ts: 'phone-control' has sessions
// waiting in the terminal with no hook card, 'keypad' a screen with no
// buttons, 'ask' Ask on with a history, 'posts' v0.7's Posts on with a
// week of made-up posts). One fixture is built per accounts
// and variant pair. With cswap
// the fixture shows Jantar without the legacy ccw tool, as anyone else runs
// it: no `next →`, burn, moves or hold list.
//
// A fixture module may export SCREENSHOT_ART: pictures as HTML (a meeting's
// slides, a phone photo for the composer). They are drawn first, in the same
// Chromium, with the app's own fonts and no network, and handed to the
// fixture as `art` (name -> bytes).
//
// It talks to no daemon, reads nothing from your home, and listens on an
// ephemeral 127.0.0.1 port only. Review every picture by eye before
// committing it: nothing real may be in one. Then run scripts/brand.mjs,
// which frames some of these pictures in the banner and the social preview.
//
// Usage (after `pnpm build`):
//   node scripts/screenshots.mjs [--out DIR] [--dist DIR] [--fixture FILE] [--export NAME] [--only today,meds-phone,...] [--list]
//
// --only takes screen names (every variant) or file names without .png.
// --list prints the file names it would write, and runs nothing.
// --dist serves another build of the web app than packages/web/dist.
// The fixture module's export is called with `{ accounts, variant, art }`
// and returns what serveWebApp() serves plus `v04`, `now` and `timezone`.
// The fixtures are TypeScript, so the script runs itself again under tsx
// (packages/cli's), with test/integration's tsconfig for the @jantar/* paths.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fontFaces } from './brand.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const CHILD_ENV = 'JANTAR_SCREENSHOTS_CHILD';

/** What this browser learned when it paired (ui/screens/devices/local.ts): Life needs control. */
const DEVICE = { id: 'dev2', name: 'iPhone', scopes: ['read', 'control', 'launch'] };

export const SIZES = [
  { key: 'phone', width: 390, height: 844, scale: 2, phone: true },
  { key: 'desktop', width: 1440, height: 900, scale: 1, phone: false },
];
export const THEMES = ['light', 'dark'];
/** The sizes a shot takes when it names none. */
export const DEFAULT_SIZES = ['phone', 'desktop'];
const PHONE = ['phone'];

/** The fixture's session ids (web-fixture.ts sidOf): 1 a question, 2 a plan, 3 a Bash command, 4 your turn. */
export function sidOf(n) {
  const p = String(n).padStart(4, '0');
  return `a1b2c3d4-${p}-4000-8000-00000000${p}`;
}

/** The terminal dock's rows (TermDialog.tsx): Claude's options as buttons in one group. */
const choices = (page) => page.getByRole('group', { name: 'Choices' });
/** A tap within 500 ms of the rows showing is dropped (TAP_GUARD_MS): wait past it, as a person would. */
const LOOK_MS = 800;

/**
 * The screens, in README order. `sizes`: which of SIZES (default both);
 * `accounts`: which accounts fixture (cswap, the default, or one Claude
 * login); `variant`: the fixture's variant (default none); `steps(page,
 * fixture)`: what to do once the screen has loaded.
 */
export const SHOTS = [
  { name: 'board', path: '/' },
  // The Bash permission as a hook card: Yes, the always-allow row (held 2 s) and No.
  {
    name: 'card',
    path: `/s/${sidOf(3)}`,
    sizes: PHONE,
    steps: async (page) => {
      await page.getByText('pnpm prisma migrate reset --force').first().waitFor();
    },
  },
  // The same three sessions waiting in the terminal with no hook card: the dock reads the screen.
  {
    name: 'dialog-plan',
    path: `/s/${sidOf(2)}`,
    sizes: PHONE,
    variant: 'phone-control',
    // A plan this short shows open; folded, the whole dock fits the phone (the transcript above says what it does).
    steps: async (page) => {
      await choices(page).getByRole('button', { name: /^Yes, manually approve edits/ }).waitFor();
      await page.getByRole('button', { name: /Read the plan/ }).click();
    },
  },
  {
    name: 'dialog-question',
    path: `/s/${sidOf(1)}`,
    sizes: PHONE,
    variant: 'phone-control',
    steps: async (page) => {
      const type = choices(page).getByRole('button', { name: /^Type something/ });
      await type.waitFor();
      await page.waitForTimeout(LOOK_MS);
      await type.click();
      await page.getByLabel('Your answer').fill('put it in auth/, next to the refresh logic');
    },
  },
  {
    name: 'dialog-permission',
    path: `/s/${sidOf(3)}`,
    sizes: PHONE,
    variant: 'phone-control',
    steps: async (page) => {
      await choices(page).getByRole('button', { name: /^Yes, and don’t ask again/ }).waitFor();
    },
  },
  // A list Jantar can't turn into buttons: the screen's lines and the keypad, two moves down.
  {
    name: 'keypad',
    path: `/s/${sidOf(2)}`,
    sizes: PHONE,
    variant: 'keypad',
    steps: async (page) => {
      const down = page.getByRole('button', { name: 'Down', exact: true });
      await down.waitFor();
      await page.waitForTimeout(LOOK_MS);
      await down.click();
      await down.click();
    },
  },
  // The composer with a photo and a PDF attached (both uploaded) and a prompt typed.
  {
    name: 'attach',
    path: `/s/${sidOf(4)}`,
    sizes: PHONE,
    steps: async (page, fixture) => {
      const photo = fixture.art?.photo;
      if (!photo || !fixture.pdf) throw new Error('the attach shot needs a fixture with art.photo and pdf (web-fixture-v051.ts)');
      await page
        .locator('form[aria-label="Send a prompt"] input[type="file"]')
        .first()
        .setInputFiles([
          { name: photo.name, mimeType: photo.type, buffer: photo.bytes },
          { name: 'spec.pdf', mimeType: 'application/pdf', buffer: fixture.pdf },
        ]);
      // Both chips uploaded (a tick each): the fixture answers every upload at once.
      await page.locator('li[data-state="ready"]').nth(1).waitFor({ timeout: 10_000 });
      await page.getByLabel('Prompt for Claude').fill('check the header on these');
    },
  },
  {
    name: 'start',
    path: '/new?root=r.work&path=jantar&start=1',
    // Resume: Last, so the command line shows --resume <id>. A phone then goes back to the sheet's top (folder,
    // account, mode, the command line); the desk panel shows Hold to start whole.
    steps: async (page) => {
      await page.getByRole('radio', { name: 'Last' }).click();
      await page.getByText('--resume', { exact: false }).first().waitFor();
      if ((page.viewportSize()?.width ?? 0) >= 768) {
        await page.getByRole('button', { name: /Hold to start/ }).scrollIntoViewIfNeeded();
        return;
      }
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('*')) if (el.scrollHeight > el.clientHeight + 1 && el.scrollTop > 0) el.scrollTop = 0;
        window.scrollTo(0, 0);
      });
    },
  },
  { name: 'accounts', path: '/accounts' },
  { name: 'accounts-single', path: '/accounts', accounts: 'single', sizes: PHONE },
  { name: 'today', path: '/today', sizes: PHONE },
  // Ask on in its own variant, so no other picture gains its tab: a reminder added, "calories left?", a meal to add.
  // The page opens on its newest turn; the picture shows it from the top.
  {
    name: 'ask',
    path: '/ask',
    sizes: PHONE,
    variant: 'ask',
    steps: async (page) => {
      await page.getByRole('button', { name: 'Add all 2' }).waitFor();
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('*')) if (el.scrollHeight > el.clientHeight + 1 && el.scrollTop > 0) el.scrollTop = 0;
        window.scrollTo(0, 0);
      });
    },
  },
  { name: 'todos', path: '/todos', sizes: PHONE },
  { name: 'reminders', path: '/todos?tab=reminders', sizes: PHONE },
  { name: 'projects', path: '/todos?tab=projects', sizes: PHONE },
  { name: 'meds', path: '/meds', sizes: PHONE },
  {
    name: 'dose',
    path: '/meds',
    sizes: PHONE,
    // The first dose due now (Placebin at 13:00): its row opens the dose sheet.
    steps: async (page) => {
      await page.locator('li[data-dose][data-status="pending"] > button').first().click();
      await page.getByRole('dialog').waitFor();
    },
  },
  { name: 'food', path: '/food', sizes: PHONE },
  { name: 'places', path: '/places', sizes: PHONE },
  // v0.7: Posts on in its own variant, so no other picture changes (Today keeps its sections).
  { name: 'posts', path: '/posts', sizes: PHONE, variant: 'posts' },
  { name: 'money', path: '/money', sizes: PHONE },
  { name: 'intel', path: '/intel', sizes: PHONE },
  { name: 'meetings', path: '/meetings', sizes: PHONE },
  // "Launch review" (web-fixture-v05.ts): the summary, decisions and action items.
  { name: 'meeting', path: '/meetings?id=01JV0000000000000000000501', sizes: PHONE },
  // The same meeting's transcript, a slide at the moment it was taken.
  {
    name: 'meeting-transcript',
    path: '/meetings?id=01JV0000000000000000000501',
    sizes: PHONE,
    steps: async (page) => {
      const rail = page.locator('section[aria-label="Transcript"]');
      await rail.waitFor();
      await rail.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(300);
      await page.locator('ol[aria-label="Transcript"] img').first().waitFor({ timeout: 10_000 });
    },
  },
];

/** The sizes (entries of SIZES) a shot takes. */
export function sizesOf(shot) {
  const keys = shot.sizes ?? DEFAULT_SIZES;
  return SIZES.filter((s) => keys.includes(s.key));
}

/** The file name (without .png) of one variant. */
export function fileName(shot, size, theme) {
  return `${shot.name}-${size.key}${theme === 'dark' ? '-dark' : ''}`;
}

/** Every picture of every shot, in the order they are taken. */
export function variants(only = null) {
  const out = [];
  for (const shot of SHOTS) {
    for (const size of sizesOf(shot)) {
      for (const theme of THEMES) {
        const file = fileName(shot, size, theme);
        if (only && !only.has(shot.name) && !only.has(file)) continue;
        out.push({ shot, size, theme, file });
      }
    }
  }
  return out;
}

/** The fixture a shot uses: its accounts mode and variant. */
export function fixtureKey(shot) {
  return `${shot.accounts ?? 'cswap'}:${shot.variant ?? 'default'}`;
}

function parseArgs(argv) {
  const out = {
    out: join(root, 'docs', 'img'),
    dist: join(root, 'packages', 'web', 'dist'),
    fixture: join(root, 'test', 'integration', 'web-fixture-v051.ts'),
    exportName: 'webFixtureV051',
    only: null,
    list: false,
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
    else if (a === '--fixture') out.fixture = resolve(value());
    else if (a === '--export') out.exportName = value();
    else if (a === '--only') out.only = new Set(value().split(','));
    else if (a === '--list') out.list = true;
    else fail(`unknown argument ${a}`);
  }
  return out;
}

function fail(message, code = 2) {
  process.stderr.write(`screenshots: ${message}\n`);
  process.exit(code);
}

/** Run this file again under tsx, so it can import the TypeScript fixtures. */
function relaunch() {
  const tsx = join(root, 'packages', 'cli', 'node_modules', '.bin', 'tsx');
  if (!existsSync(tsx)) fail('tsx is missing: run pnpm install first');
  const r = spawnSync(tsx, ['--tsconfig', join(root, 'test', 'integration', 'tsconfig.json'), fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, [CHILD_ENV]: '1' },
  });
  process.exit(r.status ?? 1);
}

const shown = (file) => (file.startsWith(`${root}/`) ? relative(root, file) : file);

/** A context that reaches nothing: every request is refused, so a page is only what it holds. */
async function sealedContext(browser, o) {
  const ctx = await browser.newContext({ offline: true, serviceWorkers: 'block', reducedMotion: 'reduce', ...o });
  await ctx.route('**/*', (route) => route.abort());
  return ctx;
}

/** Draw the fixture's pictures (SCREENSHOT_ART) with the app's fonts: name -> bytes. */
async function drawArt(browser, specs) {
  const out = {};
  const faces = fontFaces();
  for (const [name, a] of Object.entries(specs ?? {})) {
    const ctx = await sealedContext(browser, { viewport: { width: a.width, height: a.height }, deviceScaleFactor: 1 });
    try {
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

async function shoot(opts) {
  const dist = opts.dist;
  if (!existsSync(join(dist, 'index.html'))) fail(`${shown(dist)} has no index.html: run pnpm build first (or pass --dist)`);
  if (!existsSync(opts.fixture)) fail(`${relative(root, opts.fixture)} is missing (the synthetic fixture; pass another with --fixture)`);
  const todo = variants(opts.only);
  if (!todo.length) fail(`--only matched nothing (screens: ${SHOTS.map((s) => s.name).join(', ')})`);
  const { serveWebApp } = await import(pathToFileURL(join(root, 'test', 'integration', 'web-server.ts')).href);
  const mod = await import(pathToFileURL(opts.fixture).href);
  const make = mod[opts.exportName];
  if (typeof make !== 'function') fail(`${relative(root, opts.fixture)} exports no function ${opts.exportName}`);
  const { chromium } = await import('playwright-core');

  let browser;
  let server;
  try {
    browser = await chromium.launch();
    const art = await drawArt(browser, mod.SCREENSHOT_ART);
    // One fixture per accounts mode and variant the shots ask for.
    const fixtures = new Map();
    for (const { shot } of todo) {
      const key = fixtureKey(shot);
      if (fixtures.has(key)) continue;
      const f = make({ accounts: shot.accounts ?? 'cswap', variant: shot.variant ?? 'default', art });
      if (!f?.v04 || typeof f.now !== 'number' || typeof f.timezone !== 'string') fail(`${opts.exportName}() must return v04, now and timezone (see web-fixture-v051.ts)`);
      fixtures.set(key, f);
    }
    // One server; each shot points it at its fixture (shots run one at a time).
    let current = fixtures.values().next().value;
    server = await serveWebApp(dist, () => current);
    mkdirSync(opts.out, { recursive: true, mode: 0o755 });
    for (const { shot, size, theme, file } of todo) {
      current = fixtures.get(fixtureKey(shot));
      const fixture = current;
      const ctx = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: size.scale,
        isMobile: size.phone,
        hasTouch: size.phone,
        colorScheme: theme,
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
        // The event stream: accepted and kept quiet, so the app shows "live" as a running daemon
        // does (the fixture server refuses it, and a shot is taken long before the heartbeat is missed).
        await ctx.routeWebSocket((url) => url.pathname === '/v1/events', () => undefined);
        await ctx.route(
          (url) => url.pathname.startsWith('/v1/'),
          async (route) => {
            const req = route.request();
            // The body goes along for the routes that look at it (an upload's kind from its first bytes).
            const reply = fixture.v04.answer(req.method(), new URL(req.url()), req.postDataBuffer());
            if (!reply) return route.continue();
            if (reply.bytes) return route.fulfill({ status: reply.status, contentType: reply.type, body: reply.bytes });
            return route.fulfill({ status: reply.status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(reply.body) });
          },
        );
        const page = await ctx.newPage();
        await page.goto(`${server.base}${shot.path}`, { waitUntil: 'networkidle' });
        // Skeletons wait 150 ms before they show; give every list time to settle.
        await page.waitForTimeout(600);
        if (shot.steps) {
          await shot.steps(page, fixture);
          // Sheets slide in (shorter with reduced motion) and the preview is asked again.
          await page.waitForTimeout(600);
        }
        const out = join(opts.out, `${file}.png`);
        await page.screenshot({ path: out });
        process.stdout.write(`${shown(out)}  ${size.width}x${size.height}@${size.scale}x  ${theme}  ${shot.path}${shot.variant ? `  (${shot.variant})` : ''}\n`);
      } finally {
        await ctx.close();
      }
    }
    if (server.misses.length) process.stdout.write(`(the fixture had no answer for: ${[...new Set(server.misses)].join(', ')})\n`);
  } finally {
    await browser?.close().catch(() => undefined);
    await server?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.list) {
    for (const v of variants(opts.only)) process.stdout.write(`${shown(join(opts.out, `${v.file}.png`))}\n`);
    process.exit(0);
  }
  if (process.env[CHILD_ENV] !== '1') relaunch();
  else
    shoot(opts).catch((e) => {
      process.stderr.write(`screenshots: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exit(1);
    });
}
