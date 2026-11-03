# Work

Work is a place for the work you do for clients: each project as one
screen, and one search across Jantar. Later parts of 0.13 add clients and
companies, a log of calls and meetings, follow-ups and deals; this page
grows with them. Work is off until you turn it on at the Mac, and it is
yours alone: nothing of it ever reaches an
[accountability partner](people.md).

```sh
jantar work on        # turns Todos on too: Work's projects and follow-ups are todos
jantar work status
jantar work off       # hides Work again; nothing is deleted
```

`jantar life on work` and `jantar life on all` turn it on the same way,
and `jantar life off todos` turns Work off with Todos (it says so).

## What this build has

The Mac side of Work's first part. The phone's Work screens (a Work tab,
the project screen, search from every header) come with the app's next
update; until then the routes below are there for it, and Todos keeps
showing your projects as before.

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
while Meetings is on), and its live sessions from the Board.

You can have up to 500 projects (it was 200): finished client projects
pile up.

### One search across Jantar

`GET /v1/search?q=` looks in everything that is on: projects, todos (open
ones, then done), meetings (by name and people), sessions (by name and
folder), the Intel shelf, cafés and posts; clients and deals join when
they exist. Each part answers only while it is on, with at most five
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

## Only yours

- Every Work route is an owner route on your hostname; none is under the
  partner's address, and her app, her Chat and her bundle import nothing of
  Work. Tests read the route tables and the source to keep it so.
- Work's own data lives in life.db, in tables of its own with no space
  column: only Work's code names them.
- Nothing about a client goes into a log line, an audit row or an event:
  ids and counts only. A folder's name can be a client's, so seeding writes
  an audit row with no folder and no name.

## Your data

Work keeps its data in life.db, so the nightly backup, `jantar life
backup` and `jantar life restore` cover it with the rest of Life (the two
can't be restored apart). 0.13 moves life.db to schema 5, which adds
Work's tables; see [Upgrading](upgrading.md).
