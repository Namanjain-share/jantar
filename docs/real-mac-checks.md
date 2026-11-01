# Real-Mac checks

Every test in this repository runs against a scripted terminal and fake
`osascript`, `screencapture`, `cswap` and `claude`. Some things only a real
Mac can show: what Terminal.app really delivers, what Claude Code really
draws, what an iPhone really does. This page lists what has been tried on
a real Mac, and what has not. Where a check is open, Jantar leaves that
answer to the Mac until it passes.

## How to run one safely

The build never types into, selects or captures a real Terminal tab of
yours. To try a check:

- use a scratch Terminal window and a scratch folder, removed afterwards;
- run a separate daemon on a throwaway state dir and port (for example
  `JANTAR_HOME=/tmp/jantar-check` and `--port 7421`; keep the path short:
  Unix socket paths max out at 103 bytes);
- use an account that is not kept for other work, and a small model;
- for hook checks, a session started with the hooks; for screen checks,
  one started with `JANTAR_SKIP_HOOKS=1`.

[Trying Escape and Clear draft again](#trying-escape-and-clear-draft-again)
says how to check the two keys that are on by default, on another macOS,
Terminal or Claude Code version.

## Verified on 30 October 2026

macOS 26.6, Terminal.app, Claude Code 2.1.314.

- **S1**: Terminal delivers every `do script` string intact and appends one
  Return; the empty `enter` and an arrow then pick a menu option, and Down
  answers the trust dialog's "Yes, I trust this folder".
- **Clear draft**: End and one Ctrl+U cleared just the cursor's row of a
  two-row draft, and the Return sent the rest; End and eight Ctrl+U emptied
  it with nothing sent. Jantar now types End once per row and two more,
  then two Ctrl+U per row and six more, cut to the box it reads, and
  refuses where that count could be short (vim NORMAL mode, a box Claude's
  full-screen display may cut off; see SECURITY.md). Later that day the
  write as it ships (v0.4.1) emptied a four-row draft with nothing sent.
  `controls.clearVerified` is on by default.
- **S2**: Escape (CSI-u `\e[27u`) interrupts a busy turn without resending
  it, and leaves an idle draft alone; `controls.escapeVerified` is on by
  default. Ctrl+C interrupts too, and Ctrl+C twice quits cleanly.
- **S3**: Shift+Tab's status-line texts for manual, accept edits, plan and
  auto, one step per press.
- **S6, writer**: `jantar send` through the launchd daemon, a prompt and
  `/plan`, each proven by the transcript, with no Automation prompt.
- **L1**: `jantar new` opens a window without taking focus, reports the
  trust dialog as a card, and proves the first prompt. "Ask me" now types
  `--permission-mode manual` (with no flag, the account's own default mode
  won).
- **Resume**: a resumed session keeps its id, and with shared history
  `--resume` on another account finds the conversation.
- **Primer**: the same tiny Haiku run, sent by the legacy ccw tool, started
  an idle account's 5-hour window: cswap's next reading showed it, and the
  profile's shared history links stayed intact. Jantar's own primer runs
  the same command; on that Mac it leaves priming to ccw.

### The first run, in detail

macOS 26.6.1, Terminal.app, Claude Code 2.1.314, Jantar 0.4.0 under
launchd, in throwaway windows and a scratch folder (removed afterwards), on
two cswap accounts not kept for other work, with the haiku model.

| # | What | Result |
|---|---|---|
| S1 | Bytes Terminal delivers via `do script` | Every string arrives intact (escape sequences included), plus an appended **CR** (`\r`). `''` is Enter; `ESC[B` + CR moves and selects; `ESC[27u`, `ESC[Z`, `ESC[F` + Ctrl-U and Ctrl-C each arrive as one chunk. |
| L-trust | Trust dialog on a new folder | The pointer starts on "No, exit"; **Down (+CR) selects "Yes, I trust this folder"** and Claude opens. |
| S3 | Shift+Tab (`ESC[Z`) on an empty box | One mode step per press, nothing submitted. The cycle without the dangerous flag: auto → manual → accept edits → plan → auto. Exact texts: `⏸ manual mode on · ? for shortcuts`, `⏵⏵ accept edits on (shift+tab to cycle)`, `⏸ plan mode on (shift+tab to cycle)`, `⏵⏵ auto mode on (shift+tab to cycle)`; all match the mode regex. Bypass is not in the cycle (`mode_unavailable`, correct). |
| Clear draft | `ESC[F` + **one** Ctrl-U on a 2-row draft | **Unsafe**: clears only the cursor's (empty) row; the appended CR then **submits the draft**. |
| Clear draft | `ESC[F` + 8× Ctrl-U on a 2-row draft | Box emptied, nothing sent. |
| Clear draft | one Ctrl-C (idle) on a 2-row draft | Box emptied, nothing sent (but Ctrl-C interrupts a busy turn, so it is not usable while Claude works). |
| Paste rule | text + CR in one write | A short text is submitted by the same write's CR; a long one stays in the box until a separate lone CR (see SP5 below). Jantar's writer sends a separate Return and proves the send. |
| S2 | Escape `ESC[27u` (+CR) on a busy turn | Interrupts ("Interrupted · What should Claude do instead?"), the box is empty, **no resend** of the prompt. On an idle box with a draft: nothing happens, nothing is sent. |
| Interrupt | Ctrl-C on a busy turn | Interrupts; Claude keeps running; no resend. |
| Quit | `\x03\x03` in one write | Claude exits cleanly ("Resume this session with: `claude --resume <id>`"). |
| Writer | `jantar send <sid> "Reply with just: ok"` through the launchd daemon | Proven by the transcript in 4 s. No macOS Automation prompt appeared. |
| S6 | `jantar send <sid> "/plan"` | Proven by the transcript; the mode line shows `⏸ plan mode on`. |
| L1 | `jantar new` (cs-shell, flags, a first prompt) | The window opened without stealing focus; the trust dialog was reported as a card ("Claude asks · Accessing workspace"); answered on the Mac → "Answered on the Mac" → Ready → first prompt **proven**, exit 0. |
| L-manual | Permission pick "Ask me (manual)" | **Bug, fixed in 0.4.1**: no flag was passed, so the default mode in the account's Claude settings (auto) won. Claude Code 2.1.314 accepts `--permission-mode manual`. |
| L8/L9 | `--resume last` on the other account | Resumed the same session id; the first prompt was proven; Claude on the second account quoted the first account's history. Cross-account resume works with `--share-history`. |
| CLI | `jantar new --preview --name X` | **Bug, fixed in 0.4.1**: the preview request left out the name (the real start sends it). |
| S5 | Screenshots through the daemon | Not testable from `ctl.sock` (the route is TCP only). The daemon's `node` needs Screen Recording permission; left off. |
| S4 | Session-only `/model` and `/effort` | Not run on purpose: a wrong keypress would change the default model or effort for every session. The phone already warns that these save a default. |
| P1/E1 | iPhone lock-screen medicine push; Ask Claude accuracy | Need the phone and real meals; not run. |

### What changed in 0.4.1

- **Clear draft clears every row.** Jantar reads Claude's input box under
  the pane's writer lock and types, in one write, End once per row of the
  draft and two more, then two Ctrl+U per row and six more (1 row: 3 End +
  8 Ctrl+U; 2 rows: 4 End + 10 Ctrl+U; 30 rows: 32 End + 66 Ctrl+U, 162
  bytes). In Claude Code 2.1, End at the end of a row moves to the end of
  the next one, so the Ends reach the draft's last row from anywhere;
  Ctrl+U deletes a row's text, or only the line break when the cursor is at
  a row's start, so a row can take two. Spare End at the end of the last
  row and spare Ctrl+U in an empty box do nothing; they cover a row or two
  typed at the Mac between the read and the write.
- **Clear draft refuses when the rows it reads may be short.** Nothing is
  typed, and the phone gets a fixed reason, when no input box shows or its
  bottom edge is off screen (blank rows there would not be counted), the
  screen cannot be read, the draft is taller than 30 rows, or:
  - Claude's vim mode is out of INSERT (`-- NORMAL --`, `-- VISUAL --` or
    `-- VISUAL LINE --` under the box). In NORMAL mode Claude Code 2.1.314
    drops End, its Ctrl+U deletes only from the cursor's character back to
    the start of the row (the character stays), and Return submits: a
    one-row draft with the cursor on its last letter would send that letter.
  - The box shows as many rows as Claude's full-screen display can
    (settings `tui: "fullscreen"`, or `CLAUDE_CODE_NO_FLICKER=1`): at most
    max(3, floor(H/2) - 5) rows in a tab H rows tall, the ones around the
    cursor, with no sign that others are hidden. The screen text does not
    say which display runs, so Jantar reads H (Terminal's `number of rows`)
    with the screen and refuses when the box is that tall, or when H cannot
    be read. In an 80x24 window Clear draft takes at most 6 rows; a 30-row
    draft needs a window at least 72 rows tall.

  Both come from Claude Code 2.1.314's own code, not from this run.
- **Escape and Clear draft are on by default.** `controls.escapeVerified`
  and `controls.clearVerified` default to true. Only the default changed: a
  `config.json` that holds `false` keeps it (the daemon writes every
  setting when it saves, so an install from before 0.4.1 usually does).
  `jantar controls status` shows both; `jantar controls escape on` and
  `jantar controls clear-draft on` turn them on.
- **"Ask me" names its mode.** The permission pick `manual` types
  `--permission-mode manual`, so the account's own default mode never
  decides. The flags still come from the one allowlist; there is no free
  text. The `manual` name needs Claude Code 2.1.314 or newer: an older one
  that does not know it refuses the flag, so the start fails instead of
  coming up in another mode.
- **`jantar new --preview --name X`** asks the daemon with that name, so
  the preview's command line and its "name taken" warning match the start.
- **The writer's clean-up** of a one-row prompt it typed that never
  arrived types the one-row Clear draft write (End first, so text right of
  a cursor moved at the Mac goes too), and leaves the box alone in vim
  NORMAL or VISUAL mode.

## Verified on 31 October 2026

v0.4.2's dialogs, on Claude Code 2.1.314, `--permission-mode manual`,
`JANTAR_SKIP_HOOKS=1`, one `do script` per write:

- Down and Terminal's Return move one row and choose it, exactly one
  answer: in a question (one or two), on a Write, Create or Bash prompt (a
  label wrapped over three lines included), on a plan approval and on the
  review before submitting. Down, text and the Return in one write answer
  "Type something." and "Tell Claude what to change".
- A digit is unsafe: `3` chose option 3 of question 1 and its Return then
  answered question 2 with its highlighted row. Jantar never sends one.
- In a multi-select, the Return ticks the highlighted box; the unnumbered
  Submit row is reached with Down. Cancel on the review declines every
  answer.
- **SP5**, in part: text typed into a row is submitted by the same write's
  Return when it is short (6 and 26 characters), and stays in the row,
  whole, when it is longer (191 and 700 characters) until a separate
  Return. Jantar sends that one Return only while the row shows exactly the
  typed text.
- **SP4**: two Bash prompts queued at once draw no "1 of 2" and differ only
  in their description and command; Jantar's check covers both, and a
  Return on the first left the second untouched.
- No on a permission prompt stops the turn and leaves the box empty, which
  is why "No, and tell Claude …" puts the note in the box for you to send.
- A lone Return on a plan's highlighted "Yes, and use auto mode" ran the
  plan and switched the session to auto mode (the screen half of SP8).
- **SP14**: Up after Downs in one write chose the row it should, 5 of 5: in
  a question (from "Chat about this" back up through "Type something."), in
  a multi-select (the box ticked, the dialog still open), on a 3-row Write
  prompt and on a short plan. Rows above the highlighted one answer from
  the phone, and the keypad has ↑.
- **SP15**: on a dialog whose body scrolls, Down moved the highlight, not
  the box, 4 of 4: on two 80-line plans showing `↓` (a plain row, and the
  feedback row with its text) and on a 120-line Write prompt whose title was
  scrolled off a 24-row window. A dialog whose top is off screen still gets
  no buttons from Jantar (two queued prompts would look the same): use the
  keypad or the Mac.
- **SP6, the screen path end to end**: the built daemon under a temporary
  LaunchAgent, on a throwaway home and port 7421, answering a throwaway
  session's dialogs exactly as the phone does. A 3-row Write prompt
  answered No; a stale tap on the first of two queued Bash prompts, already
  answered at the Mac, got "The dialog on the Mac changed" and left the
  second alone; a plan approved with "Yes, manually approve edits"; two
  questions, the first answered with 192 typed characters and the second a
  multi-select, submitted whole; a subagent's Bash prompt answered while a
  background agent ticked. With an expected line one character off, or a
  line missing, the compare-and-type script typed nothing. One change came
  from it: "Yes, and switch to accept edits" on a Write prompt now takes
  the 2-second hold, like the other rows that change the session's mode
  (v0.5.1).
- **SP7**, in part: a session resumed after the hooks were installed took
  its status from the hooks.

Inferred, not yet tried: on a dialog whose body scrolls, the highlighted
row takes a lone Return as on any other (SP15 tried Down there).

## Still open

| Check | Question | What depends on it |
|---|---|---|
| Clear draft, the rest | With vim mode off, in a window at least 72 rows tall: one long line wrapped over several rows and a 30-row draft, each emptied with nothing new in the transcript. Then the refusals, with nothing typed: a draft in vim NORMAL mode, and a 7-row draft in an 80x24 window | `controls.clearVerified` (on by default) |
| S5 | screencapture sizes, with Screen Recording granted to the daemon's `node` under launchd | screenshots |
| S4 | Do `/model` and `/effort` with an argument change only this session? | the commands menu's warning |
| S6, the rest | The transcript proof for `/compact`, `/clear` and the other slash commands (`/plan` is verified) | slash commands |
| Medicine pings | On an iPhone, does a medicine push stay on the lock screen until tapped? Are notification buttons shown? | the Medicines copy |
| Ask Claude | Sensible calories for real home cooking, under 15 s | the estimate model |
| Resume | Does Claude Code refuse `--session-id` with `--resume`? | the Resume command line |
| One login | With `JANTAR_ACCOUNTS=single`, does a start type `claude ...` into a new tab, and do the hooks find the session as the one account? | single-account mode outside the fakes |
| Phone | Each Life screen and Intel over the front door, under a second; a timed todo and a medicine time with the phone locked; a mute that holds the todo and not the medicine | Life on the phone |
| Rewrite | 10 runs: no MCP or skills in `system/init`, nothing new under `projects/` or in `history.jsonl`, no Jantar hook events, `--system-prompt-file` under the subscription login | the Rewrite flag set |
| L2 to L7 | `do script` opens a window, not a tab, with "Prefer tabs"; the folder privacy prompt for the daemon; failure screens; ccw's relaunch keeps `--name`, and `--permission-mode manual` (if it drops it, a moved "Ask me" session comes back in the account's default mode) | launching and its dialog cards |
| Viewer | pdf.js, the Prism worker and long press on iPhone Safari (the Chromium suite covers desktop engines only) | the Files viewer and the Board row menu |
| SP1 | With a draft typed at the Mac and not sent, does Escape (and Terminal's Return) close a Write prompt as No without sending the draft? Needs a person at the Mac to type the draft | Escape on the keypad (off until then) |
| SP2 | In auto mode, the permission prompt with No first and no numbers: its exact screen, and whether Down chooses the second row. Tried on 31 October: auto mode ran the command with no prompt, so the layout was not seen | `DIALOG_GATES.noFirst` (off: those dialogs get the keypad) |
| SP3 | In fullscreen, a Write prompt scrolled partly off screen with the wheel: does the first Return only scroll it into view, and the second choose? Needs a person at the Mac | the "Jantar saw no change" answer |
| SP5, the rest | `/plan please`, `@note.txt check` and `#tag it` typed into "Type something." and "Tell Claude what to change": plain text, or a command? | dialog text starting with `/ ! # @` (refused until then) |
| SP6, the rest | The keypad on a screen Jantar can't read; a custom statusLine drawn under a live dialog | the keypad's compare-and-type on a real screen |
| SP7, the rest | A session started without the hooks, quit, then `claude --resume <id>` with them: does a Write prompt open a card? | "sessions pick the hooks up on resume" |
| SP8 | A plan card's "Yes, and use auto mode" (hold) in a session that ran in auto mode: does the mode line read auto mode after, and does a broad allow rule set before plan mode stop auto-approving, as after the Mac's own row? | the plan card's auto row (`HOOK_PLAN_AUTO`, off until then) |
| SP9 | A card's "Yes, and allow access to … for this session" for a file outside the folder, then a second file in that folder | the combined session row (no second prompt) |
| SP10 | Does a plan card's hook payload carry the plan text? | the plan card (else it sends you to the Mac) |
| SP11 | On an iPhone: **+** with Photo Library (a HEIC photo and a Live Photo), Take Photo and Choose Files (a PDF); paste a photo; drag one onto the composer on an iPad; From this session's folder | attachments on iOS (HEIC arrives as a JPEG of at most 2000 px with no location) |
| SP12 | "describe these" with a photo and a PDF to a manual-mode session: the composed text proven, Claude's one Read prompt for the uploads folder answered from the phone, both files described | Claude reading uploads |
| SP13 | A 15 MB PDF from the phone on cellular through the front door | uploads through a tunnel (no 413 on the way) |
| SP16 | With text typed into "Type something." at the Mac (one line, then wrapped over two): Down from that row, and Down twice from row 1 across it to "Chat about this". Does each Down move the highlight, or move the cursor inside the text (so the Return would submit the text)? | the rows past a row holding text (off: answered at the Mac) |
| SP17 (v0.5.2): partly done 31 Oct | A workflow agent's Bash prompt with Claude's countdown (`… will automatically block this request in 1:33 …`): tap No on the phone while it ticks, a queued twin's stale tap (409), a tap with under 5 s left (409, nothing typed). Done on the real Mac: the `typeif` parts around the time against a real tab (same screen and a tick type; text in place of the time, an empty gap, swapped parts and one character off type nothing). Not yet: a live countdown prompt, which Claude raises only for some safety prompts in bypass mode | answering an unattended agent's prompt before Claude blocks it |

### Meetings (v0.5)

The extension's suites run in a test Chromium against synthetic Meet and
Teams pages. On real calls, so far: pairing worked; a Meet call kept its
captions and got its summary; a short Teams call kept its captions.
**Screenshots from the extension did not reach Jantar in the first three
real calls**, and the cause is not known yet. Since 0.5.3 the popup's
Settings › Last screenshot says how each try ended, so R3 can say why. The
rest is open:

| Check | Question | What depends on it |
|---|---|---|
| R1 | Build, Load unpacked, pin, `jantar meetings on`, `jantar pair --extension`, paste, Allow: the terminal says "Paired.", the popup says it is connected and lists your projects. Then Site access set to **On specific sites** as [extension.md](extension.md) says, and once to **On click**: does the popup still reach Jantar, and do notes still start? | setting the extension up, and taking the permission back |
| R2 | A Meet call with a second device: Start, talk 5 minutes, another tab for 2 minutes, Chrome minimized for 1 minute: lines keep arriving, and the phone shows them within 10 s. Then, with Chrome's automatic picture-in-picture for Meet on, another tab for over 60 s while people talk: still one meeting, not ended `left`, and the lines said meanwhile kept (if not, Meet's in-call check must be widened) | captions in a hidden tab, and Meet's picture-in-picture |
| R3 | The page button, Option+Shift+S and the popup's Screenshot, twice each: each saves, neither the button nor the popup is in the picture; one JPEG's size on a Retina screen. After each try, write down which control you used and what the bubble said, then read the popup's **Settings › Last screenshot** (with its "Chrome said" or "Jantar answered" line) and the `meetings: screenshot upload` lines in `daemon.err.log`. Read it right away: it is gone once Chrome quits or the extension reloads or updates, and a time older than the click means the extension never got that try. "Chrome said: Chrome did not answer" while the Mac was busy means the 5-s capture limit is too short there. **Failing so far** (above) | screenshots |
| R4 | Captions off with notes on, then Meet's "Translate speech" on: the bubble says how to turn them on, and the camera button still shows in the call. Captions on and nobody talking for over 60 s after Start: no "Can't read captions on this page." | Meet's in-call check and its captions-not-found |
| R5 | A Teams web call on `teams.cloud.microsoft` and one on `teams.live.com`: captions read with names; whether they live in the top frame; the same silent minute after Start as R4 | the Teams adapter |
| R6 | The camera button in Meet and in Teams (Chat and the participants panel open too) covers none of the site's controls or captions | the button's spot |
| R7 | Leave a Meet call and rejoin within a minute; in Teams open Chat during a call (the mini window) and stay there over 60 s while people talk: still one meeting, not ended `left`, notes go on with the lines said meanwhile (if not, Teams' in-call check must be widened) | the one-minute grace, and Teams' mini window |
| R8 | End, then the phone: the summary in under a minute, decisions, items, Add to todos, the transcript with its screenshots, the viewer, Export text, Delete and Undo | the summary on real meetings |
| R9 | Option+Shift+S clashes with nothing in Meet or Teams, and Settings › Shortcut shows the key Chrome holds ("Shortcut: ⌥⇧S"; "not set" when another extension took it, with Set opening `chrome://extensions/shortcuts`) | the shortcut |
| R10 | Chrome minimized and the shortcut pressed from another app: nothing is captured, or the flash says why | `captureVisibleTab` on macOS |
| R11 | Quit Chrome during a call with notes on: the meeting ends within about 15 minutes and gets its summary | the keep-alive and the stale end |

### Alerts, the MCP server and Life (v0.5.3)

The suites cover these with fakes: a push channel that records what would
leave the Mac, the fake terminal's countdown, playwright's Chromium with the
built app and its service worker, and `jantar mcp` against a daemon on a
synthetic home. What only an iPhone, a real countdown or a real Claude Code
can show:

| Check | Question | What depends on it |
|---|---|---|
| AL1 | iPhone, iOS 26, Jantar on the Home Screen and open: `jantar notify test needs` plays one sound, not two (the app answered in time and the push came silent). Two means `silent` is not honoured, or the answer was late. Then the same with the silent switch on: does the push still buzz? (The app answers that it played, so the push comes silent; if iOS honours that, an open app in silent mode loses the buzz too.) Then `jantar notify test urgent` with the switch still on: it must buzz (Answer soon is never sent silent) | the chime from a push |
| AL2 | With Speak on, does the voice speak in the Home Screen app, and with the silent switch on? After Jantar is closed and opened again from the Home Screen, tap once anywhere (not a button), then `jantar notify test needs`: does it speak, with no visit to Devices? Note whether one plain tap was enough | the voice; whether iOS counts a tap's pointerup |
| AL3 | After Jantar was in the background, does a push's tone play without a tap (the audio resumed by itself), or only after the next tap? Does a second push with the same tag sound again? | sounds after the background; the urgent repeat |
| AL4 | A real countdown ask (a workflow agent's prompt in bypass mode): one Answer soon push within a few seconds, "about 2 min to answer", no separate "needs you" push, and the repeat at about a minute left. Then two parallel subagent asks at once, the first left to time out (and once with the first answered): does the second ask get its own push? Once an ask's alert ends nothing reads the screen again, so a queued ask whose card opened earlier may get none | the urgent alert |
| MCP1 | `jantar mcp` in a terminal, then the `claude mcp add` line it prints: `/mcp` shows `jantar` with 5 tools (once per cswap profile). In a session started in a folder linked to a project, `todos_here` names that project; from home, with no project linked to home, it names none. This checks that Claude Code gives a user-scope server `CLAUDE_PROJECT_DIR` (without it, the folder the server runs in decides) | todos from Claude sessions |
| IN1 | On an iPhone, in Safari and in the Home Screen app, tap the header's magnifier: does the keyboard open with the Intel search box focused? (The focus happens once the shelf's code has loaded, after the tap.) If not, a tap on the box opens it | search from the header |
| LF1 | A medicine or reminder due while Wi-Fi is off: the ping goes out, marked late, when Wi-Fi comes back. On Wi-Fi that reaches nothing past DNS (a hotel's sign-in page) it is tried five times over a few minutes, then dropped, never sent twice: the wait for the network covers only a push that never left (no DNS answer within 10 s, no connection). After a wake, does the log show `getaddrinfo` (waits) or `Socket timeout` (counted)? | the missed-push retry |
| LF2 | A daily reminder at 11:00 snoozed an hour rings at 12:00 that day and at 11:00 the next | a repeating todo's own time |

## Trying Escape and Clear draft again

On another macOS, Terminal or Claude Code version, try Escape and Clear
draft again before relying on them. Use a throwaway Terminal window, a
scratch folder and an account that is not kept for other work.

- **Clear draft:** with vim mode off and a window at least 72 rows tall,
  leave each of these in Claude's input box and press Clear draft on the
  phone: a draft of three or more rows (a line, then `\` and Return for
  the next) with the cursor on its first row; one long line that wraps
  over several rows; a draft of 30 rows. Each time the box must end up
  empty and the transcript must show nothing new. Then the refusals: the
  three-row draft with vim mode on and the input in NORMAL mode, and a
  7-row draft in an 80x24 window, must each be refused with nothing typed.
- **Escape:** with `controls.interruptKey` set to `escape`, hold Interrupt
  on the phone during a long turn: Claude must say "Interrupted · What
  should Claude do instead?", leave the box empty and resend nothing.
  (Jantar never presses it over a draft: the appended Return would send
  the draft.)

If either misbehaves, turn it off at the Mac:
`jantar controls clear-draft off` or `jantar controls escape off` (with the
daemon stopped, these write `~/.jantar/config.json`). The key is then
refused, and the phone hides Clear draft.

## Telling us

If you run one of these on your own Mac, an issue with what you saw (and
your macOS, Terminal, Chrome and Claude Code versions) is welcome. Use
synthetic text only.
