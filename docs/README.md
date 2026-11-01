# Jantar docs

<picture><source media="(prefers-color-scheme: dark)" srcset="brand/logo-dark.svg"><img src="brand/logo.svg" width="40" alt="The Jantar mark: a 2x2 grid with one cell lit."></picture>

## Using Jantar

| Page | What it holds |
|---|---|
| [Install and run](install.md) | Requirements, a read-only trial, running under launchd, macOS prompts, reaching it from your phone (Tailscale, Cloudflare), pairing, updating, uninstalling |
| [The app](phone-app.md) | Every screen on the phone and the Mac, sending prompts with proof, new sessions and Resume, Files, Rewrite, Ask, Controls, devices and scopes |
| [Answering from the phone](phone-control.md) | Hook cards, terminal dialogs as buttons, the keypad, attachments, what stays at the Mac and why |
| [Alerts and sounds](alerts.md) | The five alert groups and their tones, Answer soon for Claude's 2-minute countdown, what the lock screen can and cannot do, `jantar notify` |
| [Accounts](accounts.md) | One login or cswap, usage and resets, accounts kept for other work |
| [The primer](primer.md) | Starting an idle account's 5-hour window early |
| [Life](life.md) | Today, todos, reminders, projects, medicines, food and weight, cafés, finance, posts; backup and restore |
| [Ask](assistant.md) | The chat page: plain words in, todos, reminders, meals, expenses and post ideas out as cards you add with a tap; "save this: <link>" to Intel; what goes to Claude |
| [Intel shelf](intel.md) | The shelf, its search, its sources and the JSONL line format, `jantar mcp` for Claude Code, and Add post: the Mac reads a reel, video, post, article or PDF you save (depths, sources, Retry, what leaves the Mac) |
| [Save to Jantar](shortcut.md) | The iOS Share-sheet Shortcut for Add post: a key made at the Mac, the steps, the Tailscale and Cloudflare doors, troubleshooting |
| [Meetings](extension.md) | The Chrome extension for Google Meet and Microsoft Teams: setup, captions, screenshots, summaries, export, deleting everything; and Read saved links, posts read in your own Chrome |
| [Servers](fleet.md) | v0.6 Fleet: pairing Linux servers, Windows machines and other Macs with the Mac; the front door (Cloudflare Access or Tailscale), each OS, accounts, tmux, updating ten servers, rotating the Access token, limits and what is not verified yet |
| [Configuration](configuration.md) | Every command, the daemon's flags, environment variables, `config.json`, the state folder |
| [Security, in plain words](security.md) | What Jantar can reach, what a phone can do, what leaves the Mac; the full model is [SECURITY.md](../SECURITY.md) |
| [Questions](faq.md) | Common questions and known limits |
| [Roadmap](roadmap.md) | Ideas for later, with no dates |
| [Upgrading](upgrading.md) | Updating Jantar (0.7.0: keep a copy of life.db first), and running it beside the legacy ccw tool |
| [Real-Mac checks](real-mac-checks.md) | What has been tried on a real Mac, what is still open, and how to try one safely |

The [changelog](../CHANGELOG.md) lists what each version changed.

## Building Jantar

| Page | What it holds |
|---|---|
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Setup, commands, tests, screenshots, privacy rules, the contributor agreement |
| [How it is put together](architecture.md) | The daemon, the app, the hooks and the extension, in one diagram |
| [Repository layout](LAYOUT.md) | The folders, the daemon's parts and what each exports, startup order, what each version added |
| [Hook protocol](hook-protocol.md) | What Claude Code sends a hook, and the wire format between `jantar-hook` and the daemon |
| [Provenance](PROVENANCE.md) | Code adapted from other projects, file by file |
| [Package READMEs](../packages/cli/README.md) | The CLI (what each command writes and runs), and [the web app](../packages/web/README.md) (screens, design tokens, PWA) |
