# Repository layout

How the code is organised: the folders, the parts of the daemon and what
each exports, the contracts between them, the order the daemon starts
them, and what each version added. [architecture.md](architecture.md) is
the short overview; [CONTRIBUTING.md](../CONTRIBUTING.md) has the rules a
change follows.

Shared files (`packages/daemon/src/contracts.ts`, the protocol, the root
config) change in one commit with every implementation they affect.

## Layout

```
jantar/
  README.md  SECURITY.md  CONTRIBUTING.md  CODE_OF_CONDUCT.md  CLA.md
  LICENSE (FSL-1.1-MIT)  THIRD_PARTY_NOTICES.md
  CHANGELOG.md
  docs/            README.md (the index), the user guides (install, phone-app, phone-control,
                   accounts, primer, life, intel, extension, configuration, security, faq,
                   roadmap, upgrading, real-mac-checks), and for contributors: LAYOUT.md (this
                   file), architecture.md, hook-protocol.md, PROVENANCE.md
  docs/img/        the screenshots the README and docs show (scripts/screenshots.mjs writes them)
  docs/brand/      the logo, the README banner and the social preview (scripts/brand.mjs writes them)
  package.json  pnpm-workspace.yaml  tsconfig.base.json  vitest.shared.mjs
  .github/workflows/ci.yml, cla.yml; .github/ISSUE_TEMPLATE/, PULL_REQUEST_TEMPLATE.md
  scripts/         check-secrets.mjs (lint:secrets), check-provenance.mjs, check-oss.mjs
                   (lint:oss), perf-chunks.mjs and perf-memory.mjs (the size and memory gates),
                   screenshots.mjs and brand.mjs (the pictures), each with its node:test file
  packages/
    protocol/      zod schemas, events, reducer, selectors, hook wire format, REST/WS types
    life-core/     pure Life logic (v0.4): dose schedules, adherence, supply, repeats, day keys in a zone
    daemon/        jantard
      src/contracts.ts   FROZEN internal interfaces
      src/config.ts      paths, settings (atomic 0600 writes), binaries
      src/context.ts     builds the real DaemonContext
      src/lifecycle.ts   start/stop services in order
      src/core/          store/bus, clock, exec, ids, hash, log, status precedence,
                         memory db, testing helpers (core/testing.ts)
      src/main.ts        entry point: flags (--port, --home, --no-terminal, --read-only), signals
      src/daemon.ts      startDaemon(): wires every part in startup order (also used by test/integration)
      src/modes.ts       --no-terminal (NullTerminalBackend) and --read-only wrappers
      src/log-rotate.ts  keeps launchd's daemon.{out,err}.log bounded
      src/files/ rewrite/ launcher/ controls/   v0.3 parts
      src/life/          v0.4 Life: life.db, the scheduler and pushes, backups, one folder per module
      src/intel/         v0.4 Intel shelf: JSONL sources followed for appends, the captures file
      src/primer/        v0.4 window primer (opt-in, cswap only)
      src/uploads/       v0.4.2 files from the phone: the store, type sniffing, the sweep and the
                         prompt's file list (built by the API's services; not a daemon part)
      src/meetings/      v0.5 Meetings: meetings.db (refused, never reset), the extension's
                         captures, screenshot files, the library, the summary queue
      src/auth/extensions.ts  v0.5 the paired Chrome extension's key (its own kind, not a device)
      src/ask/           v0.5.3 Ask: the message's stdin (input.ts), the answer's checks and the
                         card rules (answer.ts), the turns in memory, the queue and Add/Undo (service.ts)
    hook/          jantar-hook (bin/jantar-hook.mjs, zero dependencies)
    cli/           jantar (src/commands/<name>.ts, one file per command)
    web/           Vite + React 19 PWA
    extension/     v0.5 Chrome extension (MV3, esbuild): content script for Meet and Teams
                   (src/content, one adapter file per site), service worker (src/background,
                   the only caller of the daemon), popup (src/popup), shared messages and wire
                   constants (src/shared); scripts/build.mjs -> dist/ (load unpacked) and
                   dist-test/ (the e2e build)
  test/fixtures/   @jantar/fixtures: makeFakeHome(), fake binaries, transcript/model builders,
                   Life and Intel bodies (life.ts, intel.ts), past conversations (history.ts)
  test/integration/ end-to-end suites (run from packages/cli: vitest.integration.config.ts);
                   the browser checks of the built app (web*.integration.test.ts) and their
                   synthetic data: web-fixture.ts (the board), web-fixture-v03.ts,
                   web-fixture-v04.ts (Life, the shelf, Resume, one login),
                   web-fixture-v05.ts (v0.4's with Meetings on), web-fixture-v051.ts (v0.5's with
                   terminal dialogs, uploads and per-session transcripts; the screenshots');
                   v0.4.2's v042-*.integration.test.ts and web-v042.integration.test.ts boot
                   the real Terminal.app backend on the fake osascript (harness.ts `terminalApp`);
                   v0.5: extension.ts launches playwright-core's own Chromium with the built
                   extension in a fresh temp profile and drives it (openPopup, tabIdOf, the
                   camera's closed shadow root): ext-smoke and ext-v05 (synthetic Meet and
                   Teams pages at the real URLs); v05-meetings, v05-privacy, web-v05;
                   v0.5.3: v053-ask (Ask through the daemon, the CLI and the fake claude)
```

