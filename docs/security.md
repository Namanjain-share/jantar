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
- Rewrite, Ask Claude, Chat and meeting summaries run Claude Code on your
  own account, so their text goes to Anthropic as any Claude Code use does.
  A meeting's screenshots never leave the Mac
  ([the summary](../SECURITY.md#the-summary-what-leaves-the-mac)). Chat
  sends what you type, your photos and what it looks up to answer, for the
  parts you turned on ([Chat and Siri](#chat-and-siri-v010)).
- With `jantar mcp` added, what its tools return (shelf items, and the
  titles and notes of the open todos of the project linked to the
  session's folder) goes into that Claude session and reaches Anthropic
  like any tool output
  ([the MCP server](../SECURITY.md#folder-todos-and-the-mcp-server)).
- With reading links on (0.8), a saved link's caption, page text, top
  comments, on-screen text, transcript, your note, and its frames as
  pictures go to Claude to write the item's summary; requests go to the
  platform from the Mac, and with Read saved links your Chrome visits the
  post as you ([reading links](../SECURITY.md#v08-intel-reads-links)).
- Work (0.13) keeps your clients' names, phones, e-mails and notes on the
  Mac, in life.db. They leave only when you ask: an export you name, what
  Chat reads to answer you (it goes to Claude through your account),
  `jantar mcp`'s `client_here` in a session (a name and the next step,
  never a phone or an e-mail), and a follow-up's push, which says only
  "Follow-up" and its time unless you turn its words on at the Mac. Jantar
  never messages a client and never reads another app's contacts
  ([Work](../SECURITY.md#v013-work-clients-the-log-follow-ups)).
- There is no Jantar server, no telemetry and no account with this project.

## Servers (v0.6, Fleet)

Off until you run `jantar fleet on` at the Mac
([SECURITY.md](../SECURITY.md#v06-fleet-paired-servers) has the full
model).

- Pairing a server extends your phone's reach to it, as far as that
  server's own switches allow. With the default, a paired phone, or anyone
  who takes over the Mac, can send prompts to every server; a server joined
  with `--read-only` is watch-only.
- Servers open no port. Each keeps one connection to the Mac's front door,
  with keys checked in both directions every time it connects; a server
  saves nothing unless the Mac that made its join line signs the answer.
- Each server's switches are set on that server only. Your phone's calls
  run there through the same checks as on the Mac.
- A server is untrusted on the Mac: it reports only its own sessions, and
  its text is checked, cut to size and labelled with the name the Mac gave
  it.
- The connection is protected by TLS and that handshake. Anything that ends
  TLS in the middle (Cloudflare, or a proxy a server trusts) could inject
  calls after a real handshake; Tailscale has no such middle party.
- The Mac is a single point of failure: while it sleeps, no server is
  reachable from the phone.

## Reading links (v0.8, Add post)

Off until you run `jantar intel read on` at the Mac
([SECURITY.md](../SECURITY.md#v08-intel-reads-links) has the full model).

- The Mac fetches the links you save, with an honest User-Agent and no
  cookies, and only public https addresses: it refuses local and private
  addresses, `.local` names and cloud metadata addresses, checked after DNS
  and again on every redirect, with size and time caps. A headless browser
  and yt-dlp go through the same check.
- Your own Chrome (the extension's **Read saved links**, off by default)
  opens only a post link the Mac rebuilt from the post's id, on one of six
  platforms' own host, in a muted background tab that closes the moment it
  goes anywhere else. Your cookies never leave Chrome.
- What a page says is data: Claude reads it in one run with no tools, no
  MCP and an empty folder, inside tags it can't close, and its answer is
  checked (no links, no Markdown) before it is kept.
- Frames and speech run in a small helper, under a macOS sandbox that
  can't reach the network, other programs, the pasteboard or any file in
  your home folder outside its job folder (shared places such as
  `/private/tmp`, `/Users/Shared` and attached drives stay readable to it).
  Audio never leaves the Mac.
- The iOS Shortcut's door exists only over Tailscale or Cloudflare, with a
  key made at the Mac; it can only save, and says the same sentence
  whatever happened ([the Shortcut](shortcut.md)).

## Chat and Siri (v0.10)

Chat sends what you type, your photos and what it looks up to answer
(only the parts you turned on) to Claude, on your account. Each message
is one Claude Code run with no file, shell or web tool: it can only call
Jantar's own tools, and Jantar stops the run before any call if Claude
Code shows anything else. Adds and changes happen at once with Undo for a
day; deletes, stopping a medicine and anything that spends quota wait for
your tap; after Chat reads text someone else wrote, its writes wait for
your tap too. It never types into a session. It saves a link only when
you wrote it. The history stays on the Mac (`chat.db`, 30 days by
default; `jantar chat clear` deletes it).

The Siri door takes its own key, made at the Mac and shown once. Someone
with that key could read and change your lists by voice or text (never
delete), 10 times a minute, until you revoke it: `jantar chat shortcut
revoke --all`. [SECURITY.md](../SECURITY.md#v010-chat-and-the-siri-door)
has the details.

## What a session can do

The trust boundary is your macOS user (and, with Fleet, the user Jantar
runs as on each paired server). Any process running as you,
including a Claude session with general Bash access, can reach Jantar's
local sockets and could pair itself as a device. That is no more than such
a process can already do, but treat card approvals as coming from
"anything running as you", not only your phone
([threat model](../SECURITY.md#threat-model-summary)).

With `jantar mcp` added to Claude Code, a session can search the Intel
shelf, save notes to it, and list and add todos of the Life project linked
to its folder (at most 20 an hour), never complete, edit or delete one.
Any process running as you could do the same for any linked folder
([folder todos and the MCP server](../SECURITY.md#folder-todos-and-the-mcp-server)).
When a session's ask shows Claude's 2-minute countdown, the daemon reads
that screen to warn your phone, and keeps nothing it reads
([the countdown read](../SECURITY.md#the-countdown-read)).

## Reporting a problem

Use GitHub's private vulnerability reporting on this repository
(**Security > Report a vulnerability**), not a public issue
([how](../SECURITY.md#reporting-a-problem)). Known risks the project has
accepted are listed under [accepted risks](../SECURITY.md#accepted-risks).
