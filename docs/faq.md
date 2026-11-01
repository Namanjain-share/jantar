# Questions

## Does my code leave the Mac?

Not because of Jantar. The daemon listens on 127.0.0.1, and your phone
reaches it through the front door you set up: Tailscale (private to your
tailnet) or a Cloudflare Tunnel (TLS ends at Cloudflare, so Cloudflare can
read that traffic). There is no Jantar server and no telemetry. Rewrite,
Ask Claude, Ask and meeting summaries run Claude Code on your account, the
same way any Claude Code use does. Once you add `jantar mcp`, what its tools
return goes into the session that called them, and so to Anthropic like any
tool output. Notifications go through Apple's or Google's push service. See
[Security, in plain words](security.md).

## Do I need an API key?

No. Jantar uses Claude Code's own login. Its headless runs (Rewrite, Ask
Claude, Ask, the primer, meeting summaries) run `claude` (or `cswap run`) with
any API key or token taken out of the environment, so they use your
subscription login.

## Do I need cswap or several accounts?

No. One Claude login is enough, and Jantar finds it. cswap adds usage bars,
several accounts and the [primer](primer.md); see [Accounts](accounts.md).

## Is it affiliated with Anthropic?

No. "Claude" and "Claude Code" are Anthropic's products; Jantar is an
independent tool that works with the files and hooks Claude Code exposes.
It is not affiliated with Google or Microsoft either.

## iTerm2, tmux, Ghostty, Linux?

Not yet. Jantar drives Terminal.app on macOS only. Linux servers with Claude
Code in tmux come next (v0.6, being built now): run everything on your server
and answer it from your phone. iTerm2 and Ghostty follow; see the
[roadmap](roadmap.md).

## Why can switches only be changed at the Mac?

Because a phone must never widen its own reach. If a lost or borrowed phone
could turn on Files or starting sessions, pairing would protect much less.
Every switch, folder, scope grant and the programs the daemon runs are set
with the `jantar` CLI on the Mac; while a part is off, the phone shows the
command that turns it on.

## What does Jantar type into my terminal?

Only what you send or answer, and the control keys you press (Shift+Tab,
Interrupt, Clear draft, Escape). A prompt counts as sent only when the
transcript shows it. A dialog answer is typed only while the Mac still
shows exactly the dialog you tapped. It never sends a digit, Tab or
Shift+Tab inside a dialog. See [Answering from the phone](phone-control.md).

## What happens to Claude when Jantar is not running?

Nothing changes. The hooks fail open: with the daemon down, Claude behaves
as if they were not there. `JANTAR_SKIP_HOOKS=1` turns them off for one
session.

## Does Meetings record audio?

No. There is no audio, no recording and no bot in the call. It keeps the
call's live captions (the words Google or Microsoft already show you) after
you press Start notes, and the screenshots you click. See
[Meetings](extension.md).

## Can I use it at work?

Yes. Under FSL-1.1-MIT you may use, change and self-host Jantar for any
purpose, at work included, except offering it to others as a competing
commercial product or service. Each version becomes MIT two years after
its release. Check what your workplace allows before you keep anyone's
words from a call.

## Can I read and change the code?

Yes, all of it is here. Jantar is source-available (fair source), not a
project under an OSI license. Contributions come under
[CLA.md](../CLA.md).

## Why does `jantar open` not work in Safari?

Safari may refuse the daemon's `Secure` cookie on plain
`http://127.0.0.1`. On the Mac, use Chrome for `jantar open`, or the HTTPS
address of your front door.

## Why did a medicine ping not come?

Pings come from the daemon on your Mac, so they need the Mac awake. Since
0.5.3, a ping the Mac could not send for lack of network goes out, marked
late, once the network is back, up to 6 hours late (a medicine's is skipped
when its next dose is under 3 hours away). Keep your phone's own alarm for
a dose you must not miss.

## Known limits

- Terminal.app only (tmux, iTerm2 and a live terminal view come later).
- Safari may refuse the daemon's `Secure` cookie on plain
  `http://127.0.0.1`; on the Mac use Chrome for `jantar open`, or the HTTPS
  address of your front door.
- No account switching, Telegram alerts or Mac banners: the legacy ccw tool
  does those when it is installed ([upgrading.md](upgrading.md#jantar-beside-the-legacy-ccw-tool)).
- Medicine and reminder pings need the Mac awake.
- Each `jantar open` pairs a new admin device (revoke old ones under
  Devices).
- Some dialog rows stay at the Mac until a real Mac confirms them
  ([real-Mac checks](real-mac-checks.md), and
  [what stays at the Mac](phone-control.md#what-stays-at-the-mac)).
- Meetings: Chrome only, Meet and Teams on the web (not the Teams desktop
  app), from the captions the site shows; loaded unpacked (no Chrome Web
  Store yet). Its shortcut is driven by Chrome itself, so the test browser
  covers the button and the toolbar but not Option+Shift+S. Screenshots
  from the extension have not yet reached Jantar on a real call
  ([Meetings checks](real-mac-checks.md#meetings-v05)).