## The daemon's parts

Each part of `jantard` lives in its own folder and exports one factory,
typed with its `Factories` entry in `packages/daemon/src/contracts.ts`, so
the wiring in `daemon.ts` is mechanical. Tests sit beside each in
`packages/daemon/test/<part>/`.

| Part | Folders | Exports |
|---|---|---|
| Scaffold | `packages/protocol/**`, `packages/daemon/src/{contracts,config,context,lifecycle,version,index}.ts`, `packages/daemon/src/core/**` | the contracts, settings, `DaemonContext` |
| Sources | `packages/daemon/src/sources/{claude-files,transcripts,cswap,ccw-legacy}/**` | `createSessionSource: Factories['sessions']` (claude-files/index.ts); `createTranscriptReader: Factories['transcripts']`, `createTranscriptWatcher: Factories['transcriptWatcher']` (transcripts/index.ts); `createUsageSource: Factories['usage']` (cswap/index.ts); `createCcwLegacySource: Factories['ccwLegacy']` (ccw-legacy/index.ts) |
| Hooks | `packages/hook/**`, `packages/daemon/src/hooks/**`, `packages/cli/src/commands/hooks.ts` | `createHooksBridge: Factories['hooks']` (hooks/index.ts); `installHooks`, `uninstallHooks`, `hooksStatus` (hooks/installer.ts, used by the CLI) |
| Terminal and writer | `packages/daemon/src/terminal/**`, `packages/daemon/src/writer/**` | `createTerminalAppBackend: Factories['terminal']` (terminal/terminal-app/index.ts); `createWriter: Factories['writer']` (writer/index.ts) |
| API, auth, push, db | `packages/daemon/src/{api,auth,notify,db}/**`, `packages/cli/src/commands/{pair,open,status,send}.ts` | `openSqliteDb: DbOpener` (db/index.ts); `createNotifiers: Factories['notifiers']`, `createNotificationRouter: Factories['notifications']` (notify/index.ts); `createApiServer: Factories['api']` (api/index.ts) |
| Web | `packages/web/**` | the built app in `packages/web/dist` (served by the daemon at `/`) |
| Fixtures, doctor, launchd | `test/fixtures/**`, `packages/daemon/src/{doctor,launchd}/**`, `packages/cli/src/commands/{install,uninstall,doctor}.ts`, `scripts/launchd/**` | `runDoctor` (doctor/index.ts); launchd plist render / install / uninstall (launchd/index.ts) |
| Wiring | `packages/daemon/src/{main,daemon,modes,log-rotate}.ts`, `test/integration/**` | wires `Factories` → `Parts` (`startDaemon` in daemon.ts), persists events and card history, starts services with `startServices` |
| Files, Rewrite, launching, Controls (v0.3) | `packages/daemon/src/{files,rewrite,launcher,controls}/**` | `createFilesService: Factories['files']`, `createChangesService: Factories['changes']` (files/index.ts); `createRewriteService: Factories['rewrite']` (rewrite/index.ts); `createLauncher: Factories['launcher']` (launcher/index.ts); `createControlsService: Factories['controls']` (controls/index.ts) |
| Life, Intel, the primer (v0.4) | `packages/life-core/**`, `packages/daemon/src/{life,intel,primer}/**` | `createLifeService: Factories['life']` (life/index.ts, with `LIFE_MODULE_BUILDERS`); `createIntelService: Factories['intel']` (intel/index.ts); the primer service (primer/index.ts) |
| Meetings (v0.5) | `packages/extension/**`, `packages/daemon/src/meetings/**`, `packages/daemon/src/auth/extensions.ts`, `packages/web/src/ui/screens/meetings/**` | `createMeetingsService: Factories['meetings']` (meetings/index.ts, with `MEETINGS_BUILDERS`; daemon.ts passes `{ readOnly }`); the built extension in `packages/extension/dist` |
| Ask (v0.5.3) | `packages/protocol/src/ask.ts`, `packages/daemon/src/ask/**`, `packages/daemon/src/api/routes/ask.ts`, `packages/daemon/assets/ask/**`, `packages/web/src/ui/screens/ask/**`, `packages/cli/src/commands/ask.ts` | `createAskService: Factories['ask']` (ask/index.ts; daemon.ts passes `{ life, usage, ccwLegacy }` and `{ readOnly }`) |

