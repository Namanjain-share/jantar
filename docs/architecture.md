# How it is put together

One daemon on the Mac, one web app for the Mac and the phone, a small hook
client for Claude Code, a CLI, and an optional Chrome extension. Nothing
runs anywhere else.

```
 phone PWA / browser ──HTTPS+WSS (Tailscale Serve, or a Cloudflare Tunnel)──┐
                                                                            ▼
                    jantard (Node 22 daemon, launchd: com.jantar.daemon)
   sources: Claude session files · transcripts · hooks · cswap files · legacy ccw files (read-only)
   core:    store → shared reducer → event bus (seq) · SQLite (events, audit, devices, push)
   terminal: Terminal.app backend · writer: one queue per pane, send-with-proof
   life:    life.db (its own SQLite file) · one scheduler for every Life ping
   intel:   JSONL sources followed for appends · captures file
   primer:  one tiny headless run per idle 5-hour window (opt-in, cswap)
   meetings: meetings.db (its own SQLite file) · screenshot files · one summary run at a time
   api:     REST /v1 + WS /v1/events · pairing · scopes · audit · Web Push
          ▲                         ▲                        ▲
   jantar-hook (hooks.sock)     jantar CLI (ctl.sock)    Jantar Chrome extension (127.0.0.1, its own key)
```

- **Reading.** The daemon finds sessions from Claude Code's own session
  files, follows their transcripts, and reads the Terminal tab a session
  runs in when it needs the screen. With cswap it reads the usage cache;
  with the legacy ccw tool it reads its files. It never writes to any of
  them.
- **Hooks.** When you install them, Claude Code calls `jantar-hook` on
  permission prompts, questions and plans. The hook asks the daemon over a
  Unix socket and waits for your answer. When the daemon is not running the
  hook steps aside and Claude behaves as usual. The wire format is in
  [hook-protocol.md](hook-protocol.md).
- **Typing.** One writer queue per Terminal pane. A prompt counts as sent
  only when the transcript shows it; a dialog answer only types while the
  screen still shows what you tapped.
- **The app.** One state, built by a reducer shared by the daemon and the
  app (`packages/protocol`), sent as a numbered event stream over a
  WebSocket, with REST for reads and writes. The app is a PWA served by the
  daemon itself.
- **Your data.** Each kind of data lives in its own SQLite file, so a
  damaged one stops only its own part: `jantar.db` (events, audit, devices,
  push), `life.db` and `meetings.db`. Files the phone sends wait in
  `uploads/`. See [the state folder](configuration.md#the-state-folder).

## Packages

| Package | What |
|---|---|
| `packages/protocol` | zod schemas, event types, the shared reducer, REST and WebSocket types |
| `packages/daemon` | `jantard`: sources, hooks bridge, Terminal.app backend, writer, API, auth, Web Push, SQLite, Life, the Intel shelf, the primer and Meetings |
| `packages/life-core` | pure date, repeat, dose and adherence logic for Life |
| `packages/hook` | `jantar-hook`: zero-dependency hook client |
| `packages/cli` | `jantar`: every command in [Configuration](configuration.md#commands) |
| `packages/web` | Vite + React 19 PWA ([its README](../packages/web/README.md)) |
| `packages/extension` | the Jantar Chrome extension (Manifest V3, esbuild): the page's caption reader and camera button, the service worker, the popup |
| `test/fixtures` | synthetic HOME builder and fake `cswap` / `claude` / `ps` / `osascript` for tests |
| `test/integration` | end-to-end suites on a synthetic HOME, and the browser checks |

[LAYOUT.md](LAYOUT.md) maps the folders file by file, with the daemon's
startup order and its internal contracts.
