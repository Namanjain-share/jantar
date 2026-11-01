# Changelog

What changed for people who use Jantar, newest first. Versions before
0.4.0 kept the package version 0.1.0; their names here are the milestones.

## 0.5.3 (unreleased)

- **Ask**, a chat page on the phone, right after Today. Tell it what to
  add in plain words ("todo add call the bank", "remind me at 6 to take my
  vitamin", "had 2 rotis and dal", "spent 250 on lunch") and it suggests
  todos, reminders, meals and expenses as cards. Nothing is added until you
  tap **Add** (or **Add all** for the todos and meals of one answer, never
  money), each added card has **Undo** until a day after you asked, and
  **Edit** changes a card before it is added. Ask "calories left?" or
  "what's due?" and the answer is filled in on the phone from Today, with
  your own calorie target. Off until `jantar ask on`. The guide:
  [docs/assistant.md](docs/assistant.md).
- Ask runs Claude Code on your account the way Rewrite does, on Rewrite's
  model: only what you type goes to Claude (with the date, time and time
  zone, which Life parts are on, the currency code and the fixed category
  names), never your saved lists, medicines or money. Claude can only
  propose the four kinds of card; anything else in its answer is left out
  and the page says how many. Its history stays in the daemon's memory,
  the last 30 messages per phone (and an older one while Undo still works
  on what it added) for up to 7 days; Clear history, `jantar ask off` and
  a restart forget it. A message refused because one is still waiting
  doesn't count against the 10 a minute and 100 a day.
  [SECURITY.md](SECURITY.md#v053-ask) lists what it can't do.
- **A sound for each kind of alert.** Every push now belongs to one of five
  groups (Answer soon, Needs you, Done, Medicines and reminders, Problems),
  and each has its own tone in the app, picked per device under Devices ›
  Notifications › Sounds, with a Test button. "Speak a few words" adds one
  fixed phrase per group, never what Claude asked, a folder or a medicine.
  Tones and the voice play only while Jantar is open on screen and follow
  the silent switch; on the lock screen the iPhone plays its one alert
  sound for every web app, whatever you pick. When the open app plays a
  push's tone, the push comes without the phone's sound, so you hear one;
  Answer soon, medicine and Life pings always keep it. Sounds are on by
  default on a phone and off on the Mac's dashboard.
  [Alerts and sounds](docs/alerts.md).
- **Answer soon.** When an unattended agent's ask shows Claude's 2-minute
  auto-block countdown, the daemon reads that screen once and the phone
  gets one push, "web-app · about 2 min to answer", in place of the
  "needs you" push, and one repeat at about a minute left. It never holds
  the command or the question, expires with the countdown, and goes out as
  a permission push (the mute and each device's kinds hold it). With
  Sounds on, the dock plays the alarm at 60, 30 and 10 seconds left.
  `jantar notify urgent off` turns it off. While pushes are muted, or Web
  Push is off, nothing is read.
- `jantar notify`: Web Push, the kinds the Mac sends, the urgent alert and
  the mute in one view; `urgent on|off`, `done on|off` (Done pushes, and so
  the success tune, stay off by default) and `test [group]`, one test push
  to your devices (at most 10 a minute).
- **Life.** Todos repeat every year too (birthdays, renewals; a 29 February
  one falls on the 28th in other years). A repeating reminder keeps its
  own time: a daily 11:00 snoozed an hour still rings at 11:00 the next
  day (a reminder made before 0.5.3 learns its time once you change it in
  the todo sheet). Today has Add todo, due today, and its weight line logs
  today's weight. [Life](docs/life.md) lists the limits.
- The daily calorie target starts at **1,500 kcal** (it was 2,000). A
  target you already set on the phone stays as it is.
- **A ping the Mac could not send for lack of network** (asleep, Wi-Fi off)
  goes out, marked late, once the network is back, up to 6 hours late; a
  medicine's is skipped when its next dose is under 3 hours away. A push
  that may have reached Apple or Google is never sent again, so a ping can
  be late but never arrives twice. A DNS lookup that hangs past the push's
  10 seconds counts as no network too. A ping whose send ended after its
  30-second deadline but reached a device is no longer sent again (since
  0.4). Session pushes are not retried.
- **`jantar mcp`**: an MCP server for Claude Code. A session can search the
  Intel shelf, read an item, save a link or a note ("via claude" on the
  phone), and list and add todos of the Life project linked to its folder
  (at most 20 an hour; never done, edit or delete). Run `jantar mcp` in a
  terminal for the `claude mcp add` line to paste. The shelf is global:
  every session can read all of it. What the tools return goes into the
  session and reaches Anthropic like any tool output. [The Intel shelf](docs/intel.md#from-claude-code-mcp).
- **Search the shelf by words, best match first.** Every word must appear
  in the item (the title, notes, type, tags, link or a field), a "quoted
  phrase" matches whole, and a word at the start of a title's word ranks
  highest. The order of `jantar intel list --q` and the phone's search
  changed: best match first, newest first only without words. On the
  phone the words are marked in each row, and a magnifier in the header
  opens the search.
- **Meetings: why a screenshot was not saved.** The popup's Settings shows
  the last try (when, which control, how it ended, Chrome's own words or
  the status Jantar answered) and the screenshot shortcut, with a link to
  change it. The bubble says "Not saved: click the Jantar icon once in this
  tab, then try again." when Chrome has not let the extension take that
  tab, and Chrome gets 5 seconds to take a picture. The daemon logs one
  line per screenshot upload, refusals included, with the status and size
  only. Why the screenshots of three real calls never arrived is still
  open: the next call's Last screenshot should say.
- **A one-line install.** `curl -fsSL https://jantar.namanbuilt.com/install.sh | bash`
  checks for macOS, Node.js and pnpm, clones release v0.5.3 into `~/jantar`,
  builds it, runs `jantar init` and asks before `jantar install`. No sudo.
  Ending the line with `bash -s -- --dry-run` shows the plan and changes
  nothing. To update a one-line install, run the same line again: `git pull`
  updates only a clone of main. See [Install in one line](docs/install.md#install-in-one-line).
- **The website has a 53-second film**, with captions and no sound, in a
  wide cut and a portrait cut for phones, and the film's words written out
  under it. The README opens with a short loop of the same story. Both use
  example data only.
- The integration suites' own time limits get the same allowance on a slow
  CI runner as their waits, and the Life scheduler arms its next ping even
  after a failed read. The Ubuntu run's `v04-life` "08:00" step had timed
  out at 30 seconds.
- New settings: `ask.enabled` (off) and `notify.urgent` (on). The protocol
  version stays 3 and the settings version 2: no migration.

## 0.5.2 (1 November 2026)

The first public release.

- **Prompts from unattended agents answer from the phone.** Claude Code draws
  a ticking "will automatically block this request in 1:33" line in an
  unattended agent's prompt, and every tap on it was refused as "The dialog
  on the Mac changed". Jantar now leaves out only the time of Claude's own
  countdown when it checks the prompt before typing: the command, the
  question and every option must still match exactly. The phone shows the
  deadline and counts it down, and refuses a tap with under 5 seconds left
  ("Answer it at the Mac").
- On a phone the Board's **+** for a new session is the icon alone, so
  "3 need you" and Start fit a 390 px screen.
- `jantar open` links to the port the daemon really listens on (a daemon
  started with `--port` got a link to 7420 before).
- A place whose switch is off at the Mac (Files, New session, Life, the
  shelf, Meetings) says so and names the command that turns it on, instead
  of "That page does not exist."
- Without the legacy ccw tool, Accounts no longer names autoswitch or shows
  an empty Moves section, and the start sheet drops the note about an
  account move restarting with ultracode effort: nothing else moves a
  session.
- `jantar doctor` shows no ccw row on a Mac without ccw, and tells a port
  held by another Jantar (a different `JANTAR_HOME`) apart from this one's.
- The Chrome extension has its own 16, 32 and 48 px icons.
- When Terminal is slow to find a session's tab, the screen's next read
  finds it. Before, one slow answer made the phone say no terminal tab was
  found for the next five seconds.

## 0.5.1 (31 October 2026)

0.4.2 and 0.5.0 in one release.

- **Answer terminal dialogs from the phone** (from 0.4.2). A session with no
  hook card for its prompt (started before the hooks, run with
  `JANTAR_SKIP_HOOKS=1`, or a subagent asking) now shows the dialog on its
  Terminal screen as buttons in Claude's own words: permission prompts,
  plan approval, questions, multi-select and the review before submitting.
  Jantar types an answer only while the Mac still shows exactly the dialog
  you tapped. Rows that save a rule or switch mode take a 2-second hold.
- **The keypad** (from 0.4.2): ↓, ↑ and Enter for a screen Jantar can't
  turn into buttons, such as an MCP form or the `/model` list.
- **Attachments** (from 0.4.2): photos and files from the phone go to the
  Mac, and the prompt names them by path so Claude reads them. Photos are
  scaled and lose their location data. Up to 10 files a prompt, 20 MB each.
- Rows above the highlighted one, and dialogs whose body scrolls, answer
  from the phone after passing on a real Mac.
- "Yes, and switch to accept edits" on a Write prompt now takes the
  2-second hold, like the other rows that change the session's mode.
- The app's first load stays under its size gate: a picked file's
  preparation loads the first time you attach one.

## 0.5.0 (31 October 2026)

- **Meetings**: a Chrome extension that keeps a Google Meet or Microsoft
  Teams call's live captions and the screenshots you click, on your Mac.
  After the call one headless Claude run writes a summary, the decisions
  and the action items, which go to a project's todos with one tap. No
  audio and no recording. Off until `jantar meetings on`.
- `jantar pair --extension` and `jantar meetings` (export, unpair).
- Meetings on the phone under More: search, project chips, each meeting's
  summary, transcript with its screenshots, Export text, Edit, Delete with
  Undo.

## 0.4.2 (31 October 2026, shipped in 0.5.1)

Built beside 0.5.0 and released inside 0.5.1; see 0.5.1 for what it
added.

## 0.4.1 (30 October 2026)

After the first run on a real Mac:

- Clear draft clears every row of a draft, and refuses when it can't see
  them all (vim NORMAL mode, a box Claude's full-screen display may cut).
- Escape and Clear draft are on by default; `jantar controls escape` and
  `jantar controls clear-draft` switch them.
- "Ask me" starts Claude with `--permission-mode manual`, so the account's
  own default mode never decides.
- `jantar new --preview --name X` previews with that name.

## 0.4.0 (30 October 2026)

- **Renamed to Jantar**: the CLI is `jantar`, the daemon `jantard`, the
  state folder `~/.jantar`. An import command copies the old state folder
  across (see the README).
- **One Claude login is enough.** cswap and the legacy ccw tool are
  optional; `jantar init` sets up a new Mac.
- **Life**, each module off until you turn it on: Today, todos with
  reminders and projects, medicines with pings and refills, food with "Ask
  Claude" and weight, cafés, and finance with bills. Deletes have a
  five-second Undo instead of a confirm. Nightly backups.
- **The Intel shelf**: links and notes from JSONL files your scripts
  append to, with `jantar intel add`.
- **Resume** a folder's earlier conversation from the start sheet.
- **Kept accounts** (`jantar accounts keep`) are never picked by Auto,
  Rewrite or Ask Claude.
- **The window primer** (opt-in, cswap): starts an idle account's 5-hour
  window early.
- Source-available under FSL-1.1-MIT, with a contributor agreement and
  community files.

## v0.3 (30 October 2026)

- **Files**: which files sessions changed, a folder browser and a read-only
  viewer for code, Markdown, images, PDFs and notebooks.
- **New session** from the phone in any folder you allow, with the flags
  from a fixed list and the exact command line shown first.
- **Rewrite**: dictated text turned into a prompt you review before sending.
- **Controls**: the permission mode, Interrupt, Clear draft, slash commands,
  and terminal screenshots.
- Each part is off until switched on at the Mac; a phone can't change a
  switch.

## v0.2 (30 October 2026)

- The app's design: the board as a ledger in two themes, day and night,
  with red only for "needs you".
- Every write carries a per-device secret; push goes to real push services
  only.
- Fixes to sending: Enter only while the box holds exactly our text, never
  typing twice, and refusing prompts that could never be proven sent.

## v0.1 (29 October 2026)

- The daemon, under launchd: Claude Code sessions, transcripts, cswap usage
  and the legacy ccw tool's files, read-only.
- The phone app (an installable PWA): the board, a session's transcript,
  approval cards through Claude Code's hooks, sending prompts with
  transcript proof, accounts, alerts and devices.
- Pairing with a one-time QR code, Web Push, and access through Tailscale
  Serve.
- The CLI: install, doctor, open, pair, remote, hooks, status and send;
  `--read-only` and `--no-terminal` modes.