Rules of thumb:

- Dependencies for every package are already in its `package.json`. Ask
  in an issue before adding one.
- A helper used by one part stays in that part's folder; a widely useful
  test helper can move into `@jantar/fixtures`.
- Each part's `index.ts` exports exactly the factory in the table.

## Contracts in one paragraph

Every daemon part gets a `DaemonContext` (`paths`, `settings`, `bins`,
`clock`, `exec`, `proc`, `log`, `store`, `db`, `env`, `version`) plus the
parts it depends on (see `Factories`). State changes go through
`ctx.store.emit()` with typed events from `@jantar/protocol`; the store
applies the shared reducer, keeps a 2,000-event replay ring and delivers to
subscribers in seq order. External programs run through `ctx.exec(file, argv,
opts)` (absolute path, no shell, never rejects). Liveness checks use
`ctx.proc.isAlive(pid)`. Status from different sources is merged with
`mergeStatus()` (`core/status.ts`). Tests use `createTestContext()` and
`makeFakeHome()`.

## Order of startup

Implemented in `packages/daemon/src/daemon.ts`:

1. `createDaemonContext({ openDb: openSqliteDb })` (config.json is migrated
   to version 2 first; another daemon on the state dir stops the start)
2. `persistEvents(store, db)` and `persistPendingHistory(store, db)` (db/index.ts)
3. parts: ccwLegacy → sessions → transcripts → transcriptWatcher → usage →
   hooks → terminal → writer → notifiers → files → changes → rewrite →
   launcher → controls → life → intel → meetings → ask → primer →
   notifications → api (`--read-only` wraps usage, hooks, terminal, writer,
   rewrite, launcher and settings, and life's food module only for Ask
   Claude, never intel; meetings is told `readOnly`, not wrapped: capture and
   edits work, summaries never run; ask is told `readOnly` too: the API
   refuses sending a message, and its list says Ask can't run;
   `--no-terminal` swaps in `NullTerminalBackend`; see modes.ts)
4. `startServices([...])` in that order (log rotator first); stop in reverse
   on SIGINT / SIGTERM, then close the db.

