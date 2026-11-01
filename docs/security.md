# Security, in plain words

Jantar can type into your terminals and answer Claude Code's permission
prompts. Anyone who can drive it can run commands on your Mac, so it is
built to be reachable by as little as possible. This page is the short
version; [SECURITY.md](../SECURITY.md) is the full threat model, and each
point below links to its section there.

## What Jantar can reach

- Claude Code's session files and transcripts, cswap's usage cache and the
  legacy ccw tool's files, read-only
  ([threat model](../SECURITY.md#threat-model-summary)).
- Terminal.app: it reads the text of the tabs Claude runs in and types only
  what you send or answer ([approvals](../SECURITY.md#approvals),
  [controls](../SECURITY.md#controls-keys-modes-slash-commands)).
- With Files on, the folders you name at the Mac, never keys, `.env` files,
  `~/.ssh` or the other names on a denylist that can't be shortened
  ([the path policy](../SECURITY.md#files-and-the-path-policy)).
- With screenshots on, a picture of a session's Terminal window
  ([screenshots](../SECURITY.md#screenshots-and-the-device-secret)).

## What a phone can and can't do

- A phone pairs once with a QR code that works once, for 10 minutes, and
  signs every write with its own secret
  ([authentication](../SECURITY.md#authentication-and-authorisation)).
- Scopes go read < control < launch < admin. Only the Mac grants `launch`,
  which starts sessions
  ([starting sessions](../SECURITY.md#starting-sessions-the-launch-scope-and-the-flags-allowlist)).
- A phone can never change a switch, a folder, a scope or the programs the
  daemon runs, not even an admin device: those are set at the Mac
  ([switches](../SECURITY.md#switches-set-on-the-mac-only)).
- New sessions take flags from fixed lists only; there is no free-text flag.
- An answer to a terminal dialog is typed only while the Mac still shows
  exactly the dialog you tapped, checked again in the same AppleScript run
  that types it ([answering a dialog](../SECURITY.md#answering-a-dialog),
  [what it can't close](../SECURITY.md#compare-and-type-and-what-it-cant-close)).

## What leaves the Mac

- The daemon listens on 127.0.0.1 only. Your phone reaches it through the
  front door you set up: Tailscale Serve, or a Cloudflare Tunnel, where TLS
  ends at Cloudflare ([network exposure](../SECURITY.md#network-exposure)).
- Notifications go to Apple's or Google's push service, with the detail you
  choose (medicine names stay off the lock screen unless you turn them on).
- Rewrite, Ask Claude, Ask and meeting summaries run Claude Code on your
  own account, so their text goes to Anthropic as any Claude Code use does.
  A meeting's screenshots never leave the Mac
  ([the summary](../SECURITY.md#the-summary-what-leaves-the-mac)). Ask
  sends only what you type there (medicine names or amounts you type
  included), the date and time, and which Life parts are on; your saved
  lists, medicines and money stay on the Mac, and nothing is added until
  you tap Add ([Ask](../SECURITY.md#v053-ask)).
- There is no Jantar server, no telemetry and no account with this project.

## What a session can do

The trust boundary is your macOS user. Any process running as you,
including a Claude session with general Bash access, can reach Jantar's
local sockets and could pair itself as a device. That is no more than such
a process can already do, but treat card approvals as coming from
"anything running as you", not only your phone
([threat model](../SECURITY.md#threat-model-summary)).

## Reporting a problem

Use GitHub's private vulnerability reporting on this repository
(**Security > Report a vulnerability**), not a public issue
([how](../SECURITY.md#reporting-a-problem)). Known risks the project has
accepted are listed under [accepted risks](../SECURITY.md#accepted-risks).
