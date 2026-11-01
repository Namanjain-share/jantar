# Servers (Fleet)

Pair your Linux servers, Windows machines and other Macs with the Mac
Jantar runs on, and the phone shows every Claude Code session on all of
them on one board. Each server runs its own sessions on its own Claude
account(s); you answer, prompt and start them from the same app.

Fleet is new in v0.6 and **off by default**. Until you run
`jantar fleet on` at the Mac, nothing in the app or the daemon changes.
Parts of it are not yet checked on real servers: see
[Not verified yet](#not-verified-yet) before you rely on it.

Below, `jantar.example.com` stands for your Mac's front door, `build-1`
for a server and `/home/sam` for a home folder on it.

## How it works

- **The Mac stays the hub.** The phone talks to the Mac as it does today,
  through your Tailscale or Cloudflare front door. The Mac is always the
  hub: there is no Linux or Windows hub.
- **Each server dials out.** A server runs Jantar too, as a *node*. It keeps
  one WebSocket open to `https://jantar.example.com/v1/node/link`, through
  the same front door. Servers open no port and need nothing inbound, so
  they work behind NAT and firewalls wherever outbound HTTPS works. The Mac
  gets no new port or hostname either.
- **Keys pinned at join.** `jantar node pair` at the Mac prints a one-time
  line. The server makes its own key pair, claims the line, and checks the
  Mac's signature against the key in the line before it saves anything.
  Every reconnect is a fresh challenge in both directions. The Mac keeps
  only the servers' public keys.
- **The phone's calls run on the server.** When you answer a card or send a
  prompt to a server's session, the Mac checks your phone as it always does,
  then forwards the call. The server runs it through its own API, with its
  own switches and guards: the same checks that protect a session on the
  Mac protect it there.
- **The Mac names each server** (`--name` at pairing). A server can never
  call itself "Mac", and its cards always carry the name the Mac gave it.

The Mac is the one way in. **While it sleeps or is off, the phone reaches no
server** (the servers keep running; their sessions wait). See
[The sleeping Mac](#the-sleeping-mac).

## What works where

| | Linux, Claude in tmux | Linux, Claude outside tmux | Windows with WSL2 | Native Windows (preview) | Another Mac |
|---|---|---|---|---|---|
| Sessions on the board, status, last reply, transcript | yes | yes | yes | yes | yes |
| Hook cards (approve, deny, questions, plans) | yes | yes | yes | yes, Claude Code 2.1.310 or newer | yes |
| Screen text, terminal dialogs, keypad | yes | no | yes | no | yes |
| Send prompts and attachments | yes | no | yes | no | yes |
| Keys, modes, slash commands, Interrupt | yes | no | yes | no | yes |
| Start or resume sessions | yes (a new tmux session) | no | yes | no | yes (a new Terminal window) |
| Picture view, Files, Rewrite | no | no | no | no | no |
| Accounts | cswap if installed, else config dirs | same | same, inside WSL | config dirs | cswap or one login |
| Usage numbers | with cswap | with cswap | with cswap | no | with cswap |
| Runs as | a systemd user service | same | systemd inside WSL2 | a task at logon (lines printed) | the LaunchAgent |

Escape and Clear draft stay off on tmux servers until they are checked
there with real Claude Code.

## Before you start

**At the Mac:** Jantar installed and reachable from your phone through a
fixed front door: [Tailscale Serve](install.md#tailscale-recommended) or a
[named Cloudflare Tunnel with Access](install.md#cloudflare-tunnel-with-access).
A loopback or LAN address, `http://`, or a quick tunnel (its address
changes on every restart) can't be used for servers, and `jantar fleet on`
refuses them.

**On each server:**

- Node.js 22.13 or newer with corepack (it brings pnpm 10), and git. A
  distribution's own Node package may be older; Node's own packages or a
  version manager give a current one.
- Claude Code, installed and signed in on that server. Over SSH:
  `claude auth login` prints a link; open it on your phone or laptop and
  paste the code back. Each account in its own config dir:
  `CLAUDE_CONFIG_DIR=~/.claude-work claude auth login`. Logins stay at the
  server; the phone never sees one.
- **Linux and WSL2:** tmux 3.2 or newer and procps
  (`sudo apt-get install -y tmux procps git` on Debian or Ubuntu;
  `apk add procps` on Alpine, whose own `ps` is not enough), and systemd
  240 or newer for the service.
- **Native Windows:** Windows 10 1809 or Windows Server 2019 or newer.

Building Jantar took about 15 seconds for `pnpm install` and about a minute
for `pnpm -r build` on a 12-core builder (Debian 12 in Docker), with a peak
of about 1.5 GB of memory. A server with 1 GB of memory needs swap for the
build; expect it to take longer on a small server.

## Turn Fleet on

At the Mac:

```
$ jantar fleet on
Fleet is on. Servers reach this Mac at https://jantar.example.com/v1/node/link
With Cloudflare Access in front (the setup in docs/install.md), add one Access
application for jantar.example.com/v1/node/* with a single Service Auth policy
and a service token (docs/fleet.md#cloudflare-access). Each server needs that
token's id and secret. Note the token's expiry date: when it lapses every server
goes offline at once (renew it with jantar node access on each server).
This Mac is the hub: while it sleeps or is off, the phone can't reach any server.
Next: jantar node pair --name <name> [--count K] here, then run each line on its server.
```

With Tailscale it prints the tag and grant to add instead. Fleet is a
Mac-only switch: a phone, an admin phone included, can never turn it on.
The first `fleet on` makes the Mac's Fleet key,
`~/.jantar/fleet/hub-key.pem` (0600 in a 0700 folder).

## Open the door for servers

Servers use the same front door as your phone. Pick the part below for the
door you have.

### Cloudflare Access

Your phone gets through Access with your e-mail address. A server can't log
in like that, so it uses a **service token** on its own Access application
that covers only the servers' path.

1. In Cloudflare Zero Trust, under Access > Service auth, create a service
   token named `jantar-nodes`. Pick its duration and **write down the expiry
   date**: when it lapses, every server goes offline at once. Copy its
   client id and client secret; the secret is shown once.
2. Under Access > Applications, add a self-hosted application for
   `jantar.example.com` with the path `/v1/node/*`.
3. Give it **one** policy, with the action **Service Auth**, that includes
   the `jantar-nodes` token. Not Allow (that shows a login page) and never
   Bypass (that leaves the path open and unlogged).

A more specific path takes precedence in Access, so the token works only on
`/v1/node/*`, and your phone's e-mail login does nothing there. Each server
sends the token's two headers on every connect.

`jantar doctor` at the Mac checks this door from outside: with Fleet on, it
asks `https://jantar.example.com/v1/node/pair` without the token. An answer
from Access is right. An answer from Jantar means the servers' path is open
to the internet with only Jantar's own handshake in front, and doctor
warns.

One token for every server is the simple default: Jantar's own key per
server is what removing a server relies on, and a stolen token alone gets
only as far as that handshake. One token per server also works, if you want
to revoke a server at Cloudflare too.

### Tailscale

1. Put each server on your tailnet with a tag:
   `sudo tailscale up --advertise-tags=tag:jantar-node` (on Windows, add
   `--unattended` so it stays up after you log out). A pre-approved, tagged
   auth key does it without a login.
2. In your tailnet's access policy, let that tag reach the Mac's HTTPS port
   and nothing else. A synthetic example, where `100.64.0.10` is the Mac:

   ```json
   {
     "tagOwners": { "tag:jantar-node": ["autogroup:admin"] },
     "hosts": { "jantar-hub": "100.64.0.10" },
     "grants": [
       { "src": ["autogroup:member"], "dst": ["*"], "ip": ["*"] },
       { "src": ["tag:jantar-node"], "dst": ["jantar-hub"], "ip": ["tcp:443"] }
     ]
   }
   ```

   Servers then reach only the Mac's Serve port: not each other, not
   anything else on the Mac. Your own devices still reach the servers.

There is no Access token on Tailscale: `jantar node join` asks for none. A
server that can't have a TUN device (Tailscale's userspace mode) can't
link; use the Cloudflare door for it.

Both doors at once is not supported: the servers use the door your phone
uses (`jantar remote status` at the Mac shows it).

## Pair the servers

At the Mac, one line per server, each good once for 10 minutes:

```
$ jantar node pair --name build --count 3
Run one line on each server within 10 minutes. Each works once.
  build-1  jantar node join jn1.eyJ1IjoiaHR0cHM6Ly9qYW50YXIuZXhhbXBsZS5jb20iLCJjIjoi…
  build-2  jantar node join jn1.eyJ1IjoiaHR0cHM6Ly9qYW50YXIuZXhhbXBsZS5jb20iLCJjIjoi…
  build-3  jantar node join jn1.eyJ1IjoiaHR0cHM6Ly9qYW50YXIuZXhhbXBsZS5jb20iLCJjIjoi…
```

Names use `a-z`, `0-9` and `-`, up to 24 characters, never `mac`. Without
`--name` they are `node-1`, `node-2`, ... `--count` goes up to 20; `--json`
prints the lines for a script. A line holds the Mac's address, a one-time
code and the Mac's public key: no password, and nothing that works after it
is used or after 10 minutes. Pairing works only at the Mac (its control
socket), never from a phone.

## Install and join

### Linux, WSL2 or another Mac

On the server, as the user who runs Claude:

```sh
git clone https://github.com/Namanjain-share/jantar.git ~/jantar
cd ~/jantar
corepack enable        # with sudo if Node is installed system-wide
pnpm install --frozen-lockfile && pnpm -r build
alias jantar="node $HOME/jantar/packages/cli/bin/jantar.mjs"
jantar node join jn1.eyJ1Ijoi… --hooks
```

Put the `alias` line in your shell's startup file to keep `jantar` around.
What the join prints on a Linux server with the Cloudflare door:

```
Cloudflare Access client id (empty if the door has no Access): 3f2a….access
Cloudflare Access client secret: (hidden)
Paired with https://jantar.example.com as build-1.
Service: systemd user unit jantar.service, started. Lingering is on, so it keeps running after you log out.
Linked. 2 Claude sessions here (1 in tmux) on 2 accounts: claude (~/.claude), work (~/.claude-work).
Hooks: installed in ~/.claude/settings.json and ~/.claude-work/settings.json.
Sessions outside tmux show on the phone with their cards, but Jantar can't type into them.
Starting sessions from the phone is off here: jantar launch on, then jantar folders add-root <dir>.
```

The join, in order:

1. Refuses if this machine already looks like a hub: it has paired phones,
   push subscriptions, paired servers or a front door of its own. With its
   daemon stopped, join reads Jantar's database without changing it (a
   server's own database holds none of these, so leaving and joining again
   just works). Joining would make it a server and its phones would lose
   it. `--replace-hub` goes on anyway, after one warning line.
2. Asks for the Access token (not on Tailscale). The secret is asked
   without echo, or read from `JANTAR_CF_ACCESS_CLIENT_SECRET`; it is never
   a flag, so it never lands in your shell history, and it is never
   printed. Pass the id with `--cf-access-client-id` to skip that question.
3. Claims the line and checks the Mac's signature. If anything but the Mac
   that made the line answers, it stops with nothing saved.
4. Saves `~/.jantar/node/node.json` (0600 in a 0700 folder): the Mac's
   address and key, this server's name and private key, and the Access
   token.
5. Installs and starts the service (below), then waits up to 15 seconds for
   the first link.

| Option | Effect |
|---|---|
| `--hooks` | install Jantar's hooks into every Claude config dir here (`~/.claude` and each `~/.claude-<name>` with a login), so cards reach the phone |
| `--read-only` | watch only: cards, prompts, keys and starting sessions are all refused on this server |
| `--no-service` | install no service; run `jantard` yourself (the join prints the line) |
| `--cf-access-client-id ID` | the Access token's id |
| `--replace-hub` | join even though this machine has phones of its own |

Where the service can't start (no systemd: a container, OpenRC, WSL
without systemd), the join still pairs and prints the daemon's own line to
run yourself, as `--no-service` does; `jantar node leave` works there too.

**The service on Linux** is a systemd user unit,
`~/.config/systemd/user/jantar.service`, with `KillMode=process`: restarting
Jantar never stops the tmux sessions it started. The join turns on
lingering (`loginctl enable-linger`), so it keeps running after you log out
and starts at boot; if that is refused it prints the `sudo` line to run.
The daemon's logs go to `~/.jantar/logs/daemon.{out,err}.log`.

**On another Mac** the service is the usual LaunchAgent, and that Mac needs
the Automation permission for Terminal, as the hub does.

### WSL2

WSL2 is the full way to run a Windows server: Claude Code and Jantar both
run inside the Linux distro, and everything in the Linux column works. WSL1
can't run Claude Code (`wsl --set-version <distro> 2`). WSL2 needs Windows
10 or 11, or Windows Server 2022 or newer (Server 2019 has only WSL1), and
hardware virtualization: on a cloud VM, an instance type with nested
virtualization.

Inside WSL, systemd must be on: `[boot]` `systemd=true` in
`/etc/wsl.conf`, then `wsl --shutdown` from Windows. WSL also stops about
15 seconds after its last terminal closes, service or not. To keep it
running, put this in `%USERPROFILE%\.wslconfig` on the Windows side:

```ini
[general]
instanceIdleTimeout=-1

[wsl2]
vmIdleTimeout=-1
```

and add a Task Scheduler task that starts the distro at logon (for
example, the program `wsl.exe` with the arguments `-d Ubuntu --exec
/bin/true`). WSL can't start before a user logs on, so an unattended server
needs auto-logon. `jantar doctor` inside WSL prints these lines.

### Windows

Native Windows is a **preview**, and not yet checked on a real Windows
machine. Windows Terminal can't be typed into or read from outside (its
makers refuse that for good), so Jantar gets the sessions, their
transcripts and their hook cards, and nothing else: no prompts, screen,
keypad or starting sessions. For those, use [WSL2](#wsl2). Where WSL2 can't
run (no virtualization, as on many cloud VMs), this is what the machine
gets.

In PowerShell:

```powershell
git clone https://github.com/Namanjain-share/jantar.git $HOME\jantar
cd $HOME\jantar
corepack enable
pnpm install --frozen-lockfile
pnpm -r build
node packages\cli\bin\jantar.mjs node join jn1.eyJ1Ijoi… --hooks
```

For a `jantar` command, save a `jantar.cmd` in a folder on your `PATH`
holding one line: `@node "C:\Users\sam\jantar\packages\cli\bin\jantar.mjs" %*`.

Cards need Claude Code 2.1.310 or newer there (`jantar hooks status` says
when it is older). Jantar's hooks on Windows use Claude Code's exec form,
with no shell, and fail open: if Jantar is not running, Claude asks in its
own terminal.

There is no Windows service code. The join prints two lines to run in
Command Prompt (`cmd.exe`, **Run as administrator**: creating a logon task
needs it), a task that starts the daemon at logon:

```
schtasks /Create /TN Jantar /SC ONLOGON /RL LIMITED /F /TR "\"C:\Program Files\nodejs\node.exe\" \"C:\Users\sam\jantar\packages\daemon\bin\jantard.mjs\" --log-files"
schtasks /Run /TN Jantar
```

It runs while you are logged on; an unattended server needs auto-logon or
a kept session. At logon a console window opens for it: keep it open
(minimise it), as closing it stops Jantar. `schtasks /End /TN Jantar` stops it and
`schtasks /Delete /TN Jantar /F` removes it. `jantar install` prints the
lines again (to update): it keeps `--read-only` when the running daemon has
it, and with the daemon stopped it asks you to say `--read-only` or
`--no-read-only`. On Windows the 0600 and 0700
file modes mean nothing; your user profile's permissions protect the
Jantar folder.

**Use native Windows only on a machine nobody else logs on to.** The pipes
Jantar listens on have machine-wide names, so another user could create one
first. The hook client checks the hooks pipe's owner against a key the
daemon writes to `run\hooks.key` in the Jantar folder at each start, and
sends nothing to a pipe that fails, so Claude asks in its own terminal; the
control pipe has no such check yet. Keep the Jantar folder in your profile
(the default): a `JANTAR_HOME` outside `%USERPROFILE%` leaves the key as
readable as that folder. On a shared server, use [WSL2](#wsl2) or Linux.

## Accounts on a server

| Server | Accounts | Usage numbers |
|---|---|---|
| Linux or WSL2 with cswap | cswap's accounts, read from `~/.local/share/claude-swap` | yes |
| Linux or WSL2 without cswap, native Windows | its config dirs: `~/.claude` is `claude`, and each `~/.claude-<name>` with a `.claude.json` is `<name>`, numbered the first time it is seen and never renumbered | no |
| Another Mac | as on the hub: cswap, or one login | with cswap |

The phone's Accounts screen has one section per machine. Jantar only checks
that a config dir's `.claude.json` exists: it never opens it or the login
inside. A session started from the phone in a config dir runs as
`env CLAUDE_CONFIG_DIR=<dir> claude …` (no `env` part for `~/.claude`).

## Sessions in tmux

On Linux and WSL2, Jantar types only into Claude sessions that run in tmux
(its default server), and reads their screens there:

```sh
tmux new-session -s api
claude
```

A session outside tmux shows on the phone with its cards and transcript,
and the composer says it can't type into it. Panes in copy mode, with
synchronized panes or with input off are refused, with a line saying which.
Every write is bound to the session's own terminal and checked inside tmux
in the same step that types it.

Starting sessions from the phone is off on a new server, as on the Mac. On
the server: `jantar launch on`, then `jantar folders add-root ~/code`. The
phone's start sheet then has a **Where** row; a session started there opens
in a new tmux session (200 columns by 50 rows) that you can attach to with
`tmux attach`. From the Mac's command line: `jantar new /home/sam/code/api-server --node build-1`.

Each server keeps its own switches (`jantar controls`, `jantar launch`, its
folder roots, `--read-only`), set only on that server. The Mac's switches
govern the Mac's sessions.

## See how it is

At the Mac:

```
$ jantar fleet status
Fleet:   on
Door:    https://jantar.example.com/v1/node/link (Cloudflare)
Servers: 2 of 3 online
  build-1  online · 3 sessions
  build-2  online · 1 session
  build-3  offline for 14m · last: the connection dropped (1006)
```

- `jantar node list` lists each server's OS, terminal, sessions, whether it
  is online, and its Jantar version, marked when it differs from the Mac's.
- `jantar status` adds one line per machine under the board.
- The phone shows the same under Devices > Machines.

When every server dropped within two minutes of each other while the Mac
stayed up, `fleet status` adds one hint: the Access token may have expired
([rotate it](#rotate-the-access-token)).

On a server: `jantar node status` (the link and why it last closed, the
terminal, accounts, hooks per config dir, read-only, starting) and
`jantar doctor` (tmux, procps, lingering, WSL, the Claude version on
Windows, hooks, the link). `status` shows the Mac's host and the Access
token's id, never the secret or the key.

## Update a server

Servers update on their own schedule. Each one, from its clone:

```sh
cd ~/jantar
git pull --ff-only
pnpm install --frozen-lockfile && pnpm -r build
node packages/cli/bin/jantar.mjs install
```

`jantar install` rewrites and restarts the service (a server installed with
`--read-only` stays read-only), and the link comes back by itself. With no
service file to read (native Windows, or a server joined with
`--no-service`), install asks the running daemon; if that is stopped too,
it refuses until you add `--read-only` or `--no-read-only`. On
native Windows it prints the task's lines again; run
`schtasks /End /TN Jantar` and `schtasks /Run /TN Jantar` to restart it on
the new build.

Ten servers over SSH, with synthetic names:

```sh
for h in build-1 build-2 build-3; do
  ssh "$h" 'cd ~/jantar && git pull --ff-only && pnpm install --frozen-lockfile && pnpm -r build && node packages/cli/bin/jantar.mjs install'
done
```

(Each server's non-interactive shell must find `node` and `pnpm`.)

Different Jantar versions work together as long as their link version is
the same; `jantar node list` and the phone show who runs what. A server on
another link version can't link: the Mac shows "build-2 runs an older link
version: update Jantar there", and updating that side fixes it.

## Rotate the Access token

The shared token's expiry takes every server offline at once, so renew it
before the date you wrote down:

1. In Cloudflare Zero Trust, rotate the `jantar-nodes` token's secret and
   keep the old secret valid for a while (Cloudflare offers an overlap).
2. On each server, within that overlap:

   ```sh
   jantar node access
   ```

   It asks for the id (shown, the current one by default) and the new
   secret (hidden, or `JANTAR_CF_ACCESS_CLIENT_SECRET`), saves them and
   restarts the service. The server's pairing and key stay: no new join
   line.
3. `jantar fleet status` at the Mac shows them all online again.

If the token already lapsed, do the same with a new token; each server
comes back as soon as its service restarts. A server counts the Access
refusals it met while away and reports them on its next link
(`jantar fleet status` shows them).

## Remove a server

At the Mac, `jantar node revoke build-2`, or **Remove** under Devices >
Machines on an admin phone (two taps). Its link closes at once, its
sessions and cards leave the board, and it can't link again. The row stays
in the Mac's records for the audit log.

On the server, `jantar node leave` stops and removes the service and
deletes its key. Where `systemctl --user` can't run (no systemd, or a
shell without your login session, such as `sudo -iu`), it still removes the
unit and the key, and prints how to stop a `jantard` still running. Claude's hooks stay (they fail open):
`jantar hooks uninstall --apply` removes them. To pair it again, make a new
line at the Mac and join with it.

A server unseen for 90 days is removed when it next connects. Two machines
with the same key (a cloned VM) push each other off: the newest link wins.
Run `jantar node leave` and join again on one of them.

## Turn Fleet off

`jantar fleet off` at the Mac closes every server's link and takes their
sessions off the board. The pairings stay: `jantar fleet on` brings them
back without joining again (the servers retry every 10 minutes while Fleet
is off).

## Replace the hub key

If the Mac's Fleet key may have leaked, every server must pair again:

1. `jantar fleet off`.
2. `jantar node revoke <name>` for each server (`jantar node list`).
3. Delete `~/.jantar/fleet/hub-key.pem`.
4. `jantar fleet on` makes a new key.
5. `jantar node pair` again, and on each server `jantar node leave`, then
   join with its new line.

## The sleeping Mac

Every server is reached through the Mac. While the Mac sleeps, is off or
loses its network, the phone shows the servers as unreachable, and cards
and prompts for them wait. The servers keep running; Claude keeps waiting
in their terminals. A Mac used as the hub should not sleep on power: turn
on "Prevent automatic sleeping on power adapter when the display is off"
(System Settings > Battery > Options, or Energy), or run
`sudo pmset -c sleep 0`. With Fleet on, `jantar fleet on` and
`jantar doctor` read the Mac's sleep setting (read only) and say when it
sleeps on power.

## Security

The whole picture is in
[SECURITY.md](../SECURITY.md#v06-fleet-paired-servers). In short:

- A server opens no port. It dials the Mac's front door, and the Mac
  checks it with the key it kept at pairing; the server checks the Mac
  with the key pinned in its join line. A join line works once, for 10
  minutes.
- The phone's calls for a server's session are checked at the Mac as any
  call is (its pairing, scope and the device secret), then run on the
  server behind that server's own switches. A server never sees your
  phone's secret, and the Mac never runs anything a server asks.
- The Mac treats each server as untrusted: a server can only speak of its
  own sessions, within fixed limits (64 sessions, 32 cards, 10 pushes a
  minute, bounded sizes and rates); past them its link is closed.
- `jantar node join --read-only` makes a watch-only server: it shows its
  sessions and cards, and refuses every prompt, key and answer.
- `jantar node revoke <name>` at the Mac ends a server's link at once; it
  needs a new join line to come back.
- Native Windows: only on a machine nobody else logs on to (see
  [Windows](#windows)).

## Limits

- The Mac is the only hub; a server joins one Mac, once. No server-to-server
  anything.
- One door for the phone and the servers. No HTTP proxy, no Tailscale
  userspace mode, no quick tunnel.
- tmux's default server only; no GNU screen, iTerm2 or other terminals on
  servers.
- Native Windows: watch and cards only (see [Windows](#windows)).
- No Picture view, Files or Rewrite for servers' sessions; Life, Intel,
  Meetings and notifications live on the Mac.
- A server that goes offline keeps its rows and cards on the phone, muted
  ("offline since 14:02"), until it is back, removed, or the Mac's daemon
  restarts. Nothing is queued: a prompt or answer to an offline server is
  refused at once.
- After the Mac's daemon restarts, an open card on a server may be pushed
  to the phone once more.
- Per server: 64 sessions, 32 open cards, its newest 20 alerts and
  finished sends beside the Mac's, 10 notifications a minute, and
  1 MiB per message (larger replies such as transcript pages and uploads
  travel in parts; uploads up to the usual 20 MiB).

## Not verified yet

These are built and tested against fakes (a fake Claude in Docker for
Linux), but not yet on real machines. Until each passes, the safe
behaviour holds: a refusal you can see, never a guess.

- **Sending prompts on Linux.** Before typing, Jantar checks that the
  Claude process is the session's, by its start time. Until a real server
  confirms the format Claude writes there, a mismatch refuses the send
  with a sentence that names the server. Cards and transcripts work either
  way.
- **Real Claude Code in tmux:** prompt timing, dialog answers through the
  screen, and Escape and Clear draft (off on tmux servers until checked).
  If a dialog never matches, every answer is a visible refusal and nothing
  is typed; hook cards still work.
- **The Cloudflare Access path application for the WebSocket.** If it
  fails, the server reports "Access refused"; Tailscale is the other door.
- **Native Windows** (hooks through a named pipe, the printed task): see
  [Windows](#windows). Also whether the logon task needs the elevated
  Command Prompt the join asks for on every Windows edition, and its console
  window at logon (the automated check runs elevated, with no logon).
- **WSL2 keep-alive** over hours, and a second Mac as a server.

The security side of Fleet, including what it does not protect against,
is in [SECURITY.md](../SECURITY.md#v06-fleet-paired-servers).