The window primer (v0.4, `primer/`) reads usage and ccwLegacy, so it
starts after them. It never primes under `--read-only` (it is told so, not
wrapped) or with one Claude login. It keeps `<state dir>/primer/primed.json`
(0600) and runs each prime in the empty `<state dir>/primer/work` (0700).

v0.4.2 adds no part and leaves this order as it is. The upload store
(`src/uploads/store.ts`, `UploadStore` in contracts.ts) belongs to the API:
`ApiServices` builds it on `paths.uploadsDir` (`<state dir>/uploads`,
`<sid>/<id>.<ext>`, folders 0700 and files 0600, made on the first upload),
the upload routes (`api/routes/uploads.ts`, a raw-body scope of their own in
`api/app.ts`) and `sendPrompt` use it, and the API server sweeps it once at
start and every 6 hours until it stops. Dialog answers and the keypad are
two more methods of the controls part (`controls/dialog.ts`,
`controls/keypad.ts`), over the Terminal.app backend's compare-and-type
script mode.

Ask (v0.5.3, `ask/`) holds only life, usage and ccwLegacy: no writer,
terminal, launcher, controls, files or settings. Each message is one run of
the shared headless runner (`rewrite/run.ts`) in the empty
`<state dir>/ask/work` (0700, emptied before each run), beside a copy of its
prompt (`assets/ask/assistant-v1.md`). Its turns live in its memory only, so
`start()` has nothing to load; `stop()` and the switch going off abort the
run and forget them.

## What each version added

### v0.3

Files, Rewrite, Folders with New sessions, and Controls: settings for each
switch, jantar.db migration 3, and their routes, which answer 403 with the
command that turns them on while a switch is off.

### v0.4

Life, the Intel shelf, Resume, one Claude login and the window primer.
Protocol 3 and settings version 2 with its migration (`config.json.v1` is
kept for rollback); the `life-core` package (Noblot's dose, supply and
recurrence code with its tests; [PROVENANCE.md](PROVENANCE.md)); `life.db`
(`life/db.ts`: its own migrations, refused rather than reset when corrupt);
the shared headless Claude runner in `rewrite/run.ts`; kept accounts as the
setting `accounts.kept`; the navigation (Today, Intel, More).

v0.4 also renamed the project to Jantar (packages `@jantar/*`, the CLI
`jantar`, the daemon `jantard`, the state dir `~/.jantar`). The old name
stays only where an upgrade from it needs it, listed in `OLD_NAME_ALLOW` in
`scripts/check-oss.mjs`.

### The screenshots

`node scripts/screenshots.mjs` (after `pnpm build`) serves the built app
with the daemon's own headers and the synthetic fixture in
`test/integration/` (its `--fixture` and `--export` flags name it),
freezes Chromium's clock at the fixture's afternoon, answers the routes
from the fixture, and writes every screen in its `SHOTS` list as
`docs/img/<screen>-{phone,desktop}[-dark].png`, in the sizes each shot
asks for. With cswap the fixture shows Jantar without the legacy ccw
tool (no `next →`, burn, moves or hold list), as anyone else runs it.
`node scripts/brand.mjs` then draws `docs/brand/` from those
pictures, the tokens and the repo's own fonts. A screen added to the README
or a docs page goes in `SHOTS` (and the fixture, if it needs data);
`scripts/screenshots.test.mjs` fails when a page shows a picture the script
does not take, or `docs/img` holds one it does not.

### v0.4.2

Answering terminal dialogs from the phone, the keypad, attachments in the
composer. The protocol shapes and constants (`TerminalDialog`,
`DIALOG_GATES`, `DIALOG_NOTES`, the upload limits), four routes
(`sessionDialog`, `sessionKeypad`, `uploadCreate`, `uploadDelete`), the
raw-body pipeline for uploads (`RouteDef.rawBody`: its own parser scope,
and every check before a byte of the body is read), the screen read's
dialog and screen key, the prompt's attachments, the contracts
(`ControlsService.answerDialog` and `.keypad`, compare-and-type
`PressKeyOptions.expect`, `UploadStore`), and the shared dialog fixtures
(`test/fixtures/src/dialogs.ts`, with a web copy in
`packages/web/test/term-dialog-fixtures.json`).

