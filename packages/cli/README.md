# jantar (CLI)

The command line client for `jantard`. It talks to the daemon over its
control socket, `~/.jantar/run/ctl.sock` (mode 0600). It never types into a
terminal itself and it never approves anything: approvals come only from
paired devices.

```
jantar init               first-run setup: find Claude Code and cswap, write the settings this Mac needs
jantar install            set up ~/.jantar and the LaunchAgent, start the daemon, run doctor
jantar doctor             read-only health check
jantar open               open the dashboard in this Mac's browser, one tap to pair
jantar remote setup       reach it from your phone (Tailscale Serve; --cloudflare as a fallback)
jantar pair               QR code that pairs a phone (one-time, 10 minutes)
jantar pair --extension   a line to paste into the Jantar Chrome extension; waits until it pairs
jantar hooks install      optional: approval / question / plan cards on the phone
jantar status             the board: "your turn" first, then accounts and alerts
jantar send <s> <text>    send a prompt and wait until the transcript proves it arrived
jantar uninstall          stop the daemon and remove the LaunchAgent (keeps ~/.jantar)
jantar import-ccw-v2      copy a ccw-v2 state dir (the old name, ~/.ccw-v2) into an empty ~/.jantar
```

Everything past the Board is off until switched on here, on the Mac. A
phone can never change these settings (`files`, `folders`, `launch`,
`rewrite`, `controls`, `screenshots`, `life`, `intel`, `accounts`,
`meetings` and `ask` are Mac-only groups), so every "turn it on at your Mac"
sentence the phone shows names one of these commands:

```
jantar folders add-root ~/Desktop     a folder Files and New session may browse (list, roots, rm-root, allow)
jantar files on|off                   changed files and the read-only viewer (files roots: the same roots)
jantar launch on|off                  starting sessions from the phone (status, defaults, mode, pre-launch)
jantar devices grant <device> launch  let one device start sessions (list, revoke-scope, revoke)
jantar new <folder>                   start a session from the Mac, as the start sheet does
jantar rewrite on|off                 dictated text into a prompt (glossary, model)
jantar controls on|off                keys, mode switching and slash commands, on by default (status, escape, clear-draft)
jantar screenshots on|off             a Picture view of the session's window (allow-select)
jantar life on <module...>            Life: todos, medicines, food, places, finance (status, off, set, backup, restore)
jantar intel on|off                   the Intel shelf (sources, source add <file.jsonl>, source rm, add, list)
jantar accounts                       one Claude login or cswap, the kept accounts and ccw's hold list
jantar accounts keep <n...>           keep accounts for other work: Auto, Rewrite, Ask Claude and Ask never pick them
jantar accounts prime on|off          start idle 5-hour windows early (cswap only; --kept for kept accounts too)
jantar meetings on|off                Meetings from the Chrome extension (bare: the status; unpair)
jantar meetings export <id|last|--all> [--out DIR]   a folder per meeting: meeting.md and shots/*.jpg
jantar ask on|off                     Ask: a chat page that suggests todos, reminders, food and money (status)
```

Flags for new sessions come from fixed lists only (`--permission`,
`--chrome`, `--effort`, `--model`); there is no way to pass other claude
flags. `folders add-root` refuses `/`, `/Users`, `~/Library` and anything
the daemon's denylist protects, checked by name and by realpath.

Every command has `--help`. Exit codes: `0` ok, `1` failed (for `send`, the
prompt was not sent or not proven), `2` usage error, `3` daemon not running.

## What each command touches

