# Install and run

How to put Jantar on your Mac, try it without changing anything, run it
for real, and reach it from your phone. The README's Quickstart is the
short version of this page.

## Requirements

- macOS with Terminal.app. It is the only terminal Jantar drives so far
  (see the [roadmap](roadmap.md)).
- Node.js 22.13 or newer, and pnpm 10.
- Claude Code, signed in. One account is enough. The "Ask me" permission
  pick types `--permission-mode manual`, which needs Claude Code 2.1.314 or
  newer.
- Claude Code's hooks are optional and opt-in. They carry the approval
  cards ([Hook cards](phone-control.md#hook-cards)).
- Optional: cswap 0.26.x for several accounts, their usage, moves and the
  [primer](primer.md).
- Optional: Tailscale, or a Cloudflare Tunnel, for the phone.
- Optional: Chrome 120 or newer for [Meetings](extension.md).
- Optional, v0.6: Linux servers, Windows machines and other Macs paired
  with this Mac. Each needs its own install; [Servers](fleet.md#before-you-start)
  lists what.

## Install

Clone the repository (the exact line is in the
[README's Quickstart](../README.md#quickstart)), then:

```sh
cd jantar
pnpm install && pnpm -r build

# put the CLI on your PATH (or: cd packages/cli && pnpm link --global)
alias jantar="node $PWD/packages/cli/bin/jantar.mjs"
```

To look first, skip `jantar init` for now and try it in a throwaway folder
(next section). Nothing in it needs `init`.

## Try it without touching anything

`--read-only` refuses every action on your sessions (no typing, no focus,
no answering cards, no cswap calls, no settings changes, no primes, no Ask
Claude runs) and `--no-terminal` means no AppleScript at all. With a
throwaway state dir, nothing is written outside it:

```sh
export JANTAR_HOME=/tmp/jantar-try     # keep it short: Unix socket paths max out at 103 bytes
node packages/daemon/bin/jantard.mjs --read-only --no-terminal --port 7491
```

In a second terminal, in the same folder, with the same alias and
`JANTAR_HOME` (neither carries over from the first terminal):

```sh
alias jantar="node $PWD/packages/cli/bin/jantar.mjs"
export JANTAR_HOME=/tmp/jantar-try
jantar status       # the board: your turn first, then accounts
jantar open         # the dashboard in this Mac's browser, one tap to pair
```

`jantar open` links to the port the daemon listens on (7491 here). The page
asks you to tap **Pair this browser**, then offers notifications, which you
can skip. Stop the daemon with Ctrl-C (it shuts down cleanly and removes its
sockets), then `rm -rf /tmp/jantar-try`. `JANTAR_ACCOUNTS=single` in the
daemon's environment shows the single-account view on a Mac that has
cswap.

## Set it up

```sh
unset JANTAR_HOME                 # back to ~/.jantar, if you tried it first
jantar init
```

`jantar init` has four steps: what this Mac has (Node, `claude`, `cswap`,
Terminal.app), accounts, launching and folders, then what to run next. It
runs no program and writes settings only, after asking. `jantar init --yes`
takes every default and leaves an existing config as it is.

## Run it for real

```sh
jantar install --print            # shows exactly what install would write and run
jantar install                    # ~/.jantar, the hook client copy, the LaunchAgent com.jantar.daemon, then doctor
jantar doctor                     # read-only health check (cswap and ccw are optional)
jantar open
```

`jantar install` writes `~/Library/LaunchAgents/com.jantar.daemon.plist`
(KeepAlive, an absolute node path) and loads it with launchctl. It does not
install Claude Code's hooks and leaves the legacy ccw tool alone.
`--no-start` only writes the files; `--no-doctor` skips the health check at
the end. Running it again reloads the daemon. `--read-only` runs the daemon
watch-only (the flag goes into the LaunchAgent); running install again
keeps that choice, and `--no-read-only` drops it.

`jantar doctor` changes nothing and exits 1 when a check fails. `--json`
prints the checks as JSON. It checks Node, cswap, `claude`, Terminal
access, the daemon, coexistence with ccw and remote access, and, with
[Fleet](fleet.md) on, the door servers use and whether this Mac sleeps on
power.

`jantar open` opens the dashboard in this Mac's browser with a one-time
link; one tap on **Pair this browser** pairs it as an admin device.
`--print` prints the link instead, and `--no-admin` pairs it with read and
control only. Each `jantar open` pairs a new device; revoke old ones under
Devices.

Or run the daemon in the foreground instead of under launchd:
`node packages/daemon/bin/jantard.mjs`. The daemon's logs are in
`~/.jantar/logs/` (`daemon.out.log` and `daemon.err.log` under launchd).

| `jantard` flag | Effect |
|---|---|
| `--port <n>` | TCP port on 127.0.0.1 (default `remote.port`, 7420; `0` picks a free port) |
| `--home <dir>` | state dir (default `$JANTAR_HOME`, then `~/.jantar`) |
| `--no-terminal` | Terminal.app backend off: no screen peek, focus or sending |
| `--read-only` | observe only: refuse sending, focus, answering cards, the cswap poller, primes, Ask Claude and settings changes (Life writes still work) |
| `--log-files` | v0.6: append its own output to `<state dir>/logs/daemon.{out,err}.log` (the Windows task for a server uses it) |
| `-v`, `--version` | print the version and exit |
| `-h`, `--help` | print the help and exit |

### macOS prompts

- **Automation.** The first time the daemon reads or types into a Terminal
  tab, macOS asks whether it may control Terminal.
- **Screen Recording.** Only with [terminal screenshots](phone-app.md#controls-and-screenshots)
  on: the first screenshot makes macOS ask whether the daemon's `node` may
  record the screen (System Settings > Privacy & Security > Screen
  Recording). Until it is allowed, the Picture view says so and the Text
  view keeps working.
- **Files and Folders.** Under launchd, macOS may ask whether `node` may
  read `~/Desktop` or `~/Documents` the first time a folder there is
  browsed.

### Uninstall

```sh
jantar hooks uninstall --apply   # if you installed the hooks: restores Claude's settings minus Jantar's entries
jantar uninstall                 # stops the daemon and removes the LaunchAgent; keeps ~/.jantar
jantar uninstall --purge         # also deletes ~/.jantar (settings, devices, audit log), after a y/N
```

`--purge --yes` does not ask. `--purge` refuses while Claude's settings
still call Jantar's hook client; `--force` purges anyway. Turn off Tailscale
Serve or stop the tunnel with their own tools.

## Reach it from your phone

The daemon only ever listens on 127.0.0.1. Give it one HTTPS front door,
then pair the phone (a QR code that works once, for 10 minutes). Pairing is
needed whichever door you pick, and so is the device secret on every write.

### Tailscale (recommended)

Private to your tailnet, a real certificate and an address that never
changes, so the Home Screen app and its notifications keep working.

```sh
jantar remote setup            # the steps, and what it would run
jantar remote setup --apply    # tailscale serve --bg --https=443 http://127.0.0.1:7420
jantar pair
```

`--apply` points pairing links at `https://<mac>.<tailnet>.ts.net`. Funnel
(Tailscale's public internet mode) is never used, and `jantar doctor` fails
if it finds Funnel on the daemon.

### Cloudflare Tunnel with Access

For a phone without Tailscale, on a domain you have in Cloudflare. The
tunnel dials out from the Mac, so nothing opens on your router, and
Cloudflare Access asks who you are before any request reaches the Mac.
Below, `jantar.example.com` stands for your own hostname.

1. Make the tunnel and its DNS name:

   ```sh
   brew install cloudflared
   cloudflared tunnel login
   cloudflared tunnel create jantar
   cloudflared tunnel route dns jantar jantar.example.com
   ```

2. Point it at the daemon, in `~/.cloudflared/config.yml`:

   ```yaml
   tunnel: jantar
   credentials-file: <the .json file that tunnel create wrote>
   ingress:
     - hostname: jantar.example.com
       service: http://127.0.0.1:7420
     - service: http_status:404
   ```

3. In Cloudflare Zero Trust, under Access > Applications, add a self-hosted
   application for `jantar.example.com` with a policy that allows only your
   own e-mail address (a one-time PIN, or your identity provider). Give it a
   long session duration, so the Home Screen app is not signed out every
   day.
4. Run the tunnel (`cloudflared tunnel run jantar`, or
   `cloudflared service install` to keep it running), then:

   ```sh
   jantar remote url https://jantar.example.com
   jantar pair
   ```

TLS ends at Cloudflare, so Cloudflare can read the traffic; Access, pairing
and the device secret still guard every request. Notifications go from the
Mac to Apple's or Google's push service directly, not through the tunnel.

### A quick tunnel, to try it

To try it without a domain, `jantar remote setup --cloudflare` prints the
steps for a Cloudflare quick tunnel: a random `trycloudflare.com` address
that changes on every restart, with no Access in front. Then
`jantar remote url https://<random>.trycloudflare.com` and `jantar pair`.

### The remote commands

```sh
jantar remote status              # what is set up now (--json for scripts)
jantar remote url https://HOST    # use HOST in pairing links and accept it as an Origin
jantar remote url --clear         # back to loopback-only pairing links
```

### Pair the phone

```sh
jantar pair                       # a QR code; scan it with the phone's camera
```

| Option | Effect |
|---|---|
| `--name NAME` | the new device's name (default: chosen on the phone) |
| `--admin` | also grant admin (settings, devices): only for a device you fully trust |
| `--read-only` | read only: no prompts, approvals or focus |
| `--json` | print `{code,url,expiresAt}` instead of a QR code |
| `--no-qr` | print the link only |

`jantar pair --extension` pairs the Chrome extension instead
([Meetings](extension.md#set-it-up-once-at-the-mac)).

Then open the link on the phone, choose **Add to Home Screen** (needed for
notifications on iPhone, iOS 16.4 or newer) and turn notifications on under
Devices. Scopes go from read to control to launch to admin; see
[Devices](phone-app.md#devices-and-scopes) to grant or take them back.

## Updating

```sh
git pull
pnpm install && pnpm -r build
jantar install                    # reloads the daemon on the new build
```

Reopen the app on the phone to load the new build. With Meetings, reload
the extension too ([Updating the extension](extension.md#updating-the-extension)).
Paired servers update on their own, one by one or in a loop over SSH
([Update a server](fleet.md#update-a-server)).
The [changelog](../CHANGELOG.md) says what changed. Coming from the old
name, see the README's Quickstart.

## When something is wrong

- `jantar doctor` says which part is missing or failing.
- `jantar status` shows what the daemon sees. Exit code 3 from any command
  means the daemon is not running.
- `~/.jantar/logs/daemon.err.log` has the daemon's errors.
- Safari may refuse the daemon's `Secure` cookie on plain
  `http://127.0.0.1`; on the Mac use Chrome for `jantar open`, or the HTTPS
  address of your front door.