Where the upload store, the dialog answers and the keypad sit is under
[Order of startup](#order-of-startup).
Its end-to-end suites are `test/integration/v042-dialogs`,
`v042-uploads`, `v042-privacy` and `v042-every-dialog` (every shared
fixture through the daemon), with the Chromium check
`web-v042.integration.test.ts`.

### v0.5

Meetings: a Chrome extension that keeps a Google Meet or Microsoft Teams
call's live captions and the screenshots you click, kept on the Mac with a
summary per meeting. The protocol (`protocol/src/meetings.ts`, 17 routes,
the Mac-only `meetings.enabled` switch, the `meetings` feature flag;
protocol version 3 and settings version 2 unchanged), jantar.db migration 4
(`extensions`), the extension credential end to end (its own header, route
scope `extension`, actor kind `extension`, pairing through the one pairing
service with a `kind`, accepted only from the published extension ID and
only from loopback), `meetings.db` with its store and the shell that opens
it, and the extension itself (manifest, build script, shared messages and
wire constants, the chrome fake for tests). The end-to-end suites run the
real built extension in a temp-profile Chromium against jantard.

### v0.5.1

v0.4.2 and v0.5.0 in one release. Protocol version 3 and settings version 2
are unchanged; v0.4.2 adds no jantar.db migration, so v0.5's 4
(`extensions`) is the last. `DIALOG_GATES` is
`{ up: true, tall: true, noFirst: false }`. Together they took the app's
first load over `perf-chunks`' 280 kB, so a picked file's preparation
(`session/attach/convert.ts`) and the attachment glyphs
(`session/attach/glyph-icons.tsx`) load with `import()` the first time a
file is attached; `code-split.test.ts` keeps them out of it.

The first load is 279.6 kB, about 0.4 kB under the gate, so the next web
change that reaches it needs a split first. Loading `lib/upload.ts` lazily
saved only 0.1 kB. The candidates, roughly gzipped: the Screen tab's
picture (`session/controls/ShotView.tsx` with `useShot.ts`, 1.4 kB; shown
only with screenshots on) and the hook cards (`session/Question.tsx`,
`Permission.tsx`, `Plan.tsx`, 4.4 kB; a card would wait for its chunk the
first time one opens). Raising `MAIN_JS_MAX` is a decision to record, not
a fix.

### v0.5.3

Ask: a chat page that turns plain words into suggested Life items (todos,
reminders, food, money), through the shared headless runner. The protocol
(`protocol/src/ask.ts`: the card form of the four actions on Life's own
field schemas, now exported from `life.ts`; the turn and its limits; seven
control-scope routes behind the Mac-only `ask.enabled` switch and the `ask`
feature flag; protocol version 3 and settings version 2 unchanged, no
jantar.db migration), the daemon part (`ask/`, its turns in memory only, so
no file of its own), its prompt (`assets/ask/assistant-v1.md`), the page
(`screens/ask/`, a lazy chunk), `jantar ask`, the fake claude's Ask modes
and `ASK_MARKER` (`test/fixtures/src/ask.ts`), and the end-to-end suite
`v053-ask`.

The Ask routes' schemas ride in `ROUTES`, which the first load holds, so it
needed room first (gzip, `MAIN_JS_MAX` 280.0 kB, unchanged): 279.8 kB
before Ask; 281.3 kB with Ask and its protocol; 280.3 kB with the Screen
tab's picture (`session/controls/ShotView.tsx` and `useShot.ts`) behind
`import()`, still over; 270.7 kB with the pairing QR (`devices/Qr.tsx` and
the `qrcode` package) behind `import()` too, loaded the first time a
pairing code is shown. `code-split.test.ts` keeps both out of the first
load. The Ask chunk is 55.6 kB with what it pulls in (`LAZY_MAX` 80.0 kB).
