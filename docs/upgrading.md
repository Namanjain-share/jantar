# Upgrading, and the legacy ccw tool

## Updating Jantar

Installed with the one-line install? Run the same line again
(`curl -fsSL https://jantar.namanbuilt.com/install.sh | bash`): it moves
`~/jantar` to the new release, builds it and asks before `jantar install`.
`git pull` updates only a clone of main; there, pull, build and reload
the daemon:

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

### 0.13.0: Life's fourth schema change (Work)

life.db changes on the first start of 0.13.0, whether or not you turn
[Work](work.md) on. Nothing needs doing by hand, and everything you have
reads exactly as before.

**life.db, schema 4 to 5.** Before moving it, the daemon copies it to
`backups/life-pre-0.13.0.db` (from the file as it was, with anything still
in its write-ahead log), and moves nothing if that copy can't be written.
Schema 5 adds Work's tables (clients and companies, deals, the log of
calls and meetings), all empty, and a column on todos for a follow-up's
client; no existing row is rewritten. `jantar life status` says "(life.db
schema 5)". 0.11.x refuses a schema-5 file (Life answers 503 there); to go
back, install 0.11 and restore that copy:

```sh
jantar life restore life-pre-0.13.0.db
```

Anything added to Life since the upgrade is lost then, Work's included.
The `life.work` setting is dropped by an older daemon, which leaves Work
off.

### 0.11.0: Life's third schema change (Accountability partner)

Three databases change on the first start of 0.11.0, whether or not you
turn the [Accountability partner](people.md) space on. Nothing needs doing
by hand, and your own data reads exactly as before. With the space off
(the default), that is all.

**life.db, schema 3 to 4.** Before moving it, the daemon copies it to
`backups/life-pre-0.11.0.db` (from the file as it was, with anything still
in its write-ahead log), and moves nothing if that copy can't be written.
Schema 4 adds a `space` to every Life table (every existing row is yours,
`''`, so nothing is rewritten), rebuilds `weights` and `foods_saved` keyed
per space, and adds the space's tables (the people, their Activity, alerts,
plans, templates, sleep, the journal). `jantar life status` says "(life.db
schema 4)". 0.10.x refuses a schema-4 file (Life answers 503 there); to go
back, install 0.10.2 and restore that copy:

```sh
jantar life restore life-pre-0.11.0.db
```

Anything the person you share with added since the upgrade is lost then,
and they are asked to set sharing up again.

**chat.db, schema 1 to 2** (a `thread` on every row, so their chat is
apart from yours; every existing row is yours). The daemon first copies it
to `backups/chat-pre-0.11.0.db`. An older daemon refuses a schema-2 chat.db
(Chat answers 503 there); to go back, put that copy back as chat.db at the
Mac. Don't use `jantar chat clear --broken` for this: it would set both
threads aside.

**jantar.db, migration 8** adds the space's tables (their devices, link
codes, push list, invites and the consent ledger) and an audit column. It
needs no copy: an older daemon warns and carries on, never reading them, so
they simply can't sign in there and get no pushes. Settings gain
`remote.peopleUrl` and `people`; an older daemon drops both, so their
hostname answers 403 there.

To start sharing after the upgrade: [Their hostname](people.md#their-hostname)
(a DNS route, an ingress rule and an Access application for their address),
then `jantar remote people-url`, `jantar people on --name <your name>`,
`jantar people add`, `jantar people offer` and `jantar people invite`.
`jantar people doctor` checks each step.

Their projects and food log need nothing more: they are rows of their
space in the same tables, and their calorie target and goal weight are
`meta` keys named for them (`kcal_target:<id>`, `goal_kg10:<id>`), never
yours. `jantar people add` turns their food log on unless you pass
`--no-food`; the Standard and Everything presets offer it in full (pass
`--see food=counts` or `--see food=off` to `jantar people offer` for
less), and `jantar people doctor` has a food line for each person. With
their food log off, nothing agrees a food level for you: their join and
their Allow store food off, and turning it off takes food out of a request
still waiting. No schema change; a food level a pre-release build stored
beside a food log that is off is a doctor `FIX`, and `jantar people
modules <name> --food off` (or turning the log on) puts it off.

You read of their projects only what their join page now names (each
one's name, emoji, status and open and overdue counts), and their join
page's to-do line names their projects. Their name and device names are
plain text on one line: a join or a linked device with an escape sequence
or a line break in either is a 400, and `jantar people` prints whatever is stored with
escapes taken out.

What you call each space (its label: `jantar people add --label`,
`jantar people label`, or their Sharing tab) is a field of their person
row in life.db: no schema change, and a space without one reads
"Accountability partner". Their app points its manifest at
`/v1/p/manifest` once they are in and you named the space, so an icon they
add after that takes the name; an icon already on their Home Screen keeps
its name. A name longer than 12 characters gives the Home Screen its first
words that fit (it gave the last word in pre-release builds). `jantar people doctor` gains an "origin fence" line (no
credential needed). A day the calendar doesn't have (2026-02-30) in any
People path is now a 400, where it could reach the handler before.

### 0.10.0: Life's second schema change

0.10.0 adds a table for cafés' visits to `life.db`. Nothing to copy by
hand this time: before it moves the file to the new layout, the daemon
writes `life-pre-0.10.0.db` in the backups folder itself (from the file as
it was, with anything still in its write-ahead log), and moves nothing if
that copy can't be written. A daemon older than 0.10.0 that never started
on the file wrote nothing, so upgrading straight from 0.6.x gets the copy
too, from before both changes.

0.9.1 can't open the newer file: every Life part would say "Life data
could not be opened". To go back, install 0.9.1 and run:

```sh
jantar life restore life-pre-0.10.0.db
```

That brings back Life as it was at the upgrade and loses every Life change
made since (todos, doses, meals, money, posts and cafés); the newer file
is kept beside it. `jantar life restore` with no name lists the copy, and
`jantar life status` names it. It is kept until 30 newer backups exist,
like every backup.

If you made Siri keys, revoke them before you go back
(`jantar chat shortcut revoke --all`): 0.9.1 doesn't know them apart from
Shortcut keys, so with only Siri keys its save door would exist (answering
401 rather than 404), `jantar intel shortcut list` would list them, and
its five-key rule could revoke one.

The copy is written once: if you go back, use 0.9.1 for a while and then
upgrade again, the copy still holds Life as it was at the first upgrade.
Before upgrading again, keep a copy of your own (`jantar life backup`,
then copy that file aside) or move `life-pre-0.10.0.db` out of the
backups folder so a fresh one is written.

### 0.7.0: Life's first schema change

0.7.0 adds a table for Posts to `life.db`, the first change to that file's
layout since Life began. The new daemon moves the file to it on start, and
0.6.1 can't open it after that: every Life part would say "Life data could
not be opened". The nightly backup and the start-up one name their copy
after the day, so they can replace that day's copy with the new layout.
Keep a copy they never write, before you upgrade:

```sh
jantar life backup                       # on 0.6.1: prints "Backed up to <folder>/life-<day>.db"
cp -p <folder>/life-<day>.db <folder>/life-pre-0.7.0.db
```

Then upgrade as above. To go back to 0.6.1 later, install it and run
`jantar life restore life-pre-0.7.0.db` (restore works while Life can't
open its file, and keeps the newer file beside it). `jantar life restore`
with no name lists the copy, and it is kept until 30 newer backups exist.

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
