# Work

Work is a place for the work you do for clients: each project as one
screen, one search across Jantar, your clients and companies, a log of
calls, meetings and notes, follow-ups that ring like any reminder, and
deals on stages from a new lead to Won or Lost, with insights. Work is
off until you turn it on at the Mac, and it is yours alone: nothing of it
ever reaches an [accountability partner](people.md).

```sh
jantar work on        # turns Todos on too: Work's projects and follow-ups are todos
jantar work status
jantar work off       # hides Work again; nothing is deleted
```

`jantar life on work` and `jantar life on all` turn it on the same way,
and `jantar life off todos` turns Work off with Todos (it says so).

## What this build has

The Mac side of all of Work: projects and search; clients, the log,
follow-ups, meetings linked to clients, import and export; deals, their
stages and insights. The phone's Work screens (a Work tab, the project,
client and deal screens, the Log sheet, the deal stages, Insights, search
from every header) come with the app's next update; until then the routes
below are there for it, Todos keeps showing your projects as before, and
Chat and the CLI already reach your clients and deals.

### A project on one screen

`GET /v1/projects/<id>` answers a project in one read, so a phone screen
needs one round trip:

- the project, with its open and overdue counts, notes, due day and
  folder;
- its open todos, in the order the todos list shows them;
- how many were done this week, and the ten done most recently;
- a health line: how many are overdue (the same rule as everywhere: an
  earlier day, or today at a time already past), the next one due, how
  many were done in each of the last eight weeks (Monday to Monday in your
  Life time zone), and, for an active project, how many days it has been
  quiet once nothing in it has changed for more than 14 days.

A project's meetings come from Meetings (`GET /v1/meetings?project=`,
while Meetings is on), and its live sessions from the Board. While Work is
on, the project also carries its client, its newest log entries, its deal
(an open one first, else the newest) and its milestones.

**Milestones.** A project can have up to 12 milestones in order
("Wireframes", "Build", "Launch"), each with an optional target day, ticked
when done (`PUT /v1/work/projects/<id>/milestones`). The project shows how
many are done, the next one, and any whose day has passed while not done.
Todos stay flat: a milestone is its own step, not a group of todos. Only
your own projects take milestones, never a shared list.

You can have up to 500 projects (it was 200): finished client projects
pile up.

### One search across Jantar

`GET /v1/search?q=` looks in everything that is on: clients (by name,
company, e-mail and phone digits), projects, deals (by title and client),
todos (open ones, then done), meetings (by name and people), sessions (by
name and folder), the Intel shelf, cafés and posts. Each part answers only while it is on, with at most five
results, any case or accent ("cafe" finds "Café"). The query stays on the
Mac: the request log never records it, and nothing is written for a
search.

The todos list takes `?q=` too (title and notes).

### Start from your client folders

Your client folders already are a list of your work. Work can make one
project per folder you pick, each linked to its folder, so its sessions
show on it:

```sh
jantar work seed ~/Desktop/work/client/acme ~/Desktop/work/client/northwind
jantar work seed ~/Desktop/work/client/globex --name "Globex audit"
```

