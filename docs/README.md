# Jantar docs

<picture><source media="(prefers-color-scheme: dark)" srcset="brand/logo-dark.svg"><img src="brand/logo.svg" width="40" alt="The Jantar mark: a 2x2 grid with one cell lit."></picture>

## Using Jantar

| Page | What it holds |
|---|---|
| [Install and run](install.md) | Requirements, a read-only trial, running under launchd, macOS prompts, reaching it from your phone (Tailscale, Cloudflare), pairing, updating, uninstalling |
| [The app](phone-app.md) | Every screen on the phone and the Mac, sending prompts with proof, new sessions and Resume, Files, Rewrite, Controls, devices and scopes |
| [Answering from the phone](phone-control.md) | Hook cards, terminal dialogs as buttons, the keypad, attachments, what stays at the Mac and why |
| [Accounts](accounts.md) | One login or cswap, usage and resets, accounts kept for other work |
| [The primer](primer.md) | Starting an idle account's 5-hour window early |
| [Life](life.md) | Today, todos, reminders, projects, medicines, food and weight, cafés, finance; backup and restore |
| [Intel shelf](intel.md) | The shelf, its sources and the JSONL line format |
| [Meetings](extension.md) | The Chrome extension for Google Meet and Microsoft Teams: setup, captions, screenshots, summaries, export, deleting everything |
| [Configuration](configuration.md) | Every command, the daemon's flags, environment variables, `config.json`, the state folder |
| [Security, in plain words](security.md) | What Jantar can reach, what a phone can do, what leaves the Mac; the full model is [SECURITY.md](../SECURITY.md) |
| [Questions](faq.md) | Common questions and known limits |
| [Roadmap](roadmap.md) | Ideas for later, with no dates |
| [Upgrading](upgrading.md) | Updating Jantar, and running it beside the legacy ccw tool |
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
