# Configuration and command reference

Every `jantar` command, the daemon's flags, the environment variables,
the settings in `config.json` and what lives in the state folder. Each
command also has `--help`.

The CLI talks to the daemon over its control socket,
`~/.jantar/run/ctl.sock` (mode 0600). It never types into a terminal itself
and never approves anything: approvals come only from paired devices.
`packages/cli/README.md` lists what each command writes and runs.

## Commands

### Everyday

| Command | What it does |
|---|---|
| `jantar status [--json] [--alerts N]` | the board: your turn first, then cards, accounts and the last N alerts (default 3) |
| `jantar send <session> <text...\|-> [--replace] [--no-wait] [--timeout S] [--json]` | send a prompt and wait until the transcript proves it arrived ([details](phone-app.md#sending-a-prompt)) |
| `jantar new <folder> [options]` | start a session in a new Terminal window, as the phone does ([options](phone-app.md#new-session-and-resume)) |
| `jantar open [--print] [--no-admin]` | open the dashboard in this Mac's browser, one tap to pair |
| `jantar pair [--name NAME] [--admin \| --read-only] [--json] [--no-qr]` | a QR code that pairs a phone or browser, once, within 10 minutes ([options](install.md#pair-the-phone)) |
| `jantar pair --extension` | a line to paste into the Chrome extension's popup; waits until it pairs |
| `jantar devices list [--all] [--json]` | paired devices (`--all` includes revoked ones) |
| `jantar devices grant <device> <scope...>` | add scopes; only the Mac grants `launch` |
| `jantar devices revoke-scope <device> <scope...>` | take scopes back (the scopes above go with it) |
| `jantar devices revoke <device>` | sign a device out for good |

### Switches and folders

Each of these is a Mac-only setting: a phone can never change it.

| Command | What it does |
|---|---|
| `jantar folders list \| roots` | the roots set on this Mac and the exceptions; what the running daemon serves now |
| `jantar folders add-root <path> [--id ID] [--label L]` | a folder Files and New session may browse (refuses `/`, `/Users`, `~/Library` and protected folders) |
| `jantar folders rm-root <id>` | remove a root |
| `jantar folders allow <path>` / `rm-allow <path>` | open or hide a hidden home folder such as `~/.config/nvim` (never `~/.ssh`, `~/.claude*`, ...) |
| `jantar files on \| off \| status` | changed files and the read-only viewer |
| `jantar files roots [add <path> [--id ID] [--label L] \| remove <id>]` | the same roots as `folders` |
| `jantar launch on \| off \| status` | starting sessions from the phone |
| `jantar launch defaults [--permission P] [--chrome\|--no-chrome] [--effort E] [--model M] [--reset]` | where the start sheet's picks begin |
| `jantar launch mode claude \| cswap-run \| cs-shell` | how a new tab starts Claude: `claude` itself (one login), `cswap run`, or your `cs` shell function |
| `jantar launch pre-launch -- <argv...>` / `--clear` | a program run once per account before its first start (cswap-run mode; `{n}` is the account) |
| `jantar rewrite on \| off \| status` | dictated text into a prompt |
| `jantar rewrite glossary add \| rm <word...>` | words Rewrite must spell exactly |
| `jantar rewrite model opus \| sonnet \| haiku` | the model that writes prompts (default opus) |
| `jantar controls on \| off \| status` | Interrupt, the permission mode, the slash commands menu and Clear draft (on by default) |
| `jantar controls escape on \| off` | allow Escape (Interrupt sends it when `controls.interruptKey` is `escape`) |
| `jantar controls clear-draft on \| off` | show Clear draft |
| `jantar screenshots on \| off \| status` | a Picture view of the session's Terminal window |
| `jantar screenshots allow-select [on \| off]` | capture a background tab by selecting it for a moment |

### Life, Intel, accounts, Meetings and Ask

| Command | What it does |
|---|---|
| `jantar life status` | modules, zone, currency, who gets medicine pings, backups |
| `jantar life on \| off <module...> \| all` | `todos`, `medicines`, `food`, `places`, `finance` ([Life](life.md)) |
| `jantar life set timezone <IANA> \| none` | the zone days and ping times follow (none: the Mac's) |
| `jantar life set currency <XXX> \| none` | a label for amounts |
| `jantar life set lock-screen-details on \| off` | names on the lock screen |
| `jantar life backup` / `restore <file> [--yes]` | copy `life.db` now; put a backup back |
| `jantar intel on \| off \| sources` | the shelf and the files it follows ([Intel](intel.md)) |
| `jantar intel source add <file.jsonl>` / `source rm <id>` | follow a file, or stop |
| `jantar intel add "<title>" [--url U] [--type T] [--tag T]... [--note N]` | put an item on the shelf |
| `jantar intel list [--q TEXT] [--type T] [--tag T] [--limit N]` | what is on the shelf: best match first with `--q`, else newest first ([search](intel.md#search)) |
| `jantar mcp` | the MCP server Claude Code sessions use for the shelf and their folder's todos; in a terminal it prints the `claude mcp add` line to paste ([MCP](intel.md#from-claude-code-mcp)) |
| `jantar accounts` | one login or cswap, the kept accounts and the legacy ccw tool's hold list ([Accounts](accounts.md)) |
| `jantar accounts keep <n...>` / `keep --none` | the accounts kept for other work |
| `jantar accounts prime [on [--kept] \| off]` | prime idle 5-hour windows ([the primer](primer.md)) |
| `jantar meetings [on \| off]` | Meetings from the Chrome extension ([Meetings](extension.md)) |
| `jantar meetings export <id> \| last \| --all [--out DIR]` | a folder per meeting: `meeting.md` and `shots/*.jpg` |
| `jantar meetings unpair` | revoke every paired extension |
| `jantar ask on \| off \| status` | Ask, a chat page that suggests todos, reminders, food and money ([Ask](assistant.md)); `off` forgets its history; `status` names the model (Rewrite's) |

### Alerts

| Command | What it does |
|---|---|
| `jantar notify` (or `notify status`) | Web Push on or off, the kinds the Mac sends, the urgent alert, the mute |
| `jantar notify urgent on \| off` | the Answer soon push for Claude's 2-minute countdown (`notify.urgent`, on by default) |
| `jantar notify done on \| off` | adds or removes `done` in `notify.kinds` (the success tune needs it) |
| `jantar notify test [urgent \| needs \| done \| care \| problem]` | one test push of that group to your devices (default `needs`), past the Mac's kinds and the mute |

[Alerts and sounds](alerts.md) has the groups, their tones and what the lock screen can do.

### Setup

| Command | What it does |
|---|---|
| `jantar init [--yes]` | first-run setup: find Claude Code and cswap, write the settings this Mac needs |
| `jantar install [--print] [--no-start] [--no-doctor]` | set up `~/.jantar` and the LaunchAgent, start the daemon, run doctor |
| `jantar uninstall [--purge [--yes] [--force]]` | stop the daemon and remove the LaunchAgent (keeps `~/.jantar` unless `--purge`) |
| `jantar doctor [--json]` | read-only health check |
| `jantar remote status [--json]` | what is set up for the phone |
| `jantar remote setup [--tailscale \| --cloudflare] [--apply]` | the steps for Tailscale Serve (or a Cloudflare quick tunnel); `--apply` runs the Serve command |
| `jantar remote url https://HOST` / `--clear` | the address in pairing links |
| `jantar hooks status \| install \| uninstall [--apply \| --yes] [--settings FILE] [--json]` | Claude Code's hooks ([Hook cards](phone-control.md#hook-cards)) |
| `jantar version` | the CLI and protocol versions |

The command that imports a state dir from Jantar's old name is in the
README's Quickstart.

### Exit codes

`0` ok, `1` failed (for `send` and `new`: not sent or not proven), `2`
usage error, `3` daemon not running.

## The daemon's flags

`jantard` (`node packages/daemon/bin/jantard.mjs`):

| Flag | Effect |
|---|---|
| `--port <n>` | TCP port on 127.0.0.1 (default `remote.port`, 7420; `0` picks a free port) |
| `--home <dir>` | state dir (default `$JANTAR_HOME`, then `~/.jantar`) |
| `--no-terminal` | Terminal.app backend off: no screen peek, focus or sending |
| `--read-only` | observe only: refuse sending, focus, answering cards, the cswap poller, primes, Ask Claude, Ask's messages and settings changes (Life writes still work) |
| `-v`, `--version` | print the version |
| `-h`, `--help` | print the help |

## Environment

| Variable | Effect |
|---|---|
| `JANTAR_HOME` | the state folder (default `~/.jantar`). Keep it short: Unix socket paths max out at 103 bytes. `jantar install` pins it in the LaunchAgent |
| `JANTAR_ACCOUNTS=single` | one-login mode on a Mac that has cswap |
| `JANTAR_SKIP_HOOKS=1` | in a Claude session's environment: Jantar's hooks do nothing for that session (no cards; its dialogs are answered through the screen) |
| `JANTAR_LOG_LEVEL=debug` | more daemon logging; `jantar install` passes it to the LaunchAgent |
| `JANTAR_WEB_DIST` | serve the web app from another build folder; `jantar install` passes it on |
| `JANTAR_VAPID_SUBJECT` | the contact sent to push services (a `mailto:` or `https:` URL of yours) |

## Settings

Settings live in `~/.jantar/config.json`. Change them with the `jantar`
commands above: they go through the daemon, or into the file while it is
stopped. The groups marked "the Mac" are refused from any phone, an admin
device included. A setting the daemon does not know is refused, never dropped. The
full schema, with every default, is `packages/protocol/src/settings.ts`.

| Section | What it holds | Who changes it |
|---|---|---|
| `remote` | `port` (7420), `publicUrl` (the address in pairing links), `allowedOrigins` | the Mac (`jantar remote`) |
| `folders` | `roots`, `sessionRoots` (live sessions' folders count as roots; on), `allow`, `extraDeny` (added to the denylist, which can't shrink) | the Mac |
| `files`, `rewrite`, `screenshots`, `meetings`, `ask` | `enabled` (off), plus `rewrite.model` (also Ask's model), `rewrite.glossary`, `screenshots.allowSelect` | the Mac |
| `launch` | `enabled` (off), `mode` (`claude`), `defaultFlags`, `preLaunchArgv`, `csCommand`, rate limits | the Mac |
| `controls` | `enabled`, `escapeVerified`, `clearVerified` (all on), `interruptKey` (`interrupt` or `escape`) | the Mac |
| `life` | one switch per module (off), `timezone`, `currency`, `lockScreenDetails` | the Mac |
| `intel` | `enabled` (off), `sources` (up to 10 files) | the Mac |
| `accounts` | `kept`, `prime`, `primeKept` | the Mac |
| `bins` | absolute paths to `claude`, `cswap`, `osascript` and the rest, found by `jantar install` (launchd's `PATH` is minimal) | the Mac |
| `autoswitch` | the ceilings Jantar shows (`ceiling` 97 %, `weekly_ceiling` 95 %) and the hold list; Jantar itself does not switch accounts | the Mac, or an admin device |
| `notify`, `usage` | push bodies and kinds, a mute, and `urgent` (the Answer soon push, on); the cswap poller (`auto`: only while the legacy ccw tool's bot is not running) | the Mac, or an admin device |

## The state folder

Everything Jantar keeps is in `~/.jantar` (or `JANTAR_HOME`), mode 0700:

| Path | What |
|---|---|
| `config.json` | the settings |
| `jantar.db` | events, the audit log, devices, push subscriptions, paired extensions |
| `life.db`, `backups/` | Life, and its nightly copies (the newest 30) |
| `meetings.db`, `meetings/` | Meetings' text, and the screenshots, a folder per meeting |
| `uploads/<session>/` | files sent from the phone, removed after 7 days |
| `intel/captures.jsonl` | items added with `jantar intel add` or the phone |
| `primer/` | `primed.json` and the empty folder primes run in |
| `push/` | the Web Push keys |
| `bin/jantar-hook` | the hook client Claude's settings call |
| `logs/` | the daemon's logs |
| `run/` | `ctl.sock`, `hooks.sock` and screenshots in flight |
| `rewrite/`, `food-estimate/`, `meeting-summary/`, `ask/` | working folders for Rewrite, Ask Claude, meeting summaries and Ask. `ask/` holds only a copy of Ask's prompt and an empty `work/` folder the run starts in: Ask's history lives in the daemon's memory, never in a file |

`jantar uninstall --purge` deletes the whole folder after a y/N.