| Command | Writes | Runs |
|---|---|---|
| `init [--yes]` | `config.json` only (accounts, launching, folders), after asking; through the daemon when one runs | nothing (it only looks for files and binaries) |
| `install` | `~/.jantar/` (0700), `config.json` (`bins`: absolute paths found now), `~/.jantar/bin/jantar-hook`, `~/Library/LaunchAgents/com.jantar.daemon.plist`; refuses while ccw-v2's LaunchAgent is installed | `launchctl bootout` / `bootstrap` for `com.jantar.daemon` only |
| `install --print` | nothing | nothing |
| `uninstall [--purge]` | removes the plist (and `~/.jantar` with `--purge`, after a y/N) | `launchctl bootout` for `com.jantar.daemon` only |
| `doctor` | nothing | `cswap --version` (profile env stripped), `pgrep -f "ccw --telegram"`, `tailscale status --json`, `tailscale serve status --json` |
| `hooks install` / `uninstall` | nothing, unless `--apply` (asks y/N) or `--yes`; then Claude's settings file, with a backup | nothing |
| `remote setup --apply` | settings (`remote.publicUrl`, `allowedOrigins`) | `tailscale serve --bg --https=443 http://127.0.0.1:7420` |
| `open` | nothing | `/usr/bin/open <one-time local link>` |
| `files`, `folders`, `launch`, `rewrite`, `controls`, `screenshots`, `life on/off/set`, `intel on/off/source`, `accounts keep/prime` | settings, through the daemon (or `config.json` while it is down) | nothing itself; with priming on, the daemon later runs `cswap run --share-history <n> -- -p` on idle accounts |
| `meetings on/off` | settings, through the daemon (or `config.json` while it is down); `on` says what stays on the Mac and what the summary sends | nothing |
| `meetings export` | a new folder per meeting under `--out` (default: the current folder), 0700, holding `meeting.md` and `shots/*.jpg` (0600), read over `ctl.sock`; one meeting refuses a folder already there, `--all` leaves it as it is and goes on; times in Life's time zone when one is set, else the Mac's | nothing |
| `meetings unpair` | revokes every paired extension key, through the daemon | nothing |
| `ask on/off` | settings, through the daemon (or `config.json` while it is down); `on` says what goes to Claude and what stays on the Mac, `off` makes the daemon forget Ask's history (kept in its memory only) | nothing; with Ask on, the daemon runs one headless `claude -p` per message, on Rewrite's model |
| `pair --extension` | a one-time code in the daemon, printed as `jantar-ext:<port>:<code>` | nothing |
| `life backup` / `restore` | a copy of `life.db` in `~/.jantar/backups` / `life.db` from a backup (the old one kept beside it), through the daemon | nothing |
| `intel add` | one line in `~/.jantar/intel/captures.jsonl`, through the daemon | nothing |
| `devices grant` / `revoke-scope` / `revoke` | the device's scopes, through the daemon | nothing |
| `new` | nothing itself; the daemon opens one Terminal window | nothing |
| `import-ccw-v2 [--from DIR] [--dry-run]` | an empty `~/.jantar` (built beside it, then renamed into place); never anything in the old dir, which it only reads; refuses while ccw-v2's daemon or LaunchAgent is still there | nothing |

It never reads cswap's credentials or configs, Claude's `.key` files or the
legacy ccw tool's Telegram config, and never edits ccw's files or its
LaunchAgent. While ccw's bot runs, `doctor` checks that Jantar stays in
coexistence mode (no autoswitch, no Telegram, no Mac banners, no second
cswap poller).

## Remote access

The daemon only listens on `127.0.0.1`. For a phone, put HTTPS in front of it:

- **Tailscale Serve (recommended):** tailnet only, a real certificate and a
  stable URL (the Home Screen app and push keep working).
  `jantar remote setup --apply` runs the Serve command and points pairing
  links at `https://<mac>.<tailnet>.ts.net`. Funnel (public internet) is never
  used, and `doctor` fails if it finds Funnel on the daemon.
- **Cloudflare quick tunnel (fallback):** `jantar remote setup --cloudflare`
  prints the steps. The URL changes on every restart and Cloudflare
  terminates TLS.

Pairing is required on top of either.

## Tests

```
pnpm --filter @jantar/cli test               # unit + end-to-end
pnpm --filter @jantar/cli test:unit
pnpm --filter @jantar/cli test:integration   # boots jantard in-process (test/integration)
```

Tests run on a synthetic HOME (`makeFakeHome()` from `@jantar/fixtures`)
with an injected exec: they never run `launchctl`, `osascript`, `tailscale` or a
browser, and never install hooks. Under a test runner the CLI also refuses
to write into the real user's `~/Library/LaunchAgents`, `~/.jantar`,
`~/.claude*` or `~/.config/ccw` (`src/lib/guard.ts`).

The end-to-end suites (`test/integration`) boot the daemon with the
production wiring (`startDaemon` from `packages/daemon/src/daemon.ts`, the
same function `jantard` runs), with fake `cswap` / `ps` / `osascript` /
`lsof` on PATH and a scripted terminal instead of Terminal.app. They check
session discovery and accounts, a hook PermissionRequest decided from a
paired device, an AskUserQuestion answered through the real hook client (its
push, its tap link and its audit entry), `jantar send` proven by the
transcript, every refusal of `--read-only` and `--no-terminal`, the v0.3
commands over the real control socket (each "turn it on at your Mac"
sentence followed, a scope granted, a root added and a session started with
`jantar new` in a scripted window), and the real `jantard` binary starting
with flags and stopping cleanly on SIGTERM (that one needs `pnpm -r build`
first and is skipped otherwise).
