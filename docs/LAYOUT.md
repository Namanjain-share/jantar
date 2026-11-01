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
                   alerts, accounts, primer, life, assistant, intel, extension, configuration,
                   security, faq, roadmap, upgrading, real-mac-checks), and for contributors:
                   LAYOUT.md (this file), architecture.md, hook-protocol.md, PROVENANCE.md
  docs/img/        the screenshots the README and docs show (scripts/screenshots.mjs writes them)
  docs/brand/      the logo, the README banner and the social preview (scripts/brand.mjs writes them);
                   the launch film, its phone cut and the README's GIFs (scripts/launch-video.mjs)
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
      src/link/          v0.6 the node link's library: Ed25519 keys and node.json (keys.ts), the
                         handshake, frames and bulks (codec.ts), backoff, join (pairWithHub), ws
      src/fleet/         v0.6 the hub's Fleet part: the link server (socket.ts), the registry of
                         each node's view, ingest and clipping of its events, forwarding calls
      src/node/          v0.6 a node's link to its hub: the dialler, the feed (snapshot, events),
                         the executor (the hub's calls through the node's own API)
      src/auth/nodes.ts  v0.6 pairing claims, revokes and the handshake's verdicts for nodes
      src/terminal/tmux/ v0.6 the tmux backend a Linux node types with (terminal/pick.ts picks it)
    hook/          jantar-hook (bin/jantar-hook.mjs, zero dependencies)
    cli/           jantar (src/commands/<name>.ts, one file per command)
    web/           Vite + React 19 PWA
    extension/     v0.5 Chrome extension (MV3, esbuild): content script for Meet and Teams
                   (src/content, one adapter file per site), service worker (src/background,
                   the only caller of the daemon), popup (src/popup), shared messages and wire
                   constants (src/shared); scripts/build.mjs -> dist/ (load unpacked) and
                   dist-test/ (the e2e build)
  test/fixtures/   @jantar/fixtures: makeFakeHome(), fake binaries, transcript/model builders,
                   Life and Intel bodies (life.ts, intel.ts), past conversations (history.ts);
                   v0.6: memoryLinkPair() (link.ts), synthetic servers (node.ts) and the fake
                   interactive Claude (runtime/fake-claude-tui.mjs)
  test/docker/     v0.6 the Docker Linux end to end (a hub, a door playing Cloudflare Access,
                   two Linux nodes, a phone; `node test/docker/run.mjs`, JANTAR_FLEET_E2E=1)
  test/windows/    v0.6 the native Windows checks W1-W8 (`pnpm --filter @jantar/cli
                   test:windows`, the ci workflow's windows-latest job)
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
                   v0.5.3: v053-ask (Ask through the daemon, the CLI and the fake claude),
                   web-v053-ask (the built Ask page in Chromium against jantard),
                   v053-alerts (the alert groups, the countdown and the missed-push
                   retry, through the built app's service worker), ext-v053 (the toolbar
                   icon's activeTab path) and mcp (the built `jantar mcp` over stdio);
                   v0.6.1: v061-background (background work through the hooks, the
                   transcript, the phone's events and `jantar status`);
                   v0.7.0: v07-posts (Posts through `jantar post`, ctl.sock, a paired
                   phone and the ring, with the privacy sweep)
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
| Fleet, the hub (v0.6) | `packages/daemon/src/{fleet,link}/**`, `packages/daemon/src/auth/nodes.ts`, `packages/cli/src/commands/{fleet,node}.ts` | `createFleet: Factories['fleet']` (fleet/index.ts; L1's `createLinkServer` and `NodeAuth` inside) |
| Fleet, a node (v0.6) | `packages/daemon/src/node/**`, `packages/daemon/src/terminal/{pick.ts,tmux/**}`, `packages/daemon/src/sources/cswap/dirs.ts`, `packages/cli/src/lib/{systemd,service}.ts` | `createNodeLink: Factories['nodeLink']` (node/index.ts; daemon.ts passes `{ executor, self }`); `createTmuxBackend` (terminal/tmux/index.ts, picked by `pickTerminal`) |

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

v0.6: the role decides (`roleOf`: a `node/node.json` in the state dir makes
a node). The hub builds `fleet` (inert while `fleet.enabled` is off) and
starts it after `notifications`, before `api`. A node starts ccwLegacy (an
inert stand-in) → sessions → transcriptWatcher → usage → hooks → terminal
(the tmux backend's 10-second pane tick, when it has one) → writer → files
→ launcher → controls → api (no TCP port: only the control socket and the
link app) → nodeLink (the dialler, last, so the hub's first call finds the
API); Changes, Rewrite, Life, Intel, Meetings, Ask, the primer and pushes
are stand-ins that open no file and start no timer (`nodeOffParts()` in
modes.ts).

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
prompt (`assets/ask/assistant-v2.md`). Its turns live in its memory only, so
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
no file of its own), its prompt (`assets/ask/`), the page
(`screens/ask/`, a lazy chunk), `jantar ask`, the fake claude's Ask modes
and `ASK_MARKER` (`test/fixtures/src/ask.ts`), and the end-to-end suites
`v053-ask` (over HTTP, with the privacy sweep) and `web-v053-ask` (the built
page in Chromium: each phrase to its cards, Add, Undo, hostile answers, the
switch). The user's guide is `docs/assistant.md`.

The Ask routes' schemas ride in `ROUTES`, which the first load holds, so it
needed room first (gzip, `MAIN_JS_MAX` 280.0 kB, unchanged): 279.8 kB
before Ask; 281.3 kB with Ask and its protocol; 280.3 kB with the Screen
tab's picture (`session/controls/ShotView.tsx` and `useShot.ts`) behind
`import()`, still over; 270.7 kB with the pairing QR (`devices/Qr.tsx` and
the `qrcode` package) behind `import()` too, loaded the first time a
pairing code is shown. `code-split.test.ts` keeps both out of the first
load. The Ask chunk is 55.8 kB with what it pulls in (`LAZY_MAX` 80.0 kB).

Alerts with a tone per group, the urgent alert for Claude's 2-minute
countdown, Life's yearly repeat and missed-push retry, todos and the shelf
for Claude Code through `jantar mcp`, search on the phone, and the Meetings
screenshot diagnostics. Protocol version 3 and settings version 2 are
unchanged (one new setting, `notify.urgent`, beside Ask's `ask` group), and
nothing in the release adds a migration to jantar.db or life.db: a repeat's
own time (`repeat.at`) rides in the todo's stored repeat.

- Protocol: `alerts.ts` (the five groups, `alertGroupOf`, the tones and the
  only phrases ever spoken); `RepeatSchema` takes `yearly` and `at`; the
  folder-todo shapes; `intel.ts`'s `searchTerms` and the list's `sort`; and
  three routes that answer only over ctl.sock: `folderTodos`,
  `folderTodoCreate` and `notifyTest` (`api/routes/notify.ts`).
- Daemon: `notify/countdown.ts`, the read-only countdown probe and its
  episodes (one urgent push per ask, one repeat), wired into the router
  with the shared `PaneLookup` that `daemon.ts` builds before the
  notifications part; Web Push counts a push that never left the Mac
  (`offline`), and the Life scheduler waits for the network on it.
- CLI: `commands/notify.ts` and `commands/mcp.ts` (a stdio MCP server with
  no new dependency, a ctl.sock client like the rest).
- Web: `lib/sounds.ts` (tones made with Web Audio, the phrases, the tap
  that opens audio) and `ui/screens/devices/Sounds.tsx`; the service
  worker hands a push's group to an open window and shows it silent only
  when that window played it.
- Extension: the last screenshot try (`LastShot`, in Chrome's session
  storage) and the shortcut in the popup's Settings.

The alerts were built beside Ask, on 0.5.2's 279.6 kB: 277.1 kB with the
Screen tab's picture, `lib/sounds.ts` and the Sounds section behind
`import()`. Together, the release's first load is 269.0 kB in 8 chunks, and
the Ask chunk 57.3 kB with what it pulls in. `code-split.test.ts` keeps all
of them out of the first load; the hook cards remain the next split to try.

### v0.6.0

Fleet: servers (Linux, WSL2, other Macs, and native Windows as a preview)
paired with the Mac, each running its own Claude sessions on its own
accounts, all on the one phone. Off until `jantar fleet on` at the Mac
(`fleet.enabled`, a Mac-only switch); with it off the Mac behaves as v0.5.3
but for the lazy hook cards, `PROC_START_UNREAD` in `writer/proc-start.ts`
and the admin-only `/v1/machines` routes.
One codebase, two roles: a daemon whose state dir holds `node/node.json`
is a node (`roleOf` in `config.ts`), else the hub. A node binds no TCP port,
runs no Life, Intel, Meetings, primer, Rewrite or pushes (stand-ins in
`modes.ts`), and dials the hub's own front door over one WebSocket
(`@jantar/protocol/node-link`, a subpath the phone's bundle never imports;
`ws` 8.22.0 in the daemon). The hub keeps each node's view in
`state.nodes`, re-emits its checked and clipped events into its own store
(`session.node` stamped), and forwards the phone's calls for a node's
sessions through the node's own API (the `link` transport). The node link's
upgrade is taken before Fastify (`api/node-upgrade.ts`), so the phone's
event stream keeps its 4096-byte frames. jantar.db gains migration 5
(`nodes`: public keys only). Every daemon reader of sessions goes through
`localSessions` / `localSession`, so a server's session never reaches the
Mac's own parts (`test/arch/v06-local-sessions.test.ts`). The parts `fleet`
(hub) and `nodeLink` (node) sit on the `link/` library; a Linux node types
through the tmux backend (`terminal/tmux/`, text only on stdin, every write
one gated `if-shell -F` step) and reads its accounts from cswap or its
config dirs (`sources/cswap/dirs.ts`). On native Windows the hooks and
control sockets are named pipes (`pipePath` in config.ts; the hooks pipe
proves its owner with `run\hooks.key`) and the hooks use Claude Code's
exec form. The Screen tab's picture and the hook cards load lazily to make
room in the first load. Tests: `test/integration` is unchanged for a single
Mac; the link and both roles are tested over real `ws` on port 0
(`packages/daemon/test/{link,fleet,node}`), end to end in Docker
(`test/docker`, E1-E15) and on `windows-latest` (`test/windows`, W1-W8).

Merged onto 0.5.3: a node runs no Ask either (an Ask stand-in in
`nodeOffParts`, `ask: false` in its daemon.version), and the urgent alert
reads the Mac's own sessions only (`urgentFor` in `notify/router.ts`, and the probe's `localSession`): a
server's unattended ask gets its plain waiting push, under the server's push
budget. Fleet's migration 5 is jantar.db's only new one (0.5.3 added none).
The first load holds both without raising `MAIN_JS_MAX` (280.0 kB): 0.5.3
alone was 269.0 kB and Fleet alone 277.8 kB; merged, with the Screen tab's
picture, the pairing QR, the sounds and the hook cards each behind
`import()`, it is 271.2 kB in 14 chunks.

### v0.6.1

Background work: a session idle between turns while a dynamic workflow or
background agent it started still runs. `sources/transcripts/background.ts`
(`BackgroundScanner`, pure) replays the main transcript's launches and ends
(main chain only, rows older than the claude process ignored, recently
ended ids kept so an end written before its launch wins) and checks them
against Claude's own count in each `turn_duration` row; the watcher
feeds it the bytes it already reads and publishes the optional
`Session.background` (`SessionBackgroundSchema`: counts of workflows,
agents, shells and monitors, `since`, up to three workflow names) on every
poll. The protocol's `backgroundRunning`, `shownStatus` and
`backgroundText` let the web (`glyphStateOf`, the row, the session header's
line) and `jantar status` show such a session as working; `status` and
`statusSource` are unchanged, and so are pushes, cards and typing. The field
is cleared by a patch to `{}`, never `unset`, so a 0.6.0 hub (which refuses
an unset key it does not know) keeps its link to a 0.6.1 node. No migration,
no settings change and no protocol bump (`PROTOCOL_VERSION` 3, `NODE_PROTO`
1). The first load stays under `MAIN_JS_MAX` at 271.7 kB. Tests: the scanner
and the watcher in `packages/daemon/test/sources/transcript-background.test.ts`,
the board and the header in `packages/web/test/board-background.test.tsx`,
end to end in `test/integration/v061-background.integration.test.ts`.

### v0.7.0

Posts: a sixth Life part, `posts`, for what the user plans to post on
social media by hand. Jantar never posts: it keeps the text, rings at the
time and gives Copy and Open. The protocol (`life.ts`: the post, its body
and patch, the weekly goals, `POST_PLATFORM_LABEL` / `POST_KIND_LABEL`
shared by the push, the CLI and the phone; five control-scope routes
behind the `posts` feature, phase `v0.7`, only the list and an add on
ctl.sock); the daemon module (`life/posts/{module,repo,pings}.ts`: the
todo ring reused through `armRing` in `life/todos/pings.ts`, posts due in
the same minute as one push, the week from Monday in the Life zone, the
ctl.sock add limit `V07_LIMITS.postCtl` in `api/services.ts`); life.db's
migration 2 (the `posts` table and its one index, `posts_open`), Life's
first schema change, with goals in `meta('post_goals')`; `jantar post add`
and `list` (`cli/src/commands/post.ts`); the phone's Posts screen
(`screens/life/posts/`, a lazy chunk; `life/shared/links.tsx` for the
https-only Open shared with Cafés); and Ask's post card (`AskPostAction`,
an idea with no text, notes or link) with its prompt moved to
`assets/ask/assistant-v2.md`. The v1 copy a daemon left in
`<state dir>/ask/` stays (Rewrite's `prepareRunDir` owns that folder). No
jantar.db migration, no settings version and no protocol bump
(`PROTOCOL_VERSION` 3). Tests: `packages/protocol/test/v07-posts.test.ts`,
`packages/daemon/test/life/posts{,-pings}.test.ts`,
`packages/cli/test/post.test.ts`, `packages/web/test/posts.test.tsx`, Ask's
post card in `packages/daemon/test/ask/` and `packages/web/test/ask.test.tsx`,
end to end in `test/integration/v07-posts.integration.test.ts`.