It never runs by itself. The folders must be inside one of your folders
(`jantar folders add-root <path>`), it needs Files or New session on (Work
adds no new way to list the Mac's folders), and a folder a project already
links is skipped and counted. A project is named from its folder
("acme-web" becomes "Acme Web") unless you name it. The phone's sheet
(`POST /v1/work/seed`) picks folders from the same browsers.

### Clients and companies

A client is a person or a company. A person can belong to one company,
and a company lists its people. Each has a state: **lead**, **client** or
**past** (someone who has paid you once stays a client; mark them past
when the work ends). A client keeps up to five phones and e-mails, links
(https only), a title, a city, up to ten tags, a source ("Referral") and
notes, and, for a company, its client folder.

- **Add one in about ten seconds:** a name, and a company by name if you
  like (Work reuses a company with the same name, any case, or makes it).
- **Duplicates warn, never block.** While you type, Work says which client
  this may already be: the same e-mail, then the same phone (by its last
  10 digits, so "+91 98765 43210" and "098765 43210" are one), then the
  same name (a hint only).
- **Check in every N days** (7 to 365) is optional per client. A client
  due a check-in shows on Today's Work card; it never rings.
- **Delete** a client and its log and its deals go with it; its
  follow-ups and projects stay, with no client, and its people lose their
  company. Mark
  it as past instead when you can: history is worth keeping. A delete has
  no Undo beyond its Confirm.

Up to 5,000 clients and companies, past ones included.

**Duplicates and merging.** Work lists the clients that may be one (the
same e-mail, phone or name, in groups). For each pair you can say "not a
duplicate" (they stop showing together) or merge one into the other: the
one you keep keeps its own values and takes the other's where it has none
(or where you pick the other's: name, company, title, city, source,
notes, folder, check-in cadence), phones, e-mails, links and tags are
joined, and the other's deals, log, follow-ups, projects and people move
over, all in one save. The merged-away client is hidden for good. A
client imported from a file passes its mark on to the one it is merged
into, so Chat still treats those words as data. Two people or two
companies only; Chat never merges.

**Starter lists** on Clients: Needs a check-in, Open deals, Quiet leads
(14 days), Gone quiet (30 days) and Missing an email, each with how many
it holds (`GET /v1/work/clients/lists`, and `?list=` on the clients
list).

### The log

The log keeps what happened with a client: a call (in or out, how long,
how it went), a meeting, an e-mail, a message or a note. **Logging and the
next step are one save:** log a call and set "Send the quote, Thursday
15:00" together; if the next step can't be saved, neither is the call.

A client's page shows its log newest first, with its done follow-ups in
between. "Last touch" is the newest call, meeting, e-mail, message or
note; editing a client never counts. Up to 50,000 entries.

### Follow-ups

A follow-up is an ordinary todo with a client: it shows in Today's Due,
rings at its time, snoozes and catches up after sleep like any reminder,
and Chat sees it. There is no second scheduler. On a locked phone a
follow-up's push says only **"Follow-up · 15:00"**; turn its words on at
the Mac if you want them there:

```sh
jantar work lockscreen names on
```

While Work is on, tapping it opens the client.

A project can have a client too (and a business, from Work's settings).
Only your own todos and projects take a client: a shared list or your
partner's to-do never can. The todos list takes `?contact=<id>` for one
client's follow-ups.

### Meetings and clients

A meeting in a project that has a client is linked to that client by
itself, and shows in the client's log with its name. From the meeting you
can link other clients, unlink one (it stays unlinked), or make a client
from one of the names in the meeting's people. A client made that way is
marked as a meeting's words, because someone else chose that name. When a
project's client changes, its meetings' automatic links move with it;
links you made by hand stay. Deleting a meeting removes its links.

The link lives in life.db (Work never reads the meetings file); if the
two ever disagree, the daemon repairs the automatic links when Meetings
starts.

### Import and export

Import clients from a file you hand over: a CSV (columns are matched by
their header: name, first and last name, e-mail, phone, company, title,
tags, notes, source, city, state, website, LinkedIn) or a vCard (`.vcf`;
on the iPhone, a contact shared from Contacts can be saved to Files as
one). Jantar never reads another app's contacts or database, and never
looks anyone up on the web.

```sh
jantar work import clients.csv --dry-run   # what the file holds; nothing imported
jantar work import clients.csv
jantar work imports                        # the newest imports
jantar work import undo <batch>            # within 7 days
jantar work export --csv ~/Documents/clients.csv
```

A preview comes first: each row with its duplicate warning. A row with
the same e-mail or phone as a client is skipped by default; a name-only
match is added (check it). On the phone you can also pick **Fill blanks**
for a match: the client keeps what it has and gains what was empty. At
most 2,000 rows or 1 MB a file. Every client an import makes (and one it
fills) is marked as imported, so Chat treats its words as data.

Undo removes, for 7 days, the clients the import added that nothing
changed, logged, followed up or linked since, and says how many it kept.

The export is a CSV of every client, written only where you name (a new
file; never over one, never into a client folder). A cell that a
spreadsheet would run as a formula is written so that it shows instead.

### Deals

A deal is a piece of work a client may buy: a title ("Site rebuild"), its
client (usually a company), a value, an expected close day, a source
("Referral"), and the stage it is on. A client can have several open
deals at once.

- **Stages.** Work starts with six: New lead, Contacted, Proposal sent,
  Negotiation, Won and Lost. You can rename, reorder and add stages (3 to
  12), give an open stage its own close probability and its own quiet
  days, and remove one: a stage that still has deals asks which open stage
  they go to (they keep their days in stage; it isn't counted as a move).
  Won and Lost can be renamed or moved, never removed.
- **A new deal** starts on an open stage (the first, unless you pick
  another), for a client you pick or name (a client with that name, any
  case, or else a new company, a lead). Its value is in the Life currency
  unless you name another.
- **Moving it** is how its stage changes, and each move is kept in its
  log. **Won** makes its client a client (a lead becomes one) and can make
  the project for it in the same save: its name, its folder if you pick
  one, the client, the business and the deal linked. **Lost** asks why
  (price, bad timing, a competitor, no budget, went quiet, not a fit,
  killed internally, other) with a short note, and never turns a client
  back into a lead. A won or lost deal moved to an open stage is open
  again. Undo is a move back.
- **What a deal card says:** its stage and days in it, its value, the
  close day (overdue, today, this week, later), the next step (the deal's
  earliest open follow-up, else its client's) or "no next step", and
  **quiet** when neither a move nor a touch with its client happened in
  the stage's quiet days (14 by default).
- **Where deals show:** the Deals list (open ones by stage, then close
  day; filters for a stage, a client, a business, closing this week or
  month, overdue ones included, and quiet ones), each stage's total value
  and weighted value (value times the stage's probability; until you set
  your own, the open stages ramp by their place, 20 % to 80 % for the four
  default ones), a client's page (a
  person's own deals and its company's; a company's own and its people's),
  the project it became, and Today's Work card: open deals with no next
  step, quiet deals, and deals closing this week.
- **Delete** a deal and its moves go with it; a call or a note you logged
  with it stays on the client, and its follow-ups stay with no deal.
- **Money** is never added across currencies: every total is per
  currency.

Up to 5,000 deals, 500 of them open.

```sh
jantar work export --csv ~/Documents/deals.csv --deals
```

### Insights

`GET /v1/work/insights?period=` reads your deals over a period (30 or 90
days, 6 or 12 months, this calendar year, this financial year from 1
April, or all) and, with `business=`, one business. Each currency has its
own book:

- **win rate**: won out of won and lost in the period (open deals never
  count against it), and how many are still open;
- **sales cycle**: days from a deal's start to its win, over the deals won
  in the period;
- **revenue won** per month, the dry months included;
- **losses** by reason;
- **sources**: the deals started in the period, with their wins, losses
  and revenue;
- **forecast**: open deals, weighted by their stage's probability, by the
  month they should close (and those with no close day);
- **the weekly flow**: deals added, won and lost each week, and what was
  still open at the week's end.

From the moves in the period, whatever the currency: the **funnel** (how
many entered each stage, left it, moved on or were lost from it) and
**time in stage** (average and median days, and what sits there now, with
the longest wait). With nothing to
count, a figure is empty, never 0 %.

### Work's settings

Your businesses (up to five trading names; a project can carry one),
the dial code WhatsApp needs before a 10-digit number ("+91"), and how
many days with no touch make a client quiet (14 by default) are set on
the phone and live in life.db. `jantar work settings` shows them. Only
the on/off switch and the lock-screen words are switches at the Mac.

### Chat and Claude sessions

With Work on, Chat can find and read your clients, add and change one, log
a call or a note with its next step, and add a follow-up; find your deals,
add and change one, and move one to another stage, each with Undo. Moving
a deal to Won makes a project only when you ask for one. It never deletes
(a delete is a card you tap), never imports, exports or merges, never
changes the stages, never sets a folder, and never sends anything to a
client. A
client imported from a file or made from a meeting's name is data to
Chat: after reading one, every change it wants to make becomes a card
for you to tap. Asking Chat about a client sends that client's details to
Claude through your account. See [Chat](assistant.md).

In a Claude Code session, `jantar mcp`'s `client_here` says who the work
in that folder is for: the client of the folder's project, or the company
whose folder holds it, with its state, open deals and their stages, next
follow-up and last touch, but no phone, e-mail or notes.

## What Work never does

- It never contacts a client: no e-mail, SMS or WhatsApp is sent, and no
  page is served for one. Call, WhatsApp and Email buttons (on the phone)
  open your own app with the number or address filled in.
- It never writes into a client folder.
- It never reads another app's contacts or database, and never looks a
  contact up on the web.

## Only yours

- Every Work route is an owner route on your hostname; none is under the
  partner's address, and her app, her Chat and her bundle import nothing of
  Work. Tests read the route tables and the source to keep it so.
- Work's own data lives in life.db, in tables of its own with no space
  column: only Work's code names them.
- Nothing about a client goes into a log line, an audit row, an event or
  an error: ids and counts only. A folder's name can be a client's, so
  seeding writes an audit row with no folder and no name. A test plants a
  client's name, phone and e-mail (and a deal's title, source and loss
  note), runs every Work route, and reads the logs, the audit log and the
  events for them.
- A follow-up rings only your devices.

## Your data

Work keeps its data in life.db, so the nightly backup, `jantar life
backup` and `jantar life restore` cover it with the rest of Life (the two
can't be restored apart). 0.13 moves life.db to schema 5, which adds
Work's tables; see [Upgrading](upgrading.md).
