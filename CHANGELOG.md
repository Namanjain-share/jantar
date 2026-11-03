# Changelog

What changed for people who use Jantar, newest first. Versions before
0.4.0 kept the package version 0.1.0; their names here are the milestones.

## 0.13.0 (unreleased)

**Work** (off by default; `jantar work on`, which turns Todos on too): a
place for the work you do for clients, owner-only. This build has the Mac
side of projects and search, of clients, the log of calls and meetings,
follow-ups, import and export, and of deals, their stages and insights;
in the app, all of it too: Work's place, your projects, a project as one
screen with its milestones, one search from every phone header, your
clients (the list, a client's page, the Log sheet, follow-ups on Today and
Todos, a meeting's clients, import, export and merging duplicates), and
your deals (the pipeline, a deal's page, Won and Lost, the stages) with
Insights. [Work](docs/work.md) has it all.

**Before upgrading: nothing to copy by hand.** The daemon keeps
`life-pre-0.13.0.db` in the backups folder before it moves life.db to
schema 5 (Life's fourth schema change, which adds Work's tables, all
empty, and a column on todos for a follow-up's client; no existing row is
rewritten). 0.12 can't open Life afterwards, and going back means
restoring that copy. [Upgrading](docs/upgrading.md) has the steps.

- **A project on one screen.** `GET /v1/projects/<id>` answers a project
  with its open todos, how many were done this week, the ten done last,
  and a health line: overdue (the same rule as the project's own count),
  the next one due, eight weeks of done todos, and how many days an active
  project has been quiet once nothing in it changed for more than 14.
- **One search across Jantar.** `GET /v1/search?q=` finds projects, todos,
  meetings (by name and people), sessions, Intel items, cafés and posts,
  each part only while it is on, five a part, any case or accent. The
  query is never logged, and a person's space never shows. The todos list
  takes `?q=` too.
- **Start from your client folders.** `jantar work seed <folder...>` (and
  the phone's sheet, through `POST /v1/work/seed`) makes one project per
  folder you pick inside one of your folders, linked to it; a folder a
  project already links is skipped. Never automatic, and it needs Files or
  New session on.
- **Up to 500 projects** (was 200).
- **Work in the app.** Work is a place right after Chat, on a device paired
  with `control`: with Life, Chat and Work on, the phone's tabs are Board,
  Today, Chat, Work and More (Files moves into More); a row between Chat
  and Files in the iPad's sidebar; an item on the Mac's rail and `g w`
  (⌘1-⌘9 keep their places). Your projects are one tap away, under
  Active, Paused and Done with their clients and next due todos, a table
  on a wide window; a project is one screen with its client, status,
  health, milestones, deal, todos, the sessions in its folder (**New
  session here**), meetings, log, notes and **Open folder in Files**.
  While Work is on, Todos has no Projects tab and a project's old link
  opens in Work.
- **Search from every phone header.** The magnifier opens the search
  sheet on every screen (⌘K on a Mac, "Search or jump" on an iPad), which
  finds clients, projects, deals, todos, meetings, sessions, Intel, cafés,
  posts and places; **Search Intel only** is its last row.
- **Open project** in a Board row's long-press menu, and a session's
  screen names its project under the title.
- **Start from your client folders** in the app too: tick folders, name
  them, and Create makes a project each (and a client each, if you want).
- **Clients in the app.** Work › Clients lists your clients under Needs a
  step (an open deal and no follow-up), Clients, Leads and Past, each with
  its next step, open deals and last touch; filter by words, state, tag or
  a starter list (the filters are the address, so Today's links open the
  list they name). A client's page has Call, WhatsApp and Email (your
  phone's own apps; WhatsApp needs a country code, from Work's dial code),
  its next step, follow-ups, deals, projects, people, the log with older
  pages, and its details; coming back from a call asks "Log the call?".
  Add a client in about ten seconds (a possible duplicate warns, never
  blocks); delete one with what goes and what stays spelled out, or mark
  it past. Words from an import or a meeting are marked as such. On a wide
  window the list is a table until you open one.
- **The Log sheet.** A call, meeting, e-mail, message or note, and its
  next step (Tomorrow, In 3 days, Next week or a day you pick), in one
  save; what you typed is kept on the phone when the Mac can't be reached.
- **Follow-ups on Today and Todos.** A follow-up names its client on its
  row, and the todo sheet has a Client field. Today's Work card lists
  check-ins due, deals with no next step, quiet ones and ones closing this
  week, only on a day it has some.
- **A meeting's clients**, on its page: linked through its project or by
  you, suggested from its names (nothing without your tap), Unlink.
- **Import and export in the app**: a CSV or vCard from Files with a
  preview and a decision per possible duplicate, Undo for 7 days; the CSV
  export goes to the share sheet. **Find duplicates** and **Merge with…**:
  pick what the kept client takes, or say "not a duplicate".
- **Deals in the app.** Work › Deals is your pipeline: on a phone, a strip
  of stages and one stage's deals at a time; on a wide Mac or iPad window,
  a board with a column per stage, Won and Lost as the last 30 days. Each
  stage says its open and weighted value per currency. A card shows its
  value, days in stage, next step, close day and whether it is quiet; its
  **···** (a long press on a phone) moves it, logs, sets a next step or
  opens its client, and a mouse or trackpad can drag it to another column
  (never a finger: a drag would fight the scroll). Won asks "Make a project
  for it?" with the client's folder filled in; Lost asks why. A deal's page
  has its moves, its follow-ups, its project and its log; **+** adds a
  deal (a client's page has **+ New deal** too), **Edit stages** renames,
  reorders, adds and removes them, and Today's deal lines open just the
  deals they count. With a keyboard, `m` moves a deal.
- **Insights in the app**: one scroll of cards per currency (win rate,
  cycle, forecast, revenue won, sources, why lost, the funnel and time in
  stage) for 30 or 90 days, 6 or 12 months, this financial year or all;
  "—" when there is nothing to count.
- **Milestones in the app**: a project's page lists them, each ticked done
  with a tap; Edit names, dates, orders and removes them.
- `jantar life on work` brings Todos with it, and `jantar life off todos`
  turns Work off too and says so.
- **Clients and companies.** A client is a person or a company (a person
  belongs to one company), a lead, a client or past, with phones, e-mails,
  https links, tags, notes and an optional "check in every N days" that
  shows on Today. Add one with a company by name (reused when it exists);
  a possible duplicate is a warning, never a block (the same e-mail, the
  same phone by its last 10 digits, or the same name). Deleting a client
  takes its log with it and lets its todos and projects keep going without
  it. Up to 5,000.
- **The log.** Calls, meetings, e-mails, messages and notes per client,
  each with its next step in the same save (a refused next step saves
  neither). A client's page merges in its done follow-ups; "last touch"
  is its newest entry.
- **Follow-ups are todos with a client**: Today, reminders, snooze and
  Chat all see them, with no second scheduler. On a locked phone a
  follow-up says only "Follow-up · 15:00" unless you run `jantar work
  lockscreen names on`; with Work on, its tap opens the client. Only your
  own todos and projects can have a client (never your partner's or a
  shared list).
- **Meetings link to clients.** A meeting in a client's project is linked
  to that client by itself and shows in its log; you can link or unlink
  others, or make a client from a name in the meeting (marked as the
  meeting's words). A project's new client takes its meetings along.
- **Import and export.** A CSV or vCard file (at most 2,000 rows, 1 MB),
  previewed with duplicate warnings (Skip, Fill blanks, Add anyway),
  imported as one batch you can undo for 7 days; `jantar work import
  <file>` at the Mac. Never another app's contacts or database. The
  clients export as a CSV (`jantar work export --csv <file>`) that imports
  back as the same clients and companies.
- **Chat** can find, read, add and change clients, log a call with its
  next step and add a follow-up; find, add and change deals and move them
  between stages (Won makes a project only when you ask), each with Undo;
  an imported client or a meeting's name is data to it, so its changes
  after reading one are cards you tap. It never contacts a client and
  never changes the stages. The prompt is v2.
- **Deals.** A client can have several deals, each on a stage: New lead,
  Contacted, Proposal sent, Negotiation, Won and Lost to start with, which
  you can rename, reorder, add to and remove (a removed stage's deals go
  where you say). Moving a deal to Won makes its client a client and can
  make its project in the same save; Lost asks why (eight reasons and a
  note) and never demotes a client; a closed deal moved back is open
  again. A deal shows its days in stage, its next step (its own
  follow-up, else its client's), its close day, and whether it has gone
  quiet; Today's Work card counts the open deals with no next step, the
  quiet ones and those closing this week. Money is per currency, never
  added across. Up to 5,000 deals, 500 open; `jantar work export --csv
  <file> --deals` writes them as a CSV.
- **Duplicates and merging.** Work lists the clients that may be one;
  you can rule a pair "not a duplicate", or merge one into the other (its
  values fill the blanks, or the ones you pick win; its deals, log,
  follow-ups, projects and people move over in one save; the merged-away
  client is hidden for good). **Starter lists** on Clients: needs a
  check-in, open deals, quiet leads, gone quiet, missing an email.
- **Milestones on a project**: up to 12 in order, each with an optional
  target day; the project shows how many are done, the next one and any
  past its day.
- **Insights**: per currency, the win rate, the sales cycle, revenue won
  by month, losses by reason, sources, the weighted forecast by close
  month and the weekly flow; and the funnel and time in stage from the
  moves. Periods from 30 days to all time, the financial year from 1 April
  among them. Nothing to count reads as empty, never 0 %.
- **`jantar mcp`'s `client_here`**: who the session's folder's work is
  for, with its open deals and their stages and its next step; never a
  phone, an e-mail or notes.
- **Work's settings** (businesses, a dial code for WhatsApp, quiet days)
  are set on the phone; `jantar work settings` shows them.
- **Only yours, still.** A test plants a client's name, phone and e-mail
  (and a deal's title, source and loss note), runs every Work route, and
  finds none of them in the logs, the audit log, the events or an error
  reply.
- **Only yours.** Work's routes are all owner routes on your hostname,
  Work's data has tables of its own that only its code names, nothing of
  it is in the partner's app or Chat, and a log line, audit row or event
  never names a client or a folder. Tests read the route tables and the
  source to keep it so.

## 0.12.2 (4 November 2026)

- **Linking another device gives them the link, not only a code.** In the
  Accountability partner's app, Me › Devices › Link another device showed
  a code to enter at `/p/link` within 5 minutes. It now shows the whole
  link, on the address their app is open at, with Copy link, Share where
  the browser has a share sheet (AirDrop or Messages from an iPhone to a
  laptop) and a QR code, the code in large type to enter by hand, and
  the steps: open the link, sign in with the code emailed to you, and if
  it asks, open the link again or paste it. It counts down to when the
  link runs out, then says how to get a new one. Back on Me › Devices,
  the new device shows in the list ("Mac is linked."), and the screen
  says how many of the five devices are linked.
- **A device-link code lasts 15 minutes** (it was 5): the One-time PIN
  sign-in on the new device can take a few minutes on its own. It still
  works once, and five devices are still the most.
- `/p/link` says what to do after a One-time PIN sign-in dropped the code
  from the link: open the link once more, paste it, or type its code. An
  expired or used link says to make a new one on a linked device, and five
  devices say to revoke one first, on whichever device it happens.
- A device they join or link with is named for what it is (Mac, Windows
  PC, iPad, Android phone and so on), not "Phone".
- Your Sharing screen for them says how many of their five devices are
  linked, so you can see a new one arrive.

## 0.12.1 (4 November 2026)

- **An invite opens after a One-time PIN sign-in.** Signing in to
  Cloudflare Access with a code by email brought the person you invited
  back to the join page without the part of the link that holds the
  invite, and the page only said "This page needs the link you were
  sent". It now says they are signed in and to open the link once more,
  or paste it there: the whole link, one a mail app wrapped or encoded
  (Outlook's Safe Links), or just its code shows the same page to read
  and accept, a wrong one says so, and nothing is shared before Accept
  and join. Opening the link again in the same tab works too. A sign-in
  through an identity provider such as Google keeps the link whole, as
  before.
- **A reload after joining doesn't ask for the link again.** A phone that
  has joined and comes back to the join page (a reload during Add to Home
  Screen or Turn on notifications, a tab Safari dropped, or the used link
  opened again) goes on to their Today, or back to the step it was on.
- In their app, fields are 16 px, so an iPhone no longer zooms in when one
  takes focus. The paste field's error is tied to it for a screen reader
  and said again when it repeats, and the page says "Loading…" while the
  link loads. The link-code page (`/p/link`) takes the whole link as well
  as its code.
- `jantar people invite`, your People list and the People guide say that
  with the One-time PIN they open the link once more after signing in, or
  paste it.
- Intel: a link's read is marked done only once its item says so, so the
  phone never shows a finished read on an item still "Reading".
- Keys and taps the moment a screen appears now count: **a** or **d** on a
  question or permission card that has just come up, a reload right after
  Show more in Meetings or the Intel shelf (it brings back every row you
  had), and a name picked or a box ticked as the People sharing screen
  opens.

## 0.12.0 (3 November 2026)

Jantar uses the whole window. On a wide Mac window and on an iPad, lists
open their items beside them, Today is a page of cards, and Chat keeps its
days and changes in view. On an iPad it gets a labelled sidebar, phone-size
type and 44 pt targets, keeps what you typed when you rotate, and stays
clear of the on-screen keyboard. Nothing to do before upgrading: no data
changes. A phone looks as it did.

- **Today is a page of cards** on a wide window (from about 640 px of
  content, on a Mac or an iPad): Medicines, Claude, Due, Food, Bills and
  Posts side by side, three columns on a 1440 px Mac window and two at
  1024. Each card shows up to five rows and links to its place; the Claude
  card lists the sessions waiting on you longest. The Life places sit in a
  strip on top, and **Edit cards** orders and hides the cards on this
  device. A phone keeps the list.
- **Alerts** fills a wide window with one table (it stopped at 1120 px),
  and an alert opens beside the list instead of under its row: its full
  text, when it happened, its session as it is now, Open session or Open
  accounts, Mute pushes, and the session's earlier alerts. j and k move
  through them; Esc or Close goes back. The address keeps the open alert
  and the kind filter (`/alerts?kind=error&id=…`). In a narrow window a
  row still opens under itself.
- **Intel** fills a wide window with cards (five across a 1440 px Mac
  window): the first picture when there is one, the title, where it is
  from, what it is and two tags; the reads in progress are cards too. An
  item opens beside the list, which keeps your search and filters; Close or
  Esc goes back to them. A reel's pictures are shown four across the
  reading column, about 120 x 213 instead of 52 x 90.
- **Chat** keeps its days beside the thread on a wide window: search the
  chat, the turns by day (what each said, its photos and changes, a card
  still waiting in ember, Siri's), and a tap takes the thread to that
  turn. From about 1240 px, what Chat changed that can still be undone and
  its photos have a column of their own; with an empty thread that column
  says what Chat can see. The thread reads in a 680 px column with the
  composer under it.
- Chat's Confirm button now says what it does: **Delete**, **Stop**,
  **Summarize** or **Re-read**.
- **Meetings** fill a wide window with cards, the days side by side (four
  across a 1440 px Mac window): the name, when and how long, who was there
  and the summary's first lines. A meeting opens beside the list, which
  keeps your search, project and scroll. Where the meeting has 760 px, its
  transcript reads on the left and the summary, decisions and action items
  stay in view on the right; screenshots are 160 x 90 thumbnails (a tap
  opens them). Beside the list in less, Summary | Transcript shows one at
  a time.
- **Cafés** fill a wide window with cards (four across a 1440 px Mac
  window): the name, its stars or want, the price, the best dish and its
  stars, the area, last visit and tags. A café opens beside the list, its
  sections as cards: the ratings three across, Dishes beside Visits.
- **Tap a star to rate**: on a café's screen a tap on a rating's stars sets
  it at once, with "Vibe 3 → 4 · Undo". With a trackpad or a mouse a hover
  shows the value and sets nothing; clearing a rating stays in Edit.
- **Todos, Medicines, Food and Finance** put their sections side by side
  as cards on a wide window: Todos' Overdue, Today, Upcoming and No date
  (three across a 1440 px Mac window), Reminders by when they ring, and
  Projects as cards that list each project's next todos; Medicines' doses
  beside your medicines; Food's Eaten beside the day's calories and weight;
  Finance's By category, Bills and Entries. A row's actions sit beside its
  name instead of across the window. A phone keeps the lists.
- **Posts** puts Late, Today, Tomorrow, Later and No date side by side on
  a wide window (four across at 1440 px), and Done in columns. A post opens
  beside the list: its text to read, **Copy**, Mark posted and Open, its
  notes, the comments you logged in the same place, and a field at the
  bottom to log another by pasting its link (kept if you leave before
  logging it). In a narrow window a post still opens in its sheet.
- **Files** shows Changed and Browse side by side on a wide window, and a
  file opens beside the list; **Hide browser** in the viewer's header gives
  the file the whole window, and Esc closes it. The viewer's back and ···
  buttons are 44 pt on a touch screen at every width.
- **Accounts** lays itself out by its own width: the matrix from about
  640 px of content (it stopped at 1320 px; now it spans the window, on a
  ground of its own), with Resets and 7-day columns from about 1180. With
  one Claude login the login is a card across the window, its sessions in
  columns; paired machines sit two across.
- **Devices** uses two columns of cards from about 760 px of content:
  this device, its notifications and sounds on the left; paired devices,
  machines and pairing on the right (it stopped at 880 px).
- **New session** puts the folders beside the start form by the space it
  has, not the window: from about 800 px of content (was a 1024 px
  window). In a wide window /more goes to the board: the rail already lists
  every place.
- **Board and sessions** follow their own width too: a session's property
  column shows once the session has about 940 px (beside the list on a
  1440 px Mac window; it asked for a 1360 px window), and the Board's
  alerts and legend once it has 900. Where a session has less than 640 px,
  Show on Mac is an icon, so its header fits. A session header's buttons
  never shrink under their labels: the session's name, then the folder,
  shortens instead, and on a touch screen the 1 / 3 steppers show once the
  session has about 900 px (j and k still step with a keyboard). Claude's
  replies in a session read in the reading type, at most 640 px wide.
- What you type to a session, to Chat or as a new session's first prompt
  is kept when you leave and come back, or reload the tab, until it is
  sent; files and photos already uploaded stay attached to it.
- The board puts the ledger beside a session from a window 856 px wide
  (was 1024), and its column is 340 px until the window is about 1240 px
  wide (it was 360 from 1024 and 440 from 1280). Each place keeps its own
  scroll: opening one no longer starts it where the last place was
  scrolled, and going back finds it where you left it.
- Resizing the window, or turning a phone or an iPad, no longer resets the
  open session: what you typed, a card's picked option and typed answer,
  and the transcript's place all stay. New session's start form keeps its
  Name, account and picks the same way when it moves between the pane
  beside the folders and its sheet.
- On an iPad with a trackpad or a mouse, rows and buttons show their hover
  tint, as on a Mac (iPadOS says it can't hover, so Jantar now watches the
  pointer itself).
- On a touch screen 768 px and wider (an iPad), text and spacing keep the
  phone's sizes instead of the Mac's smaller, denser ones. The Mac is
  unchanged.
- Accounts, Alerts and Devices load the first time you open one, as Files
  and Life do, which keeps the app's first load small.
- Fixed: in the Home Screen app on an iPad, the top bar sat under the
  clock and the status bar over the home indicator. Both now leave room
  for them (nothing changes on a Mac).
- On an iPad, with the on-screen keyboard up, the app fits above the
  keyboard: the composer and what a pane pins at its bottom sit on it, the
  headers stay in view when iOS moves the page, and a focused field
  scrolls into view. Sheets and menus move with the app. Pinch zoom is
  left alone. A bottom sheet (a phone, or an iPad's narrow Split View or
  Slide Over) is never taller than the room above the keyboard: it
  scrolls, and the field you tapped stays in view.
- **Keys at any width**: once you have used a keyboard (a Mac from the
  start, an iPad after its first key press), the shortcuts work in a
  narrow window too, and only then show their keys. New: ⌘1–⌘9 open the
  places in their order (Board, Today, Chat, Files, Accounts, Alerts,
  Devices, Intel, Meetings; a place that is off says so), g then t, c, i,
  m or f for Today, Chat, Intel, Meetings and Files, and ⌘. as Esc for
  keyboards without one. In a text field only ⌘K, ⌘1–⌘9, ⌘. and Esc
  reach Jantar; ⌃K opens the palette only outside a field, since it
  deletes to the end of the line in one.
- **Forms** open as a sheet near the top of the window on a Mac and an
  iPad, 540 px wide, instead of a bottom sheet across the middle of a wide
  window (a phone keeps its bottom sheet). Its Save and Cancel stay in
  view, and once you have typed in it, tapping outside it, Esc or a swipe
  asks before throwing that away. Resizing across the phone's width keeps
  what you typed. On an iPad without a keyboard a sheet no longer raises
  the on-screen keyboard until you tap a field.
- On a touch screen every control is at least 44 pt at every width: the
  session's composer, Send, attach and Rewrite, a question's own answer,
  segmented controls (each segment the full height), Accounts' rows,
  aliases and sessions (one button that opens the account's sessions),
  filter chips, and the Mac-style rail and ⌘K button an iPad still shows
  until its own sidebar.
- **iPad**: from 640 px wide a touch screen gets its own shell instead of
  the Mac's top bar, rail and status bar. In landscape (1024 and wider) a
  220 px sidebar with names: Search or jump, Board, Today with its six
  places under it (a caret hides them), Chat, Files, Alerts, Partner (with
  Accountability partner on), then the Library (Intel, Meetings); at its
  foot the accounts strip (each account's 5-hour use, and whether Jantar
  is live), which opens Accounts, and ⋯ with Devices, the legend, the
  theme and Reload app. ⌘\ or its button folds it to a 72 px rail of
  labelled places, remembered on this device. In portrait the rail, whose
  top button shows the whole sidebar over the screen. The window controls'
  corner is left free. Today's strip of places shows whenever the nav
  doesn't list them. The sidebar loads on its own, so a Mac or a phone
  never downloads it.
- **Board in portrait** (an iPad, or a Board narrower than about 800 px
  beside the phone): the sessions waiting on you sit above the list, oldest
  first. A question with one set of options can be answered there (a tap
  picks, Send answer sends); a plan, a command or a question in the
  terminal opens its session. A session then fills the pane, and
  **‹ Sessions** shows the list over it (a tap on a session, outside it or
  Esc puts it away); in Chat, **‹ Days** does the same for the days.
- **A single choice opens beside its button** on an iPad or a Mac: Cafés'
  Sort and Filters, and a dose of a medicine, open as a small popover next
  to what you tapped instead of a sheet across the window (above it when
  there is more room there, and the sheet again when the on-screen
  keyboard leaves no room). A phone keeps its bottom sheets.
- **The on-screen keyboard** on an iPad: a sheet moves up to just below
  the status bar while it is out, and ends above it. ⌘K's search sits near
  the top (never in the middle, where the keyboard would hide it), 600 px
  wide, and its list stops above the keyboard. In a session, a row of
  terminal keys (esc, ⇧⇥, and ^C held) takes the controls' place above the
  composer while you type, and the meta line steps aside; typing your own
  answer to a question folds its options into one line with your pick (tap
  it to see them). A sheet no longer raises the keyboard by itself on an
  iPad without a keyboard attached (Intel's Add post, Posts' Log a
  comment).
- A question card's "Chat about this" is now **Clarify with Claude**, so it
  isn't mistaken for Jantar's Chat. It still sends Claude's own words.
- **Chat beside any screen**: the Chat button (in the Mac's top bar, at
  the end of a screen's header on an iPad) or ⌘J opens the thread next to
  what you're looking at, with the box ready to type in, on the iPad and
  the Mac. Where the screen keeps at least 560 px beside it, it is a
  360 px column; otherwise it lies over the right edge (Esc, ×, ⌘J close
  it). Open in Chat takes it full size. It is closed until you open it,
  remembers that on this device, and shares its draft with Chat. A phone's
  ⌘J opens the Chat tab.
- **Looking at**: beside a café, a post, an Intel item, a meeting or a
  session (or a todo or medicine a notification opened), Chat's panel shows
  a "Looking at" chip above its box, so "rate this 4 for vibe" knows what
  you mean. It goes with your message only while it shows (× takes it off).
  Jantar sends only the item's kind and id: the Mac finds the item, writes
  the line Chat reads itself, and drops one it doesn't know. An Intel item,
  a meeting or a session is named to Chat by kind and id only, and Chat
  reads it with its tools as before. The turn shows what it was about. With
  a Mac on an older Jantar (0.11 included), the chip's words go at the
  start of the message. The person you share with can't send one: their
  Chat names nothing of yours.
- **The whole key map, and ? to list it** (Keys and the legend, the keys of
  the place you're in first; on an iPad also in the sidebar's ⋯). ↑ and ↓
  (or j and k) move through a list, ↵ opens the row beside it, and Esc goes
  back to that row. c starts a new todo, café, post, food or expense, and /
  goes to the place's search. On a todo, e edits it, x marks it done and ⌫
  deletes it (with Undo); on an open café 1–5 set its stars and v logs a
  visit; on an open post ⌘C copies it, m marks it posted and l logs a
  comment. In a session, t, s and f switch views, ⌥1–⌥4 pick a question's
  option, ⌘↑ and ⌘↓ go through the sessions waiting on you, and with Keys
  open ↑, ↓ and ↵ work the terminal's keypad. ⌘⇧A adds a photo to Chat.
  **⌘Z** undoes the change shown on screen (the Undo line, or in Chat the
  newest change of the newest turn), never one you can't see. Following a
  link puts the focus on the new pane's heading, Tab starts at "Skip to
  content", and a list is one stop for Tab. In a browser tab ⌘1–⌘9 and ⌘J
  may stay the browser's; the list says so.
- **Intel**: drop a link or some text on the shelf to save it, with Undo.
- **An iPad says iPad**: iPadOS asks for the desktop site and calls itself a
  Mac, so pairing named it "Mac (Safari)". It is now "iPad (Safari)",
  pairing says "Pair this iPad", Devices says "This iPad" and "Safari ·
  iPadOS" (a paired iPad too, by its name), and the Sounds note speaks of
  the iPad. Devices › This device has a **Keyboard** row: Auto (shortcuts
  once a keyboard has been used), On or Off on this device, and Show
  shortcuts.
- **Accountability partner** (0.11) uses the width too. It is "Partner" in
  the iPad's sidebar and rail (its full name everywhere else), and on a
  wide Today the person sharing with you is the first card (Edit cards
  moves or hides it, and lists it only while it is on). Their screen keeps
  their name, status, Plan, Assign, Alert and the tabs in a column on the
  left from about 800 px, with the tab beside it: their Today as cards
  (the day's plan with Nudge, their to-dos, medicines and weight, the
  evening review), every other tab at most 720 px wide. Rotating an iPad
  keeps a plan you are writing. A café in the shared space says "shared"
  on its card as on its row. Their own app is unchanged.
- On an iPad, when the connection drops, the sidebar's foot says
  **Reconnecting…** with a Reconnect button. An empty place sits in the
  middle of a wide pane instead of its top-left corner. In a short window
  (under 600 px tall) a session's question or permission card takes at most
  half the window and scrolls inside, so the conversation keeps room above
  it. On a touch screen nothing sits in the bottom 24 px, where an iPad
  window's resize handle is (an iPhone's home indicator already leaves
  more), and nothing sits in that corner with a mouse either: the Mac's
  status bar ends **? legend** short of it (when its text is too long, the
  left side clips first), and in a window under 768 px wide the tabs and
  Send keep 24 px under them. A
  session beside the list in a narrow pane (an iPad at 1024 px with its
  sidebar) keeps its header on one line: the session's name and its
  arrows step aside, and the Chat button is an icon.
- On a touch screen the small capitals (section names, tags, badges and
  the iPad's rail labels) are 12 px instead of 11, so nine characters in ten
  are 12 px or more on every screen. A Mac keeps 11.

## 0.11.0 (3 November 2026)

**Accountability partner** (off by default; called People in the code, the
routes and the `jantar people` command): share a space on your Jantar with
one other person who wants a hand keeping to their days, and act as their
accountability partner. They get their own app on their own hostname; you
plan their day, add to-dos and reminders for them, and see only what they
agree to share. With it off, nothing changes for you.

**Before upgrading: nothing to copy by hand.** The daemon keeps
`life-pre-0.11.0.db` in the backups folder before it moves life.db to
schema 4 (Life's third schema change, which adds a space to every Life
table; every existing row stays yours), and `chat-pre-0.11.0.db` before
chat.db moves to schema 2. 0.10 can't open Life or Chat afterwards, and
going back means restoring those copies. jantar.db gains the space's
tables and an audit column (migration 8; 0.10 keeps working on it, and the
other person simply can't sign in there). [Upgrading](docs/upgrading.md)
has the steps.

- **Setting it up: a second hostname behind its own Access.** Their app
  lives on a hostname of its own (`us.example.com` next to your
  `jantar.example.com`), on the same Cloudflare tunnel: a DNS route, an
  ingress rule, and a Cloudflare Access application of its own whose
  policy lets in only their email (One-time PIN, the longest session).
  Then, at the Mac: `jantar remote people-url https://us.example.com`,
  `jantar people on --name Sam`, `jantar people add Asha --email …`,
  `jantar people offer Asha` and `jantar people invite Asha`, which prints
  a link that works once, for 24 hours. `jantar people doctor` checks every
  piece, including that their hostname serves their app and none of yours,
  that each hostname refuses a write carrying the other's Origin (checked
  with no credential), and that a visitor without a sign-in is sent to
  Cloudflare Access. With
  Tailscale, their hostname gets its own port and your tailnet policy
  limits them to it. [Accountability partner](docs/people.md#their-hostname)
  has each step.
- **Consent first.** The invite carries an offer: a list of fields (what
  you would see, add or change), filled by a preset (Light, Standard,
  Everything) and single flags. Their join page names every one in plain
  words, each with a switch that only turns it down, plus what you can't do
  and what is always theirs, and the honest limits (their space is stored
  on your Mac). They can narrow it any time. You ask for more from your
  screen's Sharing tab or `jantar people ask`; they answer Allow or No
  thanks, one request at a time, with 7 days before the same field can be
  asked again and "Don't ask me about this again". Every step is in a
  ledger on your Mac that is only appended to, and every 14 days their
  Today asks "Is this setup still working for you?", with an answer that
  stays theirs unless they share it.
- **What the space is called, per person.** "Accountability partner" by
  default; when you add someone (`jantar people add Asha --label
  Cofounder`) or later (their Sharing tab, or `jantar people label Asha
  Coach`; `--default` puts it back) you pick Cofounder, Partner, Coach,
  Mentor, Teammate, Family, Friend or words of your own (up to 40
  characters, plain text on one line; their name and device names are
  plain text on one line too). It titles your screen for them,
  your Today line and the pushes about the space, and on their side their
  join page ("as your cofounder"), the top of their Today, their app's
  name and the notifications they get. Installed after you named it, their
  Home Screen icon takes the name too (12 characters at most under the
  icon: its first words that fit, so "Partner in crime" is "Partner in";
  their Sharing tab shows it before you save); an icon added before keeps
  its name. A rename is a line in their
  Activity. The nav entry stays "Accountability partner".
- **What they get**: their own app, "Accountability partner" ("Partner"
  under its Home Screen icon) or the name you gave the space, with none of
  your screens or code in it.
  After joining it walks them through Add to Home Screen and notifications.
  Today runs their day plan (Now, Next and Later, a tick on every row, a
  5-second Undo, one bottom bar for the thumb, steps of their own, focus
  steps, a rough day, their status), their doses, a quick food add while
  their food log is on, and what is due. To-do has To-dos, Reminders and
  Projects: their own reminders with a day and time, and projects of their
  own (create, rename, archive and bring back, or delete, which keeps the
  to-dos) that group their to-dos, each with a page of its to-dos. Each
  item snoozes, skips with a reason (you see it, and their page and Skip
  sheet say so), asks you to change one of yours, or edits (its project
  too) and deletes one of theirs. Undo on a repeating item puts its date
  back and takes the reason back. Health holds their medicines (Taken or
  Skip with Undo), their food log while it is on, sleep (Going to sleep
  and Woke up, never a guessed time) and weight (any past day, with Undo
  on a delete, and "Corrected by Sam (was 72.4 kg)" on one you corrected).
  Then the evening review, a journal with one-tap
  check-ins, Alerts, their own assistant, the cafés and lists you share,
  and Me: Sharing (with "See what Sam sees" for each area), Activity,
  Devices, Notifications, Pause and Leave.
- **What you see**: Accountability partner in More (the rail on a wide
  screen), a line for them on your Today, and their screen: Plan (an editor
  with templates and Quick plan, a typed plan read as you type with no AI),
  Assign (a to-do with a due day and time, a repeat, one of their
  projects, "Got it" or a short report, no snooze and "Tell me if not done
  by"), Alert, and tabs for Today, To-do (filtered by their projects: you
  see each one's name and emoji, whether it is active, paused or done, and
  how many of its to-dos are open or overdue, never its notes, due day or
  when they changed it, as their join page says),
  Health (medicines at the level they share, their food log at the level
  they share, weight with Correct where they allow it, sleep), Journal
  (read, and comment if they
  allow it), Chat (read only), Lists, Alerts, Sharing (what they agreed to,
  Ask for more, their devices, your pushes about them: the opt-in day
  summary, the review push, quiet hours) and Activity (their record, in
  your words). An area they keep private is a grey tile, never a gap.
  Someone invited (with the link's expiry, and Copy link again on an admin
  device) or who left is a row with the next step. Asking for more from a
  phone without admin shows the `jantar people ask` line for what you
  tick.
- **Never in their name, never behind their back.** No screen, route or
  command of yours ticks their items, logs or undoes a dose, adds a weight,
  or pauses or narrows for them. Their Activity lists every change you make,
  each time you look at an area (once an hour per area), and each device of
  yours that can newly open their space. Jantar never asks for their
  location or keeps their IP address, and you never see when they last
  opened the app. Their reminders and doses ring their phone, not yours.
- **Alerts both ways**: check in, call me, Urgent, good morning and night,
  running late, a reminder about an item and a custom line, with one-tap
  replies. One resolver decides every alert, comment and ring between
  you, and every notification your changes and requests send them: limits
  set by whoever receives, holds for their pause, mute, Need space, focus,
  sleep and quiet hours (one line when a hold ends, such as "1 alert, a
  reminder and 2 updates from Sam while you were in quiet hours"), and
  Urgent through quiet hours unless they switch that off. Their own
  reminders and doses always ring. Their lock screen shows everything,
  hides alert text (the default) or hides everything (the space's name
  and "Medicine time").
- **Their medicines**: in their own space. They add, edit and stop any and
  log their doses; with the agreement's fields you add one for them, and
  edit or stop yours and theirs ("Edited by Sam", the old values in their
  Activity). You see them in full (names, doses, times, taken or skipped,
  how often in 30 days) or as how often only, and one plain line when doses
  went unlogged two days running. Your remove is Stop: their history stays.
- **Their food log** (on unless you add them with `--no-food`; `jantar
  people modules Asha --food on|off`, and off is refused while they have
  entries): what they ate with calories if they know them (an item without
  them shows no number), edit, delete with Undo, one-tap saved foods,
  their own daily target, and a photo of a meal through their Chat. Only
  they write it. You see it at the level they agree to: in full (what they
  ate, its calories and each day's total against their target, never when
  they logged it) or only how many meals each day; Standard and Everything
  offer it in full, Light leaves it off, and `jantar people offer --see
  food=counts` (or `full`, or `off`) sets it. Your Today line and your
  day summary follow the same level. Turning their food log on later
  grants you nothing until they say yes to a request. While it is off, no
  food level is agreed: their join page and their answer to your request
  store food off whatever the offer or the request said, turning it off
  takes food out of a request still waiting (and ends one that was only
  about food), and `people doctor` says to put off any food level found
  beside no food log.
- **Their assistant**: a Chat of their own, on your Mac and your Claude
  accounts (your account rules apply). It reads and changes only their
  space, with Undo; deletes and alerts to you are cards they tap; it has no
  journal tool and nothing of yours, and your words reach it as data. 30
  messages a day by default (you set the number). With their chat shared
  you read it; they see "Sam can read this chat" on every visit.
- **Shared cafés and lists**: cafés and lists you both add to, tick and
  rate ("Edited by Asha", "Ticked by Asha · 18:20"); deleting one is a
  Confirm, and the other is told.
- **Pause, Leave, Download**: theirs alone, working even while the space is
  off, the daemon is read-only or Life data is damaged. Pause holds your
  new items, requests and alerts; Leave revokes their devices at once and keeps their
  data 30 days or deletes it now; Download gives them their own space as a
  readable page or a data file. From the Mac, `jantar people remove` gives
  them 7 days to download first (`--now`, `--forget`), and prints the
  Access step to remove their email once sharing has ended (with the 7
  days, the day to do it).
- **A day in their space is a date.** A day the calendar doesn't have
  (2026-02-30) in any of their paths or yours about them is refused before
  anything is written.
- **At the Mac**: `jantar people on|off|doctor|add|label|offer|ask|prefs|modules|invite|list|devices|revoke|revoke-invite|remove|todos`
  and `jantar remote people-url`. Everything that lets someone in, shapes
  their offer or ends their space runs only at the Mac. Their name, device
  names and to-do titles are printed with any escape sequence taken out.
- **Not in this version**: your own assistant reading their space, and
  more than one person.

## 0.10.2 (3 November 2026)

- Alerts no longer say **you rejected** for a tool call nobody refused.
  Claude writes the same words when it stops a call (Esc on a running
  call, a workflow or agent being stopped) as when you say No with
  nothing typed. When nothing proves a No, Jantar now reads those words
  as a stop in a subagent's or workflow agent's own transcript, and in
  bypass, auto or don't-ask mode, except for a question or plan you
  dismissed. A call Claude itself marks as stopped while running, not
  refused, is a stop in every mode. A No with words typed for Claude
  always shows, and a No at a subagent's or safety-check prompt, which
  Jantar missed before, now shows too, with the words you typed.

## 0.10.1 (3 November 2026)

- **New folder in Files**: inside any folder you browse (say ~/Desktop),
  New folder makes an empty folder and opens it with **Start a session
  here**, the start sheet for that folder. It needs launching on and a
  device with the launch scope, as starting a session does.
- A new folder's name is refused when it differs only in capitals from
  something already in that folder, and the message names what is
  there.
- Retrying a new folder after a dropped connection no longer says it
  already exists.
- `launch.rate.foldersPerHour` now holds for new folders asked for at
  the same moment, and a new folder refused for the limit says how many
  minutes to wait.
- The start sheet's New folder shows that wait, says "can't make folders
  or start sessions" without the launch scope (and keeps Create off), and
  no longer cuts a long pasted name without saying why.
- `jantar files status` says whether Files shows New folder;
  `jantar launch status` shows the new-folder limit.

## 0.10.0 (3 November 2026)

Cafés get stars, ratings, a price level, tags and visits. Ask becomes
**Chat**, which does what you ask across Jantar at once, with Undo, and
asks before deleting anything; ask it by voice with Siri ("Hey Siri,
Jantar"). Upgrade notes follow.

**Before upgrading: nothing to copy by hand.** The daemon keeps
`life-pre-0.10.0.db` in the backups folder before it moves life.db to
schema 3 (Life's second schema change); 0.9.1 can't open Life afterwards,
and going back needs `jantar life restore life-pre-0.10.0.db`
([Upgrading](docs/upgrading.md#0100-lifes-second-schema-change)).
jantar.db gains a column for key scopes (0.9.1 keeps working on it).
Chat's history is new data on disk, in `chat.db`.

- **Cafés**: a café's own stars, six optional ratings (Food, Coffee &
  drinks, Vibe, Service, Value, Work), a price level, would go again,
  tags (Wi-Fi, Sockets, Quiet and 18 more, plus your own), dishes with a
  price, order again and notes (a dish can be listed before it is
  tried), and visits (day, spend, stars, what you had). The list sorts
  (best, recent, visits, name, price, work) and filters by tags, price,
  stars, area and would go again; each café has its own screen. A café
  with visits asks before it is deleted. On the Mac, `jantar place list`
  and `jantar place show` read cafés.
- **Chat** (the nav's Chat, right after Today; `/ask` lands there): one
  thread per Mac, the same on every phone and for Siri. Type, or send up
  to four photos (a receipt, a menu), and Chat reads and changes your
  todos, reminders, medicines, food, weight, cafés (the new fields too),
  money, bills, posts, the Intel shelf and meetings, for the parts that
  are on. Adds and changes happen at once and show under the answer with
  **Undo** for a day; every delete, stopping a medicine, and anything that
  spends Claude quota is a **Confirm** card that runs only on your tap;
  after Chat reads someone else's text (a saved page, a meeting or a todo
  made from one, a session), its writes wait as **Do it** cards. A link is saved only when
  you wrote it.
- **Sessions in Chat are read only**: it can say which session waits for
  you, what it asked, its last messages and your accounts' usage, and it
  can never type into a terminal, answer a prompt or start a session.
- **History**: kept on the Mac in `chat.db` for 30 days (`jantar chat keep
  <days>`); Clear chat (or `jantar chat clear`) deletes it, and what Chat
  added stays.
- **Siri**: "Hey Siri, Jantar" with an iPhone Shortcut and a Siri key made
  at the Mac (`jantar chat shortcut add`, in your own Terminal; shown
  once). Siri speaks the answer within 20 seconds and Jantar's own count
  of what changed, else "Still working on it" and a notification when it
  is ready. Same door rules as Save to Jantar: Tailscale or Cloudflare
  only, and a Siri key opens nothing else
  ([Ask Jantar with Siri](docs/shortcut.md#ask-jantar-with-siri)).
- **What goes to Claude now**: what you type and your photos, with the
  last messages of the chat and whatever Chat looks up to answer, for the
  parts that are on ([Chat](docs/assistant.md#what-goes-to-claude)).
- **On the Mac**: `jantar chat on | off | status | clear | keep |
  voice-model | shortcut`; `jantar ask` still works and runs `jantar
  chat`. `jantar doctor` checks the Siri door too.

## 0.9.1 (3 November 2026)

Start when I join, in the Jantar extension: open the Jantar icon on a Meet
or Teams join screen or in the waiting room, fill the sheet as for Start
notes, and press Start when I join. Notes start by themselves once you are
let in, exactly as Start notes would, and never before. And Jantar turns
the call's captions on when notes start, since it writes notes from them.
Jantar, the protocol and meetings.db don't change: build and reload the
extension (no new permission), and update the phone app.

- **Start when I join**: the icon shows ARM while it waits, ON once notes
  are on, and the page says "Jantar started notes. Let people know you keep
  notes." Only that tab, only once you are in the call (the controls Start
  notes trusts, seen on two checks a second apart). Cancel, closing the
  tab, leaving the meeting's page for a minute (Teams' Chat or Meet's home
  page too, also after leaving the call), another Meet call in the tab, or
  two hours unused end it. Nothing of the call reaches Jantar before you
  are let in. The armed popup names the page's title, the project and the
  todos switch.
- **Always start when I join a call** (Settings, off by default): every
  Meet or Teams call you join in this Chrome. Not this call skips one, and
  End keeps a rejoin of that call from starting again; the popup then says
  the call is skipped. A call first seen already in progress waits for
  Start notes, and a call left for Teams' Chat is not armed. Unpair turns
  it off. While the extension is not paired it arms nothing and shows no
  ARM: the join screen says to pair, and the pairing view can turn it off.
  Pairing again arms the join screens open then.
- When notes can't start by themselves (Meetings off, Jantar not running,
  the extension not paired, another tab already keeping notes for the
  call), the page and the popup say why, and the icon shows !. An armed tab
  whose notes can't start yet (Meetings off, Jantar not running) says so in
  the popup, with Cancel or Not this call.
- The icon shows ON in a tab keeping notes, however they started.
  Settings › Call check names what the page shows (the join screen, the
  waiting room, the call), by Jantar's own name for the control, for
  reports, next to Always at the top of Settings. Teams' waiting room after
  Join now is told apart only on a meeting's join link (light meetings):
  in Teams' own app an arm made on the pre-join screen ends a minute after
  Join now. Teams' waiting room and Teams light meetings are not checked on
  a real Mac yet (docs/real-mac-checks.md, R12 to R17).
- Fixed: after a reload of a call with notes on, notes resume only once the
  call's controls held two checks, never on one that flashes up in the
  waiting room.
- **Captions on when notes start** (Settings › Turn on captions when notes
  start, on by default): Jantar writes notes from the call's live captions,
  and Meet and Teams start every call with them off. When notes start
  (Start notes, Start when I join, or notes going on again after a reload)
  Jantar turns them on in that tab if they are off: Meet's captions button
  or, since Meet's redesign, Captions and translation › Turn on captions;
  Teams' Captions button, More › Captions (also for a guest in Teams light
  meetings) or More › Language and speech › Show live captions. It reads the
  control first and clicks only one that says off, closes the menu it
  opened, tries at most three times, waits while you are in the menu
  yourself, and clicks nothing more once notes stop. A Teams guest's
  Captions item says nothing and toggles, so it is clicked only when notes
  start within a minute of joining (captions start off), once per page,
  and never with a caption area on the page; otherwise Jantar leaves
  captions as they are. Once captions were on in a call, no later notes in
  that page touch them (End then Start included): if you turn them off,
  they stay off. Captions are only for you; nobody in the call sees a
  change. Settings › Call check says how it went ("Captions: turned on by
  Jantar · …", "can't tell if they are on; Jantar left them", "this meeting
  offers none (the organizer's settings)", "on earlier in this call; Jantar
  left them as they are").
- **No captions yet**: no caption line in the first minute of notes,
  Jantar asks the call's captions control. Captions on (nobody has spoken
  yet): no bubble and no !, the popup says "Captions are on; lines appear
  once someone speaks." Otherwise the page says why, once more three
  minutes later, the icon shows ! and the popup says the same until the
  first line comes in: "No captions yet: Jantar writes notes from the
  call's live captions. Turn them on: <the way for Meet, Teams, or a Teams
  guest>." only when the control says off (the controls toggle; Meet's
  words no longer say "press c"); "Jantar turned captions on. If none
  appear when people speak, check …" after its click; "… If none appear
  when people speak, turn them on: …" when nothing says; "This meeting
  offers no captions (the organizer's settings) …" when More has none. It
  replaces the 10-second "No captions on screen" bubble, and the way for
  Teams no longer names Language and speech alone or Cmd+Shift+A. A
  reload no longer leaves an old ! on the icon.
- Teams light meetings (joining as a guest): their captions are read with
  the speakers' names (the guest's caption layout, no Fluent UI items).
- Meet's captions button found by its icon too, so Meet counts as in the
  call with captions off after its redesign of 22 October 2026 (Start and
  Start when I join depended on the old button). Checks R-C1 to R-C7 in
  docs/real-mac-checks.md.
- Fixed, on the phone: a meeting whose notes ran but got no caption line
  said "No transcript: notes were not started." It now says "No captions
  came in while notes were on (meeting 10:00-10:42). Jantar writes notes
  from the call's live captions; they were off or not visible." (the
  meeting's times, which may start before notes did). The first sentence
  stays for notes that never ran. A running meeting with no line yet says
  that lines come from the call's live captions, which must be on.

## 0.9.0 (2 November 2026)

Log a comment, in Posts: paste the link to a comment you made (on Reddit:
Share, then Copy link) and Jantar saves it as a posted comment, with the
platform and where read from the link; Today counts comments against a
daily share of the weekly goal; `jantar post log`; Done shows the newest
300. Nothing to do when upgrading: life.db, settings and the protocol
don't change.

- **Log a comment** (the top of Posts, beside + Post, on To post and
  Done): paste the link and see "Reddit · r/exampletools" as you paste it
  (X, LinkedIn, YouTube and the rest give the platform; type the where if
  you like), add what you wrote if you want, then Log comment (or the
  keyboard's Done), with Undo for five seconds. It counts as posted at the
  moment you log it. The same link twice is refused ("You logged that
  link already."). Jantar never opens or fetches the link.
- **Comments today**: with a comment goal (Posts › the week line, kind
  Comment), Today's Posts section shows "Comments today 3/5", the weekly
  comment goals divided by 7 and rounded up (with none, "Comments today 3"
  once one is logged that day); a tap opens Posts › Done.
- **The week line** names a comment goal's platform, and the platform of
  any other kind's goal beside it: "Reddit comments 12/35 · Reddit posts
  0/2".
- **Done** lists the newest 300 posted and skipped (was 100), each logged
  comment with the first line of what you wrote and Open; the where is
  never cut (it wraps, and the time goes under it).
- **+ Post** moved from the foot of Posts to the top, beside Log a comment,
  so a long list never pushes it down.
- **On the Mac**: `jantar post log '<link>' [--text T | --text-file F]
  [--where W]` logs a comment (quote the link), within the same 30 adds an
  hour as `jantar post add`; `jantar post list --done` prints each posted
  link.

## 0.8.0 (2 November 2026)

Add post, in Intel, off until you run `jantar intel read on` at the Mac:
send a link (an Instagram reel, a YouTube video, an X or LinkedIn post, a
Reddit thread, a TikTok, an article, a PDF, any https page) or a note from
the phone, an iOS Shortcut, Ask or `jantar intel save`. It is saved on the
shelf at once, then read on the Mac one at a time, and you find it later by
what it said. jantar.db gains a table (migration 6; 0.7 opens it and
carries on). Rebuild and reload the Chrome extension. The protocol stays at
version 3, and settings don't change version.

- **Add post** (Intel's header, with reading on): paste a link, a link and
  your own words (they become its note), or just text; pick **Light**,
  **Standard** (the default) or **Full**; Save says "Saved. Reading it on
  your Mac.", or "Already saved." with Open and Read again. **Add by hand**
  keeps the old form, which reads nothing.
- **What a read keeps**: a title, a short summary, tags and key points from
  Claude; the creator, platform and date; the caption or text; the text on
  screen read from up to 20 frames (Standard and Full), so burnt-in
  subtitles are searchable; at Full the transcript (YouTube's captions, else
  speech-to-text on the Mac, the first 30 minutes), up to 3 links from your
  note read too, and Claude's own background, labelled apart; up to 7 small
  pictures kept on the Mac; the link, when it was saved and the depth.
  **Open original** opens the post.
- **Where it reads from**, in your order: your own Chrome through the
  extension (Read saved links, off by default; post links only, rebuilt by
  the Mac, in a muted background tab that closes on any other page), then a
  headless Chrome with an empty profile, then a guarded download of the
  public page, then yt-dlp if you installed it (single-file, no ffmpeg).
  Ways known not to work for a platform are skipped ([docs/intel.md](docs/intel.md#what-each-kind-of-link-gives)).
- **The Reading strip** shows each read as it goes (Waiting, Opening in
  Chrome, Looking at frames, Listening, Summarising, Saved, or Couldn't
  read with a plain reason) with **Retry** and **Change depth**; an item's
  page has **Read again as** and **Delete**, which also removes its
  pictures and compacts the shelf's file. A read that was running when the
  daemon stopped is marked "Stopped before it finished. Retry." and never
  restarts by itself.
- **Search** covers the creator, platform, caption, text on screen,
  transcript, key points and your note; `jantar mcp`'s `intel_search` shows
  platform and creator, and `intel_get` the caption, on-screen text, points
  and transcript, labelled as text read from a web page.
- **The iOS Shortcut "Save to Jantar"** from the Share sheet, through
  Tailscale or Cloudflare only: `jantar intel shortcut add` makes its key at
  the Mac and prints the steps ([docs/shortcut.md](docs/shortcut.md)). Its
  reply is always "Saved to Jantar.". `jantar doctor` checks the door.
- **Ask**: "save this: <link>" (or just a link) gives a Save to Intel card
  at once, with no Claude run; Add saves it, Undo deletes it.
- **At the Mac**: `jantar intel read on | off | status`, `jantar intel read
  speech <locale>`, `jantar intel save`, `jobs`, `retry` and `delete`.
  `jantar intel add` is unchanged.
- **What leaves the Mac**: requests to the platforms (honest User-Agent, no
  cookies; local and private addresses refused after DNS and on every
  redirect); with Read saved links, your Chrome visits the post as you; to
  Claude, the post's text, your note and its frames as pictures. Audio never
  leaves the Mac. Frames and speech run in a small helper the Mac builds
  once with Apple's Command Line Tools, in a sandbox with no network
  ([SECURITY.md](SECURITY.md#v08-intel-reads-links)).
- **The extension** asks for two new permissions, `alarms` and `scripting`,
  which Chrome grants on reload without a prompt; the six post sites are
  asked only when you turn Read saved links on.
- playwright-core 1.63.0 becomes a runtime dependency of the daemon (it was
  already used by the tests); no other new package.

## 0.7.0 (2 November 2026)

Posts, a sixth part of Life, off until you run `jantar life on posts` at the
Mac: plan what you post on social media, get a reminder at the time, copy
the text and open the place to post it. Jantar never posts anything itself.
The protocol stays at version 3, and settings don't change version.

- **Before upgrading: `jantar life backup`, then copy that file to
  `life-pre-0.7.0.db` in the same folder.** 0.7.0 adds a table to
  `life.db`, Life's first schema change, and 0.6.1 can't open Life after
  0.7.0 has; going back needs `jantar life restore life-pre-0.7.0.db`. The
  nightly backup can replace that day's copy, which is why the copy gets
  its own name ([Upgrading](docs/upgrading.md#070-lifes-first-schema-change)).
- **A post** is one thing you will post by hand: the platform (Reddit,
  Instagram, X, LinkedIn, YouTube, TikTok, Threads, Facebook, Hacker News
  or Other), where it goes (a subreddit, an account or a handle), the kind
  (post, comment, reel, story, thread, short, video or link), a title, the
  text or caption, notes that are never copied (the flair, the media to
  attach, the sub's rules), a link to the page where you post it, and a
  day and time. It moves from Idea to Ready to Posted, or Skipped.
- **The Posts screen** (under Life) lists Late, Today, Tomorrow, Later and
  No date. A post due today or late has Copy (the text) and Open (the
  link) on its row; tap its square once you have posted it, with Undo for
  five seconds, and add the posted link in the post. Done lists what you
  posted and skipped.
- **A reminder at the time**, like a todo's, with the catch-up after the
  Mac was offline. Posts due in the same minute come as one push. The lock
  screen says "Post due" and the time; with `lock-screen-details` on it
  also names the platform and where, never the title or the text.
- **A weekly goal** per platform, or per platform and kind, set on the
  phone: "This week: Reels 1/3 · Reddit 2/6", Monday to Sunday. Today
  shows one line: "2 to post today · 1 late".
- **`jantar post add`** and **`jantar post list`** let scripts and Claude
  sessions on the Mac load and read posts: `jantar post add --platform
  reddit --where r/exampletools --at "2026-11-02 19:30" --title "Launch
  day" --text-file draft.md --link
  https://www.reddit.com/r/exampletools/submit --status ready`. A day that
  doesn't exist or an empty text file is refused, and a time already gone
  is added with "(that time has passed: it won't ring)". At most 30 adds
  an hour come from the Mac; marking posted, skipping, editing, deleting
  and the goals are on the phone only.
- **Ask** suggests a post: "reel tomorrow 7pm about the launch" gives an
  Instagram reel card with Add and Undo, added as an idea. Ask never writes
  a post's text. Its prompt is now `assistant-v2.md`.
- Nothing calls a social network or an API, and no link is ever fetched:
  links are `https` only and open when you tap them.

## 0.6.2 (2 November 2026)

- **A long prompt sent from the phone no longer says "Not delivered" when it
  arrived.** Claude Code 2.1.31x records a pasted prompt inside
  `<pasted_content>` tags, and Jantar types long prompts as a paste, so its
  check that Claude took the prompt compared the text with the tags around
  it and gave up, although the session had the prompt. The check now reads
  the prompt inside those tags.

## 0.6.1 (1 November 2026)

- **A session waiting on a dynamic workflow or a background agent shows as
  working.** Between turns Claude Code can wait on work it started in the
  background ("Waiting for 1 dynamic workflow to finish"). The board called
  that session Done. It now sits under Working with "1 workflow running",
  the workflow's name and how long, and the session's header says
  "1 workflow running · 52m · demo-sweep", until the last one finishes.
  While that work runs, the session is never drawn "no update", even in
  the middle of a turn. Background shells and monitors only add a quiet
  count ("6 shells") to the session's header, and on a wider screen to its
  Board row, because a long-lived monitor would keep a session looking
  busy forever.
- It is read from the session's transcript, so it works without hooks and
  comes back after Jantar restarts. Only counts, a workflow's name and when
  it started reach the phone: never a task's prompt, description, command
  or summary.
- Pushes, cards and typing are unchanged: the Done push still comes when
  the turn that started the workflow ends.
- `jantar status` says it too: `* Working · web-app · fix-login`, then
  `1 workflow running · 52m · demo-sweep`.
- The protocol version stays 3 (one optional session field), there is no
  settings or database change, and a Mac and its servers on 0.6.0 and 0.6.1
  still pair either way.

## 0.6.0 (1 November 2026)

**Fleet**: your servers on the same phone. It is off until you run
`jantar fleet on` at the Mac; with it off, Jantar works as 0.5.3 did but
for the last two lines below. How to set it up: [servers](docs/fleet.md).

- **Your servers on the same board.** Pair Linux servers, Windows machines
  and other Macs with the Mac (`jantar node pair` there, `jantar node join`
  on the server), and their Claude Code sessions, cards and accounts show
  on the phone beside the Mac's, each row naming its machine. Each server
  dials out to the Mac through the front door the phone already uses
  (Cloudflare with an Access service token, or Tailscale), so it opens no
  port. Keys are pinned at join and every link is a fresh challenge both
  ways; `jantar node revoke` ends a server's link at once.
- **What you set up.** With Cloudflare: one Access application for
  `/v1/node/*` with a single Service Auth policy, and a service token the
  servers share. Its expiry takes every server offline at once, so renew it
  before then and run `jantar node access` on each server. With Tailscale:
  a tag for the servers and a grant to the Mac's HTTPS port. Each server
  runs Jantar as a service: a systemd user unit with lingering on Linux and
  WSL2 (WSL2 also needs `systemd=true` and its keep-alive lines), the
  LaunchAgent on another Mac, the `schtasks` lines the join prints on
  native Windows. All of it, step by step: [servers](docs/fleet.md).
- **On Linux (and Windows with WSL2), Claude in tmux** can be answered,
  prompted and started from the phone, on the server's own Claude accounts
  (cswap if it has it, else each `~/.claude-<name>` config dir). A session
  started outside tmux shows its cards and transcript, and the phone says
  why it can't type there.
- **Native Windows is a preview**, not yet checked on a real Windows
  machine: sessions and their hook cards only (no typing or starting
  sessions), with Claude Code 2.1.310 or newer, on a machine nobody else
  logs on to.
- A server's pushes name it ("build-1 · api-server needs you"), at most 10
  a minute per server, and a busy server can't push the Mac's own alerts,
  sends or starts off the phone's lists. **Answer soon** stays with the
  Mac's own sessions: the Mac never reads a server's screen for Claude's
  countdown, so a server's unattended ask sends the usual "needs you" push.
  Ask, Life, Intel and Meetings stay on the Mac.
- A server that goes offline keeps its sessions on the board, muted
  ("offline since 14:02"), and nothing is sent there until it is back.
  `jantar fleet status` and `jantar node list` say how each link last
  closed.
- New setting: `fleet.enabled` (off). The protocol version stays 3 and the
  settings version 2; Jantar's database gets one new table, for paired
  servers, which 0.5.3 opens and leaves alone.
- Not yet checked on real machines: sending prompts on Linux, real Claude
  Code in tmux, the Access path for the link, native Windows and WSL2's
  keep-alive ([what is not verified yet](docs/fleet.md#not-verified-yet)).
- On every Mac, Fleet or not: before typing into a session, a Claude
  process whose start time can't be read is refused with one sentence that
  points to `jantar doctor`, and a bare number that is no time since 2000
  no longer counts as a start time. An admin device can list and remove
  paired servers (`GET /v1/machines`, `DELETE /v1/machines/:id`); there
  are none until Fleet is on.
- On every Mac, Fleet or not: the hook cards now load as their own part of
  the app, so the first card after the app opens may show "Loading the
  card" for a moment (well under a second; that part is kept for offline
  use like the rest). It keeps the app's first load small.

## 0.5.3 (1 November 2026)

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
  a restart forget it. A message refused because one is still waiting, or
  because Ask can't run, doesn't count against the 10 a minute and 100 a
  day.
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
  the todo sheet). Snooze, Done and then Undo no longer moves a monthly
  todo to the snoozed day of the month for good. Today has Add todo, due
  today, and its weight line logs today's weight. [Life](docs/life.md)
  lists the limits.
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
  only.
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
- A reminder due while Life's database was busy no longer rings up to 30
  seconds late.
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
