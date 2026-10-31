# Upgrading, and the legacy ccw tool

## Updating Jantar

Pull, build and reload the daemon:

```sh
git pull
pnpm install && pnpm -r build
jantar install                    # reloads the daemon on the new build
```

Then reopen the app on the phone, and with Meetings reload the extension
([Updating the extension](extension.md#updating-the-extension)). A newer
daemon migrates `config.json` and its databases on start (moving settings
to version 2 in v0.4 kept the old file as `config.json.v1`). The
[changelog](../CHANGELOG.md) says what changed in each version.

## From Jantar's old name

Up to v0.3 Jantar was called ccw-v2 and kept its state in `~/.ccw-v2`. It
now keeps it in `~/.jantar`. To bring your paired phones, push, settings and
Life along, stop the old daemon and copy its state dir into the new one:

```sh
ccw-v2 uninstall                 # the old CLI: stops its daemon and LaunchAgent, keeps ~/.ccw-v2
jantar import-ccw-v2 --dry-run   # what would be copied
jantar import-ccw-v2             # copies into an empty ~/.jantar; ~/.ccw-v2 stays as it is
jantar install
jantar hooks install --apply     # puts Jantar's hooks in place of ccw-v2's
```

`--from DIR` names another old state dir. Nothing is ever written into the
old one. A phone stays paired when it opens Jantar at the same address as
before. A session started with `CCW_V2_SKIP_HOOKS=1` stays off the board as
with `JANTAR_SKIP_HOOKS=1`. `CCW_V2_HOME` still names Jantar's state dir for
now, with a warning: set `JANTAR_HOME` instead. It never makes Jantar run on
ccw-v2's own state: `jantard` and every `jantar` command but `import-ccw-v2`
refuse a folder that holds `ccw-v2.db` and no `jantar.db`, and say to import
it. `jantar install` refuses while ccw-v2's LaunchAgent is still installed.

## Jantar beside the legacy ccw tool

Jantar grew out of `ccw`, a single-file script that does the same job from
one Terminal tab plus a Telegram bot. ccw is not published, and Jantar does
not need it: Jantar reads its files only when they exist, and works the same
without them. When it is there, Jantar runs **beside** it without touching
it:

- Different names everywhere: the CLI is `jantar`, the daemon `jantard`,
  its state lives in `~/.jantar`, its launchd label is `com.jantar.daemon`.
- It only **reads** ccw's files (`~/.config/ccw/switch/*.json`,
  `burn.json`, `active.json`, `switch.json`'s hold list and prime switch)
  to show moves and `next →`; it never writes there.
- It never starts a second Telegram poller, a second autoswitcher or a
  second primer. When ccw primes free 5-hour windows (its default), Jantar
  leaves priming to it ([the primer](primer.md#the-legacy-ccw-tool)).
- While ccw's bot keeps cswap's usage cache fresh, Jantar only reads that
  cache; it becomes the single `cswap list --json` poller only when ccw's
  bot is not running.
- Typing into a session honours a ccw move in progress.
- `jantar doctor` checks this: while ccw's bot runs, Jantar stays in
  coexistence mode (no autoswitch, no Telegram, no Mac banners, no second
  cswap poller).

Autoswitch, Telegram alerts and Mac banners are not in Jantar yet; they
are on the [roadmap](roadmap.md).
