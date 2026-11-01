# Life

A small life list next to your sessions. Each module has its own switch,
off until you turn it on at the Mac; take only what you want.

```sh
jantar life on todos medicines food places finance posts   # or: jantar life on all
jantar life set currency EUR
jantar life status
```

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="img/today-phone-dark.png"><img src="img/today-phone.png" width="240" alt="Today: two medicines due at 13:00, then the todos due."></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="img/todos-phone-dark.png"><img src="img/todos-phone.png" width="240" alt="Todos: overdue, today and upcoming."></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="img/reminders-phone-dark.png"><img src="img/reminders-phone.png" width="240" alt="Reminders: todos with a time, in the order they ring."></picture>
</p>

## The modules

- **Today**: medicines due, todos due and overdue, bills in the next three
  days, calories against the target, how many posts are due today or late,
  and how many sessions need you. Add a
  todo due today from there, and tap the weight line to log today's weight
  ("Log weight" until you do).
- **Todos** (`todos`), with **Reminders** (a todo with a time pings your
  phone) and small **Projects** (a project can be linked to a folder, and
  the Board shows it on that folder's sessions). Repeats every day, week,
  month or year (birthdays, renewals; a 29 February one falls on the 28th
  in other years), and snooze. A repeating reminder keeps its own time: a
  daily 11:00 snoozed an hour still rings at 11:00 the next day. Change
  the time in the todo sheet to move it. Three limits: a reminder made
  before 0.5.3 learns its time once you change it in the todo sheet (until
  then a snooze still moves it); a repeating todo with no time keeps a
  snooze's time after Done, and rings, until you clear the time in the
  sheet; a yearly one snoozed more than a month after its date moves to
  the snooze's month, so set its date back in the sheet.
- **Medicines** (`medicines`): dose times, every day or chosen weekdays or
  every N days; Taken, Skip or "Took it at…"; a pill count with a refill
  warning and 30 days of adherence. The lock screen says "Medicine due",
  without the name.
- **Food** (`food`): what you ate with calories, saved foods for one tap,
  "Ask Claude" to estimate a meal you type (you edit before it is saved),
  and your weight with its change over 7 and 30 days. The calorie target
  (1,500 kcal until you change it) and the goal weight are set on the
  phone.
- **Cafés** (`places`): your places and their best dishes, rated, tried or
  want to try.
- **Finance** (`finance`): expenses and income by category, monthly
  budgets, and bills that remind you.
- **Posts** (`posts`): what you plan to post on social media (a Reddit
  post, an Instagram reel, an X thread), with its text ready to copy, a
  reminder at the time, and a weekly goal per platform. Jantar never posts
  anything: you copy, open and post it yourself ([Posts](#posts)).

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="img/projects-phone-dark.png"><img src="img/projects-phone.png" width="240" alt="Projects with their open todos and live sessions."></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="img/meds-phone-dark.png"><img src="img/meds-phone.png" width="240" alt="Medicines: the day's doses and each medicine's supply."></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="img/dose-phone-dark.png"><img src="img/dose-phone.png" width="240" alt="The dose sheet: Taken, Skip or Took it at."></picture>
</p>
<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="img/food-phone-dark.png"><img src="img/food-phone.png" width="240" alt="Food: 1,240 of 1,500 kcal and the weight line."></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="img/places-phone-dark.png"><img src="img/places-phone.png" width="240" alt="Cafés, best rated first."></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="img/money-phone-dark.png"><img src="img/money-phone.png" width="240" alt="Finance: spending by category against budgets, and bills."></picture>
</p>

## How it behaves

- **Amounts** use a dot for decimals and commas only for thousands, on
  every phone: `1,240` is 1240 and `1,240.50` is 1240.50. The currency is
  a label only; there is one currency.
- **Undo instead of a confirm.** Deleting a todo, a meal, a weight, a saved
  food, a café, a money entry or a post happens at once, with Undo for five
  seconds. A medicine, a project or a bill still asks first, because
  deleting one also drops its dose history, its todos' link to it or its
  reminders.
- **Pings need the Mac awake.** Medicine, reminder and post pings come from
  the daemon, so a sleeping Mac sends none. Keep your phone's own alarm for a
  dose you must not miss. Muting pushes under Alerts holds a todo's ping,
  never a medicine's. A ping the Mac could not send for lack of network
  (asleep, Wi-Fi off) goes out, marked late, as soon as it has network
  again, up to 6 hours late. A medicine's is skipped when its next dose is
  under 3 hours away. On Wi-Fi that reaches nothing (a hotel's sign-in
  page), a ping is tried five times over a few minutes, then dropped,
  never sent twice.
- **Todos from Claude sessions.** `jantar mcp` lets a Claude session list
  and add todos of the project linked to its folder (the deepest linked
  folder wins). A project linked to your home folder, `/Users` or `/`
  counts only for a session started in exactly that folder, not for every
  folder below it. Sessions add at most 20 todos an hour; add more on the
  phone. With no project linked to the folder they add nothing: link one
  on the phone under Projects › a project › Folder.
- **Ask Claude** runs one headless Claude on an account with room (never a
  kept one) and is refused while Jantar runs read-only.
- **Ask** (its own switch, `jantar ask on`) turns plain words into todos,
  reminders, meals, money entries and post ideas, each added only by your
  tap, with Undo until a day after you asked ([Ask](assistant.md)).

## Posts

Posts is for what you post by hand: "Reddit on Monday, three reels a
week". Turn it on at the Mac with `jantar life on posts`.

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="img/posts-phone-dark.png"><img src="img/posts-phone.png" width="240" alt="Posts: today's Reddit post with Copy and Open, tomorrow's, and the week against its goals."></picture>
</p>

- **A post** has a platform (Reddit, Instagram, X, LinkedIn, YouTube,
  TikTok, Threads, Facebook, Hacker News or Other), where it goes (a
  subreddit, an account or a handle), a kind (post, comment, reel, story,
  thread, short, video or link), a title, the text or caption, notes, a
  link to the page where you post it, and a day and time. Notes hold what
  you need besides the text (the flair, the media to attach, the sub's
  rules) and are never copied.
- **Idea, Ready, Posted.** A post starts as an idea; mark it Ready when
  the text is done. Tap its square once you have posted it, with Undo for
  five seconds. Open the post to add the link to what you posted, or to
  Skip one you won't make. Done lists what you posted and skipped.
- **The reminder** rings at the post's time, like a todo's. Posts due in
  the same minute come as one push. The lock screen says "Post due" and
  the time; with `lock-screen-details` on it also says the platform and
  where ("Post on Reddit · r/exampletools · 19:30"), never the title or
  the text. A post with a day and no time is listed under that day and
  does not ring.
- **The weekly goal**: a number a week per platform, or per platform and
  kind ("Reels 3 a week", "Reddit 6 a week"). The top of Posts counts this
  week, Monday to Sunday in the Life zone: "This week: Reels 1/3 ·
  Reddit 2/6", on more lines when there are more goals. Two goals that
  would read the same name their platform too ("X threads" beside
  "Threads").
- **Jantar never posts.** It keeps the text, rings at the time and gives
  you Copy (the title, the text) and Open (the link). You post it
  yourself, then tap Posted. It never fetches a link and talks to no
  social network.

Scripts and Claude sessions on the Mac can add and list posts, at most 30
adds an hour; Posted, Skip, edits, deletes and goals are on the phone.
`--at` is in the Life zone and must be a real day; a time already gone is
still added, and the line says it won't ring. An empty `--text-file` is
refused.

```sh
jantar post add --platform reddit --where r/exampletools --at "2026-11-02 19:30" \
  --title "Typing into Terminal from a phone" --text-file draft.md \
  --link https://www.reddit.com/r/exampletools/submit --status ready
jantar post list                         # this week, then the posts to make (--done: posted and skipped)
```

## Settings

All of these change only at the Mac.

```sh
jantar life on medicines food            # any of: todos medicines food places finance posts, or all
jantar life off finance                  # its data stays in life.db
jantar life set timezone Europe/Berlin   # days and ping times (default, or none: the Mac's zone)
jantar life set currency EUR             # a label for amounts (none: plain numbers)
jantar life set lock-screen-details on   # names on the lock screen (default off: "Medicine due", "Bill due", "Post due")
jantar life status                       # modules, zone, currency, who gets medicine pings, backups
```

## Backup and restore

Life lives in its own file, `~/.jantar/life.db`. It is copied into
`~/.jantar/backups` every night at 03:30, and the newest 30 copies are
kept.

```sh
jantar life backup                       # a copy now
jantar life restore life-2026-10-29.db   # asks first, and keeps the current life.db beside it (--yes: no question)
```

A file that fails its checks is refused, never reset: Life says so on the
phone, the rest of Jantar keeps working, and `jantar life restore` brings
a backup back.

Before upgrading to 0.7.0, copy a fresh backup to `life-pre-0.7.0.db` in
the same folder. 0.7.0 adds the posts table, and 0.6.1 can't open
life.db after that; `jantar life restore life-pre-0.7.0.db` on 0.6.1 brings
the old file back ([Upgrading](upgrading.md#070-lifes-first-schema-change)).

## Privacy

Life's text stays in `life.db`. Events, audit rows, logs, error messages
and write replies never carry it, and the lock screen shows no names unless
you turn `lock-screen-details` on. [SECURITY.md](../SECURITY.md#v04-life-the-intel-shelf-resume-one-login-and-the-primer)
has the details.
