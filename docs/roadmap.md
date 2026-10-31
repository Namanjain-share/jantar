# Roadmap

Ideas, in rough order, with no dates and no promises. An issue that says
which of these you need, and why, helps decide.

## Terminals

- **Servers, next (v0.6):** Jantar on a Linux server, with Claude Code in
  tmux, run as a systemd service and controlled entirely from the phone over
  Tailscale or your own Cloudflare tunnel. Being built now.
- Then iTerm2 and Ghostty. Terminal.app only is the biggest limit today.
- A live terminal view on the phone, beside the Text and Picture views.

## Getting started

- A one-line install: a Homebrew tap, or an npm package with the web app
  already built, instead of clone, pnpm and a build.
- `jantar demo`: the daemon serving the synthetic data the screenshots use,
  read-only, so you can see the whole app with no sessions, cswap or phone.
- Signed releases.

## Sessions and answers

- Escape on the keypad, and buttons for the permission prompt that shows
  No first, once their [real-Mac checks](real-mac-checks.md#still-open)
  pass. Each open check there unlocks one more answer from the phone.
- Search across session transcripts on the phone: "which session did I ask
  about X".

## Accounts

- Moving a session to another account inside Jantar, with alerts on
  Telegram and Mac banners, so the legacy ccw tool is no longer needed for
  them.

## Life

- `jantar todo add "…" [--due] [--project]`, so sessions and scripts can
  drop a todo in Life the way `jantar intel add` feeds the shelf.
- Medicine pings that don't need the Mac awake (a copy in Apple Reminders
  or a calendar).

## Meetings

- Why a screenshot failed, shown in the popup and in `jantar meetings`.
- A daily cap on meeting summaries.
- The official transcripts (Google Meet's and Microsoft Graph's) as an
  opt-in for accounts that have them. They would also cover the Teams
  desktop app.
- A Chrome Web Store listing, with its own extension ID.

## Later

- A native app.
