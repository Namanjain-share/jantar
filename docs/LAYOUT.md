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
                         (v0.13: life/work/, Work, owner-only; the only code that names a work_ table)
      src/search/        v0.13 one search across Jantar: each group asks its own part, no SQL here
      src/intel/         v0.4 Intel shelf: JSONL sources followed for appends, the captures file
      src/primer/        v0.4 window primer (opt-in, cswap only)
      src/uploads/       v0.4.2 files from the phone: the store, type sniffing, the sweep and the
                         prompt's file list (built by the API's services; not a daemon part)
      src/meetings/      v0.5 Meetings: meetings.db (refused, never reset), the extension's
                         captures, screenshot files, the library, the summary queue
      src/auth/extensions.ts  v0.5 the paired Chrome extension's key (its own kind, not a device)
      src/chat/          v0.10 Chat (replaced v0.5.3's ask/): chat.db and its rows (db.ts, store.ts),
                         photos (photos.ts), the queue and the run (service.ts), the per-run MCP
                         server (dispatcher.ts), the tools, the journal and the taps (tools.ts,
                         actions.ts, taps.ts), the run's input and the reply (input.ts, text.ts)
      src/mcp/rpc.ts     v0.10 the MCP JSON-RPC core shared by Chat's dispatcher and `jantar mcp`
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
                   v0.5.3: v053-alerts (the alert groups, the countdown and the missed-push
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
| Chat and the Siri door (v0.10; Ask until then) | `packages/protocol/src/chat.ts`, `packages/daemon/src/{chat,mcp}/**`, `packages/daemon/src/api/routes/chat.ts`, `packages/daemon/assets/chat/**`, `packages/web/src/ui/screens/chat/**`, `packages/cli/src/commands/{chat,chat-shortcut,ask}.ts` | `createChatService: Factories['chat']` (chat/index.ts) |
| Fleet, the hub (v0.6) | `packages/daemon/src/{fleet,link}/**`, `packages/daemon/src/auth/nodes.ts`, `packages/cli/src/commands/{fleet,node}.ts` | `createFleet: Factories['fleet']` (fleet/index.ts; L1's `createLinkServer` and `NodeAuth` inside) |
| Intel reads links (v0.8) | `packages/protocol/src/{post-url,page-read}.ts`, `packages/daemon/src/intel/read/**`, `packages/daemon/assets/intel/**`, `packages/daemon/src/auth/capture-keys.ts`, `packages/daemon/src/api/routes/{capture,capture-keys,ext-reads}.ts`, `packages/extension/src/background/reads.ts`, `packages/web/src/ui/screens/intel/**`, `packages/cli/src/commands/intel{,-shortcut}.ts` | still `createIntelService: Factories['intel']` (daemon.ts passes `{ files, usage, ccwLegacy }` and `{ readOnly }`); Ask gets Intel's `read` and `remove` only |
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
   launcher → controls → life → intel → meetings → chat → primer →
   notifications → api (`--read-only` wraps usage, hooks, terminal, writer,
   rewrite, launcher and settings, and life's food module only for Ask
   Claude, never intel; meetings is told `readOnly`, not wrapped: capture and
   edits work, summaries never run; chat is told `readOnly` too: the API
   refuses sending a message, a photo and the Siri door, and its list says
   Chat can't run;
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
API); Changes, Rewrite, Life, Intel, Meetings, Chat, the primer and pushes
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

Chat (v0.10, `chat/`; Ask's `ask/` until then) holds Life, Intel's list,
get, read, remove, reread and jobs, Meetings' library and summaries, a
read-only board (the store's state and transcript pages), usage,
ccwLegacy and the notifiers: no writer, terminal, launcher, controls,
hooks' decide, files, uploads or settings' write side
(`test/arch/v010-chat.test.ts`). It opens `chat.db` at start when Chat is on
or the file exists (refused, never reset), fails any turn a restart left
unfinished, and sweeps every hour. Each message is one run of the shared
runner in tools mode in `<state dir>/chat/run/<rid>` (0700, removed when
the run ends) beside a copy of its prompt (`assets/chat/chat-v2.md` since v0.13) and
its `mcp.json`, with the dispatcher's socket in the run dir; `stop()` and
the switch going off abort the run and cancel the queue.

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
`import()`, still over; 270.7 kB with the pairing QR (`devices/Qr.tsx`,
`kit/Qr.tsx` since 0.12.2, and the `qrcode` package) behind `import()`
too, loaded the first time a pairing code is shown. `code-split.test.ts` keeps both out of the first
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
(`PROTOCOL_VERSION` 3). The first load stays under `MAIN_JS_MAX` at
273.0 kB in 14 chunks, and Posts pulls in 45.5 kB. Tests:
`packages/protocol/test/v07-posts.test.ts`,
`packages/daemon/test/life/posts{,-pings}.test.ts`,
`packages/cli/test/post.test.ts`, `packages/web/test/posts.test.tsx`,
Ask's post card in `packages/daemon/test/ask/` and
`packages/web/test/ask.test.tsx`, end to end in
`test/integration/v07-posts.integration.test.ts`.

### v0.8.0

Intel reads links (Add post): a saved link (a reel, a video, a post, an
article, a PDF, any https page) or text is kept on the shelf at once and
read on the Mac one job at a time. The protocol: the depths, platforms,
job states and tiers, the rich fields of a read item (captures only), the
jobs, thumbnails and status shapes, the page read's zod mirror
(`PageReadSchema`), the extension's read job and result, the capture door
and its keys, `INTEL_READ_LIMITS`, `INTEL_READ_REASONS` and the notes
(`intel.ts`, `constants.ts`); twelve routes in phase `v0.8`, the `capture`
scope and the `intelRead` switch (`api.ts`); and two zod-free subpaths the
extension bundles: `@jantar/protocol/post-url` (the six platforms' post
shapes, the rebuilt Chrome path, the sign-in paths) and
`@jantar/protocol/page-read` (`readPage`, the in-page reader both page
tiers run, self-contained, returning a promise). The daemon:
`intel/read/**` (the store, the queue, the guard and its CONNECT proxy,
the three page tiers, yt-dlp, the per-platform adapters, the media helper
and its sandbox profile, the Claude run with `rewrite/run.ts`'s additive
stream-json io, the answer); `auth/capture-keys.ts` and the door's gate
in `api/app.ts` (`captureCaller`, before any body); `routes/{capture,
capture-keys,ext-reads}.ts`; Ask's typed fast path (`ask/answer.ts`
`saveFastPath`). jantar.db migration 6 (`capture_keys`). The extension:
`background/reads.ts` (the alarm, the read loop, the shape checks),
`shared/post-sites.ts`, and the popup's Read saved links; `alarms` and
`scripting`, six optional post origins. The CLI: `jantar intel save |
jobs | retry | delete | read`, `jantar intel shortcut`, and a doctor check
of the Shortcut's door. The phone: Add post, the Reading strip and read
items under `screens/intel/` (the Intel chunk), and Ask's save card.
`playwright-core` 1.63.0 moves from the root's dev dependencies into the
daemon's dependencies (the headless browser tier, imported lazily). No
settings version and no protocol bump (`PROTOCOL_VERSION` 3). The first
load stays under `MAIN_JS_MAX` at 275.4 kB in 14 chunks, and Intel pulls in
46.8 kB (its own chunk 10.1 kB). Tests: G1 to G18 across `packages/daemon/test/{intel,api,ask,arch}/`,
`packages/protocol/test/{post-url,v08-intel-read}.test.ts`,
`packages/extension/test/{page-read,background/reads}.test.ts`,
`packages/cli/test/doctor-capture.test.ts`, the fake claude's read modes,
the fake yt-dlp and the fake media tools (`writeFakeMediaTools`: an
xcode-select, a swiftc that "builds" a fake `jantar-media`, a sandbox-exec
that runs it; nothing compiles Swift) in
`test/fixtures/test/intel-read.test.ts`, and end to end in
`test/integration/v08-intel-read.integration.test.ts` (the daemon with
Intel's seams from `read-net.ts`: one local HTTPS server for the public
web, playwright-core's own Chromium through the daemon's proxy; the
harness's `intel` and `fakeMediaTools` options) and
`test/integration/ext-v08-reads.integration.test.ts` (the built extension
in Chromium, every web request answered by the test), and the user's own
flow in `test/integration/v08-reel-flow.integration.test.ts` (the built
phone app saves a reel, Chrome needs a login, the headless browser and the
media helper read it, the phone finds it by a caption word and by a word
only its frames hold, and Open original is the reel; with
`JANTAR_REAL_MEDIA=1` the real Swift helper on a reel made by
`make-reel.swift`, see docs/real-mac-checks.md).

### v0.9.0

Log a comment, in Posts. The protocol: `post-place.ts` (`postPlaceOf`,
the platform and where of a comment's link, read from the link alone and
never fetched; re-exported from the main entry, no new subpath), a post
body that may be `posted` with its `postedUrl`, Today's posts part with
`comments` against a daily goal, a comment goal that names its platform
(`postGoalLabel`), and `POSTS_DONE_PAGE` 300 (`life.ts`, `constants.ts`).
The daemon: the widened create in `life/posts/module.ts` (a posted create
stamps `postedAt`, skips the open cap, refuses the same posted link twice
through `repo.ts` `hasPostedUrl`) and its `today()` (comments posted that
day in the Life zone). The phone: `screens/life/posts/LogCommentSheet.tsx`
(the Posts chunk) opened from the top of Posts, beside + Post, and Today's second Posts row.
The CLI: `jantar post log` and the posted link on `post list --done` rows.
No new route, table, migration, setting or dependency; `PROTOCOL_VERSION`
3. The first load is 276.0 kB of `MAIN_JS_MAX` 280 kB (the protocol's
shared chunk carries `postPlaceOf`), and Posts pulls in 46.8 kB (its own
chunk 7.8 kB). Tests: `packages/protocol/test/v09-comment-log.test.ts`,
`packages/daemon/test/life/posts-log.test.ts`, `packages/cli/test/post.test.ts`,
`packages/web/test/{posts,today}.test.tsx`, and end to end in
`test/integration/v09-comment-log.integration.test.ts`.

### v0.10.0

Cafés depth. The protocol (`life.ts`, `constants.ts`): a café's own
`stars`, six optional sub-ratings (`PLACE_RATING_KEYS`), a price level,
`again`, tags (`PLACE_TAGS`, work-friendly first, plus custom ones by the
category rule; `placeTagKey`, `normalizePlaceTags`), dishes whose rating
may wait, with a price, order again and notes, and visits
(`PlaceVisitSchema`); stored shapes are tolerant `z.object`s and bodies
strict; the list query's sorts and filters and `placeScore`; four routes
in phase `v0.10` (`placeGet`, `placeVisitAdd`, `placeVisitUpdate`,
`placeVisitDelete`), with `placesList` and `placeGet` read only on
ctl.sock. The daemon: life.db's migration 3 (`place_visits`), Life's second
schema change, and `CheckedDbOptions.preMigrateCopy` in `life/db.ts`, the
copy `LifeService.open()` writes before migrating
(`backups/life-pre-<version>.db`); `life/places/{module,repo}.ts` sort and
filter in the module, read every café's visit summary in one grouped query
and delete a café with its visits in one transaction. The CLI: `jantar
place list|show` (`cli/src/commands/place.ts`) and the schema in `jantar
life status`. The phone (`screens/life/places/`, the Places chunk): the
list's Sort, Filters and search in the address, `PlaceScreen.tsx` at
`?id=`, and the café, dish and visit sheets with `TagPicker.tsx`. The
first load is 277.5 kB of `MAIN_JS_MAX` 280 kB (the new routes and their
schemas sit in the protocol's shared chunk), and Places pulls in 50.5 kB
(its own chunk 11.8 kB). Tests: `packages/protocol/test/v010-places.test.ts`,
`packages/daemon/test/life/{places,places-depth,precopy,db}.test.ts`,
`packages/cli/test/place.test.ts`,
`packages/web/test/{places,place-screen,place-sheets}.test.tsx`, and end to
end in `test/integration/{v010-places,v010-upgrade,web-v010-places}.integration.test.ts`.

Chat replaces Ask. The protocol (`chat.ts`): the thread, its changes and
cards, the send body, photos, the chat keys and the Siri door's body and
reply; fourteen routes in phase `v0.10` (the phone's `/v1/chat*`, the
Mac's `chatStatus` and `chatKey*`, and `captureChat` at
`POST /v1/capture/chat`); Ask's seven routes and `ask.ts` are gone; the
`ask` settings group keeps its name and gains `keepDays` and
`voiceModel`. The daemon: `chat/` (above) with chat.db (refused, never
reset) and its photos under `<home>/chat`; the shared runner's tools mode
(`RunFlags.tools`, `TOOLS_ISOLATION_OPTIONS`, `initProblem`) and
`ExecOptions.onStdout`; `mcp/rpc.ts`, which `jantar mcp` imports too;
`assets/chat/chat-v1.md` and `bridge.mjs`; jantar.db migration 7 (a
`scope` column on `capture_keys`) and the gate split per door in
`api/app.ts`. The CLI: `jantar chat` (`chat.ts`, `chat-shortcut.ts`),
`jantar ask` as its alias, and doctor's Siri door probe. The phone
(`screens/chat/`, the Chat chunk): `Chat.tsx`, `Turn.tsx`, `Composer.tsx`
and `model.ts`; `/ask` reads as `/chat`. The first load is 278.3 kB of
`MAIN_JS_MAX` 280 kB, and Chat pulls in 43.6 kB (its own chunk 5.8 kB).
Tests: `packages/protocol/test/v010-chat.test.ts`,
`packages/daemon/test/{chat,mcp}/**`, `packages/daemon/test/rewrite/tools.test.ts`,
`packages/daemon/test/arch/v010-chat.test.ts`,
`packages/daemon/test/api/v010-capture-chat.test.ts`,
`packages/daemon/test/db/v010-chat-keys.test.ts`,
`packages/cli/test/{chat,doctor-capture}.test.ts`,
`packages/web/test/chat.test.tsx`,
`test/fixtures/test/fake-claude-chat.test.ts` (the fake claude's Chat
mode: an MCP client over the run's one server), and end to end in
`test/integration/{v010-chat,v010-siri,web-v010-chat}.integration.test.ts`.

### v0.12.0

Wide windows and the iPad, in the web app only: no protocol or daemon
change except Chat's `context` (below), and no data change.

**Size classes and the chrome** (`ui/shell/layout.ts`, one
`LayoutProvider` with four `matchMedia` listeners; `useLayout()` gives
`size`, `coarse`, `chrome`, `keyboard` and `kbUp`). The chrome follows the
pointer and the window: a fine pointer gets the phone's chrome below 768
and the Mac's (`desk`: 56 rail, 48 top bar, 24 status bar) from 768; a
coarse pointer gets the phone's below 640 and the touch shell from 640
(`ui/shell/TouchShell.tsx`, its own chunk: a 220 sidebar from 1024 with
the accounts strip and a `⋯` menu, a labelled 72 rail below). The Mac's
density (`desk:`) needs a fine pointer; a touch screen keeps the phone's
type scale and 44 pt targets at every width. `lib/input.ts` sets
`data-input` from the last pointer (hover styles key on it, as an iPad
says `hover: none` with a trackpad) and guesses `keyboard` (a key outside
a field, a modifier, an arrow, Tab or Esc, or a 30-120 px shrink of the
visual viewport with a field focused); Devices can set it On or Off.
`lib/viewport.ts` follows the visual viewport while a field has focus
(`--vvh`, `--vvt`, `--kb`, `kbUp`), and popups portal into the shell's
layer (`kit/layer.ts`), so the on-screen keyboard never covers a pane's
bottom.

**Panes by their own width** (D1). Every pane is a query container, so a
screen's `@md:` and the rest (`--container-*` in `styles/tokens.css`: sm
480, md 640, two 760, split 800, wide 900, props 940, lg 960, xl 1180)
read the pane, never the window; `md:` and `useMedia(` outside the chrome
are refused by `test/design-rules.test.ts`. `kit/SplitPane.tsx` is a list
and its detail: split from a pane of 800 (one ResizeObserver that sets
state only at 800 and 1180), the list column 340, or 440 from 1180,
Chat's 300; with nothing open the list fills the pane (`empty="fill"`,
D2); in single mode the inactive slot renders nothing; `overlay` calls the
list over an open item (Board, Chat; D8). `kit/Columns.tsx` deals cards
into columns. `kit/Pane.tsx` is every other place's keyed scroll box;
`usePaneScroll` keeps each scroll by key. One shell tree at every chrome
(the place is always slot 4, and the session is one tree for the phone
and the desk), and `lib/drafts.ts` keeps a session's, Chat's and a new
session's draft and chips across remounts and reloads, so a rotation or a
window drag loses nothing. New session's start form moves between the
detail pane and a sheet at 800, so it is built again: its Name, account and
picks are kept aside with its draft (in memory) and read back. Form sheets
are the phone's Base UI Drawer, placed top-anchored and 540 wide by CSS
(D9), so a resize across 640 / 768 keeps the form's own fields. Both
presentations are capped at the visual viewport (`--vvh`): with the
on-screen keyboard up a sheet scrolls, and the focused field is scrolled
into view in it.

**Keys** (`ui/shell/keys.ts`, `ui/kit/rows.ts`, `ui/shell/Shortcuts.tsx`):
keys at every width once `keyboard` is on, keycaps only then; the field
pass-list; ⌘1-⌘9 in `NAV` order; ⌘. as Esc; ⌘Z scoped to the Undo on
screen (`[data-undo]`); lists by `[data-row]` with a roving tabindex;
`c` clicks the place's `[data-new]`, `/` its search field; the `?`
overlay in its own chunk; an in-app `Link` focuses the new pane's heading.

**Chat beside any screen** (`screens/chat/ChatDock.tsx`, re-exported from
`Chat.tsx` so it shares Chat's chunk): a 360 column where the panes keep
560, else over their right edge; open or closed per device
(`shell/chatDock.ts`). The "Looking at" chip (`shell/lookingAt.ts`) sends
`context: { kind, id }` on `POST /v1/chat` to a daemon from 0.12 on
(`packages/protocol/src/chat.ts`); the daemon resolves the id itself
(`chat/service.ts` `lookingAt`), keeps the label on the turn and writes
one `<looking>` line for the run (`chat/input.ts` `lookingLine`): a Life
item by its own label, Intel, a meeting or a session by kind and id only.
Her `POST /v1/p/chat` body (`PersonChatSendBodySchema`) has no `context`.

**Accountability partner** (v0.11 People, its spec's 9.10) in the wide
layouts: its place closes the touch nav's top list, as "Partner" (its
`short`) in the 220 sidebar and under its icon in the 72 rail; ⌘1-⌘9 stay
`NAV`'s first nine. His screen for her (`screens/people/Partner.tsx`) is
a SplitPane from a pane of 800: the header and the tabs one under the
other in the list column, the tab or the plan editor beside them, the tab
being the same section at every width so a rotation keeps a plan being
written; her Today tab is cards (`kit/Columns.tsx`, `kit/Panel.tsx`) beside
the tabs or from a tab 640 wide, the other tabs rows 720 at most. On his
Today her rows are the first card from 640 (`Dashboard.tsx` `people`),
which Edit cards lists only while People is on. Her app (`p.html`) stays
one column, centred.

**Performance.** 0.10's first load was 278.4 kB of `MAIN_JS_MAX`
280 kB. 0.12 made room first: Accounts, Alerts and Devices load from their
own chunks (c01), which brought main to about 266 kB; the wide panes are in
the screens' chunks, the touch shell, the `⋯` menu, the popovers
(`kit/Popover.tsx`) and the `?` overlay in chunks of their own, and main
ends at 274.6 kB with 13.7 kB of CSS. `MAIN_JS_MAX` was not raised. The
Drawer and Base UI's shared popup runtime (about 20 kB) stay in main on
purpose (D12): out of main they would be charged to every lazy screen and
put Today over its 80 kB. The lazy screens at 0.12: Today 69.3, Places
55.8, Posts 52.1, Intel 50.4, Meetings 49.9, Chat 49.7, Todos 50.0, Food
48.0, Money 46.7, Meds 16.0, Accounts 11.0, Devices 10.6, TouchShell 8.8,
Alerts 5.5, Shortcuts 2.5 (kB with what each pulls in). On top of 0.11.0
(Accountability partner: its place in the nav, its route and its icon in
main, about 0.5 kB) main is 275.1 kB with 14.0 kB of CSS, Today 74.5 kB
with her card's rows and Partner 33.9 kB, its SplitPane from main.

Tests: `packages/web/test/{layout,input,viewport,split-pane,columns,drafts,keys,layout-metric}.test.ts(x)`
and the screens' own files; end to end in
`test/integration/web-v011-layout.integration.test.ts` (every place at
the iPad and Mac sizes, fine and touch, light and dark: no sideways
scroll, 44 pt on touch, the 35 % empty-width rule from 1024 px, the safe
areas and the corners, nested scrollers, type, keycaps, rotation by DOM
identity, the on-screen keyboard and hover, labels that run out of their
controls and headers too full for their pane), with its probe in
`layout-probe.ts`.

### v0.13.0 (unreleased)

Work's first part (v0.13 P1, the Mac side). The protocol: the subpath
`@jantar/protocol/work` (`work.ts`, never exported from the index, as
`people` is not): `WORK_LIMITS`, the project hub, the search's query and
groups, the seed's body and reply, and `WORK_ROUTES` (`projectGet`,
`search`, `foldersSeed`, phase `v0.13`), which the daemon serves through
`ALL_ROUTES`; in the index only `life.work` and `workOn` (`settings.ts`),
the `work` switch, and the owner-only `OwnerTodosQuerySchema` (her routes
keep `TodosQuerySchema`). The first load is 279.2 kB of `MAIN_JS_MAX`
280 kB (0.11.0's was 279.1). life-core:
`work/task-review.ts` (from Noblot) and `work/project-health.ts`. The
daemon: life.db migration 5 (`work`) in `life/db.ts`; `life/work/module.ts`
(the stub module, the seed, search's clients and deals, the project-delete
hook); the Todos module's `hub`, `q` and `onProjectDeleted`;
`search/index.ts` and `core/fold.ts`; Meetings' name-and-people `search`;
`api/routes/{search,work}.ts`. The CLI: `jantar work on|off|status|seed`
(`work.ts`). Tests: `packages/protocol/test/v013-work.test.ts`,
`packages/life-core/test/work/**`,
`packages/daemon/test/life/{work,v5-migration,project-hub,work-seed-route}.test.ts`,
`packages/daemon/test/search/search.test.ts`,
`packages/daemon/test/arch/v013-work-owner-only.test.ts`,
`packages/cli/test/work.test.ts`.

Work's second part (v0.13 P2, the Mac side: clients, the log, follow-ups,
meetings linked to clients, import and export). The protocol, in the same
subpath: a contact as stored, the Clients row and query, the client hub,
the log (rows, page cursor, log + next step), meetings' clients and
suggestions, the import (preview, rows, Undo, list), the export query,
Work's settings and client_here (`FolderClientResponseSchema`), and P2's
`WORK_ROUTES`; in the index only what his own routes and the stored rows
need: `Todo.contactId`/`dealId`, `Project.clientId`/`business`, the
owner-only `OwnerTodoBodySchema`, `OwnerTodoPatchSchema`,
`OwnerProjectBodySchema` and `OwnerProjectPatchSchema` (her routes keep the
base ones), `TodaySchema.work`, `life.workLockScreenNames` and Chat's
`work` module. life-core: `work/{contacts,tags,csv}.ts` (from Noblot) and
`work/client-import.ts`. The daemon: `life/work/{module,repo,settings,import}.ts`
(only `repo.ts` names a `work_` table); the Todos module's follow-ups
(`todos.contact_id`, `useWork`, `followUps`, `unlinkClient`, the space rule)
and the follow-up push (`todos/pings.ts`); Meetings tells Work of a
meeting's project and delete (`meetings/common.ts` `tellWork`) and
registers its list (`LifeService.useMeetings`); `api/routes/work.ts` and
`api/work-meetings.ts`; Chat's Work tools (`chat/{tools,actions,items}.ts`,
prompt `assets/chat/chat-v2.md`). The CLI: `jantar work
import|imports|export|lockscreen|settings`, and `client_here` in
`commands/mcp.ts`. Tests: `packages/protocol/test/v013-work-p2.test.ts`,
`packages/daemon/test/life/work-{clients,meetings,import,routes}.test.ts`,
`packages/daemon/test/chat/work-tools.test.ts`,
`packages/daemon/test/arch/v013-work-canary.test.ts` (W-T6), and the P2
parts of `v013-work-owner-only.test.ts` (W-T4) and the CLI's
`{work,mcp}.test.ts`.

Work's third part (v0.13 P3, the Mac side: deals, stages and insights).
The protocol, in the same subpath: a deal as stored (`DealSchema`), its
card, the deals list with each stage's column, a deal's hub, its move,
the stage list (`DEFAULT_WORK_STAGES`, `WORK_LOST_CODES`), the insights
reply, and P3's `WORK_ROUTES`; the client hub, the project hub and
client_here gain deals, the project hub its milestones (set through
`workProjectMilestones`; the daemon's own project schema in
`life/todos/repo.ts` stores them, so the index's project shapes never name
them), and the export takes `what=deals`. Nothing new in the index. life-core: `work/{deal,pipeline,stage,insights,milestones}.ts`
(from Noblot). The daemon: `life/work/deals.ts` (cards, columns, the CSV
and the insights from rows already read; no SQL), the deal and stage
methods in `life/work/module.ts`, `work_deals` reads and writes in
`life/work/repo.ts`, the stage list in `life/work/settings.ts`; the Todos
module's `dealFollowUps` and `unlinkDeal`; Chat's deal tools
(`chat/{tools,actions,items}.ts`). The CLI: `jantar work export --deals`.
Tests: `packages/protocol/test/v013-work-p3.test.ts`,
`packages/life-core/test/work/{deal,pipeline,stage,insights,milestones}.test.ts`,
`packages/daemon/test/life/work-{deals,deal-routes}.test.ts`,
`packages/daemon/test/chat/work-deal-tools.test.ts`, and the P3 parts of
the arch tests (W-T1, W-T4, W-T6) and the CLI's `work.test.ts`.
